import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageTracker } from "../src/usage.ts";

const end = (inputTokens = 1, outputTokens = 2, status: "ok" | "error" | "cancelled" = "ok") => ({ kind: "turn_end" as const, status, usage: { inputTokens, outputTokens } });
test("ignores other events", () => { const t = new UsageTracker(); t.record("s", "codex", { kind: "ready" }); assert.equal(Object.keys(t.snapshot().sessions).length, 0); });
for (const n of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) test(`invalid usage ${n}`, () => { const t = new UsageTracker(); t.record("s", "codex", end(n, 2)); const s = t.snapshot().sessions.s; assert.equal(s.inputTokens, 0); assert.equal(s.outputTokens, 2); assert.equal(s.unknownUsageTurns, 1); });
test("missing usage", () => { const t = new UsageTracker(); t.record("s", "codex", { kind: "turn_end", status: "error" }); assert.equal(t.snapshot().sessions.s.unknownUsageTurns, 1); });
test("statuses and bot totals", () => { const t = new UsageTracker(); for (const status of ["ok", "error", "cancelled"] as const) t.record("s", "codex", end(1, 2, status)); assert.equal(t.snapshot().bots.codex.turns, 3); assert.equal(t.snapshot().sessions.s.cancelled, 1); });
test("saturates large sums", () => { const t = new UsageTracker(); t.record("s", "codex", end(Number.MAX_SAFE_INTEGER, 0)); t.record("s", "codex", end(10, 0)); assert.equal(t.snapshot().sessions.s.inputTokens, Number.MAX_SAFE_INTEGER); });
test("many sessions and stable order", () => { const t = new UsageTracker(); for (let i = 99; i >= 0; i--) t.record(`s${i}`, "codex", end()); assert.equal(Object.keys(t.snapshot().sessions).length, 100); assert.equal(Object.keys(t.snapshot().sessions)[0], "s0"); });
test("snapshots are independent", () => { const t = new UsageTracker(); t.record("s", "codex", end()); t.snapshot().sessions.s.turns = 100; assert.equal(t.snapshot().sessions.s.turns, 1); });
test("forget is idempotent", () => { const t = new UsageTracker(); t.record("s", "codex", end()); t.forget("s"); const after = t.snapshot(); t.forget("s"); assert.deepEqual(t.snapshot(), after); assert.equal(Object.keys(after.sessions).length, 0); assert.equal(after.bots.codex.turns, 1); assert.equal(after.bots.codex.inputTokens, 1); });
test("budget", () => { const t = new UsageTracker({ maxTotalTokens: 3 }); assert.deepEqual(t.check("s"), { exceeded: false, remaining: 3 }); t.record("s", "codex", end()); assert.deepEqual(t.check("s"), { exceeded: true, remaining: 0 }); });
test("unlimited budget", () => { assert.deepEqual(new UsageTracker().check("s"), { exceeded: false, remaining: null }); });
test("cost accumulates before rounding", () => { const t = new UsageTracker({ price: { codex: { input: 1, output: 2 } } }); for (let i = 0; i < 10; i++) t.record("s", "codex", end(1, 1)); assert.equal(t.snapshot().sessions.s.estimatedCostUsd, 0.00003); });
test("JSON serializable", () => { const t = new UsageTracker(); t.record("__proto__", "codex", end()); assert.equal(JSON.parse(JSON.stringify(t.snapshot())).sessions.__proto__.turns, 1); });
