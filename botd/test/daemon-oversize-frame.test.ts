import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Botd } from "../src/daemon.ts";
import { MAX_FRAME_BYTES } from "../src/frames.ts";

function harness(t: import("node:test").TestContext) {
  fs.mkdirSync(".tmp", { recursive: true });
  const home = fs.mkdtempSync(path.join(".tmp", "oversize-"));
  const daemon = new Botd({ home });
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Array<{ op: string; code?: string }> = [];
  let pending = "";
  output.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop()!;
    for (const line of lines) frames.push(JSON.parse(line));
  });
  daemon.connect(input, output);
  t.after(() => {
    daemon.close();
    input.destroy();
    output.destroy();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { input, frames };
}

const hello = '{"op":"hello","clientId":"client"}\n';
const options = { timeout: 1900 };

function assertErrorAndRecovery(frames: Array<{ op: string; code?: string }>) {
  assert.equal(frames.length, 2);
  assert.equal(frames[0].op, "error");
  assert.ok(frames[0].code === "bad_json" || frames[0].code === "bad_frame");
  assert.equal(frames[1].op, "hello");
}

test("an oversized line is rejected and the next frame is answered", options, (t) => {
  const { input, frames } = harness(t);
  // Valid JSON of limit+1 bytes: only the size guard can reject it, so a missing guard
  // would answer with "hello" instead of an error.
  const prefix = '{"op":"hello","clientId":"client","padding":"';
  const suffix = '"}';
  const line = prefix + "x".repeat(MAX_FRAME_BYTES + 1 - Buffer.byteLength(prefix + suffix)) + suffix;
  assert.equal(Buffer.byteLength(line), MAX_FRAME_BYTES + 1);
  assert.doesNotThrow(() => JSON.parse(line));
  input.write(`${line}\n${hello}`);
  assertErrorAndRecovery(frames);
  assert.equal(frames[0].code, "bad_json");
});

test("an oversized non-JSON line is rejected and the next frame is answered", options, (t) => {
  const { input, frames } = harness(t);
  input.write(`${"x".repeat(MAX_FRAME_BYTES + 1)}\n${hello}`);
  assertErrorAndRecovery(frames);
  assert.equal(frames[0].code, "bad_json");
});

test("a valid frame exactly at the byte limit is accepted", options, (t) => {
  const { input, frames } = harness(t);
  const prefix = '{"op":"hello","clientId":"client","padding":"';
  const suffix = '"}';
  const line = prefix + "x".repeat(MAX_FRAME_BYTES - Buffer.byteLength(prefix + suffix)) + suffix;
  assert.equal(Buffer.byteLength(line), MAX_FRAME_BYTES);
  input.write(`${line}\n`);
  assert.deepEqual(frames.map((frame) => frame.op), ["hello"]);
});

test("a chunked 9 MiB line is discarded and the daemon recovers", options, (t) => {
  const { input, frames } = harness(t);
  const chunk = Buffer.alloc(64 * 1024, 0x78);
  for (let i = 0; i < 9 * 16; i++) input.write(chunk);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].code, "bad_json");
  input.write(`\n${hello}`);
  assertErrorAndRecovery(frames);
});

test("a NUL in a JSON string is rejected and the daemon recovers", options, (t) => {
  const { input, frames } = harness(t);
  input.write(`{"op":"hello","clientId":"a\0b"}\n${hello}`);
  assertErrorAndRecovery(frames);
});

test("an escaped lone surrogate is rejected and the daemon recovers", options, (t) => {
  t.todo("JSON parsing and client frame validation accept an unpaired surrogate in clientId");
  const { input, frames } = harness(t);
  input.write(`{"op":"hello","clientId":"\\ud800"}\n${hello}`);
  assertErrorAndRecovery(frames);
});

test("invalid UTF-8 in a JSON string is rejected and the daemon recovers", options, (t) => {
  t.todo("StringDecoder replaces invalid UTF-8 with U+FFFD, allowing the frame through");
  const { input, frames } = harness(t);
  input.write(Buffer.concat([
    Buffer.from('{"op":"hello","clientId":"'),
    Buffer.from([0xff]),
    Buffer.from(`"}\n${hello}`),
  ]));
  assertErrorAndRecovery(frames);
});

test("one thousand empty lines produce no output", options, (t) => {
  const { input, frames } = harness(t);
  input.write("\n".repeat(1000));
  assert.deepEqual(frames, []);
  input.write(hello);
  assert.deepEqual(frames.map((frame) => frame.op), ["hello"]);
});
