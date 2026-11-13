/**
 * Wire protocol of the volto bot daemon (botd).
 *
 * botd runs on an executor host and is started as a forced command
 * (`ssh <host> botd serve`). It speaks newline-delimited JSON (NDJSON) frames
 * over stdin/stdout: one JSON object per line, in both directions. A single
 * connection multiplexes many sessions, each identified by a `sid`.
 *
 * See botd/README.md for the full description.
 */

/** Version reported in the `hello` answer. */
export const BOTD_VERSION = "0.1.0";

/** Bot flavours botd knows how to drive. */
export const BOT_KINDS = ["acp", "codex-app-server", "pi-rpc"] as const;
export type BotKind = (typeof BOT_KINDS)[number];

/** Lifecycle states reported for a session. */
export const SESSION_STATES = ["starting", "running", "idle", "paused", "exited"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** How to launch the bot process behind a session. */
export type BotSpec = {
  kind: BotKind;
  /** argv of the child process; no shell is involved. */
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
};

/** Provider-side resume information handed to the client by botd. */
export type ResumeSpec = {
  providerSessionId?: string;
};

/** Frames sent by the client (the volto control plane) to botd. */
export type ClientFrame =
  | { op: "hello"; clientId: string; leaseTtlMs?: number }
  | { op: "renew"; leaseId: string; fence: number }
  | { op: "open"; sid: string; bot: BotSpec; resume?: ResumeSpec }
  | { op: "send"; sid: string; payload: unknown }
  | { op: "cancel"; sid: string; payload?: unknown }
  | { op: "ack"; sid: string; seq: number }
  | { op: "close"; sid: string }
  | { op: "resume"; sid: string; fromSeq: number };

/** Frames sent by botd to the client. */
export type ServerFrame =
  | { op: "hello"; botdVersion: string; leaseId: string; fence: number; leaseTtlMs: number }
  | { op: "event"; sid: string; seq: number; payload: unknown }
  | { op: "state"; sid: string; state: SessionState; progressAt: number }
  | { op: "error"; code: string; message: string; sid?: string }
  | { op: "gap"; sid: string; fromSeq: number; toSeq: number }
  | { op: "stall"; sid: string; idleMs: number };

export type ParseResult =
  | { ok: true; frame: ClientFrame }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseBotSpec(raw: unknown): { ok: true; bot: BotSpec } | { ok: false; message: string } {
  if (!isRecord(raw)) return { ok: false, message: "bot must be an object" };
  if (!isNonEmptyString(raw.kind) || !(BOT_KINDS as readonly string[]).includes(raw.kind)) {
    return { ok: false, message: `bot.kind must be one of ${BOT_KINDS.join(", ")}` };
  }
  const command = raw.command;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part) => typeof part === "string")
  ) {
    return { ok: false, message: "bot.command must be a non-empty array of strings" };
  }
  const bot: BotSpec = {
    kind: raw.kind as BotKind,
    command: command.map((part) => part as string),
  };
  if (isNonEmptyString(raw.cwd)) bot.cwd = raw.cwd;
  if (isRecord(raw.env)) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value === "string") env[key] = value;
    }
    bot.env = env;
  }
  return { ok: true, bot };
}

/**
 * Validate one untrusted frame. Returns the typed frame or a human readable
 * reason why the frame was rejected.
 */
export function parseClientFrame(raw: unknown): ParseResult {
  if (!isRecord(raw)) return { ok: false, message: "frame must be a JSON object" };
  switch (raw.op) {
    case "hello": {
      if (!isNonEmptyString(raw.clientId)) {
        return { ok: false, message: "hello requires a non-empty clientId" };
      }
      if (raw.leaseTtlMs !== undefined && !isFiniteNumber(raw.leaseTtlMs)) {
        return { ok: false, message: "hello.leaseTtlMs must be a number" };
      }
      if (raw.leaseTtlMs !== undefined && raw.leaseTtlMs <= 0) {
        return { ok: false, message: "hello.leaseTtlMs must be positive" };
      }
      const frame: ClientFrame = { op: "hello", clientId: raw.clientId };
      if (raw.leaseTtlMs !== undefined) frame.leaseTtlMs = raw.leaseTtlMs;
      return { ok: true, frame };
    }
    case "renew": {
      if (!isNonEmptyString(raw.leaseId)) {
        return { ok: false, message: "renew requires a leaseId" };
      }
      if (!isFiniteNumber(raw.fence)) {
        return { ok: false, message: "renew requires a numeric fence" };
      }
      return { ok: true, frame: { op: "renew", leaseId: raw.leaseId, fence: raw.fence } };
    }
    case "open": {
      if (!isNonEmptyString(raw.sid)) return { ok: false, message: "open requires a sid" };
      const bot = parseBotSpec(raw.bot);
      if (!bot.ok) return { ok: false, message: bot.message };
      const frame: ClientFrame = { op: "open", sid: raw.sid, bot: bot.bot };
      if (isRecord(raw.resume)) {
        const resume: ResumeSpec = {};
        if (isNonEmptyString(raw.resume.providerSessionId)) {
          resume.providerSessionId = raw.resume.providerSessionId;
        }
        frame.resume = resume;
      }
      return { ok: true, frame };
    }
    case "send": {
      if (!isNonEmptyString(raw.sid)) return { ok: false, message: "send requires a sid" };
      if (!("payload" in raw)) return { ok: false, message: "send requires a payload" };
      return { ok: true, frame: { op: "send", sid: raw.sid, payload: raw.payload } };
    }
    case "cancel": {
      if (!isNonEmptyString(raw.sid)) return { ok: false, message: "cancel requires a sid" };
      const frame: ClientFrame = { op: "cancel", sid: raw.sid };
      if ("payload" in raw) frame.payload = raw.payload;
      return { ok: true, frame };
    }
    case "ack": {
      if (!isNonEmptyString(raw.sid)) return { ok: false, message: "ack requires a sid" };
      if (!isFiniteNumber(raw.seq)) return { ok: false, message: "ack requires a numeric seq" };
      return { ok: true, frame: { op: "ack", sid: raw.sid, seq: raw.seq } };
    }
    case "close": {
      if (!isNonEmptyString(raw.sid)) return { ok: false, message: "close requires a sid" };
      return { ok: true, frame: { op: "close", sid: raw.sid } };
    }
    case "resume": {
      if (!isNonEmptyString(raw.sid)) return { ok: false, message: "resume requires a sid" };
      if (!isFiniteNumber(raw.fromSeq)) {
        return { ok: false, message: "resume requires a numeric fromSeq" };
      }
      if (raw.fromSeq < 1) return { ok: false, message: "resume.fromSeq must be >= 1" };
      return { ok: true, frame: { op: "resume", sid: raw.sid, fromSeq: raw.fromSeq } };
    }
    default:
      return { ok: false, message: `unknown op ${JSON.stringify(raw.op)}` };
  }
}
