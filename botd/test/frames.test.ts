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

test("reads a frame one byte at a time, including split UTF-8", async () => {
  const { stream, frames, errors } = reader();
  const value = { text: "中文 😀 𐐷" };
  for (const byte of Buffer.from(`${JSON.stringify(value)}\n`)) stream.write(Buffer.from([byte]));
  await end(stream);
  assert.deepEqual(frames, [value]);
  assert.deepEqual(errors, []);
});

test("reads several frames in one chunk", async () => {
  const { stream, frames } = reader();
  await end(stream, '{"n":1}\n{"n":2}\n{"n":3}\n');
  assert.deepEqual(frames, [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test("accepts CRLF endings", async () => {
  const { stream, frames } = reader();
  await end(stream, '{"n":1}\r\n{"n":2}\r\n');
  assert.deepEqual(frames, [{ n: 1 }, { n: 2 }]);
});

test("ignores blank lines", async () => {
  const { stream, frames, errors } = reader();
  await end(stream, '\n \r\n{"n":1}\n\n');
  assert.deepEqual(frames, [{ n: 1 }]);
  assert.deepEqual(errors, []);
});

test("flushes a final line without a newline", async () => {
  const { stream, frames } = reader();
  await end(stream, '{"last":true}');
  assert.deepEqual(frames, [{ last: true }]);
});

test("reports malformed lines and continues", async () => {
  const { stream, frames, errors } = reader();
  await end(stream, 'bad json\n{"ok":true}\n');
  assert.equal(errors.length, 1);
  assert.deepEqual(frames, [{ ok: true }]);
});

test("reports malformed final lines", async () => {
  const { stream, errors } = reader();
  await end(stream, '{');
  assert.equal(errors.length, 1);
});

test("rejects an oversized line and reads the next line in the same chunk", async () => {
  const { stream, frames, errors } = reader();
  await end(stream, `${"x".repeat(MAX_FRAME_BYTES + 1)}\n{"ok":true}\n`);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /maximum frame size/);
  assert.deepEqual(frames, [{ ok: true }]);
});

test("discards the rest of an oversized line across chunks", async () => {
  const { stream, frames, errors } = reader();
  stream.write("x".repeat(MAX_FRAME_BYTES + 1));
  await end(stream, 'tail\n{"ok":true}\n');
  assert.equal(errors.length, 1);
  assert.deepEqual(frames, [{ ok: true }]);
});

test("measures the size limit in UTF-8 bytes", async () => {
  const { stream, frames, errors } = reader();
  await end(stream, `{"text":"${"界".repeat(Math.ceil(MAX_FRAME_BYTES / 3))}"}\n{"ok":true}\n`);
  assert.equal(errors.length, 1);
  assert.deepEqual(frames, [{ ok: true }]);
});

test("accepts a line exactly at the size limit", async () => {
  const { stream, frames, errors } = reader();
  const line = `{"x":"${"a".repeat(MAX_FRAME_BYTES - 8)}"}`;
  assert.equal(Buffer.byteLength(line), MAX_FRAME_BYTES);
  await end(stream, `${line}\n`);
  assert.equal(frames.length, 1);
  assert.deepEqual(errors, []);
});

test("does not count multiple lines together against the size limit", async () => {
  const { stream, frames, errors } = reader();
  const line = `{"x":"${"a".repeat(MAX_FRAME_BYTES / 2)}"}`;
  await end(stream, `${line}\n${line}\n`);
  assert.equal(frames.length, 2);
  assert.deepEqual(errors, []);
});

test("close stops delivery and is idempotent", async () => {
  const { stream, frames, errors, handle } = reader();
  stream.write('{"before":true}\n');
  handle.close();
  handle.close();
  await end(stream, '{"after":true}\n');
  assert.deepEqual(frames, [{ before: true }]);
  assert.deepEqual(errors, []);
  assert.equal(stream.listenerCount("error"), 0);
});

test("writeFrame emits one line with escaped separators", async () => {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  writeFrame(stream, { text: "a\nb\u2028c" });
  await end(stream);
  assert.equal(output, '{"text":"a\\nb\\u2028c"}\n');
});

test("unicode round trips through writeFrame and readFrames", async () => {
  const { stream, frames, errors } = reader();
  const value = { text: "漢字 😀 𐐷" };
  writeFrame(stream, value);
  await end(stream);
  assert.deepEqual(frames, [value]);
  assert.deepEqual(errors, []);
});
