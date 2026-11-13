import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { readFrames, writeFrame } from "../src/frames.ts";

function reader() {
  const stream = new PassThrough();
  const frames: unknown[] = [];
  const errors: Error[] = [];
  readFrames(stream, (frame) => frames.push(frame), (error) => errors.push(error));
  return { stream, frames, errors };
}

test("round trips nested Unicode and escaped line separators", () => {
  const { stream, frames, errors } = reader();
  const value = { items: ["é", "界", "😀", "a\u2028b"], text: "x\ny" };
  writeFrame(stream, value);
  assert.deepEqual(frames, [value]);
  assert.deepEqual(errors, []);
});

test("does not deliver a bytewise Unicode frame before its newline", () => {
  const { stream, frames, errors } = reader();
  const value = { text: "é界😀" };
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  for (const byte of bytes.subarray(0, -1)) {
    stream.write(Buffer.from([byte]));
    assert.deepEqual(frames, []);
    assert.deepEqual(errors, []);
  }
  stream.write(bytes.subarray(-1));
  assert.deepEqual(frames, [value]);
  assert.deepEqual(errors, []);
});

test("delivers mixed JSON values in order from one chunk", () => {
  const { stream, frames, errors } = reader();
  stream.write('""\n0\nfalse\n{}\n[]\n');
  assert.deepEqual(frames, ["", 0, false, {}, []]);
  assert.deepEqual(errors, []);
});

test("round trips an empty string payload", () => {
  const { stream, frames, errors } = reader();
  writeFrame(stream, "");
  assert.deepEqual(frames, [""]);
  assert.deepEqual(errors, []);
});

test("retains a trailing partial frame until its newline arrives", () => {
  const { stream, frames, errors } = reader();
  stream.write('{"n":1}\n{"n":');
  assert.deepEqual(frames, [{ n: 1 }]);
  assert.deepEqual(errors, []);
  stream.write('2}');
  assert.deepEqual(frames, [{ n: 1 }]);
  stream.write('\n');
  assert.deepEqual(frames, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(errors, []);
});

test("retains a split UTF-8 character after a complete frame", () => {
  const { stream, frames, errors } = reader();
  const tail = Buffer.from('{"text":"😀"}\n');
  const offset = tail.indexOf(Buffer.from("😀"));
  stream.write(Buffer.concat([Buffer.from('null\n'), tail.subarray(0, offset + 1)]));
  assert.deepEqual(frames, [null]);
  assert.deepEqual(errors, []);
  stream.write(tail.subarray(offset + 1));
  assert.deepEqual(frames, [null, { text: "😀" }]);
  assert.deepEqual(errors, []);
});

test("reports a malformed first line without a stack trace in its message", () => {
  const { stream, frames, errors } = reader();
  stream.write('{invalid}\n');
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof SyntaxError);
  assert.doesNotMatch(errors[0].message, /\n\s*at\s/);
  assert.deepEqual(frames, []);
  stream.write('{"ok":true}\n');
  assert.deepEqual(frames, [{ ok: true }]);
  assert.equal(errors.length, 1);
});

test("handles a malformed line split across chunks before a valid frame", () => {
  const { stream, frames, errors } = reader();
  stream.write('{"n":');
  assert.deepEqual(errors, []);
  stream.write('}\n{"n":3}\n');
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0].message, /\n\s*at\s/);
  assert.deepEqual(frames, [{ n: 3 }]);
});
