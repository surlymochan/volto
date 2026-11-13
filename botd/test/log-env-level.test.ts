import test from "node:test";
import assert from "node:assert/strict";

import { createLogger, LOG_LEVEL_ENV, parseLevel, UNSERIALIZABLE_MARKER } from "../src/log.ts";

function collect(level = "info") {
  const lines: string[] = [];
  const logger = createLogger({ level, write: (line) => lines.push(line), now: () => 0 });
  return { lines, logger };
}

test("LOG_LEVEL_ENV identifies the environment variable", () => {
  assert.equal(LOG_LEVEL_ENV, "BOTD_LOG_LEVEL");
  assert.equal(parseLevel({ [LOG_LEVEL_ENV]: "error" }), "error");
  assert.equal(parseLevel({ OTHER_LEVEL: "debug" }), "info");
});

test("parseLevel accepts a level string", () => {
  assert.equal(parseLevel("debug"), "debug");
  assert.equal(parseLevel("error"), "error");
});

test("parseLevel defaults for null and undefined", () => {
  assert.equal(parseLevel(null), "info");
  assert.equal(parseLevel(undefined), "info");
  assert.equal(parseLevel(), "info");
  assert.equal(parseLevel({ [LOG_LEVEL_ENV]: undefined }), "info");
});

test("parseLevel defaults for empty and whitespace strings", () => {
  assert.equal(parseLevel(""), "info");
  assert.equal(parseLevel(" \t "), "info");
});

test("parseLevel normalizes string case and surrounding whitespace", () => {
  assert.equal(parseLevel("WARN"), "warn");
  assert.equal(parseLevel(" \tErRoR\n"), "error");
});

test("parseLevel defaults for unknown strings", () => {
  assert.equal(parseLevel("verbose"), "info");
  assert.equal(parseLevel(" INFO extra "), "info");
});

test("a logger using the environment level suppresses lower levels", () => {
  const { lines, logger } = collect(parseLevel({ [LOG_LEVEL_ENV]: " ERROR " }));
  logger.debug("debug message");
  logger.info("info message");
  logger.warn("warn message");
  logger.error("error message");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0] as string).level, "error");
});

test("a field with a throwing toJSON becomes the unserializable marker", { todo: "logger copies toJSON as a function instead of marking the field" }, () => {
  const { lines, logger } = collect();
  const value = { toJSON() { throw new Error("unreadable"); } };
  assert.doesNotThrow(() => logger.info("message", { value }));
  assert.equal(JSON.parse(lines[0] as string).value, UNSERIALIZABLE_MARKER);
});

test("a throwing field getter becomes the unserializable marker", { todo: "field merging drops all fields when a getter throws" }, () => {
  const { lines, logger } = collect();
  const fields = { get value(): string { throw new Error("unreadable"); } };
  assert.doesNotThrow(() => logger.info("message", fields));
  assert.equal(JSON.parse(lines[0] as string).value, UNSERIALIZABLE_MARKER);
});

test("newlines and line separators in fields remain in one JSON line", () => {
  const { lines, logger } = collect();
  const message = "first\nsecond\rthird\u2028fourth\u2029fifth";
  const value = "one\ntwo\r\nthree\u2028four\u2029five";
  logger.info(message, { value, nested: [value] });
  assert.equal(lines.length, 1);
  const line = lines[0] as string;
  assert.equal(line.split("\n").length, 2);
  assert.equal(line.endsWith("\n"), true);
  assert.doesNotMatch(line, /[\r\u2028\u2029]/);
  assert.deepEqual(JSON.parse(line), {
    ts: "1970-01-01T00:00:00.000Z", level: "info", msg: message, value, nested: [value],
  });
});
