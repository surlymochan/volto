// Tests for the bounded event ring buffer.

import test from "node:test";
import assert from "node:assert/strict";

import { EventRing } from "../src/ring.ts";

test("keeps the events in order", () => {
  const ring = new EventRing(10, 4096);
  ring.push(1, "a");
  ring.push(2, "b");
  const { events, gap } = ring.since(1);
  assert.equal(gap, null);
  assert.deepEqual(events.map((event) => event.seq), [1, 2]);
  assert.deepEqual(events.map((event) => event.payload), ["a", "b"]);
});

test("evicts the oldest events when the count bound is reached", () => {
  const ring = new EventRing(2, 1 << 20);
  for (let seq = 1; seq <= 5; seq += 1) ring.push(seq, `line-${seq}`);
  assert.equal(ring.size, 2);
  assert.equal(ring.lastSeq, 5);
  assert.equal(ring.evictedThroughSeq, 3);
});

test("reports the gap of a resume that starts before the buffer", () => {
  const ring = new EventRing(2, 1 << 20);
  for (let seq = 1; seq <= 5; seq += 1) ring.push(seq, `line-${seq}`);
  const { events, gap } = ring.since(1);
  assert.deepEqual(gap, { fromSeq: 1, toSeq: 3 });
  assert.deepEqual(events.map((event) => event.seq), [4, 5]);
});

test("reports no gap when the resume starts inside the buffer", () => {
  const ring = new EventRing(3, 1 << 20);
  for (let seq = 1; seq <= 3; seq += 1) ring.push(seq, `line-${seq}`);
  const { events, gap } = ring.since(2);
  assert.equal(gap, null);
  assert.deepEqual(events.map((event) => event.seq), [2, 3]);
});

test("respects the byte bound", () => {
  const ring = new EventRing(1000, 512);
  for (let seq = 1; seq <= 50; seq += 1) ring.push(seq, "x".repeat(64));
  assert.ok(ring.byteSize <= 512, `expected at most 512 bytes, got ${ring.byteSize}`);
  assert.ok(ring.evictedThroughSeq > 0);
});
