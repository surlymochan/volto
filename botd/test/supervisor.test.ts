import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { Supervisor } from "../src/supervisor.ts";

class Child extends EventEmitter {
  signals: string[] = [];
  kill(signal: string): boolean { this.signals.push(signal); return true; }
  exit(): void { this.emit("exit", 1, null); }
}

function harness(options: Partial<ConstructorParameters<typeof Supervisor>[0]> = {}) {
  const children: Child[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let id = 0;
  const supervisor = new Supervisor({
    spec: { command: ["bot"], cwd: ".", env: {} }, baseMs: 10, maxMs: 25,
    spawn: () => { const child = new Child(); children.push(child); return child as unknown as ChildProcess; },
    setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id as unknown as NodeJS.Timeout; },
    clearTimer: (timer) => { timers.delete(timer as unknown as number); },
    ...options,
  });
  const tick = () => { const [key, timer] = timers.entries().next().value!; timers.delete(key); timer.fn(); return timer.ms; };
  return { supervisor, children, timers, tick };
}

test("crashes restart with capped exponential backoff", () => {
  const h = harness(); const delays: number[] = [];
  h.supervisor.on("restarting", ({ delay }) => delays.push(delay));
  h.supervisor.start();
  for (let i = 0; i < 3; i++) { h.children[i].exit(); h.tick(); }
  assert.deepEqual(delays, [10, 20, 25]);
  assert.equal(h.children.length, 4);
  h.supervisor.stop();
});

test("restart cap emits failed", () => {
  const h = harness({ maxRestarts: 1 }); let failed = 0;
  h.supervisor.on("failed", () => failed++); h.supervisor.start();
  h.children[0].exit(); h.tick(); h.children[1].exit();
  assert.equal(failed, 1); assert.equal(h.timers.size, 0);
});

test("stop prevents restart and cancels escalation on exit", () => {
  const h = harness(); h.supervisor.start(); h.supervisor.stop(); h.children[0].exit();
  assert.deepEqual(h.children[0].signals, ["SIGTERM"]); assert.equal(h.timers.size, 0);
});

test("stop escalates to SIGKILL", () => {
  const h = harness({ graceMs: 42 }); h.supervisor.start(); h.supervisor.stop();
  assert.equal(h.tick(), 42); assert.deepEqual(h.children[0].signals, ["SIGTERM", "SIGKILL"]);
  h.children[0].exit(); assert.equal(h.timers.size, 0);
});

test("spawn errors are retried and eventually fail", () => {
  const h = harness({ maxRestarts: 1, spawn: () => { throw new Error("spawn failed"); } });
  let failed = 0; h.supervisor.on("failed", () => failed++); h.supervisor.start(); h.tick();
  assert.equal(failed, 1);
});
