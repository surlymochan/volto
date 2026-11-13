import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageTracker } from "../src/usage.ts";

const known = (inputTokens = 1, outputTokens = 2) => ({ kind: "turn_end" as const, status: "ok" as const, usage: { inputTokens, outputTokens } });
const unknown = { kind: "turn_end" as const, status: "ok" as const };

test("bot totals survive forgetting a session", () => {
  const t = new UsageTracker(); t.record("s", "codex", known());
  const before = t.snapshot().bots; t.forget("s");
  assert.deepEqual(t.snapshot().bots, before);
});
test("forget removes the session", () => {
  const t = new UsageTracker(); t.record("s", "codex", known()); t.forget("s");
  assert.equal(t.snapshot().sessions.s, undefined);
});
test("forgetting an unknown session is a no-op", () => {
  const t = new UsageTracker(); t.record("s", "codex", known());
  const before = t.snapshot(); t.forget("missing"); assert.deepEqual(t.snapshot(), before);
});
test("a forgotten session restarts while bot totals keep growing", () => {
  const t = new UsageTracker({ maxTotalTokens: 10 }); t.record("s", "codex", known()); t.forget("s");
  assert.deepEqual(t.check("s"), { exceeded: false, remaining: 10 });
  t.record("s", "codex", known(2, 1));
  assert.equal(t.snapshot().sessions.s.turns, 1); assert.equal(t.snapshot().bots.codex.turns, 2);
  assert.equal(t.snapshot().bots.codex.inputTokens, 3);
});
test("unknown turns consume the default budget", () => {
  const t = new UsageTracker({ maxTotalTokens: 50 });
  for (let i = 0; i < 100; i++) t.record("s", "codex", unknown);
  assert.deepEqual(t.check("s"), { exceeded: true, remaining: 0 });
  assert.equal(t.snapshot().sessions.s.budgetTokens, 100);
  assert.equal(t.snapshot().sessions.s.inputTokens, 0); assert.equal(t.snapshot().sessions.s.outputTokens, 0);
});
test("known and unknown turns contribute to budget", () => {
  const t = new UsageTracker({ maxTotalTokens: 10, unknownTurnTokens: 3 });
  t.record("s", "codex", known(2, 1)); t.record("s", "codex", unknown);
  assert.equal(t.snapshot().sessions.s.budgetTokens, 6);
  assert.deepEqual(t.check("s"), { exceeded: false, remaining: 4 });
});
test("budget arithmetic remains precise near MAX_SAFE_INTEGER", () => {
  const t = new UsageTracker({ maxTotalTokens: Number.MAX_SAFE_INTEGER, unknownTurnTokens: 2 });
  t.record("s", "codex", known(Number.MAX_SAFE_INTEGER - 2, 0)); t.record("s", "codex", unknown);
  assert.deepEqual(t.check("s"), { exceeded: true, remaining: 0 });
  t.record("s", "codex", unknown); assert.equal(t.snapshot().sessions.s.budgetTokens, Number.MAX_SAFE_INTEGER);
});
test("zero unknown turn charge restores old budget behavior", () => {
  const t = new UsageTracker({ maxTotalTokens: 1, unknownTurnTokens: 0 });
  for (let i = 0; i < 100; i++) t.record("s", "codex", unknown);
  assert.deepEqual(t.check("s"), { exceeded: false, remaining: 1 }); assert.equal(t.snapshot().sessions.s.budgetTokens, 0);
});
