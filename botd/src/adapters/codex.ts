// Codex adapter for volto-botd.
//
// Protocol: `codex app-server` speaks a JSON-RPC 2.0 style dialect over stdio
// (one JSON object per line; the app-server's own JSONRPCRequest schema has no
// "jsonrpc" member). The lifecycle used here is:
//
//   client -> server   initialize, initialized, thread/start, thread/resume,
//                      turn/start, turn/interrupt
//   server -> client   thread/started, turn/started, item/*, turn/completed,
//                      thread/tokenUsage/updated, error, ... notifications
//   server -> client   item/commandExecution/requestApproval,
//                      item/fileChange/requestApproval,
//                      item/permissions/requestApproval (plus the legacy
//                      execCommandApproval / applyPatchApproval) requests
//
// Message shapes follow the protocol types shipped with the codex CLI
// (`codex app-server generate-ts` / `generate-json-schema`).
import type {
  BotAdapter,
  BotKind,
  ModelFamily,
  NormalizedEvent,
  OpenOptions,
  SpawnSpec,
} from "../adapter-types.ts";

/** Command that starts the Codex machine protocol. */
const CODEX_COMMAND = "codex";
/** Sub-command that exposes the JSON-RPC app-server on stdio. */
const APP_SERVER_SUBCOMMAND = "app-server";

/** Identity reported to the app-server during `initialize`. */
const CLIENT_INFO = {
  name: "volto-botd",
  title: "volto botd",
  version: "0.0.1",
};

/**
 * Server -> client request methods that ask the client for a decision.
 * These are answered through {@link CodexAdapter.answerPermission}.
 *
 * `item/tool/requestUserInput` is deliberately not listed: it is a question,
 * not an approval, and cannot be answered by the allow/deny policy this
 * adapter exposes. It is surfaced as a raw event instead.
 */
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
]);

type PermissionRequest = {
  /** True once the turn of the request was cancelled: it may no longer be allowed. */
  cancelled?: boolean;
  /** Id as sent on the wire (string or number). */
  wireId: string | number;
  /** Request method; decides the shape of the response. */
  method: string;
  /** Raw request params. */
  params: unknown;
};

type TokenUsage = { inputTokens?: number; outputTokens?: number };

type TurnEndStatus = "ok" | "error" | "cancelled";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Normalized tool name for a thread item, or undefined when the item is not a
 * tool call. Item types follow the app-server `ThreadItem` union.
 */
function toolName(item: Record<string, unknown>): string | undefined {
  switch (asString(item.type)) {
    case "commandExecution":
      return "shell";
    case "fileChange":
      return "apply_patch";
    case "webSearch":
      return "web_search";
    case "plan":
      return "update_plan";
    case "mcpToolCall": {
      const tool = asString(item.tool) ?? "";
      const server = asString(item.server) ?? "";
      if (server && tool) return `mcp:${server}/${tool}`;
      return tool || server || undefined;
    }
    case "dynamicToolCall": {
      const tool = asString(item.tool) ?? "";
      return tool ? `dynamic:${tool}` : undefined;
    }
    default:
      return undefined;
  }
}

/** Short human readable summary of a tool item. */
function toolSummary(item: Record<string, unknown>, phase: "start" | "end"): string | undefined {
  switch (asString(item.type)) {
    case "commandExecution": {
      if (phase === "start") return asString(item.command);
      const exitCode = asNumber(item.exitCode);
      if (exitCode !== undefined) return `exit ${exitCode}`;
      return asString(item.command);
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes
        .map((change) => asString(asRecord(change)?.path))
        .filter((path): path is string => typeof path === "string");
      return paths.length > 0 ? paths.join(", ") : undefined;
    }
    case "webSearch":
      return asString(item.query);
    case "mcpToolCall":
      return asString(asRecord(item.error)?.message);
    default:
      return undefined;
  }
}

/** Terminal status of a tool item, mapped onto the normalized tool statuses. */
function toolStatus(item: Record<string, unknown>): "end" | "error" {
  const status = asString(item.status);
  return status === "failed" || status === "declined" ? "error" : "end";
}

export class CodexAdapter implements BotAdapter {
  readonly kind: BotKind = "codex";
  readonly family: ModelFamily = "gpt";

  /** Next id used for client -> server requests. */
  #nextRequestId = 1;
  /** Thread id of the most recent session, used as a fallback. */
  #lastSessionId: string | undefined;
  /** Thread id already announced through a "ready" event. */
  #announcedSessionId: string | undefined;
  /** Turn id per thread, used to interrupt a running turn. */
  #turnByThread = new Map<string, string>();
  /** Item ids whose assistant text was already streamed as deltas. */
  #streamedItems = new Set<string>();
  /** Pending approval requests, keyed by the id handed out with the event. */
  #pendingApprovals = new Map<string, PermissionRequest>();
  /** Token usage per turn, as reported by thread/tokenUsage/updated. */
  #usageByTurn = new Map<string, TokenUsage>();

  #allocateRequestId(): number {
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    return id;
  }

  /**
   * Command that starts Codex in its machine protocol. No shell and no secrets
   * in argv: model, effort and instructions travel as protocol messages.
   */
  spawn(opts: OpenOptions): SpawnSpec {
    return {
      command: [CODEX_COMMAND, APP_SERVER_SUBCOMMAND],
      env: {},
      cwd: opts.cwd,
    };
  }

  /**
   * Messages to write to stdin once the process is up: initialize the
   * app-server, acknowledge the handshake, then open (or resume) a thread.
   */
  handshake(opts: OpenOptions): unknown[] {
    const initialize = {
      id: this.#allocateRequestId(),
      method: "initialize",
      params: {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: true },
      },
    };
    const initialized = { method: "initialized" };
    const session = opts.resumeProviderSessionId
      ? this.#resumeRequest(opts)
      : this.#startRequest(opts);
    return [initialize, initialized, session];
  }

  #startRequest(opts: OpenOptions): unknown {
    const params: Record<string, unknown> = {
      cwd: opts.cwd,
      // Approvals are routed back to the caller, which decides the policy.
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    };
    if (opts.model) params.model = opts.model;
    if (opts.effort) params.config = { model_reasoning_effort: opts.effort };
    // developerInstructions extends the base prompt instead of replacing it,
    // which keeps the codex tool instructions intact.
    if (opts.systemPrompt) params.developerInstructions = opts.systemPrompt;
    return { id: this.#allocateRequestId(), method: "thread/start", params };
  }

  #resumeRequest(opts: OpenOptions): unknown {
    const params: Record<string, unknown> = {
      threadId: opts.resumeProviderSessionId,
      cwd: opts.cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    };
    if (opts.model) params.model = opts.model;
    if (opts.effort) params.config = { model_reasoning_effort: opts.effort };
    if (opts.systemPrompt) params.developerInstructions = opts.systemPrompt;
    return { id: this.#allocateRequestId(), method: "thread/resume", params };
  }

  /** Wrap a user prompt into a `turn/start` request. */
  prompt(text: string, ctx: { providerSessionId?: string }): unknown {
    const threadId = ctx.providerSessionId ?? this.#lastSessionId ?? "";
    return {
      id: this.#allocateRequestId(),
      method: "turn/start",
      params: {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
      },
    };
  }

  /**
   * Provider-native cancel: interrupt the running turn. Codex requires both
   * the thread id and the turn id, so nothing is sent when no turn is known.
   */
  cancel(ctx: { providerSessionId?: string }): unknown[] {
    // A cancelled turn may no longer allow a pending approval: it stays
    // known, but from now on it can only be declined.
    for (const request of this.#pendingApprovals.values()) request.cancelled = true;
    const threadId = ctx.providerSessionId ?? this.#lastSessionId;
    const turnId = threadId ? this.#turnByThread.get(threadId) : undefined;
    if (!threadId || !turnId) return [];
    return [
      {
        id: this.#allocateRequestId(),
        method: "turn/interrupt",
        params: { threadId, turnId },
      },
    ];
  }

  /**
   * Answer a pending approval request with the provider-native response.
   * Returns null when the id is unknown or cannot be answered by a boolean.
   */
  answerPermission(id: string, allow: boolean): unknown | null {
    const pending = this.#pendingApprovals.get(id);
    if (!pending) return null;
    this.#pendingApprovals.delete(id);
    // A late allow of a cancelled turn is never honored; a late deny still is.
    if (pending.cancelled && allow) return null;

    switch (pending.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return {
          id: pending.wireId,
          result: { decision: allow ? "accept" : "decline" },
        };
      case "item/permissions/requestApproval": {
        const requested = asRecord(asRecord(pending.params)?.permissions);
        const granted = allow
          ? {
              network: requested?.network ?? undefined,
              fileSystem: requested?.fileSystem ?? undefined,
            }
          : {};
        return {
          id: pending.wireId,
          result: { permissions: granted, scope: "turn" },
        };
      }
      case "execCommandApproval":
      case "applyPatchApproval":
        return {
          id: pending.wireId,
          result: {
            decision: allow ? "approved" : { denied: { rejection: "denied by policy" } },
          },
        };
      default:
        return null;
    }
  }

  /** Map one stdout line to normalized events. Never throws. */
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

      const message = asRecord(payload);
      if (!message) return [{ kind: "raw", payload }];

      const method = asString(message.method);
      if (method !== undefined) {
        // Server -> client request (carries an id) or notification.
        if (message.id !== undefined && message.id !== null) {
          return this.#parseServerRequest(message, method);
        }
        return this.#parseNotification(message, method);
      }
      if ("error" in message) return this.#parseErrorResponse(message);
      if ("result" in message) return this.#parseResultResponse(message);
      return [{ kind: "raw", payload }];
    } catch {
      return [{ kind: "raw", payload: line }];
    }
  }

  #parseServerRequest(
    message: Record<string, unknown>,
    method: string,
  ): NormalizedEvent[] {
    if (!APPROVAL_METHODS.has(method)) return [{ kind: "raw", payload: message }];
    const wireId = message.id as string | number;
    const id = String(wireId);
    this.#pendingApprovals.set(id, { wireId, method, params: message.params });
    return [
      {
        kind: "permission",
        id,
        request: { method, params: message.params ?? null },
      },
    ];
  }

  #parseNotification(message: Record<string, unknown>, method: string): NormalizedEvent[] {
    const params = asRecord(message.params);

    switch (method) {
      case "thread/started": {
        const threadId = asString(asRecord(params?.thread)?.id);
        if (!threadId) return [{ kind: "raw", payload: message }];
        this.#lastSessionId = threadId;
        return this.#ready(threadId, message);
      }
      case "turn/started": {
        const threadId = asString(params?.threadId);
        const turnId = asString(asRecord(params?.turn)?.id);
        if (threadId && turnId) this.#turnByThread.set(threadId, turnId);
        return [{ kind: "raw", payload: message }];
      }
      case "turn/completed":
        return this.#parseTurnCompleted(message, params);
      case "item/started":
        return this.#parseItem(message, params, "start");
      case "item/completed":
        return this.#parseItem(message, params, "end");
      case "item/agentMessage/delta": {
        const delta = asString(params?.delta);
        const itemId = asString(params?.itemId);
        if (delta === undefined) return [{ kind: "raw", payload: message }];
        if (itemId) this.#streamedItems.add(itemId);
        return [{ kind: "text", delta }];
      }
      case "thread/tokenUsage/updated": {
        const turnId = asString(params?.turnId);
        const last = asRecord(asRecord(params?.tokenUsage)?.last);
        if (turnId && last) {
          const usage: TokenUsage = {};
          const inputTokens = asNumber(last.inputTokens);
          const outputTokens = asNumber(last.outputTokens);
          if (inputTokens !== undefined) usage.inputTokens = inputTokens;
          if (outputTokens !== undefined) usage.outputTokens = outputTokens;
          this.#usageByTurn.set(turnId, usage);
        }
        return [{ kind: "raw", payload: message }];
      }
      case "error": {
        const text = asString(asRecord(params?.error)?.message) ?? "codex error";
        return [{ kind: "error", message: text }];
      }
      default:
        // Everything else (status changes, warnings, reasoning deltas, ...) is
        // passed through untouched.
        return [{ kind: "raw", payload: message }];
    }
  }

  #ready(threadId: string, message: Record<string, unknown>): NormalizedEvent[] {
    if (this.#announcedSessionId === threadId) {
      return [{ kind: "raw", payload: message }];
    }
    this.#announcedSessionId = threadId;
    return [{ kind: "ready", providerSessionId: threadId }];
  }

  #parseItem(
    message: Record<string, unknown>,
    params: Record<string, unknown> | undefined,
    phase: "start" | "end",
  ): NormalizedEvent[] {
    const item = asRecord(params?.item);
    if (!item) return [{ kind: "raw", payload: message }];

    const name = toolName(item);
    if (name) {
      const summary = toolSummary(item, phase);
      if (phase === "start") {
        return summary === undefined
          ? [{ kind: "tool", name, status: "start" }]
          : [{ kind: "tool", name, status: "start", summary }];
      }
      const status = toolStatus(item);
      return summary === undefined
        ? [{ kind: "tool", name, status }]
        : [{ kind: "tool", name, status, summary }];
    }

    // Assistant messages arrive as text deltas; only fall back to the final
    // item text when no delta was streamed for that item.
    if (asString(item.type) === "agentMessage") {
      const itemId = asString(item.id);
      const text = asString(item.text);
      if (itemId && this.#streamedItems.has(itemId)) {
        return [{ kind: "raw", payload: message }];
      }
      if (text !== undefined) {
        if (itemId) this.#streamedItems.add(itemId);
        return [{ kind: "text", delta: text }];
      }
    }

    return [{ kind: "raw", payload: message }];
  }

  #parseTurnCompleted(
    message: Record<string, unknown>,
    params: Record<string, unknown> | undefined,
  ): NormalizedEvent[] {
    const turn = asRecord(params?.turn);
    const turnId = asString(turn?.id);
    const rawStatus = asString(turn?.status);
    const events: NormalizedEvent[] = [];

    const errorMessage = asString(asRecord(turn?.error)?.message);
    if (rawStatus === "failed" && errorMessage) {
      events.push({ kind: "error", message: errorMessage });
    }

    const status: TurnEndStatus =
      rawStatus === "completed"
        ? "ok"
        : rawStatus === "interrupted"
          ? "cancelled"
          : "error";
    const usage = turnId ? this.#usageByTurn.get(turnId) : undefined;
    if (turnId) this.#usageByTurn.delete(turnId);
    events.push({ kind: "turn_end", status, usage });
    return events;
  }

  #parseErrorResponse(message: Record<string, unknown>): NormalizedEvent[] {
    const error = asRecord(message.error);
    return [
      {
        kind: "error",
        message: asString(error?.message) ?? "codex request failed",
      },
    ];
  }

  #parseResultResponse(message: Record<string, unknown>): NormalizedEvent[] {
    const result = asRecord(message.result);
    const threadId = asString(asRecord(result?.thread)?.id);
    if (threadId) {
      this.#lastSessionId = threadId;
      return this.#ready(threadId, message);
    }
    const turn = asRecord(result?.turn);
    const turnId = asString(turn?.id);
    const threadIdFromTurn = asString(result?.threadId);
    if (turnId && threadIdFromTurn) this.#turnByThread.set(threadIdFromTurn, turnId);
    return [{ kind: "raw", payload: message }];
  }
}

/** Shared adapter instance. */
export const codexAdapter = new CodexAdapter();

export default codexAdapter;
