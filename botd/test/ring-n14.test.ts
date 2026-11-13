// Boundary cases of the bounded event ring (botd/src/ring.ts) for the N14 card.
//
// Covered here: the count bound at its edges (a capacity of one, a ring
// filled to exactly its capacity and the ring that is full again after a
// wrap-around), the order of the events after the ring wrapped around, the
// reads that start before the oldest retained event, the read of the latest
// sequence, the read beyond it and the read of an empty ring, and the fact
// that a read hands out a copy of the list of events.
//
// Not covered here (owned elsewhere): the basics live in ring.test.ts, the
// byte budget, clear(), estimateBytes() and the known bugs of the module
// live in ring-edge.test.ts.
//
// Known bug (recorded as a todo below, the sources are not touched):
//   - a read hands out the buffered events themselves, so a caller that
//     mutates a returned event changes what the ring holds.
//
// The payloads are synthetic and the tests do no I/O and use no timer.

import test from "node:test";
import assert from "node:assert/strict";

import { EventRing, estimateBytes } from "../src/ring.ts";

// ---------------------------------------------------------------------------
// The count bound (the capacity of the ring).
// ---------------------------------------------------------------------------

test("a ring with a capacity of one keeps only the newest event", () => {
  const ring = new EventRing(1, 1 << 20);
  ring.push(1, "first");
  ring.push(2, "second");

  assert.equal(ring.size, 1, "the ring holds a single event");
  assert.equal(ring.lastSeq, 2);
  assert.equal(ring.evictedThroughSeq, 1, "the first event made room for the second");
  assert.deepEqual(
    ring.since(2).events.map((event) => event.payload),
    ["second"],
  );
  assert.equal(ring.byteSize, estimateBytes("second"), "only the newest event is accounted");
});

test("a ring with a capacity of one reports the hole of the event it dropped", () => {
  const ring = new EventRing(1, 1 << 20);
  for (let seq = 1; seq <= 3; seq += 1) ring.push(seq, `line-${seq}`);

  assert.equal(ring.size, 1);
  assert.equal(ring.evictedThroughSeq, 2, "the two first events were dropped");

  const { events, gap } = ring.since(1);
  assert.deepEqual(gap, { fromSeq: 1, toSeq: 2 }, "the dropped events are the hole");
  assert.deepEqual(
    events.map((event) => event.payload),
    ["line-3"],
  );
});

test("a ring filled to exactly its capacity keeps every event", () => {
  const ring = new EventRing(3, 1 << 20);
  for (let seq = 1; seq <= 3; seq += 1) ring.push(seq, `line-${seq}`);

  assert.equal(ring.size, 3, "the ring is full but not over the bound");
  assert.equal(ring.evictedThroughSeq, 0, "nothing was dropped");
  assert.equal(
    ring.byteSize,
    estimateBytes("line-1") + estimateBytes("line-2") + estimateBytes("line-3"),
    "the full ring is accounted for",
  );

  const { events, gap } = ring.since(1);
  assert.equal(gap, null, "the range is complete");
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2, 3],
  );
  assert.deepEqual(
    events.map((event) => event.payload),
    ["line-1", "line-2", "line-3"],
  );
});

test("a ring that is filled again after a wrap-around is full again", () => {
  const ring = new EventRing(3, 1 << 20);
  for (let seq = 1; seq <= 3; seq += 1) ring.push(seq, `line-${seq}`);
  assert.equal(ring.size, 3, "the ring is full");
  assert.equal(ring.evictedThroughSeq, 0);

  for (let seq = 4; seq <= 6; seq += 1) ring.push(seq, `line-${seq}`);

  assert.equal(ring.size, 3, "the ring is full again");
  assert.equal(ring.evictedThroughSeq, 3, "the first round was dropped as a whole");
  assert.equal(ring.lastSeq, 6);
  assert.deepEqual(
    ring.since(4).events.map((event) => event.payload),
    ["line-4", "line-5", "line-6"],
  );
});

// ---------------------------------------------------------------------------
// The order of the events after the ring wrapped around.
// ---------------------------------------------------------------------------

test("the events keep their push order after the ring wrapped around", () => {
  const ring = new EventRing(3, 1 << 20);
  for (let seq = 1; seq <= 8; seq += 1) ring.push(seq, `line-${seq}`);

  assert.equal(ring.size, 3);
  assert.equal(ring.evictedThroughSeq, 5, "the first five events were dropped");
  assert.deepEqual(
    ring.since(6).events.map((event) => event.seq),
    [6, 7, 8],
    "the oldest event of the ring comes first",
  );
  assert.deepEqual(
    ring.since(6).events.map((event) => event.payload),
    ["line-6", "line-7", "line-8"],
  );
});

test("a ring that wrapped around several times keeps the newest events in order", () => {
  const ring = new EventRing(2, 1 << 20);
  for (let seq = 1; seq <= 9; seq += 1) ring.push(seq, `line-${seq}`);

  assert.equal(ring.size, 2);
  assert.equal(ring.lastSeq, 9);
  assert.equal(ring.evictedThroughSeq, 7, "every event but the last two was dropped");
  assert.deepEqual(
    ring.since(8).events.map((event) => event.seq),
    [8, 9],
  );
  assert.deepEqual(
    ring.since(8).events.map((event) => event.payload),
    ["line-8", "line-9"],
  );
});

// ---------------------------------------------------------------------------
// The reads.
// ---------------------------------------------------------------------------

test("a read from before the oldest retained event reports the hole and the survivors", () => {
  const ring = new EventRing(3, 1 << 20);
  for (let seq = 1; seq <= 5; seq += 1) ring.push(seq, `line-${seq}`);

  assert.equal(ring.evictedThroughSeq, 2, "the first two events were dropped");

  const { events, gap } = ring.since(2);
  assert.deepEqual(gap, { fromSeq: 2, toSeq: 2 }, "the hole ends at the evicted marker");
  assert.deepEqual(
    events.map((event) => event.payload),
    ["line-3", "line-4", "line-5"],
    "the oldest retained event is still delivered",
  );

  const older = ring.since(1);
  assert.deepEqual(older.gap, { fromSeq: 1, toSeq: 2 }, "the hole starts at the asked sequence");
  assert.deepEqual(
    older.events.map((event) => event.seq),
    [3, 4, 5],
  );
});

test("a read from before the oldest retained event reports the whole hole after several wrap-arounds", () => {
  const ring = new EventRing(2, 1 << 20);
  for (let seq = 1; seq <= 7; seq += 1) ring.push(seq, `line-${seq}`);

  assert.equal(ring.evictedThroughSeq, 5);

  const { events, gap } = ring.since(3);
  assert.deepEqual(gap, { fromSeq: 3, toSeq: 5 }, "the hole spans every dropped sequence");
  assert.deepEqual(
    events.map((event) => event.payload),
    ["line-6", "line-7"],
  );
});

test("a read of the latest sequence returns that event only", () => {
  const ring = new EventRing(3, 1 << 20);
  for (let seq = 1; seq <= 5; seq += 1) ring.push(seq, `line-${seq}`);

  const { events, gap } = ring.since(ring.lastSeq);
  assert.equal(gap, null, "the peer is only one event behind, there is no hole");
  assert.deepEqual(
    events.map((event) => event.seq),
    [5],
  );
  assert.deepEqual(
    events.map((event) => event.payload),
    ["line-5"],
  );
});

test("a read beyond the latest sequence returns nothing and leaves the ring alone", () => {
  const ring = new EventRing(2, 1 << 20);
  for (let seq = 1; seq <= 5; seq += 1) ring.push(seq, `line-${seq}`);

  const before = { size: ring.size, lastSeq: ring.lastSeq, bytes: ring.byteSize };

  const { events, gap } = ring.since(ring.lastSeq + 1);
  assert.deepEqual(events, [], "the peer is up to date");
  assert.equal(gap, null, "there is nothing to bridge");

  assert.equal(ring.size, before.size, "a read does not consume the events");
  assert.equal(ring.lastSeq, before.lastSeq);
  assert.equal(ring.byteSize, before.bytes);
  assert.deepEqual(
    ring.since(4).events.map((event) => event.payload),
    ["line-4", "line-5"],
    "the ring still holds the events after the read",
  );
});

test("a read of an empty ring returns no events and no hole", () => {
  const ring = new EventRing(3, 1 << 20);

  const { events, gap } = ring.since(1);
  assert.deepEqual(events, []);
  assert.equal(gap, null, "nothing was ever dropped");
  assert.equal(ring.size, 0);
  assert.equal(ring.lastSeq, 0);
});

// ---------------------------------------------------------------------------
// The copies a read hands out.
// ---------------------------------------------------------------------------

test("a read hands out a copy of the list of events", () => {
  const ring = new EventRing(3, 1 << 20);
  ring.push(1, "line-1");
  ring.push(2, "line-2");

  const first = ring.since(1);
  assert.deepEqual(
    first.events.map((event) => event.seq),
    [1, 2],
  );

  // The list that comes back belongs to the caller.
  first.events.pop();
  first.events.push({ seq: 99, payload: "injected", bytes: 0 });
  first.events.length = 0;

  const second = ring.since(1);
  assert.deepEqual(
    second.events.map((event) => event.seq),
    [1, 2],
    "the ring still holds both events",
  );
  assert.notEqual(second.events, first.events, "every read hands out its own list");
});

test("a read hands out copies of the events themselves", {
  todo: "DEFECT: since() returns the buffered events by reference, so a caller that mutates a returned event changes what the ring holds",
}, () => {
  const ring = new EventRing(2, 1 << 20);
  ring.push(1, "one");
  ring.push(2, "two");

  const { events } = ring.since(1);
  const handed = events[0] as { seq: number; payload: unknown; bytes: number };
  handed.payload = "mutated";
  handed.bytes = 1000;

  const again = ring.since(1);
  assert.deepEqual(again.events[0].payload, "one", "the ring still holds the original payload");
  assert.equal(again.events[0].bytes, estimateBytes("one"), "the size of the buffered event is unchanged");

  ring.push(3, "three");
  assert.ok(ring.byteSize >= 0, `the byte budget of the ring stays sane, got ${ring.byteSize}`);
});
