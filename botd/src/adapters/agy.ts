/**
 * volto-botd adapter: `agy` (Antigravity CLI -- Gemini model family).
 *
 * ---------------------------------------------------------------------------
 * PROTOCOL USED
 * ---------------------------------------------------------------------------
 * Two machine protocols are supported and the adapter implements both. The
 * active one is resolved once, when the adapter is constructed:
 *
 *   1. ACP -- "Agent Client Protocol": JSON-RPC 2.0 over stdio, one JSON
 *      object per line, newline delimited. Used when the `agy` binary
 *      advertises it. `agy --help` is probed once for the token "acp"; the
 *      spawn command is then `agy --acp`.
 *
 *   2. STREAM-JSON -- the Claude-Code compatible streaming fallback: the
 *      spawn command is `agy -p --output-format stream-json` and the prompt
 *      is written to stdin as plain text while stdout carries one JSON
 *      object per line.
 *
 * The authoring host had **no** `agy` binary installed, so the ACP path could
 * not be confirmed against a real binary there and the STREAM-JSON fallback is
 * what the probe selects on such a host (a missing binary is treated as "no
 * ACP support"). As soon as a real `agy` build that advertises ACP is on
 * PATH, the ACP path is selected automatically. Set `VOLTO_AGY_PROTOCOL=acp`
 * or `VOLTO_AGY_PROTOCOL=stream-json` to pin the choice explicitly (handy for
 * tests and for hosts where `agy --help` is unavailable).
 *
 * ---------------------------------------------------------------------------
 * NOTES / ASSUMPTIONS
 * ---------------------------------------------------------------------------
 * - `agy` is spawned without a shell; no secret ever appears in argv.
 * - The CLI flags `--model` and `--append-system-prompt`, plus `--resume`,
 *   are assumed to exist on the Claude-Code compatible surface of `agy`.
 *   In ACP mode the model is additionally carried in `session/new._meta`.
 * - ACP is used for the machine protocol only; the request/response ids are
 *   allocated by the adapter instance so a response can be correlated with the
 *   request that produced it.
 * - `parse()` never throws: unknown lines are reported as `kind:"raw"`.
 */

import { execFileSync } from "node:child_process";
import type {
  BotAdapter,
  BotKind,
  ModelFamily,
  NormalizedEvent,
  OpenOptions,
  SpawnSpec,
} from "../adapter-types.ts";

/** Machine protocol spoken by the `agy` binary. */
export type AgyProtocol = "acp" | "stream-json";

/** Name of the provider binary. */
export const AGY_BINARY = "agy";

/** Environment variable that pins the protocol (`acp` | `stream-json`). */
export const AGY_PROTOCOL_ENV = "VOLTO_AGY_PROTOCOL";

/** ACP protocol revision announced by the client during `initialize`. */
const ACP_PROTOCOL_VERSION = 1;

/** First JSON-RPC request id handed out by an adapter instance. */
const ACP_REQUEST_ID_START = 1;

/** Longest tool summary kept in a normalized `tool` event. */
const TOOL_SUMMARY_LIMIT = 240;

interface AcpPermissionOption {
  optionId: string;
  kind: string;
}

interface PermissionRecord {
  /** Original JSON-RPC id, echoed back verbatim in the response. */
  rawId: unknown;
  options: AcpPermissionOption[];
  /** True once the turn of the request was cancelled: it may no longer be allowed. */
  cancelled?: boolean;
}

export interface AgyAdapterOptions {
  /** Pin the protocol; when omitted it is detected (see `detectAgyProtocol`). */
  protocol?: AgyProtocol;
  /** Environment used for detection and inherited by the spawned child. */
  env?: Record<string, string | undefined>;
}

/** The environment of the current process (empty when unavailable). */
export function defaultEnv(): Record<string, string | undefined> {
  const proc = (
    globalThis as unknown as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process;
  return proc?.env ?? {};
}

/**
 * Ask the binary whether it speaks ACP. Returns false when the binary is
 * missing or does not mention ACP (any failure is treated as "no ACP").
 */
export function probeAgyAcpSupport(
  env: Record<string, string | undefined> = defaultEnv(),
): boolean {
  try {
    const help = execFileSync(AGY_BINARY, ["--help"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      env: inheritedEnv(env),
    });
    return /\bacp\b/i.test(help);
  } catch {
    return false;
  }
}

/**
 * Resolve the protocol: explicit environment override first, then the
 * `agy --help` probe, then the STREAM-JSON fallback.
 */
export function detectAgyProtocol(
  env: Record<string, string | undefined> = defaultEnv(),
): AgyProtocol {
  const forced = (env[AGY_PROTOCOL_ENV] ?? "").trim().toLowerCase();
  if (forced === "acp") return "acp";
  if (forced === "stream-json" || forced === "stream_json") return "stream-json";
  return probeAgyAcpSupport(env) ? "acp" : "stream-json";
}

/** Copy an environment map, keeping string values only. */
export function inheritedEnv(
  source: Record<string, string | undefined> = defaultEnv(),
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** `agy` adapter (Antigravity / Gemini). */
export class AgyAdapter implements BotAdapter {
  readonly kind: BotKind = "agy";
  readonly family: ModelFamily = "gemini";
  /** Protocol actually used by this instance. */
  readonly protocol: AgyProtocol;

  #nextRequestId = ACP_REQUEST_ID_START;
  #permissions = new Map<string, PermissionRecord>();
  #toolTitles = new Map<string, string>();
  #sawText = false;
  #env: Record<string, string | undefined>;

  constructor(options: AgyAdapterOptions = {}) {
    this.#env = options.env ?? defaultEnv();
    this.protocol = options.protocol ?? detectAgyProtocol(this.#env);
  }

  // ---------------------------------------------------------------- spawning

  spawn(opts: OpenOptions): SpawnSpec {
    const command = [AGY_BINARY];
    if (this.protocol === "acp") {
      command.push("--acp");
    } else {
      command.push("-p", "--output-format", "stream-json");
      if (opts.systemPrompt) command.push("--append-system-prompt", opts.systemPrompt);
      if (opts.resumeProviderSessionId) command.push("--resume", opts.resumeProviderSessionId);
    }
    if (opts.model) command.push("--model", opts.model);
    return { command, env: inheritedEnv(this.#env), cwd: opts.cwd };
  }

  // ---------------------------------------------------------------- messages

  handshake(opts: OpenOptions): unknown[] {
    if (this.protocol !== "acp") return [];

    const initialize = {
      jsonrpc: "2.0",
      id: this.#allocateId(),
      method: "initialize",
      params: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
    };

    const meta: Record<string, unknown> = {};
    if (opts.model) meta.model = opts.model;
    if (opts.effort) meta.effort = opts.effort;
    if (opts.systemPrompt) meta.systemPrompt = opts.systemPrompt;

    const params: Record<string, unknown> = { cwd: opts.cwd, mcpServers: [] };
    if (Object.keys(meta).length > 0) params._meta = { volto: meta };

    const open =
      opts.resumeProviderSessionId !== undefined
        ? {
            jsonrpc: "2.0",
            id: this.#allocateId(),
            method: "session/load",
            params: { ...params, sessionId: opts.resumeProviderSessionId },
          }
        : {
            jsonrpc: "2.0",
            id: this.#allocateId(),
            method: "session/new",
            params,
          };

    return [initialize, open];
  }

  prompt(text: string, ctx: { providerSessionId?: string }): unknown {
    if (this.protocol !== "acp") return text;
    return {
      jsonrpc: "2.0",
      id: this.#allocateId(),
      method: "session/prompt",
      params: {
        sessionId: ctx.providerSessionId ?? "",
        prompt: [{ type: "text", text }],
      },
    };
  }

  cancel(ctx: { providerSessionId?: string }): unknown[] {
    // A cancelled turn may no longer allow a pending permission: the request
    // stays known, but from now on it can only be rejected.
    for (const record of this.#permissions.values()) record.cancelled = true;
    if (this.protocol !== "acp") return [];
    return [
      {
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: ctx.providerSessionId ?? "" },
      },
    ];
  }

  answerPermission(id: string, allow: boolean): unknown | null {
    if (this.protocol !== "acp") return null;
    const record = this.#permissions.get(id);
    if (!record) return null;
    if (record.cancelled) {
      // The turn of the request was cancelled: it may no longer be allowed.
      // A late deny is answered with the reject option of the request.
      this.#permissions.delete(id);
      if (allow) return null;
    }
    const optionId = pickPermissionOption(record.options, allow);
    if (!optionId) return null;
    this.#permissions.delete(id);
    return {
      jsonrpc: "2.0",
      id: record.rawId,
      result: { outcome: { outcome: "selected", optionId } },
    };
  }

  // ------------------------------------------------------------------ parsing

  parse(line: string): NormalizedEvent[] {
    try {
      const trimmed = line.trim();
      if (trimmed === "") return [];

      let payload: unknown;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        return [{ kind: "raw", payload: trimmed }];
      }

      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        return [{ kind: "raw", payload }];
      }

      const events = this.#mapObject(payload as Record<string, unknown>);
      return events.length > 0 ? events : [{ kind: "raw", payload }];
    } catch {
      // The contract forbids throwing: anything unexpected becomes a raw event.
      return [{ kind: "raw", payload: line }];
    }
  }

  #mapObject(obj: Record<string, unknown>): NormalizedEvent[] {
    const method = typeof obj.method === "string" ? obj.method : undefined;
    if (method !== undefined || obj.jsonrpc !== undefined) {
      return this.#mapAcp(obj, method);
    }

    const type = typeof obj.type === "string" ? obj.type : undefined;
    if (type !== undefined) {
      const events = this.#mapStreamJson(obj, type);
      if (events.length > 0) return events;
    }

    // Gemini style single-shot answer: {"response": "...", "stats": {...}}.
    if (typeof obj.response === "string") {
      const events: NormalizedEvent[] = [];
      if (obj.response !== "") {
        this.#sawText = true;
        events.push({ kind: "text", delta: obj.response });
      }
      const usage = mapUsage(obj.stats);
      events.push({ kind: "turn_end", status: "ok", ...(usage ? { usage } : {}) });
      this.#sawText = false;
      return events;
    }

    // Plain text chunk: {"text": "..."}.
    if (type === undefined && typeof obj.text === "string") {
      this.#sawText = true;
      return [{ kind: "text", delta: obj.text }];
    }

    return [];
  }

  // --------------------------------------------------------------------- ACP

  #mapAcp(obj: Record<string, unknown>, method: string | undefined): NormalizedEvent[] {
    if (obj.error !== undefined && obj.error !== null) {
      return [{ kind: "error", message: errorMessage(obj.error) }];
    }

    const result = obj.result;
    if (result !== undefined && result !== null && typeof result === "object") {
      const res = result as Record<string, unknown>;
      if (typeof res.sessionId === "string") {
        return [{ kind: "ready", providerSessionId: res.sessionId }];
      }
      if (typeof res.stopReason === "string") {
        const usage = mapUsage(res.usage);
        return [
          {
            kind: "turn_end",
            status: turnStatus(res.stopReason),
            ...(usage ? { usage } : {}),
          },
        ];
      }
      if (typeof res.protocolVersion === "number") {
        return [{ kind: "ready" }];
      }
      return [];
    }

    switch (method) {
      case "session/update":
        return this.#mapSessionUpdate(obj.params);
      case "session/request_permission":
        return this.#mapPermission(obj);
      default:
        return [];
    }
  }

  #mapSessionUpdate(params: unknown): NormalizedEvent[] {
    const p = isRecord(params) ? params : {};
    const update = isRecord(p.update) ? p.update : {};
    const sessionUpdate = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";

    switch (sessionUpdate) {
      case "agent_message_chunk": {
        const delta = chunkText(update.content);
        return delta === "" ? [] : [{ kind: "text", delta }];
      }
      case "tool_call": {
        const toolCallId =
          typeof update.toolCallId === "string" ? update.toolCallId : "";
        const name = toolName(update);
        if (toolCallId) this.#toolTitles.set(toolCallId, name);
        const summary = toolSummary(update);
        return [
          {
            kind: "tool",
            name,
            status: "start",
            ...(summary ? { summary } : {}),
          },
        ];
      }
      case "tool_call_update": {
        const toolCallId =
          typeof update.toolCallId === "string" ? update.toolCallId : "";
        const name =
          (typeof update.title === "string" && update.title) ||
          this.#toolTitles.get(toolCallId) ||
          "tool";
        const summary = toolSummary(update);
        return [
          {
            kind: "tool",
            name,
            status: toolStatus(update.status),
            ...(summary ? { summary } : {}),
          },
        ];
      }
      default:
        // agent_thought_chunk, plan, available_commands_update, ... stay raw.
        return [];
    }
  }

  #mapPermission(obj: Record<string, unknown>): NormalizedEvent[] {
    const params = isRecord(obj.params) ? obj.params : {};
    const rawId = obj.id;
    const id = rawId === undefined || rawId === null ? "" : String(rawId);
    const options: AcpPermissionOption[] = [];
    if (Array.isArray(params.options)) {
      for (const option of params.options) {
        if (!isRecord(option)) continue;
        const optionId =
          typeof option.optionId === "string" ? option.optionId : undefined;
        if (!optionId) continue;
        options.push({
          optionId,
          kind: typeof option.kind === "string" ? option.kind : "",
        });
      }
    }
    this.#permissions.set(id, { rawId, options });
    return [{ kind: "permission", id, request: params }];
  }

  // ------------------------------------------------------------- stream-json

  #mapStreamJson(obj: Record<string, unknown>, type: string): NormalizedEvent[] {
    switch (type) {
      case "system": {
        const sessionId =
          typeof obj.session_id === "string"
            ? obj.session_id
            : typeof obj.sessionId === "string"
              ? obj.sessionId
              : undefined;
        return sessionId ? [{ kind: "ready", providerSessionId: sessionId }] : [];
      }
      case "assistant": {
        const message = isRecord(obj.message) ? obj.message : {};
        const content = Array.isArray(message.content) ? message.content : [];
        const events: NormalizedEvent[] = [];
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === "text" && typeof block.text === "string") {
            this.#sawText = true;
            events.push({ kind: "text", delta: block.text });
          } else if (block.type === "tool_use") {
            const name =
              typeof block.name === "string" && block.name ? block.name : "tool";
            const summary = summarize(block.input);
            events.push({
              kind: "tool",
              name,
              status: "start",
              ...(summary ? { summary } : {}),
            });
          }
        }
        return events;
      }
      case "stream_event": {
        const event = isRecord(obj.event) ? obj.event : {};
        const delta = isRecord(event.delta) ? event.delta : {};
        if (typeof delta.text === "string") {
          this.#sawText = true;
          return [{ kind: "text", delta: delta.text }];
        }
        if (event.type === "content_block_start") {
          const block = isRecord(event.content_block) ? event.content_block : {};
          if (block.type === "tool_use") {
            const name =
              typeof block.name === "string" && block.name ? block.name : "tool";
            return [{ kind: "tool", name, status: "start" }];
          }
        }
        return [];
      }
      case "result": {
        const events: NormalizedEvent[] = [];
        const resultText = typeof obj.result === "string" ? obj.result : "";
        if (resultText !== "" && !this.#sawText) {
          this.#sawText = true;
          events.push({ kind: "text", delta: resultText });
        }
        const usage = mapUsage(obj.usage);
        events.push({
          kind: "turn_end",
          status: resultStatus(obj),
          ...(usage ? { usage } : {}),
        });
        this.#sawText = false;
        return events;
      }
      case "text": {
        const delta = typeof obj.text === "string" ? obj.text : "";
        if (delta === "") return [];
        this.#sawText = true;
        return [{ kind: "text", delta }];
      }
      case "error": {
        return [{ kind: "error", message: errorMessage(obj.error ?? obj) }];
      }
      default:
        return [];
    }
  }

  #allocateId(): number {
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    return id;
  }
}

/** Create an `agy` adapter; the protocol is detected unless pinned. */
export function createAgyAdapter(options: AgyAdapterOptions = {}): AgyAdapter {
  return new AgyAdapter(options);
}

// ------------------------------------------------------------------ helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

function chunkText(content: unknown): string {
  if (typeof content === "string") return content;
  if (isRecord(content) && typeof content.text === "string") return content.text;
  return "";
}

function toolName(update: Record<string, unknown>): string {
  if (typeof update.title === "string" && update.title !== "") return update.title;
  if (typeof update.kind === "string" && update.kind !== "") return update.kind;
  return "tool";
}

function toolSummary(update: Record<string, unknown>): string | undefined {
  if (update.rawInput !== undefined) return summarize(update.rawInput);
  if (Array.isArray(update.content)) {
    for (const block of update.content) {
      if (!isRecord(block)) continue;
      const content = isRecord(block.content) ? block.content : undefined;
      if (content && typeof content.text === "string" && content.text !== "") {
        return truncate(content.text);
      }
      if (typeof block.text === "string" && block.text !== "") {
        return truncate(block.text);
      }
    }
  }
  return undefined;
}

function toolStatus(status: unknown): "start" | "end" | "error" {
  switch (status) {
    case "completed":
      return "end";
    case "failed":
      return "error";
    case "cancelled":
      return "end";
    case "pending":
    case "in_progress":
      return "start";
    default:
      return "start";
  }
}

function turnStatus(stopReason: string): "ok" | "error" | "cancelled" {
  switch (stopReason) {
    case "end_turn":
    case "max_tokens":
      return "ok";
    case "cancelled":
      return "cancelled";
    case "max_turn_requests":
    case "refusal":
      return "error";
    default:
      return "ok";
  }
}

function resultStatus(obj: Record<string, unknown>): "ok" | "error" | "cancelled" {
  if (obj.is_error === true) return "error";
  const subtype = typeof obj.subtype === "string" ? obj.subtype.toLowerCase() : "";
  if (subtype.includes("cancel") || subtype.includes("interrupt")) {
    return "cancelled";
  }
  if (subtype.includes("error") || subtype.includes("fail")) return "error";
  return "ok";
}

function mapUsage(
  usage: unknown,
): { inputTokens?: number; outputTokens?: number } | undefined {
  if (!isRecord(usage)) return undefined;
  const input = firstNumber(usage.input_tokens, usage.inputTokens);
  const output = firstNumber(usage.output_tokens, usage.outputTokens);
  if (input === undefined && output === undefined) return undefined;
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
  };
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function summarize(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text) return undefined;
    return truncate(text);
  } catch {
    return undefined;
  }
}

function truncate(text: string): string {
  return text.length > TOOL_SUMMARY_LIMIT
    ? `${text.slice(0, TOOL_SUMMARY_LIMIT)}...`
    : text;
}

function pickPermissionOption(
  options: AcpPermissionOption[],
  allow: boolean,
): string | undefined {
  const preferred = allow
    ? ["allow_once", "allow_always"]
    : ["reject_once", "reject_always"];
  for (const kind of preferred) {
    const hit = options.find((option) => option.kind === kind);
    if (hit) return hit.optionId;
  }
  const prefix = allow ? "allow" : "reject";
  const loose = options.find((option) => option.kind.startsWith(prefix));
  return loose?.optionId;
}
