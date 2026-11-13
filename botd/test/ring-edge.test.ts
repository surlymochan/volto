// Edge cases of the bounded event ring (botd/src/ring.ts).
//
// Covered: the two bounds of the buffer (the event count and the byte
// budget) at their exact boundaries, the gap that since() reports, the
// sequence numbers that do not grow monotonically, clear() and the
// measurement of a payload (estimateBytes). The basics live in ring.test.ts;
// the wording of the protocol document is not asserted here
// (protocol-doc.test.ts owns it).
//
// Known bugs (recorded as todos below, the sources are not touched):
//   - a non-monotonic push can hide an event that is still buffered;
//   - an event pushed after clear() below the evicted marker stays invisible.
//
// The payloads are synthetic and the tests do no I/O and use no timer.

import test from "node:test";
import assert from "node:assert/strict";

import { EventRing, estimateBytes } from "../src/ring.ts";

/** A payload whose wire cost is exactly `bytes` (the framing overhead is 16). */
function payloadOfBytes(bytes: number): string {
  return "x".repeat(bytes - 18);
}

// ---------------------------------------------------------------------------
// The bounds of the buffer.
// ---------------------------------------------------------------------------

test("the count bound keeps exactly maxEvents events at the boundary", () => {
  const ring = new EventRing(3, 1 << 20);
  for (let seq = 1; seq <= 3; seq += 1) ring.push(seq, `line-${seq}`);

  assert.equal(ring.size, 3, "the bound is reached but not exceeded");
  assert.equal(ring.evictedThroughSeq, 0, "nothing was dropped yet");
  assert.equal(ring.lastSeq, 3);
});

test("the count bound drops the oldest event when it is exceeded", () => {
  const ring = new EventRing(3, 1 << 20);
  for (let seq = 1; seq <= 4; seq += 1) ring.push(seq, `line-${seq}`);

  assert.equal(ring.size, 3, "the buffer never grows past the bound");
  assert.equal(ring.evictedThroughSeq, 1, "exactly one event was dropped");
  assert.equal(ring.lastSeq, 4);
  assert.deepEqual(
    ring.since(2).events.map((event) => event.seq),
    [2, 3, 4],
    "the oldest event is the one that went away",
  );
});

test("the count bound never drops the newest event", () => {
  const ring = new EventRing(1, 1 << 20);
  ring.push(1, "first");
  ring.push(2, "second");

  assert.equal(ring.size, 1);
  assert.equal(ring.evictedThroughSeq, 1);
  assert.deepEqual(
    ring.since(2).events.map((event) => event.payload),
    ["second"],
    "the event that just arrived stays",
  );
});

test("the byte bound keeps the events that fit exactly", () => {
  // Each payload costs 128 bytes, two of them fill the 256 byte budget.
  assert.equal(estimateBytes(payloadOfBytes(128)), 128);

  const ring = new EventRing(1000, 256);
  ring.push(1, payloadOfBytes(128));
  ring.push(2, payloadOfBytes(128));

  assert.equal(ring.byteSize, 256, "the buffer is exactly full");
  assert.equal(ring.size, 2, "a full buffer is not over budget");
  assert.equal(ring.evictedThroughSeq, 0, "nothing was dropped");
});

test("the byte bound drops the oldest event when the budget is exceeded", () => {
  const ring = new EventRing(1000, 256);
  ring.push(1, payloadOfBytes(128));
  ring.push(2, payloadOfBytes(128));
  ring.push(3, payloadOfBytes(128));

  assert.equal(ring.byteSize, 256, "the buffer is back within the budget");
  assert.equal(ring.size, 2);
  assert.equal(ring.evictedThroughSeq, 1, "the oldest event made room");
  assert.deepEqual(
    ring.since(2).events.map((event) => event.seq),
    [2, 3],
  );
});

test("an event that costs exactly maxBytes stays in the buffer", () => {
  assert.equal(estimateBytes(payloadOfBytes(256)), 256);

  const ring = new EventRing(10, 256);
  ring.push(1, payloadOfBytes(256));

  assert.equal(ring.size, 1, "the event fits the budget exactly");
  assert.equal(ring.byteSize, 256);
  assert.equal(ring.evictedThroughSeq, 0);

  ring.push(2, payloadOfBytes(256));
  assert.equal(ring.size, 1, "the second event pushed the first one out");
  assert.equal(ring.byteSize, 256);
  assert.equal(ring.evictedThroughSeq, 1);
});

test("a payload bigger than maxBytes evicts itself", () => {
  const ring = new EventRing(10, 256);
  ring.push(1, "x".repeat(1000));

  assert.equal(ring.size, 0, "the oversized event does not fit");
  assert.equal(ring.byteSize, 0);
  assert.equal(ring.evictedThroughSeq, 1, "the event dropped itself");
  assert.equal(ring.lastSeq, 1, "the head still moved");

  const { events, gap } = ring.since(1);
  assert.deepEqual(events, []);
  assert.deepEqual(gap, { fromSeq: 1, toSeq: 1 }, "the event itself is the hole");
});

test("an oversized payload evicts the events that came before it", () => {
  const ring = new EventRing(10, 256);
  ring.push(1, "a");
  ring.push(2, "b");
  ring.push(3, "x".repeat(1000));

  assert.equal(ring.size, 0, "the budget is spent by the oversized event alone");
  assert.equal(ring.byteSize, 0);
  assert.equal(ring.evictedThroughSeq, 3);
  assert.deepEqual(ring.since(1).gap, { fromSeq: 1, toSeq: 3 });
});

test("the constructor clamps the bounds to a minimum", () => {
  // The count bound never drops below one event, the byte budget never
  // drops below 256 bytes.
  const ring = new EventRing(0, 0);
  ring.push(1, "a");
  ring.push(2, "b");

  assert.equal(ring.size, 1, "the count bound is at least one event");
  assert.equal(ring.evictedThroughSeq, 1);

  const small = new EventRing(10, 1);
  small.push(1, "x".repeat(200));
  assert.equal(small.size, 1, "the byte budget is at least 256 bytes");
  assert.ok(small.byteSize <= 256, `expected at most 256 bytes, got ${small.byteSize}`);
});

// ---------------------------------------------------------------------------
// since() and the reported gap.
// ---------------------------------------------------------------------------

test("since() below the retained range reports the exact gap", () => {
  const ring = new EventRing(2, 1 << 20);
  for (let seq = 1; seq <= 5; seq += 1) ring.push(seq, `line-${seq}`);
  assert.equal(ring.evictedThroughSeq, 3);

  const { events, gap } = ring.since(1);
  assert.deepEqual(gap, { fromSeq: 1, toSeq: 3 }, "the hole is inclusive");
  assert.deepEqual(
    events.map((event) => event.seq),
    [4, 5],
  );

  // The hole always starts at the sequence the peer asked for.
  const partial = ring.since(2);
  assert.deepEqual(partial.gap, { fromSeq: 2, toSeq: 3 });
  assert.deepEqual(
    partial.events.map((event) => event.seq),
    [4, 5],
  );
});

test("since() at the evicted boundary reports a hole of exactly one sequence", () => {
  const ring = new EventRing(2, 1 << 20);
  for (let seq = 1; seq <= 5; seq += 1) ring.push(seq, `line-${seq}`);

  const { events, gap } = ring.since(3);
  assert.deepEqual(gap, { fromSeq: 3, toSeq: 3 }, "the last dropped sequence");
  assert.deepEqual(
    events.map((event) => event.seq),
    [4, 5],
  );
});

test("since() at the oldest retained event reports no gap", () => {
  const ring = new EventRing(2, 1 << 20);
  for (let seq = 1; seq <= 5; seq += 1) ring.push(seq, `line-${seq}`);

  const { events, gap } = ring.since(4);
  assert.equal(gap, null, "the range is complete");
  assert.deepEqual(
    events.map((event) => event.seq),
    [4, 5],
  );
});

test("since() above the retained range replays nothing and reports no gap", () => {
  const ring = new EventRing(2, 1 << 20);
  for (let seq = 1; seq <= 5; seq += 1) ring.push(seq, `line-${seq}`);

  const { events, gap } = ring.since(6);
  assert.equal(gap, null, "the peer is up to date, there is no hole");
  assert.deepEqual(events, []);
  assert.equal(ring.lastSeq, 5, "the head of the ring did not move");
});

test("since() below the first sequence reports a gap that starts below one", () => {
  // The daemon refuses a resume below the first sequence
  // (botd/src/protocol.ts), so the ring never sees it over the wire; this
  // documents what the ring does when it is called that way.
  const ring = new EventRing(2, 1 << 20);
  for (let seq = 1; seq <= 5; seq += 1) ring.push(seq, `line-${seq}`);

  const { events, gap } = ring.since(0);
  assert.deepEqual(gap, { fromSeq: 0, toSeq: 3 });
  assert.deepEqual(
    events.map((event) => event.seq),
    [4, 5],
  );
});

// ---------------------------------------------------------------------------
// The sequence numbers.
// ---------------------------------------------------------------------------

test("a duplicate sequence number is buffered twice", () => {
  const ring = new EventRing(10, 1 << 20);
  ring.push(1, "first");
  ring.push(1, "second");

  assert.equal(ring.size, 2, "the ring does not deduplicate");
  assert.equal(ring.lastSeq, 1);
  assert.deepEqual(
    ring.since(1).events.map((event) => event.payload),
    ["first", "second"],
    "both events come back, in the order they were pushed",
  );
});

test("a non-monotonic sequence number does not move the head backwards", () => {
  const ring = new EventRing(10, 1 << 20);
  ring.push(5, "five");
  ring.push(3, "three");

  assert.equal(ring.lastSeq, 5, "the head only grows");
  assert.equal(ring.size, 2);
  assert.deepEqual(
    ring.since(1).events.map((event) => event.seq),
    [5, 3],
    "the events keep the order they were pushed in",
  );
});

test("the events come back in the order they were pushed", () => {
  const ring = new EventRing(10, 1 << 20);
  for (let seq = 1; seq <= 5; seq += 1) ring.push(seq, `line-${seq}`);

  assert.deepEqual(
    ring.since(1).events.map((event) => event.seq),
    [1, 2, 3, 4, 5],
  );
});

test("the byte size of the ring is the sum of the events it holds", () => {
  const ring = new EventRing(10, 1 << 20);
  ring.push(1, "a");
  ring.push(2, { b: 2 });
  ring.push(3, undefined);

  const sum = ring
    .since(1)
    .events.reduce((total, event) => total + event.bytes, 0);
  assert.equal(ring.byteSize, sum);
  assert.equal(sum, estimateBytes("a") + estimateBytes({ b: 2 }) + estimateBytes(undefined));
});

// ---------------------------------------------------------------------------
// clear().
// ---------------------------------------------------------------------------

test("clear() forgets the events and turns them into a gap", () => {
  const ring = new EventRing(10, 1 << 20);
  for (let seq = 1; seq <= 4; seq += 1) ring.push(seq, `line-${seq}`);

  ring.clear();
  assert.equal(ring.size, 0);
  assert.equal(ring.byteSize, 0);
  assert.equal(ring.evictedThroughSeq, 4, "the marker moved to the last sequence");
  assert.equal(ring.lastSeq, 4, "the head did not move");

  const { events, gap } = ring.since(1);
  assert.deepEqual(events, []);
  assert.deepEqual(gap, { fromSeq: 1, toSeq: 4 }, "everything that was buffered is lost");
});

test("clear() leaves the ring ready for the next event", () => {
  const ring = new EventRing(10, 1 << 20);
  for (let seq = 1; seq <= 4; seq += 1) ring.push(seq, `line-${seq}`);
  ring.clear();

  ring.push(5, "after-clear");
  assert.equal(ring.size, 1);
  assert.equal(ring.lastSeq, 5);
  assert.equal(ring.evictedThroughSeq, 4, "the marker did not move");

  const { events, gap } = ring.since(5);
  assert.equal(gap, null, "the new event is not a hole");
  assert.deepEqual(
    events.map((event) => event.payload),
    ["after-clear"],
  );

  // The range that was cleared is still a hole.
  assert.deepEqual(ring.since(4).gap, { fromSeq: 4, toSeq: 4 });
});

// ---------------------------------------------------------------------------
// estimateBytes().
// ---------------------------------------------------------------------------

test("estimateBytes measures a circular payload without throwing", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  assert.doesNotThrow(() => estimateBytes(circular));
  assert.equal(estimateBytes(circular), "[object Object]".length + 16);
});

test("estimateBytes measures a BigInt without throwing", () => {
  assert.doesNotThrow(() => estimateBytes(10n));
  assert.equal(estimateBytes(10n), "10".length + 16);

  // A BigInt inside an object cannot be serialized either.
  assert.doesNotThrow(() => estimateBytes({ a: 10n }));
  assert.equal(estimateBytes({ a: 10n }), "[object Object]".length + 16);
});

test("estimateBytes measures undefined as null", () => {
  assert.doesNotThrow(() => estimateBytes(undefined));
  assert.equal(estimateBytes(undefined), "null".length + 16);
  assert.equal(estimateBytes(undefined), estimateBytes(null));
});

test("estimateBytes measures a nested payload", () => {
  const payload = { a: { b: [1, 2, { c: "d" }] } };
  assert.doesNotThrow(() => estimateBytes(payload));
  assert.equal(estimateBytes(payload), JSON.stringify(payload).length + 16);
});

test("estimateBytes counts the UTF-8 bytes of a unicode payload", () => {
  assert.doesNotThrow(() => estimateBytes("😀"));
  // The emoji is four bytes and the quotes are two.
  assert.equal(estimateBytes("😀"), 6 + 16);
  // The accented letter is two bytes.
  assert.equal(estimateBytes("héllo"), 8 + 16);
});

test("the ring buffers the exotic payloads without throwing", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  const ring = new EventRing(10, 1 << 20);
  assert.doesNotThrow(() => {
    ring.push(1, undefined);
    ring.push(2, 10n);
    ring.push(3, circular);
    ring.push(4, { nested: { deep: ["😀"] } });
  });

  assert.equal(ring.size, 4);
  assert.deepEqual(
    ring.since(1).events.map((event) => event.seq),
    [1, 2, 3, 4],
  );
  assert.ok(ring.byteSize > 0);
});

// ---------------------------------------------------------------------------
// Known bugs of botd/src/ring.ts (the sources are not touched here).
// ---------------------------------------------------------------------------

test("a non-monotonic push does not hide an event that is still buffered", {
  todo: "since() starts at evictedThrough + 1, so an event pushed below that marker is hidden",
}, () => {
  const ring = new EventRing(2, 1 << 20);
  ring.push(5, "five");
  ring.push(6, "six");
  ring.push(1, "one"); // pushed late, the ring drops the event 5 to make room

  assert.equal(ring.size, 2);
  const { events, gap } = ring.since(1);
  assert.deepEqual(
    events.map((event) => event.payload),
    ["six", "one"],
    "the event that is still buffered comes back",
  );
  assert.equal(gap, null, "nothing was lost, there is no hole");
});

test("an event pushed after clear() below the evicted marker stays visible", {
  todo: "since() starts at evictedThrough + 1, so an event below that marker is never returned",
}, () => {
  const ring = new EventRing(10, 1 << 20);
  for (let seq = 1; seq <= 4; seq += 1) ring.push(seq, `line-${seq}`);
  ring.clear();

  ring.push(2, "late");
  assert.equal(ring.size, 1);
  const { events } = ring.since(2);
  assert.deepEqual(
    events.map((event) => event.payload),
    ["late"],
    "the event that was pushed comes back",
  );
});
