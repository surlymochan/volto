// botd/src/adapters/dsh.ts
//
// DeepSeek Shell (`dsh`) adapter.
//
// `dsh --profile acp` starts the agent in Agent Client Protocol (ACP) mode:
// newline-delimited JSON-RPC 2.0 over stdio.  A session looks like
//
//   client -> agent   {"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,...}}
//   agent  -> client  {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1,...}}
//   client -> agent   {"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"...","mcpServers":[]}}
//   agent  -> client  {"jsonrpc":"2.0","id":1,"result":{"sessionId":"..."}}
//   client -> agent   {"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":"...","prompt":[{"type":"text","text":"..."}]}}
//   agent  -> client  {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"..."}}}}
//   agent  -> client  {"jsonrpc":"2.0","id":3,"method":"session/request_permission","params":{"sessionId":"...","toolCall":{...},"options":[...]}}
//   client -> agent   {"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"..."}}
//
// This file is the only place that knows about ACP; the rest of botd only
// ever sees NormalizedEvent.

import type {
  BotAdapter,
  BotKind,
  ModelFamily,
  NormalizedEvent,
  OpenOptions,
  SpawnSpec,
} from "../adapter-types.ts";

/** argv that starts dsh in its machine protocol (no shell, no secrets). */
export const DSH_COMMAND: readonly string[] = ["dsh", "--profile", "acp"];

/** ACP protocol version implemented by this adapter. */
export const ACP_PROTOCOL_VERSION = 1;

type JsonRpcId = number | string;

interface PermissionOption {
  optionId?: string;
  name?: string;
  kind?: string;
}

interface PermissionRequest {
  rpcId: JsonRpcId;
  options: PermissionOption[];
  /** True once the turn of the request was cancelled: it may no longer be allowed. */
  cancelled?: boolean;
}

export class DshAdapter implements BotAdapter {
  readonly kind: BotKind = "dsh";
  readonly family: ModelFamily = "deepseek";

  /** id used for the next JSON-RPC request we send. */
  #nextId = 0;
  /** session id learned from the `session/new` result. */
  #sessionId?: string;
  /** jsonrpc id -> method of the request we sent (used to classify replies). */
  #pending = new Map<string, string>();
  /** permission id -> the agent request it answers. */
  #permissions = new Map<string, PermissionRequest>();
  /** tool call id -> tool name, so updates without a title keep the name. */
  #toolNames = new Map<string, string>();

  /** Session id of the running ACP session, once `session/new` was answered. */
  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  spawn(opts: OpenOptions): SpawnSpec {
    return {
      command: [...DSH_COMMAND],
      env: inheritedEnv(),
      cwd: opts.cwd,
    };
  }

  handshake(opts: OpenOptions): unknown[] {
    // ACP first negotiates capabilities, then opens a session.  Both are
    // plain JSON-RPC requests; the executor writes them back to back.
    const initialize = this.#request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      // The agent keeps its own tools: we do not serve fs/terminal requests.
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    const session = this.#request("session/new", {
      cwd: opts.cwd,
      mcpServers: [],
    });
    return [initialize, session];
  }

  prompt(text: string, ctx: { providerSessionId?: string }): unknown {
    const sessionId = ctx.providerSessionId ?? this.#sessionId ?? "";
    return this.#request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  cancel(ctx: { providerSessionId?: string }): unknown[] {
    // A cancelled turn may no longer allow a pending permission: the request
    // stays known, but from now on it can only be rejected.
    for (const request of this.#permissions.values()) request.cancelled = true;
    const sessionId = ctx.providerSessionId ?? this.#sessionId;
    if (!sessionId) return [];
    // `session/cancel` is a JSON-RPC notification (no id).
    return [
      {
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId },
      },
    ];
  }

  answerPermission(id: string, allow: boolean): unknown | null {
    const request = this.#permissions.get(id);
    if (!request) return null;
    this.#permissions.delete(id);
    if (request.cancelled && allow) {
      // The turn of the request was cancelled: it may no longer be allowed,
      // so nothing is written to the provider.
      return null;
    }
    const optionId = allow
      ? pickOption(request.options, ["allow_once", "allow_always"])
      : pickOption(request.options, ["reject_once", "reject_always"]);
    if (!optionId) {
      return {
        jsonrpc: "2.0",
        id: request.rpcId,
        result: { outcome: { outcome: "cancelled" } },
      };
    }
    return {
      jsonrpc: "2.0",
      id: request.rpcId,
      result: { outcome: { outcome: "selected", optionId } },
    };
  }

  /** Map one stdout line to normalized events. Never throws. */
  parse(line: string): NormalizedEvent[] {
    try {
      const trimmed = line.trim();
      if (!trimmed) return [];
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return [{ kind: "raw", payload: line }];
      }
      const record = asRecord(message);
      if (!record) return [{ kind: "raw", payload: message }];
      return this.#mapMessage(record);
    } catch {
      return [{ kind: "raw", payload: line }];
    }
  }

  #request(method: string, params: unknown): Record<string, unknown> {
    const id = this.#nextId++;
    this.#pending.set(String(id), method);
    return { jsonrpc: "2.0", id, method, params };
  }

  #mapMessage(message: Record<string, unknown>): NormalizedEvent[] {
    const method = message.method;
    if (typeof method === "string") {
      if (method === "session/update") return this.#mapUpdate(message);
      if (method === "session/request_permission") {
        return this.#mapPermission(message);
      }
      // Any other agent -> client request/notification is not ours to answer.
      return [{ kind: "raw", payload: message }];
    }
    if (message.error !== undefined) return this.#mapError(message.error);
    if (message.result !== undefined) return this.#mapResult(message);
    return [{ kind: "raw", payload: message }];
  }

  /** A reply to one of our requests. */
  #mapResult(message: Record<string, unknown>): NormalizedEvent[] {
    const result = asRecord(message.result) ?? {};
    const id = message.id;
    const method = typeof id === "number" || typeof id === "string"
      ? this.#pending.get(String(id))
      : undefined;

    if (typeof result.sessionId === "string") {
      // `session/new` succeeded: the session is ready.
      this.#sessionId = result.sessionId;
      return [{ kind: "ready", providerSessionId: result.sessionId }];
    }
    if (result.stopReason !== undefined) {
      // `session/prompt` finished.
      return [turnEnd(result.stopReason, usageOf(result))];
    }
    if (result.protocolVersion !== undefined) {
      // `initialize` succeeded: the agent is up, no session yet.
      return [{ kind: "ready" }];
    }
    if (method === "session/prompt") return [{ kind: "turn_end", status: "ok" }];
    if (method === "session/new" || method === "initialize") {
      return [{ kind: "ready" }];
    }
    return [{ kind: "raw", payload: message }];
  }

  /** A JSON-RPC error reply. */
  #mapError(error: unknown): NormalizedEvent[] {
    const record = asRecord(error);
    if (record && typeof record.message === "string" && record.message) {
      return [{ kind: "error", message: record.message }];
    }
    if (error === null || error === undefined) {
      return [{ kind: "error", message: "unknown error" }];
    }
    return [{ kind: "error", message: String(error) }];
  }

  /** `session/update` notification: streamed agent output. */
  #mapUpdate(message: Record<string, unknown>): NormalizedEvent[] {
    const params = asRecord(message.params);
    const update = params ? asRecord(params.update) : undefined;
    if (!update) return [{ kind: "raw", payload: message }];
    const kind = update.sessionUpdate;

    if (kind === "agent_message_chunk") {
      const delta = textOf(update.content);
      // Never drop a provider line silently.
      if (!delta) return [{ kind: "raw", payload: message }];
      return [{ kind: "text", delta }];
    }
    if (kind === "tool_call") {
      const name = this.#toolName(update);
      return [
        {
          kind: "tool",
          name,
          status: "start",
          summary: toolSummary(update),
        },
      ];
    }
    if (kind === "tool_call_update") {
      return [
        {
          kind: "tool",
          name: this.#toolName(update),
          status: toolStatus(update.status),
          summary: toolSummary(update),
        },
      ];
    }
    // agent_thought_chunk, user_message_chunk, plan, ... have no normalized
    // counterpart: keep them raw instead of mixing them into the answer.
    return [{ kind: "raw", payload: message }];
  }

  /** Name of a tool call; updates reuse the name of the announced call. */
  #toolName(update: Record<string, unknown>): string {
    const callId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
    let name: string | undefined;
    if (typeof update.title === "string" && update.title) name = update.title;
    else if (callId) name = this.#toolNames.get(callId);
    if (!name && typeof update.kind === "string" && update.kind) name = update.kind;
    if (!name && callId) name = callId;
    if (!name) name = "tool";
    if (callId) this.#toolNames.set(callId, name);
    return name;
  }

  /** `session/request_permission` request: the agent asks the user. */
  #mapPermission(message: Record<string, unknown>): NormalizedEvent[] {
    const id = message.id;
    if (typeof id !== "number" && typeof id !== "string") {
      return [{ kind: "raw", payload: message }];
    }
    const params = asRecord(message.params) ?? {};
    const rawOptions = Array.isArray(params.options) ? params.options : [];
    const options: PermissionOption[] = [];
    for (const raw of rawOptions) {
      const option = asRecord(raw);
      if (!option) continue;
      options.push({
        optionId: typeof option.optionId === "string" ? option.optionId : undefined,
        name: typeof option.name === "string" ? option.name : undefined,
        kind: typeof option.kind === "string" ? option.kind : undefined,
      });
    }
    this.#permissions.set(String(id), { rpcId: id, options });
    return [{ kind: "permission", id: String(id), request: params }];
  }
}

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/** Plain text of an ACP content block (or list of blocks). */
function textOf(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((entry) => textOf(entry))
      .filter((text) => text.length > 0)
      .join("\n");
  }
  const block = asRecord(content);
  if (!block) return "";
  if (typeof block.text === "string") return block.text;
  const inner = asRecord(block.content);
  if (inner && typeof inner.text === "string") return inner.text;
  return "";
}

function toolSummary(update: Record<string, unknown>): string | undefined {
  const text = textOf(update.content);
  if (text) return text;
  const output = asRecord(update.rawOutput);
  if (output && typeof output.output === "string") return output.output;
  return undefined;
}

function toolStatus(status: unknown): "start" | "end" | "error" {
  if (status === "completed") return "end";
  if (status === "failed") return "error";
  // pending / in_progress / unknown
  return "start";
}

function turnEnd(
  stopReason: unknown,
  usage?: { inputTokens?: number; outputTokens?: number },
): NormalizedEvent {
  const status = stopReason === "cancelled" ? "cancelled" : "ok";
  return usage ? { kind: "turn_end", status, usage } : { kind: "turn_end", status };
}

function usageOf(
  result: Record<string, unknown>,
): { inputTokens?: number; outputTokens?: number } | undefined {
  const usage = asRecord(result.usage);
  if (!usage) return undefined;
  const inputTokens = firstNumber(usage.inputTokens, usage.input_tokens);
  const outputTokens = firstNumber(usage.outputTokens, usage.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens };
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function pickOption(
  options: PermissionOption[],
  kinds: string[],
): string | undefined {
  for (const kind of kinds) {
    for (const option of options) {
      if (option.kind === kind && typeof option.optionId === "string") {
        return option.optionId;
      }
    }
  }
  return undefined;
}

/** Shared instance for callers that do not need per-session state. */
export const dshAdapter = new DshAdapter();

export default dshAdapter;
