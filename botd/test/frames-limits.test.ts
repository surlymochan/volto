import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { MAX_FRAME_BYTES, readFrames, writeFrame } from "../src/frames.ts";

function reader() {
  const stream = new PassThrough();
  const frames: unknown[] = [];
  const errors: Error[] = [];
  const handle = readFrames(stream, (frame) => frames.push(frame), (error) => errors.push(error));
  return { stream, frames, errors, handle };
}

async function end(stream: PassThrough, data?: string | Buffer) {
  const ended = once(stream, "end");
  stream.end(data);
  await ended;
}

test("accepts a byte-exact limit with a split multibyte character", async () => {
  const { stream, frames, errors } = reader();
  const prefix = `{"x":"${"a".repeat(MAX_FRAME_BYTES - 11)}`;
  const suffix = Buffer.from('界"}\n');
  assert.equal(Buffer.byteLength(prefix) + suffix.length - 1, MAX_FRAME_BYTES);
  stream.write(prefix);
  stream.write(suffix.subarray(0, 1));
  await end(stream, suffix.subarray(1));
  assert.equal((frames[0] as { x: string }).x.length, MAX_FRAME_BYTES - 10);
  assert.equal(frames.length, 1);
  assert.deepEqual(errors, []);
});

test("rejects limit plus one before newline and discards subsequent chunks", async () => {
  const { stream, frames, errors } = reader();
  stream.write(" ".repeat(MAX_FRAME_BYTES));
  assert.equal(errors.length, 0);
  stream.write("x");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /maximum frame size/);
  for (let i = 0; i < 16; i++) stream.write("x".repeat(1024 * 1024));
  assert.equal(errors.length, 1);
  await end(stream, '\n{"next":1}\n');
  assert.deepEqual(frames, [{ next: 1 }]);
});

test("reads consecutive frames delivered as individual bytes", async () => {
  const { stream, frames, errors } = reader();
  for (const byte of Buffer.from('[1,2]\nnull\ntrue\n')) stream.write(Buffer.from([byte]));
  await end(stream);
  assert.deepEqual(frames, [[1, 2], null, true]);
  assert.deepEqual(errors, []);
});

test("continues after a malformed frame among several in one chunk", async () => {
  const { stream, frames, errors } = reader();
  await end(stream, '{"n":1}\n{bad}\n{"n":2}\n');
  assert.deepEqual(frames, [{ n: 1 }, { n: 2 }]);
  assert.equal(errors.length, 1);
});

test("reports an incomplete trailing frame after a complete frame at EOF", async () => {
  const { stream, frames, errors } = reader();
  await end(stream, '{"n":1}\n{"n":');
  assert.deepEqual(frames, [{ n: 1 }]);
  assert.equal(errors.length, 1);
});

test("ignores an empty line split between adjacent frames", async () => {
  const { stream, frames, errors } = reader();
  stream.write('{"n":1}\n');
  stream.write('\n');
  await end(stream, '{"n":2}\n');
  assert.deepEqual(frames, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(errors, []);
});

test("decodes a split four-byte character in a final unterminated frame", async () => {
  const { stream, frames, errors } = reader();
  const bytes = Buffer.from('{"x":"😀"}');
  const character = bytes.indexOf(Buffer.from('😀'));
  stream.write(bytes.subarray(0, character + 2));
  await end(stream, bytes.subarray(character + 2));
  assert.deepEqual(frames, [{ x: "😀" }]);
  assert.deepEqual(errors, []);
});

test("writes separate newline-terminated frames that round-trip together", async () => {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const values = [{ x: "line\nbreak" }, { x: "界" }];
  for (const value of values) writeFrame(stream, value);
  await end(stream);
  const output = Buffer.concat(chunks);
  assert.equal(output.at(-1), 10);
  assert.equal(output.toString().split("\n").length, 3);
  const result = reader();
  await end(result.stream, output);
  assert.deepEqual(result.frames, values);
  assert.deepEqual(result.errors, []);
});

test("closing with a pending partial frame suppresses EOF delivery", async () => {
  const { stream, frames, errors, handle } = reader();
  stream.write('{"pending":');
  handle.close();
  await end(stream, 'true}');
  assert.deepEqual(frames, []);
  assert.deepEqual(errors, []);
});
