// Gaps of the structured logger of botd.
//
// The cases of botd/test/log.test.ts are not repeated here: this file only
// reaches the shapes of the contract that the main logger test does not --
// a value that refers to itself, a bigint, a value that cannot be read, the
// fallbacks of `parseLevel` and the `onLog` adapter.
//
// Fixtures are synthetic: the clock is fixed, the sink collects the lines in
// an array and no real name, host, address or token is mentioned.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BIGINT_MARKER,
  CIRCULAR_MARKER,
  createLogger,
  onLogAdapter,
  parseLevel,
  UNDEFINED_MARKER,
  UNSERIALIZABLE_MARKER,
} from "../src/log.ts";
import type { Logger, LoggerOptions } from "../src/log.ts";

/** The clock of the tests: a fixed instant. */
const FIXED_NOW = Date.UTC(2026, 10, 13, 16, 14, 7);

/** A logger that collects the lines it writes in memory. */
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

test("a value that refers to itself is written with the circular marker", () => {
  const { lines, logger } = collect();
  const value: Record<string, unknown> = { name: "loop" };
  value.self = value;

  assert.doesNotThrow(() => logger.info("loop", { value }));

  const written = record(lines).value as Record<string, unknown>;
  assert.equal(written.name, "loop");
  assert.equal(written.self, CIRCULAR_MARKER);
});

test("a bigint is written with the bigint marker", () => {
  const { lines, logger } = collect();

  assert.doesNotThrow(() => logger.info("big", { size: 10n }));

  assert.equal(record(lines).size, BIGINT_MARKER);
});

test("a bigint inside a container is written with the bigint marker", () => {
  const { lines, logger } = collect();

  assert.doesNotThrow(() => logger.info("big", { sizes: [1n, 2n], nested: { count: 3n } }));

  const parsed = record(lines);
  assert.deepEqual(parsed.sizes, [BIGINT_MARKER, BIGINT_MARKER]);
  assert.equal((parsed.nested as Record<string, unknown>).count, BIGINT_MARKER);
});

test("an undefined value is written with the undefined marker", () => {
  const { lines, logger } = collect();

  assert.doesNotThrow(() => logger.info("missing", { value: undefined, nested: { gone: undefined } }));

  const parsed = record(lines);
  assert.equal(parsed.value, UNDEFINED_MARKER);
  assert.equal((parsed.nested as Record<string, unknown>).gone, UNDEFINED_MARKER);
});

// DEFECT: the logger copies `toJSON` as a member of the object, so the
// field becomes {"toJSON":"<unserializable>"} instead of the marker.
test("an object whose toJSON throws is written with the unserializable marker", { todo: "DEFECT: the logger copies `toJSON` as a member of the object instead of marking the field" }, () => {
  const { lines, logger } = collect();
  const value = {
    toJSON() {
      throw new Error("unreadable");
    },
  };

  assert.doesNotThrow(() => logger.info("unreadable", { value }));

  assert.equal(record(lines).value, UNSERIALIZABLE_MARKER);
});

test("parseLevel falls back to info and reads the level of the environment", () => {
  assert.equal(parseLevel(undefined), "info");
  assert.equal(parseLevel("nope"), "info");
  assert.equal(parseLevel({ BOTD_LOG_LEVEL: "WARN" }), "warn");
});

test("the onLog adapter writes one line", () => {
  const { lines, logger } = collect();
  const onLog = onLogAdapter(logger);

  onLog("the lease of the session expired");

  assert.equal(lines.length, 1);
  assert.equal((lines[0] as string).endsWith("\n"), true);
  const parsed = record(lines);
  assert.deepEqual(Object.keys(parsed), ["ts", "level", "msg"]);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.msg, "the lease of the session expired");
});
