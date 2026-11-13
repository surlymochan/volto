import assert from "node:assert/strict";
import test from "node:test";

import { createLineSplitter } from "../lib/jsonl.mjs";

test("emits a record split across three pushes once", () => {
  /** @type {string[]} */
  const lines = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  splitter.push('{"a"');
  splitter.push(':');
  assert.deepEqual(lines, []);
  splitter.push('1}\n');
  assert.deepEqual(lines, ['{"a":1}']);
  splitter.flush();
  assert.deepEqual(lines, ['{"a":1}']);
});

test("emits an empty line between records", () => {
  /** @type {string[]} */
  const lines = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  splitter.push('{"a":1}\n\n{"b":2}\n');
  assert.deepEqual(lines, ['{"a":1}', "", '{"b":2}']);
});
