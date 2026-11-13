// Conformance of the shape of the frames of botd/PROTOCOL.md.
//
// Covered: §2 (the op catalog: the fields of every frame), §4 (the sequence
// numbers of the events and the cumulative acknowledgement), §8 (the version
// of the daemon) and the statement of §2 that there is no envelope: a frame
// is a flat JSON object whose `op` names its kind.
//
// The frames are read from the raw NDJSON stream, so the test sees exactly
// what the daemon puts on the wire. The child of the sessions is the local
// fixture of the harness.

import test from "node:test";
import assert from "node:assert/strict";

import { BOTD_VERSION } from "../../src/protocol.ts";
import { FAKE_CHILD, startHarness, waitFor } from "../helpers.ts";
import { RawClient } from "./raw-client.ts";

const CHILD_COMMAND = [process.execPath, FAKE_CHILD];

/** The fields every frame of the daemon carries (§2). */
const FRAME_FIELDS: Record<string, string[]> = {
  hello: ["op", "botdVersion", "leaseId", "fence", "leaseTtlMs"],
  event: ["op", "sid", "seq", "payload"],
  state: ["op", "sid", "state", "progressAt"],
  error: ["op", "code", "message", "sid"],
  gap: ["op", "sid", "fromSeq", "toSeq"],
  stall: ["op", "sid", "idleMs"],
};

test("the frames of the daemon are flat objects without an envelope", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  client.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000 });
  await client.waitForOp("hello");

  client.send({
    op: "open",
    sid: "s1",
    bot: { kind: "acp", command: CHILD_COMMAND },
  });
  await client.waitFor(
    (frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "running",
    { label: "the running state of s1" },
  );

  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 2 } });
  await client.waitFor((frame) => frame.op === "event" && frame.seq === 2, {
    label: "the second event",
  });

  client.send({ op: "resume", sid: "s1", fromSeq: 1 });
  await client.waitFor((frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "running", {
    label: "the state of the resume",
  });

  const seen = new Set<string>();
  for (const frame of client.frames) {
    const op = String(frame.op);
    seen.add(op);
    const allowed = FRAME_FIELDS[op];
    assert.ok(allowed, `the daemon sent the unknown op "${op}"`);
    for (const key of Object.keys(frame)) {
      assert.ok(
        allowed.includes(key),
        `the ${op} frame carries the unknown field "${key}": ${JSON.stringify(frame)}`,
      );
    }
  }

  // The frames of the catalog went over the wire.
  assert.ok(seen.has("hello"));
  assert.ok(seen.has("event"));
  assert.ok(seen.has("state"));

  // PROTOCOL.md §1: one JSON object per line.
  assert.ok(client.lines.length > 0, "the daemon wrote no line");
  for (const line of client.lines) {
    assert.ok(
      line.startsWith("{") && line.endsWith("}"),
      `the daemon wrote a line that is not a JSON object: ${line}`,
    );
  }

  // PROTOCOL.md §2: there is no envelope. No frame carries the fields of the
  // retired envelope (v, ack, session, lease).
  for (const frame of client.frames) {
    for (const key of ["v", "ack", "session", "lease"]) {
      assert.ok(
        !(key in frame),
        `the frame ${JSON.stringify(frame)} carries the envelope field "${key}"`,
      );
    }
  }
});

test("the daemon announces its version in the answer to hello", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  client.send({ op: "hello", clientId: "client-a" });
  const hello = await client.waitForOp("hello");

  // PROTOCOL.md §8: botdVersion is the version of botd/src/protocol.ts.
  assert.equal(hello.botdVersion, BOTD_VERSION);
  assert.equal(hello.botdVersion, "0.1.0");

  // §8: there is no version field on the wire and no negotiation: the
  // answer carries the version and nothing else.
  assert.deepEqual(Object.keys(hello).sort(), ["botdVersion", "fence", "leaseId", "leaseTtlMs", "op"]);
});

test("numbers the events of a session from one", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  client.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000 });
  await client.waitForOp("hello");

  client.send({
    op: "open",
    sid: "s1",
    bot: { kind: "acp", command: CHILD_COMMAND },
  });
  await client.waitFor(
    (frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "running",
    { label: "the running state of s1" },
  );

  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 3 } });
  await client.waitFor((frame) => frame.op === "event" && frame.seq === 3, {
    label: "the third event",
  });

  // PROTOCOL.md §4: the sequence number starts at 1 and grows by one per
  // line of the child.
  const events = client.withOp("event");
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2, 3],
  );
  assert.ok(events.every((event) => event.sid === "s1"));
});

test("the acknowledgement is cumulative and never goes backwards", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  client.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000 });
  await client.waitForOp("hello");

  client.send({
    op: "open",
    sid: "s1",
    bot: { kind: "acp", command: CHILD_COMMAND },
  });
  await client.waitFor(
    (frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "running",
    { label: "the running state of s1" },
  );

  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 3 } });
  await client.waitFor((frame) => frame.op === "event" && frame.seq === 3, {
    label: "the third event",
  });

  client.send({ op: "ack", sid: "s1", seq: 2 });
  await client.waitFor(() => daemon.sessionStatus("s1")?.ackedSeq === 2, {
    label: "the first acknowledgement",
  });

  // An older acknowledgement does not lower the number (§4).
  client.send({ op: "ack", sid: "s1", seq: 1 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(daemon.sessionStatus("s1")?.ackedSeq, 2, "the ack went backwards");

  // The acknowledged number is kept in the session table (§4).
  const record = daemon.table().find((entry) => entry.sid === "s1");
  assert.ok(record, "the session is not in the table");
  assert.equal(record.ackedSeq, 2);
  assert.equal(record.lastSeq, 3);
});

test.todo(
  "PROTOCOL.md (retired §2): every frame carries the envelope fields v, seq and ack",
  async (t) => {
    // The task card asked for the envelope of the retired protocol version
    // (git 499d0fd): every frame carried `v` (the protocol version), `seq`
    // (the number of the frame) and `ack` (the number of the last frame of
    // the peer). The current document says the opposite: §2 "There is no
    // envelope: a frame is a flat JSON object whose `op` names its kind" and
    // §8 "There is no version field on the wire and no negotiation". The
    // daemon follows the document. See botd/test/conformance/DEVIATIONS.md
    // (D2).
    const { daemon } = startHarness();
    t.after(() => daemon.close());
    const client = new RawClient(daemon);

    client.send({ op: "hello", clientId: "client-a" });
    const hello = await client.waitForOp("hello");

    assert.equal("v" in hello, false, "the frame carries no version field");
    assert.equal("ack" in hello, false, "the frame carries no acknowledgement");
    assert.equal("seq" in hello, false, "the frame carries no frame number");
  },
);
