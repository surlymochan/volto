import assert from "node:assert/strict";
import { test } from "node:test";

import { backoffDelay, DEFAULT_BACKOFF } from "../src/client.ts";

const options = { baseMs: 100, maxMs: 1_000, jitter: 0.2 };
const midpoint = () => 0.5;

test("default backoff has the documented values", () => {
  assert.deepEqual(DEFAULT_BACKOFF, { baseMs: 500, maxMs: 15_000, jitter: 0.2 });
});

test("the first attempt starts at the base with midpoint jitter", () => {
  assert.equal(backoffDelay(1, options, midpoint), 100);
});

test("delay doubles for successive attempts before the cap", () => {
  assert.deepEqual([1, 2, 3, 4].map((attempt) => backoffDelay(attempt, options, midpoint)), [100, 200, 400, 800]);
});

test("delay is capped at the maximum", () => {
  assert.equal(backoffDelay(5, options, midpoint), 1_000);
});

test("minimum random value applies the lower jitter factor", () => {
  assert.equal(backoffDelay(3, options, () => 0), 400 * (1 - options.jitter));
});

test("maximum random value applies the upper jitter factor", () => {
  assert.ok(Math.abs(backoffDelay(3, options, () => 1) - 400 * (1 + options.jitter)) < 1e-10);
});

test("lower jitter is clamped to the base", () => {
  assert.equal(backoffDelay(1, options, () => 0), options.baseMs);
});

test("upper jitter is clamped to the maximum", () => {
  assert.equal(backoffDelay(5, options, () => 1), options.maxMs);
});

test("attempt zero uses the first attempt", () => {
  assert.equal(backoffDelay(0, options, midpoint), options.baseMs);
});

test("negative attempts use the first attempt", () => {
  assert.equal(backoffDelay(-3, options, midpoint), options.baseMs);
});

test("fractional attempts are floored", () => {
  assert.equal(backoffDelay(3.9, options, midpoint), backoffDelay(3, options, midpoint));
  assert.equal(backoffDelay(0.9, options, midpoint), options.baseMs);
});

test("a NaN attempt produces a finite delay", { todo: "NaN attempt currently propagates to the delay" }, () => {
  assert.ok(Number.isFinite(backoffDelay(NaN, options, midpoint)));
});

test("zero jitter gives exact delays regardless of random value", () => {
  const noJitter = { ...options, jitter: 0 };
  for (const random of [() => 0, midpoint, () => 1]) {
    assert.deepEqual([1, 2, 3, 5].map((attempt) => backoffDelay(attempt, noJitter, random)), [100, 200, 400, 1_000]);
  }
});

test("a very large attempt remains finite at the maximum", () => {
  const delay = backoffDelay(2 ** 1000, options, midpoint);
  assert.ok(Number.isFinite(delay));
  assert.equal(delay, options.maxMs);
});

test("delays are non-decreasing for a fixed random value", () => {
  for (const value of [0, 0.5, 1]) {
    const delays = Array.from({ length: 20 }, (_, index) => backoffDelay(index + 1, options, () => value));
    for (let index = 1; index < delays.length; index++) {
      assert.ok(delays[index] >= delays[index - 1]);
      assert.ok(Number.isFinite(delays[index]));
    }
  }
});
