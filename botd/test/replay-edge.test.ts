// Edge cases of the resume and of the gap replay of a live session.
//
// Covered: the bounded ring buffer (botd/src/ring.ts) and the daemon's
// resume/ack/gap behaviour over the wire (botd/src/daemon.ts). A gap frame is
// an inclusive range [fromSeq, toSeq], a replayed frame keeps its original
// sequence number and an up-to-date peer gets no gap. The wording of the
// protocol document is not asserted here (protocol-doc.test.ts owns it).
//
// Known gap: nothing in botd/src emits `resume_unavailable`; a range that is no
// longer buffered is reported with a gap frame only.
//
// Fixtures are synthetic: no real host, token or name shows up here.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { EventRing, estimateBytes } from "../src/ring.ts";
import { FAKE_CHILD, isEvent, isGap, startHarness, waitFor } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const TMP_ROOT = path.join(REPO_ROOT, "botd", ".tmp", "replay-edge-test");

/** A throw away botd home inside the worktree. */
function tempHome(name: string): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TMP_ROOT, `${name}-`));
}


after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

// A daemon that is closed writes its session table one last time, sometimes
// after the hook above ran: the exit of the file removes what is left.
process.on("exit", () => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The ring buffer of a live session.
// ---------------------------------------------------------------------------

test("since() at the head replays the last event and reports no gap", () => {
  const ring = new EventRing(10, 1 << 20);
  for (let seq = 1; seq <= 5; seq += 1) ring.push(seq, `line-${seq}`);

  const { events, gap } = ring.since(5);
  assert.equal(gap, null, "the head is not a gap");
  assert.deepEqual(events.map((event) => event.seq), [5]);
  assert.equal(events[0].payload, "line-5", "the payload of the head survives");
});

test("since() at head+1 replays nothing and reports no gap", () => {
  const ring = new EventRing(10, 1 << 20);
  for (let seq = 1; seq <= 5; seq += 1) ring.push(seq, `line-${seq}`);

  const { events, gap } = ring.since(6);
  assert.equal(gap, null, "the peer is up to date, there is no hole");
  assert.deepEqual(events, []);
  assert.equal(ring.lastSeq, 5, "the head of the ring did not move");
});

test("since() below the oldest buffered event reports the gap with the exact range", () => {
  const ring = new EventRing(2, 1 << 20);
  for (let seq = 1; seq <= 5; seq += 1) ring.push(seq, `line-${seq}`);

  const { events, gap } = ring.since(1);
  assert.deepEqual(gap, { fromSeq: 1, toSeq: 3 }, "the hole is inclusive");
  assert.deepEqual(events.map((event) => event.seq), [4, 5]);

  // The hole always starts at the sequence the peer asked for.
  const partial = ring.since(2);
  assert.deepEqual(partial.gap, { fromSeq: 2, toSeq: 3 });
  assert.deepEqual(partial.events.map((event) => event.seq), [4, 5]);
});

test("since() at the eviction boundary reports a hole of exactly one sequence", () => {
  const ring = new EventRing(2, 1 << 20);
  for (let seq = 1; seq <= 5; seq += 1) ring.push(seq, `line-${seq}`);
  assert.equal(ring.evictedThroughSeq, 3);

  const { events, gap } = ring.since(3);
  assert.deepEqual(gap, { fromSeq: 3, toSeq: 3 });
  assert.deepEqual(events.map((event) => event.seq), [4, 5]);

  // One sequence later the buffer is complete again.
  const next = ring.since(4);
  assert.equal(next.gap, null);
  assert.deepEqual(next.events.map((event) => event.seq), [4, 5]);
});

test("the ring evicts by the event count", () => {
  const ring = new EventRing(3, 1 << 20);
  for (let seq = 1; seq <= 10; seq += 1) ring.push(seq, `line-${seq}`);

  assert.equal(ring.size, 3, "the count bound is respected");
  assert.equal(ring.lastSeq, 10);
  assert.equal(ring.evictedThroughSeq, 7, "the oldest events are dropped first");
  assert.deepEqual(
    ring.since(8).events.map((event) => event.seq),
    [8, 9, 10],
  );
});

test("the ring evicts by the byte budget", () => {
  // estimateBytes adds the framing overhead to the payload: a 64 byte string
  // costs 66 + 16 = 82 bytes.
  const ring = new EventRing(1000, 512);
  for (let seq = 1; seq <= 7; seq += 1) ring.push(seq, "x".repeat(64));

  assert.ok(ring.byteSize <= 512, `expected at most 512 bytes, got ${ring.byteSize}`);
  assert.equal(ring.size, 6, "the byte bound is respected");
  assert.equal(ring.evictedThroughSeq, 1, "the oldest event made room");
  assert.equal(ring.lastSeq, 7);
});

test("estimateBytes counts the payload and the framing overhead", () => {
  assert.equal(estimateBytes({ a: 1 }), '{"a":1}'.length + 16);
  assert.equal(estimateBytes("abc"), '"abc"'.length + 16);
  assert.equal(estimateBytes(undefined), "null".length + 16);
  assert.equal(estimateBytes(null), "null".length + 16);

  // A payload that cannot be serialized is measured without throwing.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(estimateBytes(circular), "[object Object]".length + 16);

  // The byte budget of the ring never drops below 256 bytes.
  const ring = new EventRing(10, 1);
  ring.push(1, "x".repeat(1000));
  assert.ok(ring.byteSize <= 256, `expected at most 256 bytes, got ${ring.byteSize}`);
});

test("an event bigger than the byte budget evicts itself", () => {
  const ring = new EventRing(10, 256);
  ring.push(1, "x".repeat(1000));

  assert.equal(ring.size, 0, "the oversized event does not fit");
  assert.equal(ring.evictedThroughSeq, 1);
  assert.equal(ring.lastSeq, 1);

  const { events, gap } = ring.since(1);
  assert.deepEqual(events, []);
  assert.deepEqual(gap, { fromSeq: 1, toSeq: 1 }, "the event itself is the hole");
});

test("clear() turns the whole buffer into a gap", () => {
  const ring = new EventRing(10, 1 << 20);
  for (let seq = 1; seq <= 4; seq += 1) ring.push(seq, `line-${seq}`);

  ring.clear();
  assert.equal(ring.size, 0);
  assert.equal(ring.byteSize, 0);

  const { events, gap } = ring.since(1);
  assert.deepEqual(events, []);
  assert.deepEqual(gap, { fromSeq: 1, toSeq: 4 }, "everything that was buffered is lost");
});

// ---------------------------------------------------------------------------
// The daemon: the resume of a live session and the binding to the document.
// ---------------------------------------------------------------------------

/** Open a session and wait until the child runs. */
async function openSession(client: TestClient, sid: string): Promise<void> {
  client.send({
    op: "open",
    sid,
    bot: { kind: "acp", command: [process.execPath, FAKE_CHILD] },
  });
  await client.waitFor(
    (frame) => frame.op === "state" && frame.sid === sid && frame.state === "running",
    { label: `the running state of ${sid}` },
  );
}

test("a resume at the head replays the last event of a live session", async (t) => {
  const { daemon, client } = startHarness({ home: tempHome("daemon") });
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");
  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 3 } });
  await client.waitFor((frame) => frame.op === "event" && frame.sid === "s1" && frame.seq === 3, {
    label: "the third event",
  });

  const mark = client.mark();
  client.send({ op: "resume", sid: "s1", fromSeq: 3 });
  const replayed = await waitFor(() => {
    const events = client.sinceMark(mark).filter(isEvent);
    return events.length >= 1 ? events : undefined;
  }, { label: "the replay of the head" });

  assert.deepEqual(replayed.map((event) => event.seq), [3], "the replay keeps the sequence number");
  assert.equal(client.sinceMark(mark).filter(isGap).length, 0, "the head is not a gap");
});

test("a resume at head+1 replays nothing and reports no gap", async (t) => {
  const { daemon, client } = startHarness({ home: tempHome("daemon") });
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");
  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 2 } });
  await client.waitFor((frame) => frame.op === "event" && frame.sid === "s1" && frame.seq === 2, {
    label: "the second event",
  });

  const mark = client.mark();
  client.send({ op: "resume", sid: "s1", fromSeq: 3 });
  await waitFor(
    () => client.sinceMark(mark).some((frame) => frame.op === "state" && frame.sid === "s1"),
    { label: "the state after the resume" },
  );

  assert.deepEqual(client.sinceMark(mark).filter(isEvent), [], "there is nothing to replay");
  assert.deepEqual(client.sinceMark(mark).filter(isGap), [], "the peer is up to date");
});

test("a resume below the oldest buffered event reports the hole with the inclusive range", async (t) => {
  const { daemon, client } = startHarness({ home: tempHome("daemon"), ringMaxEvents: 3 });
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");
  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 5 } });
  await client.waitFor((frame) => frame.op === "event" && frame.sid === "s1" && frame.seq === 5, {
    label: "the fifth event",
  });

  const mark = client.mark();
  client.send({ op: "resume", sid: "s1", fromSeq: 1 });
  const gap = await client.waitFor((frame) => frame.op === "gap" && frame.sid === "s1", {
    label: "the gap frame",
  });
  if (gap.op !== "gap") throw new Error("unreachable");
  assert.equal(gap.fromSeq, 1);
  assert.equal(gap.toSeq, 2, "the hole is inclusive");
  assert.ok(gap.fromSeq <= gap.toSeq);

  // The frames that survived are replayed, the hole is not.
  const replayed = await waitFor(() => {
    const events = client.sinceMark(mark).filter(isEvent);
    return events.length >= 3 ? events : undefined;
  }, { label: "the replay of the survivors" });
  assert.deepEqual(replayed.map((event) => event.seq), [3, 4, 5]);
});

test("an acknowledgement beyond the head is accepted and drops nothing", async (t) => {
  const { daemon, client } = startHarness({ home: tempHome("daemon") });
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");
  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 3 } });
  await client.waitFor((frame) => frame.op === "event" && frame.sid === "s1" && frame.seq === 3, {
    label: "the third event",
  });

  const mark = client.mark();
  client.send({ op: "ack", sid: "s1", seq: 9999 });
  await waitFor(() => daemon.sessionStatus("s1")?.ackedSeq === 9999, { label: "the ack" });
  assert.deepEqual(
    client.sinceMark(mark).filter((frame) => frame.op === "error"),
    [],
    "an ack beyond the head is not an error",
  );

  // The events are still buffered: the ack did not drop anything.
  const resumeMark = client.mark();
  client.send({ op: "resume", sid: "s1", fromSeq: 1 });
  const replayed = await waitFor(() => {
    const events = client.sinceMark(resumeMark).filter(isEvent);
    return events.length >= 3 ? events : undefined;
  }, { label: "the replay after the ack" });
  assert.deepEqual(replayed.map((event) => event.seq), [1, 2, 3]);
});

test("a daemon that lost the journal reports the whole range as a gap", async (t) => {
  const { daemon, client, home } = startHarness({ home: tempHome("daemon") });
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");
  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 3 } });
  await client.waitFor((frame) => frame.op === "event" && frame.sid === "s1" && frame.seq === 3, {
    label: "the third event",
  });
  // The acknowledgement writes the session table.
  client.send({ op: "ack", sid: "s1", seq: 1 });
  await waitFor(() => daemon.sessionStatus("s1")?.ackedSeq === 1, { label: "the ack" });
  await waitFor(() => fs.existsSync(path.join(home, "sessions.json")), {
    label: "the session table",
  });

  // The daemon dies with the transport: the table survives, the events do not.
  const second = tempHome("lost-journal");
  fs.copyFileSync(path.join(home, "sessions.json"), path.join(second, "sessions.json"));
  const { daemon: restarted, client: client2 } = startHarness({ home: second });
  t.after(() => restarted.close());

  await client2.hello("client-b", 60_000);
  const mark = client2.mark();
  client2.send({ op: "resume", sid: "s1", fromSeq: 2 });
  const gap = await client2.waitFor((frame) => frame.op === "gap" && frame.sid === "s1", {
    label: "the gap frame of the lost journal",
  });
  if (gap.op !== "gap") throw new Error("unreachable");
  assert.equal(gap.fromSeq, 2);
  assert.equal(gap.toSeq, 3, "the whole range is missing");
  assert.deepEqual(client2.sinceMark(mark).filter(isEvent), [], "nothing can be replayed");
});

test("the ring implements the gap and replay rules of the daemon", () => {
  // Inclusive hole, original seq kept, no gap for an up-to-date peer. The
  // wording of PROTOCOL.md is deliberately not asserted here (protocol-doc.test.ts owns it).
  const ring = new EventRing(2, 1 << 20);
  for (let seq = 1; seq <= 5; seq += 1) ring.push(seq, `line-${seq}`);
  const replayed = ring.since(1);
  assert.deepEqual(replayed.gap, { fromSeq: 1, toSeq: 3 }, "the hole is inclusive");
  assert.ok(replayed.gap !== null && replayed.gap.fromSeq <= replayed.gap.toSeq);
  assert.deepEqual(
    replayed.events.map((event) => event.seq),
    [4, 5],
    "the replay keeps the original sequence numbers",
  );
  assert.equal(ring.since(6).gap, null, "a peer that is up to date gets no gap");
});

test("resume_unavailable is emitted when the range is gone", { todo: "nothing in botd/src emits resume_unavailable; today only a gap frame is sent" }, () => {
  assert.fail("not implemented in src");
});
