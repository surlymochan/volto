import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { Supervisor } from "../src/supervisor.ts";

class Child extends EventEmitter {
  kill(): boolean { return true; }
  exit(): void { this.emit("exit", 1, null); }
}

function harness(options: Partial<ConstructorParameters<typeof Supervisor>[0]> = {}) {
  let now = 0; let id = 0; let failed = 0;
  const children: Child[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const restarts: { delay: number; attempt: number }[] = [];
  const supervisor = new Supervisor({
    spec: { command: ["bot"], cwd: ".", env: {} }, baseMs: 10, maxMs: 40, windowMs: 100,
    spawn: () => { const child = new Child(); children.push(child); return child as unknown as ChildProcess; },
    now: () => now, random: () => 0.5,
    setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id as unknown as NodeJS.Timeout; },
    clearTimer: (timer) => { timers.delete(timer as unknown as number); },
    ...options,
  });
  supervisor.on("restarting", (event) => restarts.push(event));
  supervisor.on("failed", () => failed++);
  supervisor.start();
  return {
    supervisor, children, timers, restarts, failed: () => failed,
    crashAt(time: number) { now = time; children.at(-1)!.exit(); },
    tick() { const [key, timer] = timers.entries().next().value!; timers.delete(key); timer.fn(); },
  };
}

for (const [name, times, expected] of [
  ["five restarts inside the window exhaust the limit on the next crash", [0, 10, 20, 30, 40, 99], 1],
  ["a timestamp exactly one window old is evicted", [0, 10, 20, 30, 40, 100], 0],
  ["a timestamp just inside the window is retained", [0, 10, 20, 30, 40, 99], 1],
  ["crashes spread over the window do not exhaust the limit", [0, 25, 50, 75, 100, 125, 150], 0],
  ["timestamps older than the window are evicted", [0, 10, 20, 30, 40, 101], 0],
] as const) {
  test(name, () => {
    const h = harness();
    for (const time of times) { h.crashAt(time); if (h.timers.size) h.tick(); }
    assert.equal(h.failed(), expected);
  });
}

test("a healthy run resets the backoff at the default threshold", () => {
  const h = harness();
  h.crashAt(0); h.tick(); h.crashAt(1); h.tick(); h.crashAt(101);
  assert.deepEqual(h.restarts.at(-1), { delay: 10, attempt: 1 });
});

test("early crashes keep doubling the delay up to the cap", () => {
  const h = harness();
  for (let i = 0; i < 4; i++) { h.crashAt(i); h.tick(); }
  assert.deepEqual(h.restarts, [
    { delay: 10, attempt: 1 }, { delay: 20, attempt: 2 },
    { delay: 40, attempt: 3 }, { delay: 40, attempt: 4 },
  ]);
});

test("healthyMs overrides the window as the healthy threshold", () => {
  const h = harness({ healthyMs: 20 });
  h.crashAt(0); h.tick(); h.crashAt(19); h.tick(); h.crashAt(39);
  assert.deepEqual(h.restarts, [
    { delay: 10, attempt: 1 }, { delay: 20, attempt: 2 }, { delay: 10, attempt: 1 },
  ]);
});

test("stop cancels a pending restart", () => {
  const h = harness(); h.crashAt(0);
  assert.equal(h.timers.size, 1);
  h.supervisor.stop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.children.length, 1);
});
