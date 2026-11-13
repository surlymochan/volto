import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageTracker } from "../src/usage.ts";
import type { NormalizedEvent } from "../src/adapter-types.ts";

const known = (inputTokens = 1, outputTokens = 2): NormalizedEvent => ({ kind: "turn_end", status: "ok", usage: { inputTokens, outputTokens } });
const unknown: NormalizedEvent = { kind: "turn_end", status: "ok" };

test("check on an unknown session is not exceeded", () => {
  const t = new UsageTracker({ maxTotalTokens: 10 });
  assert.deepEqual(t.check("missing"), { exceeded: false, remaining: 10 });
});

test("check on an unknown session ignores the usage of other sessions", () => {
  const t = new UsageTracker({ maxTotalTokens: 10 });
  t.record("other", "codex", known(4, 4));
  assert.deepEqual(t.check("missing"), { exceeded: false, remaining: 10 });
});

test("check on an unknown session without a limit has no remaining budget", () => {
  const t = new UsageTracker();
  t.record("s", "codex", known());
  assert.deepEqual(t.check("missing"), { exceeded: false, remaining: null });
});

test("exceeded flips exactly at the limit", () => {
  const t = new UsageTracker({ maxTotalTokens: 5 });
  assert.deepEqual(t.check("s"), { exceeded: false, remaining: 5 });
  t.record("s", "codex", known(2, 1));
  assert.deepEqual(t.check("s"), { exceeded: false, remaining: 2 });
  t.record("s", "codex", known(1, 1));
  assert.deepEqual(t.check("s"), { exceeded: true, remaining: 0 });
});

test("remaining stays at zero once the limit is passed", () => {
  const t = new UsageTracker({ maxTotalTokens: 5 });
  t.record("s", "codex", known(4, 4));
  assert.deepEqual(t.check("s"), { exceeded: true, remaining: 0 });
});

for (const bad of [-1, NaN]) {
  test(`invalid unknownTurnTokens ${bad} falls back to one token per turn`, () => {
    const t = new UsageTracker({ maxTotalTokens: 10, unknownTurnTokens: bad });
    t.record("s", "codex", unknown);
    assert.equal(t.snapshot().sessions.s.unknownUsageTurns, 1);
    assert.equal(t.snapshot().sessions.s.budgetTokens, 1);
    t.record("s", "codex", unknown);
    assert.equal(t.snapshot().sessions.s.budgetTokens, 2);
    assert.deepEqual(t.check("s"), { exceeded: false, remaining: 8 });
  });
}

test("snapshot bots aggregate two sessions of the same kind", () => {
  const t = new UsageTracker();
  t.record("s1", "codex", known(1, 2));
  t.record("s2", "codex", known(3, 4));
  const snap = t.snapshot();
  assert.equal(snap.bots.codex.turns, 2);
  assert.equal(snap.bots.codex.ok, 2);
  assert.equal(snap.bots.codex.inputTokens, 4);
  assert.equal(snap.bots.codex.outputTokens, 6);
  assert.equal(snap.bots.codex.budgetTokens, 10);
  assert.equal(snap.sessions.s1.turns, 1);
  assert.equal(snap.sessions.s2.turns, 1);
});

test("snapshot bots keep different kinds apart", () => {
  const t = new UsageTracker();
  t.record("s1", "codex", known(1, 2));
  t.record("s2", "claude", known(3, 4));
  const bots = t.snapshot().bots;
  assert.equal(bots.codex.turns, 1);
  assert.equal(bots.codex.inputTokens, 1);
  assert.equal(bots.claude.turns, 1);
  assert.equal(bots.claude.inputTokens, 3);
});

test("a snapshot is a copy and mutating it does not change the tracker", () => {
  const t = new UsageTracker();
  t.record("s", "codex", known());
  const snap = t.snapshot();
  snap.sessions.s.turns = 999;
  snap.bots.codex.inputTokens = 999;
  snap.sessions.injected = { ...snap.sessions.s };
  const after = t.snapshot();
  assert.equal(after.sessions.s.turns, 1);
  assert.equal(after.bots.codex.turns, 1);
  assert.equal(after.bots.codex.inputTokens, 1);
  assert.equal(after.sessions.injected, undefined);
});

test("every snapshot call returns a fresh object", () => {
  const t = new UsageTracker();
  t.record("s", "codex", known());
  const first = t.snapshot();
  const second = t.snapshot();
  assert.notEqual(first, second);
  assert.notEqual(first.sessions, second.sessions);
  assert.notEqual(first.sessions.s, second.sessions.s);
  assert.notEqual(first.bots.codex, second.bots.codex);
});
