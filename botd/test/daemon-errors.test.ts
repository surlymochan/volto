// Error handling of the bot daemon.
//
// This file walks the error table of botd/PROTOCOL.md §8: every row a peer
// can trigger from the wire is driven through the daemon and both the code
// and the "session" column of the table are checked.
//
// The daemon speaks the protocol of botd/src/protocol.ts (hello, open, send,
// cancel, ...), not the handshake/prompt vocabulary of the document, and it
// reports the conditions of the table under its own codes.  PROTOCOL_CODE
// maps a code of the wire onto the row of PROTOCOL.md it belongs to and
// protocolCode() applies that map, so every test pins the code the daemon
// puts on the wire *and* the row of the table.
//
// daemon.test.ts covers the mechanics of the daemon (the ring buffer, the
// resume, the lease and the cancel escalation); this file only pins the
// error rows.  The rows the daemon cannot produce from the wire (the
// version negotiation of §9, the cancel timeout of §7, the resume of §5)
// are marked as TODO.
//
// The child is the fake child of the fixtures (test/fixtures/fake-child.mjs);
// no host name, address or credential shows up in this file.

import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { Botd } from "../src/daemon.ts";
import { MAX_FRAME_BYTES } from "../src/frames.ts";
import type { ServerFrame } from "../src/protocol.ts";
import type { ErrorFrame } from "./helpers.ts";
import {
  FAKE_CHILD,
  TestClient,
  delay,
  isError,
  makeTempDir,
  startHarness,
  waitFor,
} from "./helpers.ts";

/** The command of the fake child of the fixtures. */
const CHILD_COMMAND = [process.execPath, FAKE_CHILD];

/**
 * The codes the daemon puts on the wire and the row of PROTOCOL.md §8 they
 * belong to.
 *
 * §1 calls a line that is not a JSON object, a frame without a field and a
 * frame that is too large "invalid_frame"; the daemon reports a frame it
 * could not parse with "bad_frame" and a line that was not JSON at all with
 * "bad_json".  §6 calls an old fencing token "stale_epoch" and an elapsed
 * lease "lease_expired"; §7 calls a cancel without a running turn
 * "cancel_unknown_turn" and §8 calls a failed bot CLI "provider_error".
 *
 * The frame the daemon expects before the hello ("no_lease") has no row in
 * the table: the handshake of PROTOCOL.md is the hello of the daemon.
 */
const PROTOCOL_CODE: Record<string, string> = {
  bad_frame: "invalid_frame",
  bad_json: "invalid_frame",
  stale_fence: "stale_epoch",
  stale_lease: "stale_epoch",
  lease_paused: "lease_expired",
  unknown_session: "cancel_unknown_turn",
  session_exited: "cancel_unknown_turn",
  child_error: "provider_error",
};

/**
 * The row of PROTOCOL.md §8 an error frame of the daemon belongs to.
 *
 * The daemon reports an unknown op with the code of an invalid frame, so
 * the message decides: a frame without an op is "unknown op undefined" and
 * belongs to "invalid_frame" (a missing field), every other unknown op is
 * quoted and belongs to "unknown_op".
 */
function protocolCode(frame: ErrorFrame): string {
  if (
    frame.code === "bad_frame" &&
    frame.message.startsWith("unknown op ") &&
    frame.message !== "unknown op undefined"
  ) {
    return "unknown_op";
  }
  return PROTOCOL_CODE[frame.code] ?? frame.code;
}

/**
 * Assert that the frame is an error frame of the daemon with the given code
 * on the wire and the given row of PROTOCOL.md.
 */
function assertError(frame: ServerFrame, wireCode: string, row: string): ErrorFrame {
  assert.equal(frame.op, "error", `expected an error frame, got ${JSON.stringify(frame)}`);
  const error = frame as ErrorFrame;
  assert.equal(error.code, wireCode, `unexpected wire code: ${JSON.stringify(error)}`);
  assert.equal(protocolCode(error), row, `unexpected row of PROTOCOL.md: ${JSON.stringify(error)}`);
  return error;
}

/** Wait for a frame that matches the predicate among the frames of the mark. */
async function waitForFrame(
  client: TestClient,
  mark: number,
  predicate: (frame: ServerFrame) => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<ServerFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = client.sinceMark(mark).find(predicate);
    if (found) return found;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${label}; got ${JSON.stringify(client.sinceMark(mark))}`,
      );
    }
    await delay(10);
  }
}

/** Open a session and wait until the child runs. */
async function openSession(client: TestClient, sid: string): Promise<void> {
  client.send({ op: "open", sid, bot: { kind: "acp", command: CHILD_COMMAND } });
  await client.waitFor(
    (frame) => frame.op === "state" && frame.sid === sid && frame.state === "running",
    { label: `the running state of ${sid}` },
  );
}

/**
 * A client that drives the daemon over in-memory streams and writes the raw
 * lines helpers.ts writes as JSON objects only (a broken line, a line that
 * is too long, two lines in one chunk, ...).
 */
class RawClient {
  /** Every frame the daemon sent so far. */
  readonly frames: ServerFrame[] = [];
  private readonly input = new PassThrough();
  private readonly output = new PassThrough();
  private buffer = "";

  constructor(daemon: Botd) {
    daemon.connect(this.input, this.output);
    this.output.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      for (;;) {
        const index = this.buffer.indexOf("\n");
        if (index === -1) break;
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line.length === 0) continue;
        this.frames.push(JSON.parse(line) as ServerFrame);
      }
    });
  }

  /** Write raw lines (without the newline) to the daemon. */
  write(...lines: string[]): void {
    this.input.write(`${lines.join("\n")}\n`);
  }

  /** The error frames the daemon sent. */
  errors(): ErrorFrame[] {
    return this.frames.filter(isError);
  }

  /** Wait for a frame that matches the predicate. */
  async waitFor(
    predicate: (frame: ServerFrame) => boolean,
    label: string,
    timeoutMs = 5000,
  ): Promise<ServerFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(predicate);
      if (found) return found;
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for ${label}; got ${JSON.stringify(this.frames)}`,
        );
      }
      await delay(10);
    }
  }
}

/** A daemon and a raw client attached to it. */
function startRawHarness(): { daemon: Botd; client: RawClient } {
  const home = makeTempDir("daemon-errors-");
  const daemon = new Botd({ home, storeFile: `${home}/sessions.json` }, { onFrame: () => {} });
  return { daemon, client: new RawClient(daemon) };
}

// ---------------------------------------------------------------------------
// §1 invalid_frame — a line that is not a JSON object, a frame without a
// field and a frame that is too large.  The session stays open.
// ---------------------------------------------------------------------------

test("a frame that is not a JSON object is refused with invalid_frame and the session stays open", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");

  const mark = client.mark();
  client.send(42 as unknown as Record<string, unknown>);
  const error = await waitForFrame(client, mark, (frame) => frame.op === "error", "the error frame");
  assertError(error, "bad_frame", "invalid_frame");

  // The session is untouched: the child keeps running and the next frame is
  // answered as usual.
  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 1 } });
  const event = await waitForFrame(
    client,
    mark,
    (frame) => frame.op === "event" && frame.sid === "s1",
    "the event of the session",
  );
  assert.equal(event.seq, 1);
  assert.equal(daemon.sessionStatus("s1")?.live, true);
});

test("an array is refused with invalid_frame and the session stays open", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");

  const mark = client.mark();
  client.send([1, 2, 3] as unknown as Record<string, unknown>);
  const error = await waitForFrame(client, mark, (frame) => frame.op === "error", "the error frame");
  assertError(error, "bad_frame", "invalid_frame");

  assert.equal(daemon.sessionStatus("s1")?.live, true);
  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 1 } });
  const event = await waitForFrame(
    client,
    mark,
    (frame) => frame.op === "event" && frame.sid === "s1",
    "the event of the session",
  );
  assert.equal(event.seq, 1);
});

test("a frame without an op is refused with invalid_frame and the session stays open", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");

  const mark = client.mark();
  client.send({ sid: "s1", payload: { cmd: "emit" } });
  const error = await waitForFrame(client, mark, (frame) => frame.op === "error", "the error frame");
  // The op is missing, so the frame is invalid and not an unknown op.
  assertError(error, "bad_frame", "invalid_frame");

  assert.equal(daemon.sessionStatus("s1")?.live, true);
});

test("a frame without a required field is refused with invalid_frame and the session stays open", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");

  const mark = client.mark();
  // "send" without a payload and "hello" without a client id.
  client.send({ op: "send", sid: "s1" });
  const error = await waitForFrame(client, mark, (frame) => frame.op === "error", "the error frame");
  assertError(error, "bad_frame", "invalid_frame");

  const mark2 = client.mark();
  client.send({ op: "hello" });
  const error2 = await waitForFrame(client, mark2, (frame) => frame.op === "error", "the second error frame");
  assertError(error2, "bad_frame", "invalid_frame");

  // The session of the client is untouched by the two broken frames.
  assert.equal(daemon.sessionStatus("s1")?.live, true);
});

test("a line that is not JSON is refused with invalid_frame and the session stays open", async (t) => {
  const { daemon, client } = startRawHarness();
  t.after(() => daemon.close());

  client.write("{not json}");
  const error = await client.waitFor((frame) => frame.op === "error", "the error frame");
  assertError(error, "bad_json", "invalid_frame");

  // The connection is still alive: the next frame is answered.
  client.write(JSON.stringify({ op: "hello", clientId: "client-a" }));
  const hello = await client.waitFor((frame) => frame.op === "hello", "the hello answer");
  assert.equal(hello.op, "hello");
});

test("a line that is longer than MAX_FRAME_BYTES is refused with invalid_frame and the session stays open", async (t) => {
  const { daemon, client } = startRawHarness();
  t.after(() => daemon.close());

  client.write("x".repeat(MAX_FRAME_BYTES + 1));
  const error = await client.waitFor((frame) => frame.op === "error", "the error frame");
  assertError(error, "bad_json", "invalid_frame");

  // The connection is still alive: the next frame is answered.
  client.write(JSON.stringify({ op: "hello", clientId: "client-a" }));
  const hello = await client.waitFor((frame) => frame.op === "hello", "the hello answer");
  assert.equal(hello.op, "hello");
});

test("the stream stays in sync after a bad line", async (t) => {
  const { daemon, client } = startRawHarness();
  t.after(() => daemon.close());

  // A broken line and a good frame in the same chunk: the good frame is not
  // swallowed by the broken one.
  client.write("42", JSON.stringify({ op: "hello", clientId: "client-a" }));
  const error = await client.waitFor((frame) => frame.op === "error", "the error frame");
  assertError(error, "bad_frame", "invalid_frame");
  const hello = await client.waitFor((frame) => frame.op === "hello", "the hello answer");
  assert.equal(hello.op, "hello");
  assert.ok(hello.op === "hello" && hello.fence >= 1, "the daemon answered the hello");
  assert.equal(client.errors().length, 1, "the broken line produced exactly one error");
});

test("the daemon ignores the unknown fields of a frame", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  client.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000, v: 99, future: { a: 1 } });
  const hello = await client.waitFor((frame) => frame.op === "hello", { label: "the hello answer" });
  assert.equal(hello.op, "hello");
  assert.equal(client.frames.filter(isError).length, 0);
});

// ---------------------------------------------------------------------------
// §1 unknown_op — an op that is not in the catalog.  The session stays open.
// ---------------------------------------------------------------------------

test("an unknown op is refused with unknown_op and the session stays open", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");

  const mark = client.mark();
  client.send({ op: "prompt", task: "t-1", text: "hello" });
  const error = await waitForFrame(client, mark, (frame) => frame.op === "error", "the error frame");
  assertError(error, "bad_frame", "unknown_op");

  // The session keeps running.
  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 1 } });
  const event = await waitForFrame(
    client,
    mark,
    (frame) => frame.op === "event" && frame.sid === "s1",
    "the event of the session",
  );
  assert.equal(event.seq, 1);
  assert.equal(daemon.sessionStatus("s1")?.live, true);
});

test("an unknown op does not disturb the frames that follow it", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");

  const mark = client.mark();
  client.send({ op: "not-an-op" });
  await waitForFrame(client, mark, (frame) => frame.op === "error", "the error frame");

  // The daemon is still in sync: the ack of the session is accepted.
  client.send({ op: "ack", sid: "s1", seq: 1 });
  await waitFor(
    () => daemon.sessionStatus("s1")?.ackedSeq === 1,
    { label: "the ack of the session" },
  );
});

// ---------------------------------------------------------------------------
// §6 stale_epoch — the fencing token of the client is older than the current
// one.  The session stays open.
// ---------------------------------------------------------------------------

test("the frames of the client that lost the fence are refused with stale_epoch and the session stays open", async (t) => {
  const home = makeTempDir("daemon-errors-fence-");
  const daemon = new Botd({ home, storeFile: `${home}/sessions.json` }, { onFrame: () => {} });
  t.after(() => daemon.close());
  const first = new TestClient(daemon);
  const second = new TestClient(daemon);

  await first.hello("client-a", 60_000);
  await second.hello("client-b", 60_000);

  const mark = first.mark();
  first.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 1 } });
  const error = await waitForFrame(first, mark, (frame) => frame.op === "error", "the error frame");
  assertError(error, "stale_fence", "stale_epoch");

  // The session of the new client stays open and keeps working.
  await openSession(second, "s1");
  second.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 1 } });
  const event = await second.waitFor(
    (frame) => frame.op === "event" && frame.sid === "s1",
    { label: "the event of the session" },
  );
  assert.equal(event.seq, 1);
  assert.equal(daemon.sessionStatus("s1")?.live, true);
});

// ---------------------------------------------------------------------------
// §6 lease_expired — the lease TTL elapsed.  The session closes.
// ---------------------------------------------------------------------------

test("the expired lease refuses the input with lease_expired and keeps the session registered", async (t) => {
  const { daemon, client } = startHarness({ leaseTtlMs: 600, watchdogIntervalMs: 50 });
  t.after(() => daemon.close());

  await client.hello("client-a", 600);
  await openSession(client, "s1");

  await client.waitFor(
    (frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "paused",
    { timeoutMs: 4000, label: "the paused state" },
  );

  const mark = client.mark();
  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 1 } });
  const error = await waitForFrame(client, mark, (frame) => frame.op === "error", "the error frame");
  assertError(error, "lease_paused", "lease_expired");

  // The first expiry does not close the session: it is still registered.
  assert.ok(daemon.sessionStatus("s1"), "the session is still known");
  assert.equal(daemon.sessionStatus("s1")?.live, true);
});

test("the lease that expires twice closes the session", async (t) => {
  const { daemon, client } = startHarness({ leaseTtlMs: 300, watchdogIntervalMs: 50 });
  t.after(() => daemon.close());

  await client.hello("client-a", 300);
  await openSession(client, "s1");

  // The second expiry terminates the child: the session is closed.
  await client.waitFor(
    (frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "exited",
    { timeoutMs: 8000, label: "the exited state" },
  );
  assert.equal(daemon.sessionStatus("s1")?.live, false);
});

// ---------------------------------------------------------------------------
// §7 cancel_unknown_turn — no such turn is running.  The session stays open.
// ---------------------------------------------------------------------------

test("a cancel for a session that does not run is refused with cancel_unknown_turn and the session stays open", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");

  const mark = client.mark();
  client.send({ op: "cancel", sid: "s-unknown" });
  const error = await waitForFrame(client, mark, (frame) => frame.op === "error", "the error frame");
  assertError(error, "unknown_session", "cancel_unknown_turn");

  // The session of the client is untouched.
  assert.equal(daemon.sessionStatus("s1")?.live, true);
  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 1 } });
  const event = await waitForFrame(
    client,
    mark,
    (frame) => frame.op === "event" && frame.sid === "s1",
    "the event of the session",
  );
  assert.equal(event.seq, 1);
});

test("a cancel for a session that has exited is refused with cancel_unknown_turn and the session stays open", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");

  client.send({ op: "send", sid: "s1", payload: { cmd: "exit", code: 0 } });
  await client.waitFor(
    (frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "exited",
    { timeoutMs: 8000, label: "the exited state" },
  );

  const mark = client.mark();
  client.send({ op: "cancel", sid: "s1" });
  const error = await waitForFrame(client, mark, (frame) => frame.op === "error", "the error frame");
  assertError(error, "session_exited", "cancel_unknown_turn");

  // The daemon keeps serving the client.
  await openSession(client, "s2");
  assert.equal(daemon.sessionStatus("s2")?.live, true);
});

// ---------------------------------------------------------------------------
// §8 provider_error — the bot CLI failed, the message carries its text.  The
// session stays open.
// ---------------------------------------------------------------------------

test("the stderr of the child is reported as provider_error and the session stays open", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");

  const mark = client.mark();
  client.send({ op: "send", sid: "s1", payload: { cmd: "stderr", text: "boom" } });
  const error = await waitForFrame(client, mark, (frame) => frame.op === "error", "the error frame");
  assertError(error, "child_error", "provider_error");
  assert.equal(error.message, "boom", "the message carries the text of the child");

  // The session stays open: the child is still alive and keeps answering.
  assert.equal(daemon.sessionStatus("s1")?.live, true);
  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 1 } });
  const event = await waitForFrame(
    client,
    mark,
    (frame) => frame.op === "event" && frame.sid === "s1",
    "the event of the session",
  );
  assert.equal(event.seq, 1);
});

test("the child that exits with a non-zero code ends the session and the connection stays open", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");

  client.send({ op: "send", sid: "s1", payload: { cmd: "exit", code: 3 } });
  await client.waitFor(
    (frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "exited",
    { timeoutMs: 8000, label: "the exited state" },
  );
  assert.equal(daemon.sessionStatus("s1")?.live, false);

  // The daemon reports the exit as a state change, not as an error frame.
  assert.deepEqual(
    client.frames.filter(isError),
    [],
    "the exit of the child is reported with a state frame",
  );

  // The daemon does not close the connection: another session still runs.
  await openSession(client, "s2");
  assert.equal(daemon.sessionStatus("s2")?.live, true);
});

// ---------------------------------------------------------------------------
// The handshake of the daemon: a frame before the hello is refused.
// ---------------------------------------------------------------------------

test("a frame before the hello is refused with no_lease and the connection stays open", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  const mark = client.mark();
  client.send({ op: "open", sid: "s1", bot: { kind: "acp", command: CHILD_COMMAND } });
  const error = await waitForFrame(client, mark, (frame) => frame.op === "error", "the error frame");
  assert.equal(error.code, "no_lease");
  assert.equal(error.message, "send hello before other frames");

  // The hello opens the connection.
  await client.hello("client-a", 60_000);
  await openSession(client, "s1");
  assert.equal(daemon.sessionStatus("s1")?.live, true);
});

// ---------------------------------------------------------------------------
// The rows of the table the daemon cannot produce from the wire yet.
// ---------------------------------------------------------------------------

test("a handshake with an unsupported version is refused with version_unsupported and the session closes", async (t) => {
  t.todo("the daemon has no version negotiation: it ignores the version of the client");
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  client.send({ op: "hello", clientId: "client-a", v: 99 });
  const answer = await client.waitFor(
    (frame) => frame.op === "error" || frame.op === "hello",
    "the answer of the daemon",
  );
  assertError(answer, "version_unsupported", "version_unsupported");
});

test("a turn that does not stop in time is refused with cancel_timeout and the session stays open", async (t) => {
  t.todo("the daemon escalates the cancel to a SIGKILL and reports no error frame");
  const { daemon, client } = startHarness({ cancelGraceMs: 100, cancelKillGraceMs: 100 });
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");
  client.send({ op: "send", sid: "s1", payload: { cmd: "ignore-sigint" } });

  const mark = client.mark();
  client.send({ op: "cancel", sid: "s1" });
  const answer = await waitForFrame(
    client,
    mark,
    (frame) => frame.op === "error" || (frame.op === "state" && frame.state === "exited"),
    "the answer of the daemon",
  );
  assertError(answer, "cancel_timeout", "cancel_timeout");
});

test("a resume of a session that is gone is refused with resume_unavailable and the session stays open", async (t) => {
  t.todo("the daemon reports the hole of a gone session with a gap frame, not with an error frame");
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  const mark = client.mark();
  client.send({ op: "resume", sid: "s-unknown", fromSeq: 1 });
  const error = await waitForFrame(client, mark, (frame) => frame.op === "error", "the error frame");
  assertError(error, "resume_unavailable", "resume_unavailable");
});
