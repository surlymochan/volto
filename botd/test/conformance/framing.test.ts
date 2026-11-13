// Conformance of the framing of botd/PROTOCOL.md.
//
// Covered: §1 (framing: one JSON object per line, blank lines, the
// whitespace around a line, the size limit, unknown fields, invalid client
// frames), §7 (the codes bad_json and bad_frame) and §8 (an unknown op of
// the client).
//
// The daemon is driven with raw NDJSON lines: the tests write the bytes of
// the wire, not a parsed frame. The child of the sessions is the local
// fixture of the harness; no host, token or name shows up here.

import test from "node:test";
import assert from "node:assert/strict";

import { MAX_FRAME_BYTES } from "../../src/frames.ts";
import { FAKE_CHILD, startHarness } from "../helpers.ts";
import { RawClient } from "./raw-client.ts";

const CHILD_COMMAND = [process.execPath, FAKE_CHILD];

test("ignores the blank lines of the stream", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  client.writeRaw("\n");
  client.writeRaw("   \n");
  client.writeRaw("\t \n");

  // A blank line is not a frame: the daemon does not answer it.
  assert.deepEqual(await client.collect(), [], "a blank line must not be answered");

  // The stream is still in sync: the next frame is answered.
  client.send({ op: "hello", clientId: "client-a" });
  const hello = await client.waitForOp("hello");
  assert.equal(hello.op, "hello");
});

test("trims the whitespace around a frame", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  client.writeLine(`   ${JSON.stringify({ op: "hello", clientId: "client-a" })}   `);
  const hello = await client.waitForOp("hello");
  assert.equal(hello.op, "hello");
  assert.equal(hello.clientId, undefined);
  assert.equal(typeof hello.leaseId, "string");
});

test("answers a line that is not JSON with bad_json", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  client.writeLine("this is not json");
  const error = await client.waitForError("bad_json");
  assert.equal(error.op, "error");
  assert.equal(typeof error.message, "string");

  // The offending line is dropped, the stream stays in sync (§1).
  client.send({ op: "hello", clientId: "client-a" });
  await client.waitForOp("hello");
});

test("answers a line above the size limit with bad_json", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  // PROTOCOL.md §1: MAX_FRAME_BYTES is the limit of a pending buffer.
  assert.equal(MAX_FRAME_BYTES, 8 * 1024 * 1024, "the frame limit of §1 changed");
  client.writeLine(`{"op":"hello","clientId":"${"x".repeat(MAX_FRAME_BYTES)}"}`);

  const error = await client.waitForError("bad_json", { timeoutMs: 10_000 });
  assert.equal(error.op, "error");

  // The stream stays in sync: the next frame is answered (§1).
  client.send({ op: "hello", clientId: "client-a" });
  await client.waitForOp("hello");
});

test("ignores the unknown fields of a frame", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  client.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000, unknown: "ignored" });
  const hello = await client.waitForOp("hello");
  assert.equal(hello.op, "hello");

  client.send({
    op: "open",
    sid: "s1",
    bot: { kind: "acp", command: CHILD_COMMAND, unknown: "ignored" },
    unknown: "ignored",
  });
  const state = await client.waitFor(
    (frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "running",
    { label: "the running state of s1" },
  );
  assert.equal(state.op, "state");
});

test("refuses an unknown op with bad_frame", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  client.send({ op: "hello", clientId: "client-a" });
  await client.waitForOp("hello");

  // PROTOCOL.md §8: an unknown op of the client is refused with bad_frame.
  client.send({ op: "unknown_op" });
  const error = await client.waitForError("bad_frame");
  assert.equal(error.op, "error");
  assert.match(String(error.message), /unknown op/);
});

test("refuses a frame with a missing field with bad_frame", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  client.send({ op: "hello" });
  const error = await client.waitForError("bad_frame");
  assert.equal(error.op, "error");
  assert.match(String(error.message), /clientId/);
});

test("refuses a frame with a wrong field type with bad_frame", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  client.send({ op: "hello", clientId: "client-a" });
  await client.waitForOp("hello");

  client.send({ op: "ack", sid: "s1", seq: "1" });
  const error = await client.waitForError("bad_frame");
  assert.equal(error.op, "error");
  assert.match(String(error.message), /seq/);
});

test("refuses a resume below the first sequence number with bad_frame", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  client.send({ op: "hello", clientId: "client-a" });
  await client.waitForOp("hello");

  // PROTOCOL.md §2: resume.fromSeq is at least 1.
  client.send({ op: "resume", sid: "s1", fromSeq: 0 });
  const error = await client.waitForError("bad_frame");
  assert.equal(error.op, "error");
  assert.match(String(error.message), /fromSeq/);
});

test.todo(
  "PROTOCOL.md (retired §1): a line above 1 MiB is refused with invalid_frame",
  async (t) => {
    // The task card asked for the limit of the retired protocol version
    // (git 499d0fd): a line above 1 MiB was a violation and was answered
    // with `invalid_frame`. The current document (§1, §7) uses
    // MAX_FRAME_BYTES (8 MiB) and the code `bad_json`; the daemon follows
    // the document, so a line of 1 MiB is accepted. See
    // botd/test/conformance/DEVIATIONS.md (D3, D4).
    const { daemon } = startHarness();
    t.after(() => daemon.close());
    const client = new RawClient(daemon);

    client.writeLine(`{"op":"hello","clientId":"${"x".repeat(1024 * 1024)}"}`);
    const hello = await client.waitForOp("hello", { timeoutMs: 10_000 });
    assert.equal(hello.op, "hello", "the daemon accepts a line of 1 MiB");
  },
);

test.todo(
  "PROTOCOL.md (retired §1): a line that is not JSON is refused with invalid_frame",
  async (t) => {
    // The retired protocol version answered a broken line with
    // `invalid_frame`; the current document (§1, §7) answers `bad_json`.
    // See botd/test/conformance/DEVIATIONS.md (D4).
    const { daemon } = startHarness();
    t.after(() => daemon.close());
    const client = new RawClient(daemon);

    client.writeLine("this is not json");
    const error = await client.waitForError("bad_json");
    assert.equal(error.code, "bad_json", "the daemon answers bad_json, not invalid_frame");
  },
);

test.todo(
  "PROTOCOL.md (retired §1): an unknown op is refused with unknown_op",
  async (t) => {
    // The retired protocol version answered an unknown op with
    // `unknown_op`; the current document (§8) answers `bad_frame`.
    // See botd/test/conformance/DEVIATIONS.md (D4).
    const { daemon } = startHarness();
    t.after(() => daemon.close());
    const client = new RawClient(daemon);

    client.send({ op: "hello", clientId: "client-a" });
    await client.waitForOp("hello");
    client.send({ op: "unknown_op" });
    const error = await client.waitForError("bad_frame");
    assert.equal(error.code, "bad_frame", "the daemon answers bad_frame, not unknown_op");
  },
);
