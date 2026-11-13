// Edge cases of the resume and of the gap replay.
//
// Two journals are covered: the bounded ring buffer of a live session
// (botd/src/ring.ts) and the durable session log (botd/src/session-log.ts).
// Both answer the same question — "which frames can I still replay?" — so
// the edge cases of one are the edge cases of the other.
//
// The protocol rules are checked against the code (not against the wording of
// the document, which protocol-doc.test.ts owns): a gap is an inclusive range,
// a replayed frame keeps its original sequence number and a range the journal
// does not hold any more is `resume_unavailable`.
//
// Fixtures are synthetic: no real host, token or name shows up here.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { EventRing, estimateBytes } from "../src/ring.ts";
import { SessionLog } from "../src/session-log.ts";
import type { SessionEvent, SessionStat } from "../src/session-log.ts";
import { FAKE_CHILD, isEvent, isGap, startHarness, waitFor } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const TMP_ROOT = path.join(REPO_ROOT, "botd", ".tmp", "replay-edge-test");

/** A throw away botd home inside the worktree. */
function tempHome(name: string): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TMP_ROOT, `${name}-`));
}

/** The sequence numbers of a list of events. */
function seqs(events: SessionEvent[]): number[] {
  return events.map((event) => event.seq);
}

/** The answer of a replay, as PROTOCOL.md §5 describes it. */
type ReplayAnswer =
  | { status: "ok"; events: SessionEvent[] }
  | { status: "resume_unavailable"; missing: { from: number; to: number } };

/**
 * Replay the journal of a session the way PROTOCOL.md §5 describes it.
 *
 * The CP asks for `fromSeq` and the journal answers with the frames it still
 * holds. When the journal does not hold the range any more the answer is
 * `resume_unavailable` and the CP restarts the task with a fresh session.
 */
function replay(log: SessionLog, sid: string, fromSeq: number): ReplayAnswer {
  const stat = log.stat(sid);
  if (stat.firstSeq !== null && fromSeq < stat.firstSeq) {
    return { status: "resume_unavailable", missing: { from: fromSeq, to: stat.firstSeq - 1 } };
  }
  return { status: "ok", events: log.read(sid, fromSeq) };
}

/** True when the numbers are strictly increasing and without a hole. */
function isContiguous(values: number[]): boolean {
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] !== values[i - 1] + 1) return false;
  }
  return true;
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
// The durable session log.
// ---------------------------------------------------------------------------

test("read() at the head and at head+1", () => {
  const home = tempHome("head");
  const log = new SessionLog({ home });
  const sid = "sess-head";
  for (let i = 0; i < 4; i += 1) log.append(sid, { type: "evt", payload: { i } });

  const head = log.read(sid, 4);
  assert.deepEqual(seqs(head), [4], "the head is replayed");
  assert.deepEqual(log.read(sid, 5), [], "head+1 is empty");

  // The log agrees with the ring: nothing is reported as a gap.
  const answer = replay(log, sid, 4);
  assert.equal(answer.status, "ok");
  assert.deepEqual(seqs(answer.status === "ok" ? answer.events : []), [4]);

  log.close();
});

test("read() below the oldest retained sequence returns the retained tail", () => {
  const home = tempHome("below-oldest");
  const log = new SessionLog({ home, maxSegmentBytes: 1024, keepSegments: 2 });
  const sid = "sess-below";
  for (let i = 0; i < 8; i += 1) log.append(sid, { type: "evt", payload: { i, big: "x".repeat(900) } });

  const stat = log.stat(sid);
  assert.ok(stat.firstSeq !== null && stat.firstSeq > 1, "the oldest events are gone");
  assert.equal(stat.lastSeq, 8);

  // The read starts at the oldest event that is still on disk.
  const events = log.read(sid, 1);
  assert.deepEqual(
    seqs(events),
    Array.from({ length: stat.lastSeq! - stat.firstSeq! + 1 }, (_unused, i) => stat.firstSeq! + i),
  );
  assert.ok(isContiguous(seqs(events)), "the retained events are contiguous");

  log.close();
});

test("compact() drops the acknowledged segments while a reader holds a range", () => {
  const home = tempHome("compact-reader");
  const log = new SessionLog({ home, maxSegmentBytes: 1024, keepSegments: 50 });
  const sid = "sess-compact-reader";
  for (let i = 0; i < 10; i += 1) log.append(sid, { type: "evt", payload: { i, big: "x".repeat(2000) } });

  // The reader picks a range out of the journal.
  const held = log.read(sid, 3, 2);
  assert.deepEqual(seqs(held), [3, 4]);

  const result = log.compact(sid, 4);
  assert.equal(result.removedSegments, 4);
  assert.equal(result.firstSeq, 5);

  // The reader still holds its events, the journal does not.
  assert.deepEqual(seqs(held), [3, 4], "the snapshot of the reader is untouched");
  assert.deepEqual(seqs(log.read(sid, 3)), [5, 6, 7, 8, 9, 10]);

  // The range the reader holds is gone: the replay is not available any more.
  const answer = replay(log, sid, 3);
  assert.equal(answer.status, "resume_unavailable");
  if (answer.status === "resume_unavailable") {
    assert.deepEqual(answer.missing, { from: 3, to: 4 }, "the hole is inclusive");
  }

  // A range that is still on disk is replayed.
  const kept = replay(log, sid, 5);
  assert.equal(kept.status, "ok");
  assert.deepEqual(seqs(kept.status === "ok" ? kept.events : []), [5, 6, 7, 8, 9, 10]);

  log.close();
});

test("the retention by the segment count evicts the oldest segment", () => {
  const home = tempHome("retention-count");
  const log = new SessionLog({ home, maxSegmentBytes: 1024, keepSegments: 3 });
  const sid = "sess-retention-count";
  for (let i = 0; i < 10; i += 1) log.append(sid, { type: "evt", payload: { i, big: "x".repeat(2000) } });

  const stat = log.stat(sid);
  assert.ok(stat.segments <= 3, `expected at most 3 segments, got ${stat.segments}`);
  assert.equal(stat.closedSegments, 2);
  assert.equal(stat.firstSeq, 8, "the oldest segments are dropped");
  assert.equal(stat.lastSeq, 10);

  const events = log.read(sid);
  assert.deepEqual(seqs(events), [8, 9, 10]);
  assert.ok(isContiguous(seqs(events)));

  log.close();
});

test("the retention by the segment size rotates the log and evicts the oldest events", () => {
  const home = tempHome("retention-bytes");
  // The events are small enough to share a segment: the rotation follows the
  // byte budget and not the number of events.
  const log = new SessionLog({ home, maxSegmentBytes: 1024, keepSegments: 2 });
  const sid = "sess-retention-bytes";
  for (let i = 0; i < 12; i += 1) log.append(sid, { type: "evt", payload: { i, big: "x".repeat(300) } });

  const stat = log.stat(sid);
  assert.ok(stat.segments <= 2, `expected at most 2 segments, got ${stat.segments}`);
  assert.ok(stat.closedSegments >= 1, "the log rotated");

  const files = fs
    .readdirSync(path.join(home, "sessions"))
    .filter((name) => name.startsWith(`${sid}.ndjson`));
  assert.equal(files.length, stat.segments, "one file per segment");

  // Every segment stays inside the byte budget and holds more than one event.
  const closed = files.filter((name) => name !== `${sid}.ndjson`);
  assert.ok(closed.length >= 1);
  for (const name of closed) {
    const file = path.join(home, "sessions", name);
    const size = fs.statSync(file).size;
    assert.ok(size <= 1024, `segment ${name} is ${size} bytes`);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
    assert.ok(lines.length >= 2, `segment ${name} holds ${lines.length} events`);
  }

  // The oldest events are gone, the newest ones are still there.
  assert.ok(stat.firstSeq !== null && stat.firstSeq > 1);
  assert.equal(stat.lastSeq, 12);
  assert.ok(isContiguous(seqs(log.read(sid))));

  log.close();
});

test("a replay of an evicted range is resume_unavailable", () => {
  const home = tempHome("resume-unavailable");
  const log = new SessionLog({ home, maxSegmentBytes: 1024, keepSegments: 2 });
  const sid = "sess-resume-unavailable";
  for (let i = 0; i < 10; i += 1) log.append(sid, { type: "evt", payload: { i, big: "x".repeat(900) } });

  const stat = log.stat(sid);
  const oldest = stat.firstSeq ?? 0;
  assert.ok(oldest > 1, "the oldest events were evicted");

  const answer = replay(log, sid, 1);
  assert.equal(answer.status, "resume_unavailable");
  if (answer.status === "resume_unavailable") {
    assert.deepEqual(answer.missing, { from: 1, to: oldest - 1 }, "the hole is inclusive");
  }

  // The CP restarts the task with a fresh session: the events it needs are
  // the ones that are still on disk.
  const fresh = replay(log, sid, oldest);
  assert.equal(fresh.status, "ok");
  if (fresh.status === "ok") {
    assert.deepEqual(seqs(fresh.events), Array.from({ length: stat.lastSeq! - oldest + 1 }, (_u, i) => oldest + i));
  }

  log.close();
});

test("an acknowledgement beyond the head drops nothing that is not on disk", () => {
  const home = tempHome("ack-beyond-head");
  const log = new SessionLog({ home, maxSegmentBytes: 1024, keepSegments: 50 });
  const sid = "sess-ack-beyond";
  for (let i = 0; i < 6; i += 1) log.append(sid, { type: "evt", payload: { i, big: "x".repeat(2000) } });

  const result = log.compact(sid, 9999);
  assert.equal(result.removedSegments, 5, "every closed segment is acknowledged");
  assert.equal(result.lastSeq, 6, "the head does not move");

  // Nothing beyond the head exists, so nothing else can be dropped.
  const stat = log.stat(sid);
  assert.equal(stat.lastSeq, 6);
  assert.equal(stat.events, 1, "the active segment is never dropped");
  assert.deepEqual(seqs(log.read(sid)), [6]);

  // The range that is gone is reported as unavailable, not as a short replay.
  const answer = replay(log, sid, 1);
  assert.equal(answer.status, "resume_unavailable");
  if (answer.status === "resume_unavailable") {
    assert.deepEqual(answer.missing, { from: 1, to: 5 });
  }

  log.close();
});

test("paging the replay yields no duplicate and no hole", () => {
  const home = tempHome("paging");
  const log = new SessionLog({ home, maxSegmentBytes: 1024, keepSegments: 50 });
  const sid = "sess-paging";
  for (let i = 0; i < 11; i += 1) log.append(sid, { type: "evt", payload: { i, big: "x".repeat(900) } });

  const seen: number[] = [];
  let from = 1;
  for (;;) {
    const page = log.read(sid, from, 3);
    if (page.length === 0) break;
    seen.push(...seqs(page));
    from = page[page.length - 1].seq + 1;
  }

  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.ok(isContiguous(seen), "the pages cover the log without a hole");
  assert.equal(new Set(seen).size, seen.length, "no event is replayed twice");

  // A page that starts behind the head is empty, a limit of zero is empty.
  assert.deepEqual(log.read(sid, 12), []);
  assert.deepEqual(log.read(sid, 1, 0), []);

  log.close();
});

test("the sequence continues when the log is reopened", () => {
  const home = tempHome("restart");
  const log = new SessionLog({ home, maxSegmentBytes: 1024, keepSegments: 50 });
  const sid = "sess-restart";
  for (let i = 0; i < 9; i += 1) log.append(sid, { type: "evt", payload: { i, big: "x".repeat(900) } });
  log.close();

  // A new process picks the journal up.
  const reopened = new SessionLog({ home });
  const stat: SessionStat = reopened.stat(sid);
  assert.equal(stat.events, 9);
  assert.equal(stat.firstSeq, 1);
  assert.equal(stat.lastSeq, 9);
  assert.equal(stat.nextSeq, 10);
  assert.deepEqual(seqs(reopened.read(sid)), [1, 2, 3, 4, 5, 6, 7, 8, 9]);

  // The sequence continues where it stopped, no number is used twice.
  const appended = reopened.append(sid, { type: "evt", payload: { i: 9 } });
  assert.equal(appended.seq, 10);
  assert.deepEqual(seqs(reopened.read(sid)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  reopened.close();
});

test("an append between two pages is neither lost nor duplicated", () => {
  const home = tempHome("concurrent");
  const log = new SessionLog({ home, maxSegmentBytes: 512, keepSegments: 100 });
  const sid = "sess-concurrent";

  for (let i = 0; i < 3; i += 1) log.append(sid, { type: "evt", payload: { i } });

  // The reader pages through the journal while the writer appends.
  const first = log.read(sid, 1, 2);
  assert.deepEqual(seqs(first), [1, 2]);

  log.append(sid, { type: "evt", payload: { i: 3 } });
  log.append(sid, { type: "evt", payload: { i: 4 } });

  const second = log.read(sid, 3, 10);
  assert.deepEqual(seqs(second), [3, 4, 5]);
  for (const event of second) {
    assert.equal(event.type, "evt");
    assert.ok(event.payload !== null, "a record is never half written");
  }

  const seen = [...seqs(first), ...seqs(second)];
  assert.ok(isContiguous(seen), "the pages stay contiguous while the writer appends");
  assert.equal(new Set(seen).size, seen.length, "no event is replayed twice");
  assert.deepEqual(seqs(log.read(sid)), [1, 2, 3, 4, 5]);

  log.close();
});

test("a torn last line of a segment is skipped", () => {
  const home = tempHome("torn");
  const log = new SessionLog({ home, maxSegmentBytes: 1024, keepSegments: 50 });
  const sid = "sess-torn";
  for (let i = 0; i < 6; i += 1) log.append(sid, { type: "evt", payload: { i, big: "x".repeat(2000) } });
  log.close();

  // A crash in the middle of a write leaves half a line behind.
  const closed = path.join(home, "sessions", `${sid}.ndjson.3`);
  fs.appendFileSync(closed, '{"seq":4,"ts":1,"type":"evt","payl');

  const reopened = new SessionLog({ home });
  const events = reopened.read(sid);
  assert.deepEqual(seqs(events), [1, 2, 3, 4, 5, 6], "the torn line is skipped");
  assert.ok(isContiguous(seqs(events)), "the complete records stay contiguous");

  // The repaired file holds complete records only.
  const raw = fs.readFileSync(closed, "utf8");
  assert.ok(raw.endsWith("\n"), "the torn line is gone");
  for (const line of raw.split("\n").filter((entry) => entry.length > 0)) {
    assert.equal(typeof (JSON.parse(line) as { seq: number }).seq, "number");
  }

  // The log keeps working after the repair.
  assert.equal(reopened.append(sid, { type: "evt", payload: { i: 6 } }).seq, 7);
  reopened.close();
});

test("a corrupt line in the middle of a segment is skipped", () => {
  const home = tempHome("corrupt");
  const log = new SessionLog({ home, maxSegmentBytes: 1 << 20, keepSegments: 50 });
  const sid = "sess-corrupt";
  for (let i = 0; i < 5; i += 1) log.append(sid, { type: "evt", payload: { i } });
  log.close();

  // One record of the segment is damaged, the others are intact.
  const active = path.join(home, "sessions", `${sid}.ndjson`);
  const lines = fs.readFileSync(active, "utf8").split("\n").filter((line) => line.length > 0);
  lines[2] = "{not json at all";
  fs.writeFileSync(active, `${lines.join("\n")}\n`);

  const reopened = new SessionLog({ home });
  const events = reopened.read(sid);
  assert.deepEqual(seqs(events), [1, 2, 4, 5], "the corrupt line is skipped");
  assert.deepEqual(
    events.map((event) => (event.payload as { i: number }).i),
    [0, 1, 3, 4],
    "the payloads of the surviving records are intact",
  );

  // The sequence continues after the damaged record.
  assert.equal(reopened.append(sid, { type: "evt", payload: { i: 5 } }).seq, 6);
  reopened.close();
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

test("the ring implements the gap and replay rules of the protocol", () => {
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
