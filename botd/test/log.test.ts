// Tests for the volto-botd structured logger.
//
// Fixtures are synthetic: every credential is a made up string, the clock is
// fixed and the sink collects the lines in an array. No real secret, machine
// or person is mentioned.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BIGINT_MARKER,
  CIRCULAR_MARKER,
  createLogger,
  LOG_LEVELS,
  onLogAdapter,
  parseLevel,
  UNDEFINED_MARKER,
} from "../src/log.ts";
import type { Logger, LoggerOptions } from "../src/log.ts";
import { REDACTED } from "../src/redact.ts";

/** The clock of the tests: a fixed instant. */
const FIXED_NOW = Date.UTC(2026, 10, 13, 16, 14, 7);
const FIXED_TS = "2026-11-13T16:14:07.000Z";

/** A logger that collects the lines it writes. */
function collect(options: Partial<LoggerOptions> = {}): { lines: string[]; logger: Logger } {
  const lines: string[] = [];
  const logger = createLogger({
    write: (line) => lines.push(line),
    now: () => FIXED_NOW,
    ...options,
  });
  return { lines, logger };
}

/** The record of the only line a logger wrote. */
function record(lines: string[]): Record<string, unknown> {
  assert.equal(lines.length, 1, "exactly one line was written");
  return JSON.parse(lines[0] as string) as Record<string, unknown>;
}

test("a record is one JSON line with a trailing newline", () => {
  const { lines, logger } = collect();

  logger.info("hello");

  assert.equal(lines.length, 1);
  const line = lines[0] as string;
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.split("\n").length, 2);
  assert.deepEqual(Object.keys(record(lines)), ["ts", "level", "msg"]);
  assert.equal(record(lines).msg, "hello");
});

test("the timestamp of a record comes from the clock", () => {
  let stamp = 0;
  const { lines, logger } = collect({ now: () => stamp });

  logger.info("first");
  stamp = Date.UTC(2020, 0, 2);
  logger.info("second");

  assert.equal((JSON.parse(lines[0] as string) as { ts: string }).ts, "1970-01-01T00:00:00.000Z");
  assert.equal((JSON.parse(lines[1] as string) as { ts: string }).ts, "2020-01-02T00:00:00.000Z");
});

test("a clock that returns a date is accepted", () => {
  const { lines, logger } = collect({ now: () => new Date(FIXED_NOW) });

  logger.info("hello");

  assert.equal(record(lines).ts, FIXED_TS);
});

test("a broken clock does not throw", () => {
  const { lines, logger } = collect({
    now: () => {
      throw new Error("no clock");
    },
  });

  assert.doesNotThrow(() => logger.info("hello"));
  assert.equal(lines.length, 1);
  assert.match(record(lines).ts as string, /^\d{4}-\d{2}-\d{2}T/);
});

test("the level of a record is the level of the call", () => {
  const { lines, logger } = collect({ level: "debug" });

  logger.debug("d");
  logger.info("i");
  logger.warn("w");
  logger.error("e");

  const levels = lines.map((line) => (JSON.parse(line) as { level: string }).level);
  assert.deepEqual(levels, ["debug", "info", "warn", "error"]);
  assert.deepEqual([...LOG_LEVELS], ["debug", "info", "warn", "error"]);
});

test("a record below the level of the logger is dropped", () => {
  const { lines, logger } = collect({ level: "warn" });

  logger.debug("d");
  logger.info("i");
  logger.warn("w");
  logger.error("e");

  assert.equal(lines.length, 2);
  assert.equal((JSON.parse(lines[0] as string) as { level: string }).level, "warn");
  assert.equal((JSON.parse(lines[1] as string) as { level: string }).level, "error");
});

test("the level of the logger is read from the environment", () => {
  const { lines, logger } = collect({ level: parseLevel({ BOTD_LOG_LEVEL: "debug" }) });

  logger.debug("d");
  logger.info("i");

  assert.equal(lines.length, 2);
});

test("parseLevel reads BOTD_LOG_LEVEL", () => {
  assert.equal(parseLevel({ BOTD_LOG_LEVEL: "debug" }), "debug");
  assert.equal(parseLevel({ BOTD_LOG_LEVEL: "info" }), "info");
  assert.equal(parseLevel({ BOTD_LOG_LEVEL: "warn" }), "warn");
  assert.equal(parseLevel({ BOTD_LOG_LEVEL: "error" }), "error");
});

test("parseLevel ignores the case and the space", () => {
  assert.equal(parseLevel({ BOTD_LOG_LEVEL: "DEBUG" }), "debug");
  assert.equal(parseLevel({ BOTD_LOG_LEVEL: "  Warn  " }), "warn");
});

test("parseLevel falls back to info", () => {
  assert.equal(parseLevel({}), "info");
  assert.equal(parseLevel({ BOTD_LOG_LEVEL: "" }), "info");
  assert.equal(parseLevel({ BOTD_LOG_LEVEL: "chatty" }), "info");
  assert.equal(parseLevel(undefined), "info");
});

test("the fields of a call are part of the record", () => {
  const { lines, logger } = collect();

  logger.info("opened", { sid: "s-1", seq: 3, ok: true });

  const parsed = record(lines);
  assert.equal(parsed.sid, "s-1");
  assert.equal(parsed.seq, 3);
  assert.equal(parsed.ok, true);
});

test("the fields of a record are redacted", () => {
  const { lines, logger } = collect();

  logger.info("login", {
    token: "hunter2000",
    apiKey: "sk-EXAMPLEEXAMPLEEXAMPLEEXAMPLE",
    note: "password=hunter2000",
  });

  const parsed = record(lines);
  assert.equal(parsed.token, REDACTED);
  assert.equal(parsed.apiKey, REDACTED);
  assert.equal(parsed.note, "password=<redacted>");
});

test("a secret in the message never reaches the line", () => {
  const { lines, logger } = collect();

  logger.info("token=ghp_EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE");

  assert.equal(record(lines).msg, "token=<redacted>");
});

test("an error field becomes name, message and stack", () => {
  const { lines, logger } = collect();
  const error = new Error("boom");

  logger.error("failed", { error });

  const parsed = record(lines).error as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ["name", "message", "stack"]);
  assert.equal(parsed.name, "Error");
  assert.equal(parsed.message, "boom");
  assert.equal(parsed.stack, error.stack);
});

test("a circular field does not throw", () => {
  const { lines, logger } = collect();
  const fields: Record<string, unknown> = { name: "loop" };
  fields.self = fields;

  assert.doesNotThrow(() => logger.info("loop", fields));

  const parsed = record(lines);
  assert.equal(parsed.name, "loop");
  // The redaction copies the fields, so the cycle is broken one level down.
  assert.equal((parsed.self as Record<string, unknown>).self, CIRCULAR_MARKER);
});

test("a cycle between two fields does not throw", () => {
  const { lines, logger } = collect();
  const first: Record<string, unknown> = { name: "first" };
  const second: Record<string, unknown> = { name: "second", first };
  first.second = second;

  assert.doesNotThrow(() => logger.info("cycle", { first }));

  const parsed = record(lines);
  const nested = (parsed.first as Record<string, unknown>).second as Record<string, unknown>;
  assert.equal(nested.name, "second");
  assert.equal(nested.first, CIRCULAR_MARKER);
});

test("a bigint field does not throw", () => {
  const { lines, logger } = collect();

  assert.doesNotThrow(() => logger.info("big", { size: 10n }));

  assert.equal(record(lines).size, BIGINT_MARKER);
});

test("an undefined field does not throw", () => {
  const { lines, logger } = collect();

  assert.doesNotThrow(() => logger.info("missing", { value: undefined }));

  assert.equal(record(lines).value, UNDEFINED_MARKER);
});

test("the reserved fields cannot be overridden", () => {
  const { lines, logger } = collect();

  logger.info("hello", { ts: "nope", level: "error", msg: "nope", sid: "s-1" });

  const parsed = record(lines);
  assert.equal(parsed.ts, FIXED_TS);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.msg, "hello");
  assert.equal(parsed.sid, "s-1");
});

test("a throwing sink does not break the caller", () => {
  const logger = createLogger({
    write: () => {
      throw new Error("the disk is full");
    },
    now: () => FIXED_NOW,
  });

  assert.doesNotThrow(() => logger.info("hello"));
  assert.doesNotThrow(() => logger.error("hello", { sid: "s-1" }));
});

test("a message with newlines stays on one line", () => {
  const { lines, logger } = collect();

  logger.info("first\nsecond\r\nthird");

  const line = lines[0] as string;
  assert.equal(line.split("\n").length, 2);
  assert.equal(record(lines).msg, "first\nsecond\r\nthird");
});

test("a message with unicode stays valid JSON", () => {
  const { lines, logger } = collect();

  logger.info("héllo 🌍 ✓");

  assert.equal(record(lines).msg, "héllo 🌍 ✓");
});

test("a line separator in a message is escaped", () => {
  const { lines, logger } = collect();

  logger.info("a\u2028b");

  assert.equal(lines[0]?.includes(" "), false);
  assert.equal(record(lines).msg, "a b");
});

test("a child logger adds its fields to every record", () => {
  const { lines, logger } = collect();
  const child = logger.child({ sid: "s-1" });

  child.info("opened");
  child.warn("stalled");

  assert.equal((JSON.parse(lines[0] as string) as { sid: string }).sid, "s-1");
  assert.equal((JSON.parse(lines[1] as string) as { sid: string }).sid, "s-1");
});

test("a child of a child keeps the fields of its parent", () => {
  const { lines, logger } = collect();
  const child = logger.child({ sid: "s-1" }).child({ bot: "acp" });

  child.info("opened");

  const parsed = record(lines);
  assert.equal(parsed.sid, "s-1");
  assert.equal(parsed.bot, "acp");
});

test("the fields of a call win over the fields of a child", () => {
  const { lines, logger } = collect();
  const child = logger.child({ sid: "s-1" });

  child.info("moved", { sid: "s-2" });

  assert.equal(record(lines).sid, "s-2");
});

test("the onLog adapter writes a string as an info record", () => {
  const { lines, logger } = collect();
  const onLog = onLogAdapter(logger);

  onLog("lease expired, the sessions are paused");

  const parsed = record(lines);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.msg, "lease expired, the sessions are paused");
});

test("a custom redactor replaces the default one", () => {
  const { lines, logger } = collect({ redact: (fields) => ({ ...fields, masked: true }) });

  logger.info("hello", { token: "hunter2000" });

  const parsed = record(lines);
  assert.equal(parsed.token, "hunter2000");
  assert.equal(parsed.masked, true);
});

test("a broken redactor hides the fields but keeps the record", () => {
  const { lines, logger } = collect({
    redact: () => {
      throw new Error("broken");
    },
  });

  assert.doesNotThrow(() => logger.info("hello", { token: "hunter2000" }));

  const parsed = record(lines);
  assert.equal(parsed.msg, "hello");
  assert.equal(parsed.token, undefined);
});

test("the fields of a record are not modified", () => {
  const { lines, logger } = collect();
  const fields = { sid: "s-1", token: "hunter2000" };

  logger.info("hello", fields);

  assert.deepEqual(fields, { sid: "s-1", token: "hunter2000" });
  assert.equal(record(lines).token, REDACTED);
});
