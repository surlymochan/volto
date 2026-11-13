import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { Supervisor } from "../src/supervisor.ts";

class Child extends EventEmitter {
  exit(): void { this.emit("exit", 1, null); }
}

function harness(options: Partial<ConstructorParameters<typeof Supervisor>[0]> = {}) {
  let now = 0; let id = 0; let failed = 0;
  const children: Child[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const restarts: { delay: number; attempt: number }[] = [];
  const supervisor = new Supervisor({
    spec: { command: ["synthetic"], cwd: ".", env: {} },
    baseMs: 100, maxMs: 400, jitter: 0.5, maxRestarts: 10, windowMs: 10000,
    spawn: () => { const child = new Child(); children.push(child); return child as unknown as ChildProcess; },
    random: () => 0.5, now: () => now,
    setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id as unknown as NodeJS.Timeout; },
    clearTimer: (timer) => { timers.delete(timer as unknown as number); },
    ...options,
  });
  supervisor.on("restarting", (event) => restarts.push(event));
  supervisor.on("failed", () => failed++);
  supervisor.start();
  return {
    children, timers, restarts, failed: () => failed,
    crashAt(time: number) { now = time; children.at(-1)!.exit(); },
    tick() { const [key, timer] = timers.entries().next().value!; timers.delete(key); timer.fn(); },
  };
}

for (const [random, delay] of [[0, 50], [0.25, 75], [0.5, 100], [1, 150]] as const) {
  test(`jitter computes the requested delay with random=${random}`, () => {
    const h = harness({ random: () => random });
    h.crashAt(0);
    assert.deepEqual(h.restarts, [{ delay, attempt: 1 }]);
    assert.equal([...h.timers.values()][0].ms, delay);
  });
}

test("positive jitter is capped after the exponential base reaches the maximum", () => {
  const h = harness({ random: () => 1 });
  for (let i = 0; i < 4; i++) { h.crashAt(i); if (i < 3) h.tick(); }
  assert.deepEqual(h.restarts, [
    { delay: 150, attempt: 1 }, { delay: 300, attempt: 2 },
    { delay: 400, attempt: 3 }, { delay: 400, attempt: 4 },
  ]);
  assert.equal([...h.timers.values()][0].ms, 400);
});

test("negative jitter applies to the capped base on later attempts", () => {
  const h = harness({ random: () => 0 });
  for (let i = 0; i < 4; i++) { h.crashAt(i); if (i < 3) h.tick(); }
  assert.deepEqual(h.restarts.map(({ delay }) => delay), [50, 100, 200, 200]);
});

test("zero jitter ignores changing random values", () => {
  let value = 0;
  const h = harness({ jitter: 0, random: () => value++ });
  for (let i = 0; i < 3; i++) { h.crashAt(i); if (i < 2) h.tick(); }
  assert.deepEqual(h.restarts.map(({ delay }) => delay), [100, 200, 400]);
});

test("full negative jitter can schedule a zero delay", () => {
  const h = harness({ jitter: 1, random: () => 0 });
  h.crashAt(0);
  assert.deepEqual(h.restarts, [{ delay: 0, attempt: 1 }]);
  assert.equal([...h.timers.values()][0].ms, 0);
});

test("a healthy run resets the jittered delay and attempt at the threshold", () => {
  const h = harness({ healthyMs: 20, random: () => 1 });
  h.crashAt(0); h.tick(); h.crashAt(19); h.tick(); h.crashAt(39);
  assert.deepEqual(h.restarts, [
    { delay: 150, attempt: 1 }, { delay: 300, attempt: 2 }, { delay: 150, attempt: 1 },
  ]);
  assert.equal([...h.timers.values()][0].ms, 150);
});

test("restart limit prevents another jittered timer", () => {
  const h = harness({ maxRestarts: 1, random: () => 1 });
  h.crashAt(0); h.tick(); h.crashAt(1);
  assert.equal(h.failed(), 1);
  assert.deepEqual(h.restarts, [{ delay: 150, attempt: 1 }]);
  assert.equal(h.timers.size, 0);
});
