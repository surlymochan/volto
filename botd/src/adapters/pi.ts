// botd/src/adapters/pi.ts
//
// pi adapter: the `pi` CLI in its RPC mode.
//
// ---------------------------------------------------------------------------
// PROTOCOL
// ---------------------------------------------------------------------------
// `pi --mode rpc` talks newline delimited JSON over stdio: one JSON object per
// line, no framing header.  Every line carries a `type` discriminator.
//
// Client -> server (commands).  A command carries a client chosen `id` and the
// CLI answers with a `response` line that echoes the id:
//
//   {"id":"pi-1","type":"new_session"}                     start a session
//   {"id":"pi-2","type":"get_state"}                       report the state
//   {"id":"pi-3","type":"switch_session","sessionPath":"…"}  load a stored session
//   {"id":"pi-4","type":"prompt","message":"…"}             run a prompt
//   {"id":"pi-5","type":"abort"}                            stop the running prompt
//
// Server -> client (events):
//
//   {"type":"response","id":"pi-2","success":true,"data":{…}}
//   {"type":"response","id":"pi-4","success":false,"error":"…"}
//   {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"…"}}
//   {"type":"message_end","message":{…}}
//   {"type":"tool_execution_start","toolCallId":"…","toolName":"…","args":{…}}
//   {"type":"tool_execution_end","toolCallId":"…","isError":false,"result":{…}}
//   {"type":"agent_end","messages":[{"role":"assistant","stopReason":"stop"}]}
//   {"type":"extension_ui_request","id":"…","method":"confirm","title":"…"}
//
// The command names, the event names and the `response` envelope come from
// probes/bots/pi.mjs and probes/REPORT.md in this repository; nothing here was
// captured from a live `pi` process.
//
// ---------------------------------------------------------------------------
// ASSUMPTIONS (the repo does not document them)
// ---------------------------------------------------------------------------
// * The exact member names of `message_end`, `tool_execution_start` and
//   `tool_execution_end` are not documented in this repository, so the
//   adapter accepts the plausible spellings (`toolName`/`name`,
//   `toolCallId`/`id`, `args`/`input`, `result`/`output`, `isError`) and keeps
//   a line it cannot interpret as a `raw` event instead of dropping it.
// * The provider session id that the adapter announces is the *session file*
//   when pi reports one, because `switch_session` takes a path and that is the
//   only value a later `resumeProviderSessionId` can be used with.  The plain
//   session id stays available through {@link PiAdapter.sessionId}.
// * `--model` is passed to the CLI when the caller asks for a model.  The
//   repository does not document the flag, so it is the one assumption in
//   `spawn()`; `effort` and `systemPrompt` have no counterpart in the pi RPC
//   surface known here and are ignored.

import type {
  BotAdapter,
  BotKind,
  ModelFamily,
  NormalizedEvent,
  OpenOptions,
  SpawnSpec,
} from "../adapter-types.ts";

/** Binary name; the daemon resolves it on PATH. */
const PI_BIN = "pi";

/** argv that starts pi in its RPC mode (no shell, no secrets). */
export const PI_COMMAND: readonly string[] = [PI_BIN, "--mode", "rpc"];

/** Longest tool summary kept in a normalized `tool` event. */
const MAX_SUMMARY = 240;

/** Upper bound for the remembered extension UI requests. */
const MAX_PENDING_UI_REQUESTS = 64;

export interface PiAdapterOptions {
  /** Environment inherited by the spawned child (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
  /** Override the binary name (tests, wrappers). */
  binary?: string;
}

/** A remembered extension UI request, answered through `answerPermission`. */
interface UiRequest {
  method: string;
  /** Options of a `select` request, in the order pi offered them. */
  options: unknown[];
  /** True when the run of the request was cancelled: it may not be granted. */
  cancelled: boolean;
}

export class PiAdapter implements BotAdapter {
  readonly kind: BotKind = "pi";
  /** pi talks to several providers; there is no single model family. */
  readonly family: ModelFamily = "other";

  /** id used for the next command sent to pi. */
  #nextId = 1;
  /** command id -> command type, so that a reply can be classified. */
  #pendingCommands = new Map<string, string>();
  /** pi session id, as reported by `get_state`. */
  #sessionId: string | undefined;
  /** path of the session file, used to resume a session. */
  #sessionFile: string | undefined;
  /** provider session id that was already announced with a `ready` event. */
  #announcedSessionId: string | undefined;
  /** tool call id -> tool name, so a closing event can name its tool. */
  #toolNames = new Map<string, string>();
  /** text of the current assistant message that was already emitted. */
  #emittedText = "";
  /** usage reported by the last message or agent. */
  #usage: { inputTokens?: number; outputTokens?: number } | undefined;
  /** pending extension UI requests, keyed by their id. */
  #uiRequests = new Map<string, UiRequest>();
  #env: Record<string, string | undefined>;
  #binary: string;

  constructor(options: PiAdapterOptions = {}) {
    this.#env = options.env ?? defaultEnv();
    this.#binary = options.binary ?? PI_BIN;
  }

  /** pi session id (without the file path). */
  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /** Path of the session file pi persists the conversation in. */
  get sessionFile(): string | undefined {
    return this.#sessionFile;
  }

  // ---------------------------------------------------------------- spawning

  spawn(opts: OpenOptions): SpawnSpec {
    const command = [this.#binary, "--mode", "rpc"];
    if (opts.model) command.push("--model", opts.model);
    return {
      command,
      env: inheritedEnv(this.#env),
      cwd: opts.cwd,
    };
  }

  // ---------------------------------------------------------------- messages

  /**
   * Open (or resume) the session and ask for the state, so that the adapter
   * learns the session id and the session file.
   */
  handshake(opts: OpenOptions): unknown[] {
    const messages: unknown[] = [];
    if (opts.resumeProviderSessionId) {
      // pi resumes a stored session by its file path.
      messages.push(
        this.#command("switch_session", {
          sessionPath: opts.resumeProviderSessionId,
        }),
      );
    } else {
      messages.push(this.#command("new_session"));
    }
    // `get_state` reports the session id, the session file and the model.
    messages.push(this.#command("get_state"));
    return messages;
  }

  /**
   * Wrap a user prompt into a `prompt` command.  pi runs in the session that
   * is currently active, so the command carries no session id.
   */
  prompt(text: string, _ctx: { providerSessionId?: string }): unknown {
    return this.#command("prompt", { message: text });
  }

  /**
   * Provider-native cancel: `abort` stops the running prompt.  The run then
   * ends with the stop reason `aborted` (see probes/REPORT.md).
   *
   * The pending extension UI requests of the run belong to a turn the user
   * gave up, so they are marked: a late answer of the control plane must not
   * allow them any more.
   */
  cancel(_ctx: { providerSessionId?: string }): unknown[] {
    for (const request of this.#uiRequests.values()) {
      request.cancelled = true;
    }
    return [this.#command("abort")];
  }

  /**
   * Answer an extension UI request.  Only `confirm` and `select` are
   * approvals; the free form `input`/`editor` requests and the `notify`
   * messages are not answerable by a boolean policy.
   *
   * The request of a cancelled run is never granted: a late allow answers
   * nothing, a late deny denies the request as usual.
   */
  answerPermission(id: string, allow: boolean): unknown | null {
    const request = this.#uiRequests.get(id);
    if (!request) return null;
    this.#uiRequests.delete(id);

    if (request.cancelled) {
      // The run of the request was cancelled: it must not be granted.
      return allow ? null : denyRequest(id, request);
    }

    if (request.method === "confirm") {
      return { type: "extension_ui_response", id, confirmed: allow };
    }
    if (request.method === "select") {
      if (!allow) return denyRequest(id, request);
      const value = firstOptionValue(request.options);
      if (value === undefined) return null;
      return { type: "extension_ui_response", id, value };
    }
    return null;
  }

  // ------------------------------------------------------------------ parsing

  /** Map one stdout line to normalized events. Never throws. */
  parse(line: string): NormalizedEvent[] {
    try {
      const trimmed = typeof line === "string" ? line.trim() : "";
      if (trimmed === "") return [];

      let payload: unknown;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        return [{ kind: "raw", payload: line }];
      }

      const record = asRecord(payload);
      if (!record) return [{ kind: "raw", payload }];

      const events = this.#mapRecord(record);
      return events.length > 0 ? events : [{ kind: "raw", payload: record }];
    } catch {
      // The contract forbids throwing: anything unexpected becomes raw.
      return [{ kind: "raw", payload: line }];
    }
  }

  #mapRecord(record: Record<string, unknown>): NormalizedEvent[] {
    switch (str(record.type)) {
      case "response":
        return this.#mapResponse(record);
      case "message_update":
        return this.#mapMessageUpdate(record);
      case "message_end":
        return this.#mapMessageEnd(record);
      case "tool_execution_start":
        return this.#mapToolStart(record);
      case "tool_execution_end":
        return this.#mapToolEnd(record);
      case "agent_end":
        return this.#mapAgentEnd(record);
      case "extension_ui_request":
        return this.#mapUiRequest(record);
      default:
        // Unknown event: hand it through untouched.
        return [];
    }
  }

  /** The reply to one of our commands. */
  #mapResponse(record: Record<string, unknown>): NormalizedEvent[] {
    const key = record.id === undefined || record.id === null ? "" : String(record.id);
    const command = this.#pendingCommands.get(key);
    this.#pendingCommands.delete(key);

    if (record.success === false) {
      const reason = errorText(record.error);
      return [
        {
          kind: "error",
          message: reason ?? `pi command failed: ${command ?? "unknown"}`,
        },
      ];
    }

    const data = asRecord(record.data) ?? {};
    const session = asRecord(data.session) ?? {};
    const sessionId = str(data.sessionId) ?? str(session.id);
    const sessionFile = str(data.sessionFile) ?? str(session.file);
    if (sessionId) this.#sessionId = sessionId;
    if (sessionFile) this.#sessionFile = sessionFile;
    if (sessionId || sessionFile) return this.#ready(record);
    return [{ kind: "raw", payload: record }];
  }

  /** The session is known: announce it once. */
  #ready(record: Record<string, unknown>): NormalizedEvent[] {
    const providerSessionId = this.#sessionFile ?? this.#sessionId;
    if (!providerSessionId) return [{ kind: "raw", payload: record }];
    if (this.#announcedSessionId === providerSessionId) {
      return [{ kind: "raw", payload: record }];
    }
    this.#announcedSessionId = providerSessionId;
    return [{ kind: "ready", providerSessionId }];
  }

  /** Streamed assistant output. */
  #mapMessageUpdate(record: Record<string, unknown>): NormalizedEvent[] {
    const event =
      asRecord(record.assistantMessageEvent) ??
      asRecord(record.messageEvent) ??
      asRecord(record.event);

    if (event) {
      const type = str(event.type);
      if (type === "text_delta" || type === "text") {
        const delta = str(event.delta) ?? str(event.text) ?? str(event.content);
        if (delta === undefined || delta === "") {
          return [{ kind: "raw", payload: record }];
        }
        this.#emittedText += delta;
        return [{ kind: "text", delta }];
      }
      // Thinking deltas, tool announcements, ... have no normalized
      // counterpart: keep them raw instead of mixing them into the answer.
      return [{ kind: "raw", payload: record }];
    }

    const delta = str(record.delta);
    if (delta !== undefined && delta !== "") {
      this.#emittedText += delta;
      return [{ kind: "text", delta }];
    }
    return [{ kind: "raw", payload: record }];
  }

  /** The assistant message is complete. */
  #mapMessageEnd(record: Record<string, unknown>): NormalizedEvent[] {
    const message = asRecord(record.message) ?? record;
    const usage = usageOf(message) ?? usageOf(record);
    if (usage) this.#usage = usage;

    const events: NormalizedEvent[] = [];
    const text = extractText(message);
    // Only fall back to the final text when nothing was streamed for it.
    if (text && this.#emittedText === "") {
      events.push({ kind: "text", delta: text });
      this.#emittedText = text;
    }
    if (events.length > 0) return events;
    return [{ kind: "raw", payload: record }];
  }

  /** A tool call starts. */
  #mapToolStart(record: Record<string, unknown>): NormalizedEvent[] {
    const callId = toolCallId(record);
    const name =
      toolName(record) ?? (callId ? this.#toolNames.get(callId) : undefined) ?? "tool";
    if (callId) this.#toolNames.set(callId, name);

    const summary = summarize(record.args ?? record.input ?? record.parameters);
    return summary === undefined
      ? [{ kind: "tool", name, status: "start" }]
      : [{ kind: "tool", name, status: "start", summary }];
  }

  /** A tool call is done. */
  #mapToolEnd(record: Record<string, unknown>): NormalizedEvent[] {
    const callId = toolCallId(record);
    const name =
      toolName(record) ?? (callId ? this.#toolNames.get(callId) : undefined) ?? "tool";
    if (callId) this.#toolNames.delete(callId);

    const failed =
      record.isError === true ||
      record.is_error === true ||
      record.success === false ||
      (record.error !== undefined && record.error !== null);
    const status = failed ? "error" : "end";

    const summary = summarize(
      record.result ?? record.output ?? record.error ?? record.response,
    );
    return summary === undefined
      ? [{ kind: "tool", name, status }]
      : [{ kind: "tool", name, status, summary }];
  }

  /** The agent finished the turn. */
  #mapAgentEnd(record: Record<string, unknown>): NormalizedEvent[] {
    const messages = Array.isArray(record.messages) ? record.messages : [];
    const last = lastAssistantMessage(messages) ?? asRecord(record.message);
    const stopReason = str(last?.stopReason) ?? str(record.stopReason) ?? str(record.reason);
    const status = turnStatus(stopReason);

    const usage = usageOf(record) ?? usageOf(last) ?? this.#usage;
    this.#usage = undefined;

    const events: NormalizedEvent[] = [];
    const text = extractText(last);
    // The assistant text was usually streamed as deltas already; only emit
    // the final text when nothing was seen for this message.
    if (text && this.#emittedText === "") {
      events.push({ kind: "text", delta: text });
      this.#emittedText = text;
    }
    this.#emittedText = "";

    events.push(usage ? { kind: "turn_end", status, usage } : { kind: "turn_end", status });
    return events;
  }

  /** The agent asks the client something (`confirm` / `select`). */
  #mapUiRequest(record: Record<string, unknown>): NormalizedEvent[] {
    const id = str(record.id);
    const method = str(record.method) ?? "";
    if (!id || (method !== "confirm" && method !== "select")) {
      // `input`, `editor` and `notify` are not approval requests.
      return [{ kind: "raw", payload: record }];
    }

    this.#uiRequests.set(id, { method, options: optionValues(record), cancelled: false });
    // Keep the cache bounded for long running daemons.
    while (this.#uiRequests.size > MAX_PENDING_UI_REQUESTS) {
      const oldest = this.#uiRequests.keys().next();
      if (oldest.done) break;
      this.#uiRequests.delete(oldest.value);
    }

    return [{ kind: "permission", id, request: record }];
  }

  // ----------------------------------------------------------------- helpers

  /** Build a command line object and remember it until its reply arrives. */
  #command(type: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
    const id = `pi-${this.#nextId}`;
    this.#nextId += 1;
    this.#pendingCommands.set(id, type);
    return { id, type, ...fields };
  }
}

/** Shared adapter instance. */
export const piAdapter = new PiAdapter();

export default piAdapter;

// ------------------------------------------------------------------- helpers

/** The environment of the current process (empty when unavailable). */
export function defaultEnv(): Record<string, string | undefined> {
  const proc = (
    globalThis as unknown as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process;
  return proc?.env ?? {};
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The message text of an assistant message (string or content blocks). */
function extractText(message: unknown): string {
  const record = asRecord(message);
  if (!record) return "";
  const content = record.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        const entry = asRecord(block);
        if (!entry) return "";
        return typeof entry.text === "string" ? entry.text : "";
      })
      .filter((part) => part.length > 0)
      .join("");
  }
  if (typeof record.text === "string") return record.text;
  return "";
}

/** Token usage of a message or agent, in the normalized shape. */
function usageOf(
  source: unknown,
): { inputTokens?: number; outputTokens?: number } | undefined {
  const record = asRecord(source);
  if (!record) return undefined;
  const usage =
    asRecord(record.usage) ?? asRecord(record.tokenUsage) ?? asRecord(record.tokens);
  if (!usage) return undefined;

  const inputTokens =
    num(usage.inputTokens) ??
    num(usage.input_tokens) ??
    num(usage.input) ??
    num(usage.promptTokens) ??
    num(usage.prompt_tokens);
  const outputTokens =
    num(usage.outputTokens) ??
    num(usage.output_tokens) ??
    num(usage.output) ??
    num(usage.completionTokens) ??
    num(usage.completion_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;

  const out: { inputTokens?: number; outputTokens?: number } = {};
  if (inputTokens !== undefined) out.inputTokens = inputTokens;
  if (outputTokens !== undefined) out.outputTokens = outputTokens;
  return out;
}

/** The stop reason of a finished run, mapped onto the normalized statuses. */
function turnStatus(stopReason: string | undefined): "ok" | "error" | "cancelled" {
  switch ((stopReason ?? "").toLowerCase()) {
    case "aborted":
    case "abort":
    case "cancelled":
    case "canceled":
    case "interrupted":
    case "interrupt":
      return "cancelled";
    case "error":
    case "failed":
    case "failure":
      return "error";
    default:
      return "ok";
  }
}

/** The name of the tool of a tool event. */
function toolName(record: Record<string, unknown>): string | undefined {
  for (const candidate of [record.toolName, record.tool_name, record.name, record.tool]) {
    const value = str(candidate);
    if (value) return value;
  }
  return undefined;
}

/** The id of the tool call of a tool event. */
function toolCallId(record: Record<string, unknown>): string | undefined {
  for (const candidate of [
    record.toolCallId,
    record.tool_call_id,
    record.callId,
    record.call_id,
    record.id,
  ]) {
    const value = str(candidate);
    if (value) return value;
  }
  return undefined;
}

/** The options of a `select` request, as plain values. */
function optionValues(record: Record<string, unknown>): unknown[] {
  const options = record.options ?? record.choices;
  if (!Array.isArray(options)) return [];
  const values: unknown[] = [];
  for (const option of options) {
    if (typeof option === "string" || typeof option === "number") {
      values.push(option);
      continue;
    }
    const entry = asRecord(option);
    if (!entry) continue;
    const value = entry.value ?? entry.id ?? entry.label ?? entry.title;
    if (value !== undefined) values.push(value);
  }
  return values;
}

/** The answer that denies an extension UI request. */
function denyRequest(id: string, request: UiRequest): Record<string, unknown> {
  if (request.method === "select") {
    return { type: "extension_ui_response", id, cancelled: true };
  }
  return { type: "extension_ui_response", id, confirmed: false };
}

/** The value of the first offered option. */
function firstOptionValue(options: unknown[]): string | undefined {
  for (const option of options) {
    if (typeof option === "string") return option;
    if (typeof option === "number") return String(option);
  }
  return undefined;
}

/** A short, human readable description of a tool input or result. */
function summarize(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    return value.length > 0 ? truncate(value) : undefined;
  }
  try {
    const text = JSON.stringify(value);
    if (!text) return undefined;
    return truncate(text);
  } catch {
    return undefined;
  }
}

function truncate(text: string): string {
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY)}...` : text;
}

/** The message of an error field (string or `{ message }`). */
function errorText(error: unknown): string | undefined {
  if (typeof error === "string" && error !== "") return error;
  const record = asRecord(error);
  const message = str(record?.message);
  if (message) return message;
  if (error === undefined || error === null) return undefined;
  try {
    const text = JSON.stringify(error);
    return text && text !== "{}" ? text : undefined;
  } catch {
    return undefined;
  }
}

/** The last assistant message of a message list. */
function lastAssistantMessage(messages: unknown[]): Record<string, unknown> | undefined {
  let fallback: Record<string, unknown> | undefined;
  for (const message of messages) {
    const record = asRecord(message);
    if (!record) continue;
    fallback = record;
    if (str(record.role) === "assistant") return record;
  }
  return fallback;
}
