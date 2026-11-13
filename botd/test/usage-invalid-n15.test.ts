import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageTracker } from "../src/usage.ts";
import type { NormalizedEvent } from "../src/adapter-types.ts";

// Synthetic fixtures only: token counts and prices that are not safe non-negative
// integers must be treated as unknown usage instead of silently skewing totals.
const turn = (usage?: unknown): NormalizedEvent => ({ kind: "turn_end", status: "ok", usage }) as unknown as NormalizedEvent;
const num = (n: unknown): number => n as number;
const priced = (price: unknown) => new UsageTracker({ price: { codex: price as { input: number; output: number } } });

test("a string input count is unknown usage while the valid output half is kept", () => {
  const t = new UsageTracker();
  t.record("s", "codex", turn({ inputTokens: num("12"), outputTokens: 7 }));
  const s = t.snapshot().sessions.s;
  assert.equal(s.inputTokens, 0); assert.equal(s.outputTokens, 7); assert.equal(s.unknownUsageTurns, 1);
});
test("an invalid output count is unknown usage while the valid input half is kept", () => {
  for (const bad of [-3, 1.5, NaN, "9"]) {
    const t = new UsageTracker();
    t.record("s", "codex", turn({ inputTokens: 7, outputTokens: num(bad) }));
    const s = t.snapshot().sessions.s;
    assert.equal(s.inputTokens, 7); assert.equal(s.outputTokens, 0); assert.equal(s.unknownUsageTurns, 1);
  }
});
test("both halves invalid count as a single unknown turn with no tokens", () => {
  const t = new UsageTracker();
  t.record("s", "codex", turn({ inputTokens: num(-1), outputTokens: num(NaN) }));
  const s = t.snapshot().sessions.s;
  assert.equal(s.inputTokens, 0); assert.equal(s.outputTokens, 0); assert.equal(s.unknownUsageTurns, 1);
  assert.equal(s.budgetTokens, 1);
});
test("invalid token counts add no cost even when the bot kind is priced", () => {
  const t = priced({ input: 1, output: 1 });
  t.record("s", "codex", turn({ inputTokens: num("5"), outputTokens: 0 }));
  assert.equal(t.snapshot().sessions.s.estimatedCostUsd, 0);
});
test("negative, NaN and Infinity prices cost nothing", () => {
  for (const bad of [-1, NaN, Infinity, -Infinity]) {
    const t = priced({ input: bad, output: bad });
    t.record("s", "codex", turn({ inputTokens: 1000, outputTokens: 1000 }));
    const s = t.snapshot().sessions.s;
    assert.equal(s.inputTokens, 1000); assert.equal(s.estimatedCostUsd, 0);
  }
});
test("a bot kind without a price entry costs nothing", () => {
  const t = priced({ input: 1, output: 1 });
  t.record("s", "claude", turn({ inputTokens: 1000, outputTokens: 1000 }));
  const s = t.snapshot().sessions.s;
  assert.equal(s.inputTokens, 1000); assert.equal(s.estimatedCostUsd, 0);
  assert.equal(t.snapshot().bots.claude.estimatedCostUsd, 0);
});
test("estimatedCostUsd rounds half up on the 0.5 micro-dollar boundary", () => {
  const t = priced({ input: 0.5, output: 0.5 });
  t.record("s", "codex", turn({ inputTokens: 1, outputTokens: 0 }));
  assert.equal(t.snapshot().sessions.s.estimatedCostUsd, 0.000001);
  t.record("s", "codex", turn({ inputTokens: 2, outputTokens: 0 }));
  assert.equal(t.snapshot().sessions.s.estimatedCostUsd, 0.000002);
});
test("estimatedCostUsd rounds down just below the boundary", () => {
  const t = priced({ input: 0.499999, output: 0.499999 });
  t.record("s", "codex", turn({ inputTokens: 1, outputTokens: 0 }));
  assert.equal(t.snapshot().sessions.s.estimatedCostUsd, 0);
});
test("check() treats an invalid maxTotalTokens as an unlimited budget", () => {
  for (const bad of [-1, 1.5, NaN, "100"]) {
    const t = new UsageTracker({ maxTotalTokens: num(bad) });
    t.record("s", "codex", turn({ inputTokens: 5, outputTokens: 5 }));
    assert.deepEqual(t.check("s"), { exceeded: false, remaining: null });
  }
});
test("check() with a zero limit is already exceeded", () => {
  const t = new UsageTracker({ maxTotalTokens: 0 });
  assert.deepEqual(t.check("s"), { exceeded: true, remaining: 0 });
  t.record("s", "codex", turn({ inputTokens: 1, outputTokens: 1 }));
  assert.deepEqual(t.check("s"), { exceeded: true, remaining: 0 });
});
test("an invalid unknownTurnTokens falls back to one token per unknown turn", () => {
  for (const bad of [-1, 1.5, NaN, "3"]) {
    const t = new UsageTracker({ unknownTurnTokens: num(bad), maxTotalTokens: 50 });
    t.record("s", "codex", turn());
    const s = t.snapshot().sessions.s;
    assert.equal(s.unknownUsageTurns, 1); assert.equal(s.budgetTokens, 1);
    assert.deepEqual(t.check("s"), { exceeded: false, remaining: 49 });
  }
});
