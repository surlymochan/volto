// botd adapter: Claude Code (the `claude` CLI, headless "stream-json" protocol).
//
// Spawn:  claude -p --input-format stream-json --output-format stream-json --verbose
//
// The CLI speaks NDJSON on stdin/stdout. Output lines carry a "type" discriminator:
//   system         -> {"type":"system","subtype":"init",...}        (session bootstrap)
//   assistant      -> {"type":"assistant","message":{...}}          (text / tool_use blocks)
//   user           -> {"type":"user","message":{...}}               (tool_result blocks)
//   result         -> {"type":"result","subtype":"success",...}     (end of turn + usage)
//   control_request-> {"type":"control_request","request_id":...}   (permission prompts)
//   control_response -> our own replies to control requests
//
// Input (stdin) accepts:
//   {"type":"user","message":{"role":"user","content":"..."}}        (a prompt)
//   {"type":"control_request","request_id":...,"request":{"subtype":"interrupt"}}   (cancel)
//   {"type":"control_response","response":{...}}                     (permission answer)
import type {
  BotAdapter,
  BotKind,
  ModelFamily,
  NormalizedEvent,
  OpenOptions,
  SpawnSpec,
} from "../adapter-types.ts";
import { randomUUID } from "node:crypto";

/** Binary name; the daemon resolves it on PATH. */
const CLAUDE_BIN = "claude";

/** Provider-native argv for the headless stream-json protocol. */
const BASE_COMMAND: readonly string[] = [
  CLAUDE_BIN,
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
];

const MAX_SUMMARY = 240;
/** Upper bound for remembered permission prompts (oldest are evicted first). */
const MAX_PENDING_PERMISSIONS = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Flatten a tool_result / text payload into a short human-readable string. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (isRecord(block) && typeof block.text === "string") return block.text;
        return "";
      })
      .filter((part) => part.length > 0)
      .join("");
  }
  if (content === undefined || content === null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function summarize(text: string): string {
  if (text.length <= MAX_SUMMARY) return text;
  return `${text.slice(0, MAX_SUMMARY)}…`;
}

/** Best-effort one-line description of a tool input object. */
function summarizeInput(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "string") return summarize(input);
  try {
    return summarize(JSON.stringify(input));
  } catch {
    return undefined;
  }
}

export class ClaudeAdapter implements BotAdapter {
  readonly kind: BotKind = "claude";
  readonly family: ModelFamily = "claude";

  /** tool_use id -> tool name, so a later tool_result can name the tool it closes. */
  private toolNames = new Map<string, string>();
  /** control request id -> request payload, so a permission answer can echo the input. */
  private pendingPermissions = new Map<string, Record<string, unknown>>();

  spawn(opts: OpenOptions): SpawnSpec {
    const command = [...BASE_COMMAND];
    if (opts.model) command.push("--model", opts.model);
    if (opts.resumeProviderSessionId) command.push("--resume", opts.resumeProviderSessionId);
    if (opts.systemPrompt) command.push("--append-system-prompt", opts.systemPrompt);
    return { command, env: {}, cwd: opts.cwd };
  }

  /** The CLI needs no init message: the first stdin message opens the session. */
  handshake(_opts: OpenOptions): unknown[] {
    return [];
  }

  /** Wrap a prompt as a provider-native user message. */
  prompt(text: string, ctx: { providerSessionId?: string }): unknown {
    const message: Record<string, unknown> = {
      type: "user",
      message: { role: "user", content: text },
    };
    if (ctx?.providerSessionId) message.session_id = ctx.providerSessionId;
    return message;
  }

  /** Cancel = provider-native "interrupt" control request on stdin. */
  cancel(_ctx: { providerSessionId?: string }): unknown[] {
    return [
      {
        type: "control_request",
        request_id: randomUUID(),
        request: { subtype: "interrupt" },
      },
    ];
  }

  /** Answer a permission prompt with a provider-native control response. */
  answerPermission(id: string, allow: boolean): unknown | null {
    const request = this.pendingPermissions.get(id);
    const input = request ? request.input : undefined;
    const response = allow
      ? { behavior: "allow", updatedInput: isRecord(input) ? input : {} }
      : { behavior: "deny", message: "Permission denied by user" };
    return {
      type: "control_response",
      response: { subtype: "success", request_id: id, response },
    };
  }

  /** Map one stdout NDJSON line to normalized events. Never throws. */
  parse(line: string): NormalizedEvent[] {
    let text: string;
    try {
      text = typeof line === "string" ? line : String(line ?? "");
    } catch {
      return [{ kind: "raw", payload: null }];
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      // Not JSON (blank line, log noise, ...) -> keep the bytes verbatim.
      return [{ kind: "raw", payload: text }];
    }

    try {
      const events = this.events(payload);
      return events.length > 0 ? events : [{ kind: "raw", payload }];
    } catch {
      return [{ kind: "raw", payload }];
    }
  }

  private events(payload: unknown): NormalizedEvent[] {
    if (!isRecord(payload)) return [];
    const type = str(payload.type);
    switch (type) {
      case "system":
        return this.systemEvents(payload);
      case "assistant":
        return this.assistantEvents(payload);
      case "user":
        return this.userEvents(payload);
      case "result":
        return this.resultEvents(payload);
      case "control_request":
        return this.controlRequestEvents(payload);
      case "stream_event":
        return this.streamEventEvents(payload);
      default:
        return [];
    }
  }

  /** {"type":"system","subtype":"init","session_id":"..."} announces a live session. */
  private systemEvents(payload: Record<string, unknown>): NormalizedEvent[] {
    if (str(payload.subtype) !== "init") return [];
    const sessionId = str(payload.session_id);
    return [sessionId ? { kind: "ready", providerSessionId: sessionId } : { kind: "ready" }];
  }

  /** {"type":"assistant","message":{"content":[{"type":"text"|"tool_use"}]}} */
  private assistantEvents(payload: Record<string, unknown>): NormalizedEvent[] {
    const message = isRecord(payload.message) ? payload.message : undefined;
    if (!message) return [];
    const content = message.content;
    if (typeof content === "string") {
      return content.length > 0 ? [{ kind: "text", delta: content }] : [];
    }
    if (!Array.isArray(content)) return [];

    const events: NormalizedEvent[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      const type = str(block.type);
      if (type === "text") {
        const text = str(block.text);
        if (text) events.push({ kind: "text", delta: text });
      } else if (type === "tool_use") {
        const name = str(block.name) ?? "tool";
        const id = str(block.id);
        if (id) this.toolNames.set(id, name);
        const summary = summarizeInput(block.input);
        events.push(
          summary === undefined
            ? { kind: "tool", name, status: "start" }
            : { kind: "tool", name, status: "start", summary },
        );
      }
    }
    return events;
  }

  /** {"type":"user","message":{"content":[{"type":"tool_result"}]}} closes a tool call. */
  private userEvents(payload: Record<string, unknown>): NormalizedEvent[] {
    const message = isRecord(payload.message) ? payload.message : undefined;
    if (!message) return [];
    const content = message.content;
    if (!Array.isArray(content)) return [];

    const events: NormalizedEvent[] = [];
    for (const block of content) {
      if (!isRecord(block) || str(block.type) !== "tool_result") continue;
      const toolUseId = str(block.tool_use_id);
      const name = (toolUseId && this.toolNames.get(toolUseId)) || "tool";
      const status = block.is_error === true ? "error" : "end";
      const summary = summarize(contentToText(block.content));
      events.push(
        summary.length > 0
          ? { kind: "tool", name, status, summary }
          : { kind: "tool", name, status },
      );
    }
    return events;
  }

  /** {"type":"result","subtype":"success","usage":{...}} closes the turn. */
  private resultEvents(payload: Record<string, unknown>): NormalizedEvent[] {
    const subtype = str(payload.subtype) ?? "";
    const isError = payload.is_error === true || subtype.startsWith("error");
    const isCancelled =
      subtype === "cancelled" ||
      subtype === "interrupted" ||
      str(payload.status) === "cancelled" ||
      payload.interrupted === true;
    const status: "ok" | "error" | "cancelled" = isError ? "error" : isCancelled ? "cancelled" : "ok";

    const usage = isRecord(payload.usage) ? payload.usage : undefined;
    const inputTokens = num(usage?.input_tokens);
    const outputTokens = num(usage?.output_tokens);
    if (inputTokens === undefined && outputTokens === undefined) {
      return [{ kind: "turn_end", status }];
    }
    const usageOut: { inputTokens?: number; outputTokens?: number } = {};
    if (inputTokens !== undefined) usageOut.inputTokens = inputTokens;
    if (outputTokens !== undefined) usageOut.outputTokens = outputTokens;
    return [{ kind: "turn_end", status, usage: usageOut }];
  }

  /** {"type":"control_request","request_id":"...","request":{"subtype":"can_use_tool"}} */
  private controlRequestEvents(payload: Record<string, unknown>): NormalizedEvent[] {
    const request = isRecord(payload.request) ? payload.request : undefined;
    if (!request) return [];
    if (str(request.subtype) !== "can_use_tool") return [];

    const id = str(payload.request_id) ?? randomUUID();
    this.rememberPermission(id, request);
    return [{ kind: "permission", id, request }];
  }

  /** Keep the pending-permission cache bounded for long-running daemons. */
  private rememberPermission(id: string, request: Record<string, unknown>): void {
    this.pendingPermissions.set(id, request);
    while (this.pendingPermissions.size > MAX_PENDING_PERMISSIONS) {
      const oldest = this.pendingPermissions.keys().next();
      if (oldest.done) break;
      this.pendingPermissions.delete(oldest.value);
    }
  }

  /** Partial-message stream (only emitted with --include-partial-messages). */
  private streamEventEvents(payload: Record<string, unknown>): NormalizedEvent[] {
    const event = isRecord(payload.event) ? payload.event : undefined;
    if (!event) return [];
    if (str(event.type) !== "content_block_delta") return [];
    const delta = isRecord(event.delta) ? event.delta : undefined;
    if (!delta || str(delta.type) !== "text_delta") return [];
    const text = str(delta.text);
    return text ? [{ kind: "text", delta: text }] : [];
  }
}

export function createClaudeAdapter(): ClaudeAdapter {
  return new ClaudeAdapter();
}

export default ClaudeAdapter;
