// Conformance of the resume of botd/PROTOCOL.md.
//
// Covered: §4 (the replay of the buffered events, the gap of the events the
// ring buffer dropped, the unknown session) and §3 (a client that reconnects
// keeps its lease).
//
// The frames are written as raw NDJSON lines and the answers are read from
// the raw stream. The child of the sessions is the local fixture of the
// harness; no host, token or name shows up here.

import test from "node:test";
import assert from "node:assert/strict";

import { FAKE_CHILD, startHarness, waitFor } from "../helpers.ts";
import { RawClient } from "./raw-client.ts";

const CHILD_COMMAND = [process.execPath, FAKE_CHILD];

/** Open a session and wait until the child of the session runs. */
async function openSession(client: RawClient, sid: string): Promise<void> {
  client.send({ op: "open", sid, bot: { kind: "acp", command: CHILD_COMMAND } });
  await client.waitFor(
    (frame) => frame.op === "state" && frame.sid === sid && frame.state === "running",
    { label: `the running state of ${sid}` },
  );
}

test("replays the events after the acknowledgement when the client reconnects", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const first = new RawClient(daemon);

  first.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000 });
  const helloA = await first.waitForOp("hello");
  await openSession(first, "s1");

  first.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 3 } });
  await first.waitFor((frame) => frame.op === "event" && frame.seq === 3, {
    label: "the third event",
  });

  // The client confirms the events up to the second one.
  first.send({ op: "ack", sid: "s1", seq: 2 });
  await waitFor(() => daemon.sessionStatus("s1")?.ackedSeq === 2, {
    label: "the acknowledgement",
  });

  // The transport breaks: the client connects again with the same id.
  const second = new RawClient(daemon);
  second.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000 });
  const helloB = await second.waitForOp("hello");
  assert.equal(helloB.leaseId, helloA.leaseId, "the reconnect lost the lease");
  assert.equal(helloB.fence, helloA.fence, "the reconnect lost the fence");

  // PROTOCOL.md §4: the client resumes with fromSeq = ackedSeq + 1.
  const fromSeq = (daemon.sessionStatus("s1")?.ackedSeq ?? 0) + 1;
  assert.equal(fromSeq, 3);
  const mark = second.mark();
  second.send({ op: "resume", sid: "s1", fromSeq });

  const replayed = await waitFor(
    () => {
      const events = second.sinceMark(mark).filter((frame) => frame.op === "event");
      return events.length >= 1 ? events : undefined;
    },
    { label: "the replay" },
  );

  // Only the events the client did not confirm are replayed.
  assert.deepEqual(
    replayed.map((frame) => frame.seq),
    [3],
  );

  // The replay is answered with the state of the session (§4).
  const state = second.sinceMark(mark).find((frame) => frame.op === "state");
  assert.ok(state, "the resume was not answered with a state frame");
  assert.equal(state.sid, "s1");
  assert.equal(state.state, "running");
});

test("reports the gap of the events the ring buffer dropped", async (t) => {
  const { daemon } = startHarness({ ringMaxEvents: 2 });
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  client.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000 });
  await client.waitForOp("hello");
  await openSession(client, "s1");

  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 5 } });
  await client.waitFor((frame) => frame.op === "event" && frame.seq === 5, {
    label: "the fifth event",
  });

  // PROTOCOL.md §4: the events that the ring buffer dropped are reported as
  // a gap before the events that survived.
  const mark = client.mark();
  client.send({ op: "resume", sid: "s1", fromSeq: 1 });
  const gap = await client.waitFor((frame) => frame.op === "gap" && frame.sid === "s1", {
    label: "the gap frame",
  });
  assert.equal(gap.fromSeq, 1);
  assert.equal(gap.toSeq, 3);

  const replayed = await waitFor(
    () => {
      const events = client.sinceMark(mark).filter((frame) => frame.op === "event");
      return events.length >= 2 ? events : undefined;
    },
    { label: "the replay" },
  );
  assert.deepEqual(
    replayed.map((frame) => frame.seq),
    [4, 5],
  );
});

test("refuses the resume of an unknown session with unknown_session", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  client.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000 });
  await client.waitForOp("hello");

  // PROTOCOL.md §4: an unknown sid is refused with unknown_session.
  client.send({ op: "resume", sid: "s1", fromSeq: 1 });
  const error = await client.waitForError("unknown_session");
  assert.equal(error.op, "error");
  assert.equal(error.sid, "s1");
});
