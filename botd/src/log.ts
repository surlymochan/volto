// botd/src/log.ts
//
// Structured logging for the bot daemon.
//
// The daemon used to have a single `onLog(message: string)` hook: a free
// form string that only the CLI knew how to print. This module replaces it
// with a small, dependency free logger that writes one JSON object per
// record:
//
//   {"ts":"2026-11-13T16:14:07.000Z","level":"info","msg":"lease expired","sid":"s-1"}
//
// A record is always a single line: the message and the field values are JSON
// escaped, so a newline in a message never splits the record in two and the
// line stays valid JSON.
//
// The logger never throws. A field that cannot be serialised (a circular
// reference, a bigint, an undefined value) becomes a marker, and a sink that
// fails does not take the daemon down with it.
//
// The fields of every record run through the redaction helpers of
// `botd/src/redact.ts` before they are written, so a secret that is stored
// under a secret looking key -- or that is written in a secret looking value
// -- never reaches the line.

import { redact, redactText } from "./redact.ts";

/** The levels the logger understands, from the most to the least verbose. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/** One log level. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Name of the environment variable that carries the log level. */
export const LOG_LEVEL_ENV = "BOTD_LOG_LEVEL";

/** Fields of one record: arbitrary values, JSON friendly once sanitised. */
export type LogFields = Record<string, unknown>;

/** Sink of the logger: one line per record, the newline included. */
export type LogWrite = (line: string) => void;

/** Redactor applied to the fields of every record. */
export type LogRedact = (fields: LogFields) => LogFields;

/** Options of {@link createLogger}. */
export interface LoggerOptions {
  /** Sink of the records. */
  write?: LogWrite;
  /** Lowest level that is written. Defaults to `info`. */
  level?: LogLevel | string;
  /** Clock used for the `ts` field. Defaults to `Date.now`. */
  now?: () => number | Date;
  /** Redactor of the fields. Defaults to `redact` of `botd/src/redact.ts`. */
  redact?: LogRedact;
}

/** The logger of the daemon. */
export interface Logger {
  /** Record a message at the `debug` level. */
  debug(message: string, fields?: LogFields): void;
  /** Record a message at the `info` level. */
  info(message: string, fields?: LogFields): void;
  /** Record a message at the `warn` level. */
  warn(message: string, fields?: LogFields): void;
  /** Record a message at the `error` level. */
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every record it writes. */
  child(fields: LogFields): Logger;
}

/** Marker of a value that has no JSON representation (`undefined`). */
export const UNDEFINED_MARKER = "<undefined>";
/** Marker of a value that JSON cannot carry (`bigint`). */
export const BIGINT_MARKER = "<bigint>";
/** Marker of a value that refers to itself. */
export const CIRCULAR_MARKER = "<circular>";
/** Marker of a value that cannot be read at all. */
export const UNSERIALIZABLE_MARKER = "<unserializable>";

/** Keys of a record that the logger owns; the fields cannot set them. */
const RESERVED_KEYS = new Set(["ts", "level", "msg"]);

/**
 * Read the log level out of an environment.
 *
 * The level is taken from `BOTD_LOG_LEVEL`; `debug`, `info`, `warn` and
 * `error` are understood, in any case and with any surrounding space. An
 * unknown value -- and a missing variable -- means `info`: the daemon logs
 * the events of a normal run and stays quiet about the noise.
 */
export function parseLevel(env?: Record<string, string | undefined> | string | null): LogLevel {
  if (typeof env === "string") return normalizeLevel(env);
  const raw = env?.[LOG_LEVEL_ENV];
  return normalizeLevel(raw);
}

/**
 * Build a logger.
 *
 * Every record is one JSON line, `{ts, level, msg, ...fields}`, handed to
 * `write` with a trailing newline. The `ts` field is the ISO timestamp of
 * `now()`, the `level` field is the level of the call.
 *
 * The fields of the call are merged with the fields of the parent logger
 * (the fields of the call win) and are redacted before they are written.
 * The keys `ts`, `level` and `msg` belong to the logger and are ignored
 * when they show up in the fields.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const state: LoggerState = {
    write: typeof options.write === "function" ? options.write : () => {},
    level: normalizeLevel(options.level),
    now: typeof options.now === "function" ? options.now : Date.now,
    redact: typeof options.redact === "function" ? options.redact : (fields) => redact(fields),
    fields: {},
  };
  return makeLogger(state);
}

/**
 * Turn the `onLog` hook of the daemon into a logger.
 *
 * The daemon reports its diagnostics as plain strings; the returned function
 * writes them as `info` records.
 */
export function onLogAdapter(logger: Logger): (message: string) => void {
  return (message: string): void => {
    logger.info(message);
  };
}

// --- internals -------------------------------------------------------------

/** Everything a logger needs to write a record. */
interface LoggerState {
  write: LogWrite;
  level: LogLevel;
  now: () => number | Date;
  redact: LogRedact;
  fields: LogFields;
}

/** Build a logger over a state; the state of a child extends the state. */
function makeLogger(state: LoggerState): Logger {
  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (!isEnabled(state.level, level)) return;
    const line = buildLine(state, level, message, fields);
    try {
      state.write(line);
    } catch {
      // A broken sink must not take the daemon down.
    }
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => makeLogger({ ...state, fields: mergeFields(state.fields, fields) }),
  };
}

/** Build the line of one record, newline included. */
function buildLine(
  state: LoggerState,
  level: LogLevel,
  message: string,
  fields?: LogFields,
): string {
  const ts = timestamp(state.now);
  const msg = messageText(message);
  const record: Record<string, unknown> = { ts, level, msg };

  try {
    const redacted = applyRedactor(state.redact, mergeFields(state.fields, fields));
    for (const [key, value] of Object.entries(redacted)) {
      // A redactor may bring a reserved key back; the logger keeps it.
      if (RESERVED_KEYS.has(key)) continue;
      record[key] = value;
    }
  } catch {
    // A field that cannot be read is left out; the record itself survives.
  }

  try {
    return `${encode(JSON.stringify(sanitize(record)))}\n`;
  } catch {
    return `${encode(JSON.stringify({ ts, level, msg }))}\n`;
  }
}

/** Escape the line separators that would break a line of a log file. */
function encode(json: string): string {
  return json.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Merge the fields of a parent logger with the fields of a call. */
function mergeFields(base: LogFields, extra?: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(base)) {
    if (RESERVED_KEYS.has(key)) continue;
    out[key] = value;
  }
  if (extra !== null && typeof extra === "object") {
    for (const [key, value] of Object.entries(extra)) {
      if (RESERVED_KEYS.has(key)) continue;
      out[key] = value;
    }
  }
  return out;
}

/** Run the redactor over the fields; a broken redactor hides them. */
function applyRedactor(redactor: LogRedact, fields: LogFields): LogFields {
  const result = redactor(fields);
  if (result === null || typeof result !== "object") return {};
  return result;
}

/** True when a record of `level` passes the threshold of the logger. */
function isEnabled(threshold: LogLevel, level: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(threshold);
}

/** Turn a value into a level; an unknown value means `info`. */
function normalizeLevel(value: unknown): LogLevel {
  if (typeof value !== "string") return "info";
  const level = value.trim().toLowerCase();
  const known = LOG_LEVELS as readonly string[];
  return known.includes(level) ? (level as LogLevel) : "info";
}

/** The ISO timestamp of the clock; a broken clock does not throw. */
function timestamp(now: () => number | Date): string {
  let value: unknown;
  try {
    value = now();
  } catch {
    value = Date.now();
  }
  const date = toDate(value);
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : new Date(0).toISOString();
}

/** Turn the value of a clock into a date; an unusable value means now. */
function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return new Date();
}

/** The message of a record; it is redacted like every other text. */
function messageText(message: unknown): string {
  let text: string;
  if (typeof message === "string") {
    text = message;
  } else if (message === undefined || message === null) {
    text = "";
  } else {
    try {
      text = String(message);
    } catch {
      text = "";
    }
  }
  try {
    return redactText(text);
  } catch {
    return text;
  }
}

/**
 * Turn a value into something JSON can carry.
 *
 * Errors become `{name, message, stack}`, the values JSON does not know
 * (bigints, undefined, functions) become markers and a value that refers to
 * itself becomes the circular marker. The input is never modified.
 */
function sanitize(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null) return null;

  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return value;
  if (kind === "number") return Number.isFinite(value as number) ? value : null;
  if (kind === "bigint") return BIGINT_MARKER;
  if (kind === "undefined") return UNDEFINED_MARKER;
  if (kind === "function") return UNSERIALIZABLE_MARKER;
  if (kind === "symbol") return UNSERIALIZABLE_MARKER;

  const object = value as object;
  if (object instanceof Error) return sanitizeError(object);

  if (seen.has(object)) return CIRCULAR_MARKER;
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const out: unknown[] = [];
      for (const entry of object) {
        try {
          out.push(sanitize(entry, seen));
        } catch {
          out.push(UNSERIALIZABLE_MARKER);
        }
      }
      return out;
    }

    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(object as Record<string, unknown>)) {
      try {
        out[key] = sanitize(entry, seen);
      } catch {
        out[key] = UNSERIALIZABLE_MARKER;
      }
    }
    return out;
  } catch {
    return UNSERIALIZABLE_MARKER;
  } finally {
    seen.delete(object);
  }
}

/** The record of an error: its name, its message and its stack. */
function sanitizeError(error: Error): Record<string, unknown> {
  const message = typeof error.message === "string" ? error.message : "";
  return {
    name: typeof error.name === "string" && error.name.length > 0 ? error.name : "Error",
    message: messageText(message),
    stack: typeof error.stack === "string" ? error.stack : "",
  };
}
