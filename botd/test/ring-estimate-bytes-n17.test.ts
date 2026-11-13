import test from "node:test";
import assert from "node:assert/strict";

import { EventRing, estimateBytes } from "../src/ring.ts";

test("estimateBytes counts UTF-8 bytes in object keys and values", () => {
  assert.equal(estimateBytes({ "界": "é" }), 12 + 16);
});

test("undefined returned by toJSON uses the null representation", () => {
  assert.equal(estimateBytes({ toJSON: () => undefined }), 4 + 16);
});

test("a circular payload uses its custom string representation", () => {
  const payload: { self?: unknown; toString: () => string } = { toString: () => "界" };
  payload.self = payload;
  assert.equal(estimateBytes(payload), 3 + 16);
});

test("a negative BigInt uses its decimal string representation", () => {
  assert.equal(estimateBytes(-123n), 4 + 16);
});

test("negative count bounds still retain one event", () => {
  const ring = new EventRing(-5, 1024);
  ring.push(1, "a");
  ring.push(2, "b");
  assert.equal(ring.size, 1);
  assert.equal(ring.evictedThroughSeq, 1);
});

test("negative byte bounds retain an event at the 256-byte minimum", () => {
  const ring = new EventRing(10, -5);
  ring.push(1, "x".repeat(238));
  assert.equal(ring.byteSize, 256);
  assert.equal(ring.size, 1);
});

test("count eviction keeps the highest dropped sequence when drops are out of order", () => {
  const ring = new EventRing(1, 1024);
  ring.push(8, "a");
  ring.push(3, "b");
  ring.push(9, "c");
  assert.equal(ring.evictedThroughSeq, 8);
  assert.equal(ring.lastSeq, 9);
});

test("byte eviction keeps the highest dropped sequence when drops are out of order", () => {
  const ring = new EventRing(10, 256);
  ring.push(8, "x".repeat(110));
  ring.push(3, "x".repeat(110));
  ring.push(9, "x".repeat(238));
  assert.equal(ring.evictedThroughSeq, 8);
  assert.equal(ring.byteSize, 256);
});

test("clear after out-of-order pushes advances the marker to the highest sequence", () => {
  const ring = new EventRing(10, 1024);
  ring.push(7, "a");
  ring.push(2, "b");
  ring.clear();
  assert.equal(ring.size, 0);
  assert.equal(ring.byteSize, 0);
  assert.equal(ring.evictedThroughSeq, 7);
  assert.deepEqual(ring.since(1), { events: [], gap: { fromSeq: 1, toSeq: 7 } });
});

// DEFECT: since() includes late retained events at or below the eviction marker in a reported gap.
test.todo("since() starts replay after the eviction marker when it reports a gap", () => {
  const ring = new EventRing(2, 1024);
  ring.push(5, "a");
  ring.push(6, "b");
  ring.push(1, "c");
  const { events, gap } = ring.since(1);
  assert.deepEqual(gap, { fromSeq: 1, toSeq: 5 });
  assert.deepEqual(events.map((event) => event.seq), [6]);
});
