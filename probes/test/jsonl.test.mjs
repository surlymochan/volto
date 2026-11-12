import assert from "node:assert/strict";
import test from "node:test";

import { createLineSplitter, parseJsonl } from "../lib/jsonl.mjs";

test("splits records on LF only", () => {
  /** @type {string[]} */
  const lines = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  splitter.push('{"a":1}\n{"b":2}\n');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("keeps U+2028 inside a record", () => {
  /** @type {string[]} */
  const lines = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  splitter.push('{"a":"x\u2028y"}\n');
  assert.deepEqual(lines, ['{"a":"x\u2028y"}']);
});

test("strips a trailing CR", () => {
  /** @type {string[]} */
  const lines = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  splitter.push('{"a":1}\r\n');
  assert.deepEqual(lines, ['{"a":1}']);
});

test("flushes the last partial record", () => {
  /** @type {string[]} */
  const lines = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  splitter.push('{"a":1}');
  assert.deepEqual(lines, []);
  splitter.flush();
  assert.deepEqual(lines, ['{"a":1}']);
});

test("parseJsonl ignores blank lines and keeps unparseable ones", () => {
  const records = parseJsonl('{"a":1}\n\nnot json\n{"b":2}\n');
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], { a: 1 });
  assert.deepEqual(records[1], { raw: "not json" });
  assert.deepEqual(records[2], { b: 2 });
});
