// Tests for the volto-botd collaboration router.
//
// Fixtures are synthetic: bots, hosts and lanes are made-up names, never real
// hosts, addresses or credentials.

import test from "node:test";
import assert from "node:assert/strict";

import {
  planBatch,
  route,
  globsOverlap,
  QUOTA_SKIP_PCT,
} from "../src/router.ts";
import type { Bot, RouterState, RouterTask } from "../src/router.ts";
import type { BotKind, ModelFamily } from "../src/adapter-types.ts";

function bot(overrides: Partial<Bot> & { id: string }): Bot {
  return {
    kind: "codex" as BotKind,
    family: "gpt" as ModelFamily,
    host: "site-a",
    lane: "primary",
    status: "idle",
    quotaUsedPct: 10,
    costTier: 1,
    ...overrides,
  };
}

function task(overrides: Partial<RouterTask> & { id: string }): RouterTask {
  return {
    type: "impl",
    difficulty: 2,
    ...overrides,
  };
}

function state(overrides: Partial<RouterState> = {}): RouterState {
  return {
    running: [],
    hostLimits: {},
    familyLimits: {},
    globalLimit: 10,
    ...overrides,
  };
}

/** Assert the decision succeeded and return it. */
function assigned(decision: ReturnType<typeof route>): Extract<typeof decision, { ok: true }> {
  assert.equal(decision.ok, true, `expected an assignment, got ${JSON.stringify(decision)}`);
  return decision as Extract<typeof decision, { ok: true }>;
}

/** Assert the decision failed with the given reason. */
function rejected(decision: ReturnType<typeof route>, reason: string): void {
  assert.equal(decision.ok, false, `expected a rejection, got ${JSON.stringify(decision)}`);
  assert.equal((decision as { reason: string }).reason, reason);
}

test("routes a task to the only idle bot", () => {
  const only = bot({ id: "bot-1" });
  const decision = route(task({ id: "task-1" }), [only], state());
  const result = assigned(decision);
  assert.equal(result.botId, "bot-1");
  assert.equal(result.taskId, "task-1");
  assert.equal(result.host, "site-a");
  assert.equal(result.kind, "codex");
  assert.equal(result.family, "gpt");
  assert.equal(result.lane, "primary");
  assert.equal(result.costTier, 1);
});

test("skips bots that are down", () => {
  const bots = [bot({ id: "bot-down", status: "down" }), bot({ id: "bot-ok" })];
  assert.equal(assigned(route(task({ id: "t" }), bots, state())).botId, "bot-ok");
});

test("skips bots that are busy", () => {
  const bots = [bot({ id: "bot-busy", status: "busy" }), bot({ id: "bot-ok" })];
  assert.equal(assigned(route(task({ id: "t" }), bots, state())).botId, "bot-ok");
});

test("skips a bot that already runs a task even if it reports idle", () => {
  const bots = [bot({ id: "bot-1" }), bot({ id: "bot-2" })];
  const busy = state({ running: [{ botId: "bot-1", taskId: "other" }] });
  assert.equal(assigned(route(task({ id: "t" }), bots, busy)).botId, "bot-2");
});

test("skips bots at the quota ceiling", () => {
  const bots = [
    bot({ id: "bot-full", quotaUsedPct: QUOTA_SKIP_PCT }),
    bot({ id: "bot-ok", quotaUsedPct: QUOTA_SKIP_PCT - 0.1 }),
  ];
  assert.equal(assigned(route(task({ id: "t" }), bots, state())).botId, "bot-ok");
});

test("skips bots over the quota ceiling", () => {
  const bots = [bot({ id: "bot-full", quotaUsedPct: 120 }), bot({ id: "bot-ok" })];
  assert.equal(assigned(route(task({ id: "t" }), bots, state())).botId, "bot-ok");
});

test("honours avoidHosts", () => {
  const bots = [bot({ id: "bot-a", host: "site-a" }), bot({ id: "bot-b", host: "site-b" })];
  const decision = route(task({ id: "t", avoidHosts: ["site-a"] }), bots, state());
  assert.equal(assigned(decision).botId, "bot-b");
});

test("honours the bot difficulty window (too hard)", () => {
  const bots = [bot({ id: "bot-light", maxDifficulty: 2 }), bot({ id: "bot-heavy", maxDifficulty: 5 })];
  const decision = route(task({ id: "t", difficulty: 4 }), bots, state());
  assert.equal(assigned(decision).botId, "bot-heavy");
});

test("honours the bot difficulty window (too easy)", () => {
  const bots = [bot({ id: "bot-easy", minDifficulty: 3 }), bot({ id: "bot-any", minDifficulty: 1 })];
  const decision = route(task({ id: "t", difficulty: 2 }), bots, state());
  assert.equal(assigned(decision).botId, "bot-any");
});

test("fails when no bot matches the difficulty window", () => {
  const bots = [bot({ id: "bot-light", maxDifficulty: 2 })];
  rejected(route(task({ id: "t", difficulty: 5 }), bots, state()), "no_eligible_bot");
});

test("prefers the lowest cost tier", () => {
  const bots = [
    bot({ id: "bot-cheap", costTier: 1, quotaUsedPct: 90 }),
    bot({ id: "bot-pricey", costTier: 3, quotaUsedPct: 1 }),
  ];
  assert.equal(assigned(route(task({ id: "t" }), bots, state())).botId, "bot-cheap");
});

test("breaks a cost tier tie with the lowest quota use", () => {
  const bots = [
    bot({ id: "bot-busy-quota", costTier: 2, quotaUsedPct: 70 }),
    bot({ id: "bot-fresh-quota", costTier: 2, quotaUsedPct: 5 }),
  ];
  assert.equal(assigned(route(task({ id: "t" }), bots, state())).botId, "bot-fresh-quota");
});

test("breaks a quota tie by spreading the load across hosts", () => {
  const bots = [
    bot({ id: "bot-busy-host", host: "site-a", quotaUsedPct: 20 }),
    bot({ id: "bot-free-host", host: "site-b", quotaUsedPct: 20 }),
  ];
  const loaded = state({ running: [{ botId: "bot-busy-host", taskId: "other" }] });
  assert.equal(assigned(route(task({ id: "t" }), bots, loaded)).botId, "bot-free-host");
});

test("breaks the final tie deterministically by bot id", () => {
  const bots = [
    bot({ id: "bot-zulu" }),
    bot({ id: "bot-alpha" }),
    bot({ id: "bot-mike" }),
  ];
  assert.equal(assigned(route(task({ id: "t" }), bots, state())).botId, "bot-alpha");
});

test("is deterministic for identical inputs", () => {
  const bots = [bot({ id: "bot-1", costTier: 2 }), bot({ id: "bot-2", costTier: 2 })];
  const first = route(task({ id: "t" }), bots, state());
  const second = route(task({ id: "t" }), bots, state());
  assert.deepEqual(first, second);
});

test("respects the host limit", () => {
  const bots = [
    bot({ id: "bot-a1", host: "site-a" }),
    bot({ id: "bot-a2", host: "site-a" }),
    bot({ id: "bot-b1", host: "site-b" }),
  ];
  const limited = state({
    running: [{ botId: "bot-a1", taskId: "other" }],
    hostLimits: { "site-a": 1 },
  });
  assert.equal(assigned(route(task({ id: "t" }), bots, limited)).botId, "bot-b1");
});

test("respects a host limit of zero", () => {
  const bots = [bot({ id: "bot-a", host: "site-a" }), bot({ id: "bot-b", host: "site-b" })];
  const limited = state({ hostLimits: { "site-a": 0 } });
  assert.equal(assigned(route(task({ id: "t" }), bots, limited)).botId, "bot-b");
});

test("respects the family limit", () => {
  const bots = [
    bot({ id: "bot-gpt", family: "gpt" }),
    bot({ id: "bot-claude", family: "claude" }),
  ];
  const limited = state({
    running: [{ botId: "bot-gpt", taskId: "other" }],
    familyLimits: { gpt: 1 },
  });
  assert.equal(assigned(route(task({ id: "t" }), bots, limited)).botId, "bot-claude");
});

test("respects the global limit", () => {
  const bots = [bot({ id: "bot-1" }), bot({ id: "bot-2" })];
  const limited = state({
    running: [{ botId: "bot-1", taskId: "other" }],
    globalLimit: 1,
  });
  rejected(route(task({ id: "t" }), bots, limited), "no_eligible_bot");
});

test("a review needs a bot from another family", () => {
  const bots = [
    bot({ id: "bot-gpt", family: "gpt", costTier: 1 }),
    bot({ id: "bot-claude", family: "claude", costTier: 3 }),
  ];
  const decision = route(task({ id: "t", type: "review", implementerFamily: "gpt" }), bots, state());
  const result = assigned(decision);
  assert.equal(result.botId, "bot-claude");
  assert.equal(result.family, "claude");
});

test("a review without any independent family is rejected", () => {
  const bots = [
    bot({ id: "bot-gpt-1", family: "gpt" }),
    bot({ id: "bot-gpt-2", family: "gpt" }),
  ];
  const decision = route(task({ id: "t", type: "review", implementerFamily: "gpt" }), bots, state());
  rejected(decision, "no_independent_reviewer");
});

test("a review is rejected when the independent family is unavailable", () => {
  const bots = [
    bot({ id: "bot-gpt", family: "gpt" }),
    bot({ id: "bot-claude", family: "claude", status: "busy" }),
  ];
  const decision = route(task({ id: "t", type: "review", implementerFamily: "gpt" }), bots, state());
  rejected(decision, "no_independent_reviewer");
});

test("a review without an implementer family accepts any bot", () => {
  const bots = [bot({ id: "bot-gpt", family: "gpt" })];
  const decision = route(task({ id: "t", type: "review" }), bots, state());
  assert.equal(assigned(decision).botId, "bot-gpt");
});

test("prefers the requested bot kinds", () => {
  const bots = [
    bot({ id: "bot-plain", kind: "codex", costTier: 1 }),
    bot({ id: "bot-preferred", kind: "claude", costTier: 2 }),
  ];
  const decision = route(task({ id: "t", preferKinds: ["claude"] }), bots, state());
  assert.equal(assigned(decision).botId, "bot-preferred");
});

test("falls back to other kinds when no preferred kind is available", () => {
  const bots = [bot({ id: "bot-plain", kind: "codex", costTier: 1 })];
  const decision = route(task({ id: "t", preferKinds: ["claude"] }), bots, state());
  assert.equal(assigned(decision).botId, "bot-plain");
});

test("fails when there is no bot at all", () => {
  rejected(route(task({ id: "t" }), [], state()), "no_eligible_bot");
});

test("planBatch assigns every task while the global limit allows it", () => {
  const bots = [bot({ id: "bot-1" }), bot({ id: "bot-2" }), bot({ id: "bot-3" })];
  const tasks = [task({ id: "t1" }), task({ id: "t2" }), task({ id: "t3" })];
  const decisions = planBatch(tasks, bots, state({ globalLimit: 2 }));
  assert.equal(decisions.length, 3);
  assert.equal(decisions[0].ok, true);
  assert.equal(decisions[1].ok, true);
  rejected(decisions[2], "no_eligible_bot");
});

test("planBatch never gives one bot two tasks", () => {
  const bots = [bot({ id: "bot-1" }), bot({ id: "bot-2" })];
  const tasks = [task({ id: "t1" }), task({ id: "t2" }), task({ id: "t3" })];
  const decisions = planBatch(tasks, bots, state({ globalLimit: 5 }));
  const used = decisions.filter((d) => d.ok).map((d) => (d as { botId: string }).botId);
  assert.equal(new Set(used).size, used.length);
});

test("planBatch keeps the host limit across the batch", () => {
  const bots = [bot({ id: "bot-1", host: "site-a" }), bot({ id: "bot-2", host: "site-b" })];
  const tasks = [task({ id: "t1" }), task({ id: "t2" })];
  const decisions = planBatch(tasks, bots, state({ globalLimit: 5, hostLimits: { "site-a": 1 } }));
  const hosts = decisions.filter((d) => d.ok).map((d) => (d as { host: string }).host);
  assert.deepEqual(hosts.sort(), ["site-a", "site-b"]);
});

test("planBatch defers a task whose files overlap an already scheduled task", () => {
  const bots = [bot({ id: "bot-1" }), bot({ id: "bot-2" })];
  const tasks = [
    task({ id: "t1", files: ["src/core/**"] }),
    task({ id: "t2", files: ["src/core/one.ts"] }),
  ];
  const decisions = planBatch(tasks, bots, state({ globalLimit: 5 }));
  assert.equal(decisions[0].ok, true);
  rejected(decisions[1], "deferred_file_conflict");
});

test("planBatch defers a task with the very same files", () => {
  const bots = [bot({ id: "bot-1" }), bot({ id: "bot-2" })];
  const tasks = [
    task({ id: "t1", files: ["src/core/one.ts"] }),
    task({ id: "t2", files: ["src/core/one.ts"] }),
  ];
  const decisions = planBatch(tasks, bots, state({ globalLimit: 5 }));
  rejected(decisions[1], "deferred_file_conflict");
});

test("planBatch keeps tasks with disjoint files running", () => {
  const bots = [bot({ id: "bot-1" }), bot({ id: "bot-2" })];
  const tasks = [
    task({ id: "t1", files: ["src/core/**"] }),
    task({ id: "t2", files: ["docs/guide.md"] }),
  ];
  const decisions = planBatch(tasks, bots, state({ globalLimit: 5 }));
  assert.equal(decisions[0].ok, true);
  assert.equal(decisions[1].ok, true);
});

test("planBatch defers only the conflicting task and keeps the rest", () => {
  const bots = [bot({ id: "bot-1" }), bot({ id: "bot-2" }), bot({ id: "bot-3" })];
  const tasks = [
    task({ id: "t1", files: ["src/core/**"] }),
    task({ id: "t2", files: ["src/core/two.ts"] }),
    task({ id: "t3", files: ["docs/guide.md"] }),
  ];
  const decisions = planBatch(tasks, bots, state({ globalLimit: 5 }));
  assert.equal(decisions[0].ok, true);
  rejected(decisions[1], "deferred_file_conflict");
  assert.equal(decisions[2].ok, true);
});

test("planBatch keeps review independence per task", () => {
  const bots = [
    bot({ id: "bot-gpt", family: "gpt" }),
    bot({ id: "bot-claude", family: "claude" }),
  ];
  const tasks = [
    task({ id: "t1", type: "review", implementerFamily: "gpt" }),
    task({ id: "t2", type: "review", implementerFamily: "claude" }),
  ];
  const decisions = planBatch(tasks, bots, state({ globalLimit: 5 }));
  assert.equal((decisions[0] as { botId: string }).botId, "bot-claude");
  assert.equal((decisions[1] as { botId: string }).botId, "bot-gpt");
});

test("glob overlap detection", () => {
  assert.equal(globsOverlap("src/core/one.ts", "src/core/one.ts"), true);
  assert.equal(globsOverlap("src/core/**", "src/core/one.ts"), true);
  assert.equal(globsOverlap("src/**", "src/core/one.ts"), true);
  assert.equal(globsOverlap("src/core/one.ts", "src/core/two.ts"), false);
  assert.equal(globsOverlap("src/**", "docs/**"), false);
  assert.equal(globsOverlap("src/*.ts", "src/*.js"), false);
  assert.equal(globsOverlap("**/*.ts", "src/**"), true);
  assert.equal(globsOverlap("src/core/**", "src/other/**"), false);
});

test("planBatch keeps the family limit across the batch", () => {
  const bots = [
    bot({ id: "bot-gpt", family: "gpt" }),
    bot({ id: "bot-claude", family: "claude" }),
  ];
  const tasks = [task({ id: "t1" }), task({ id: "t2" })];
  const decisions = planBatch(tasks, bots, state({ globalLimit: 5, familyLimits: { gpt: 1 } }));
  const families = decisions.filter((d) => d.ok).map((d) => (d as { family: string }).family);
  assert.deepEqual(families.sort(), ["claude", "gpt"]);
});

test("planBatch returns one decision per task, in input order", () => {
  const bots = [bot({ id: "bot-1" })];
  const tasks = [task({ id: "t1" }), task({ id: "t2" }), task({ id: "t3" })];
  const decisions = planBatch(tasks, bots, state({ globalLimit: 5 }));
  assert.deepEqual(decisions.map((d) => d.taskId), ["t1", "t2", "t3"]);
});

test("a deferred task does not consume a bot slot", () => {
  const bots = [bot({ id: "bot-1" }), bot({ id: "bot-2" })];
  const tasks = [
    task({ id: "t1", files: ["src/core/**"] }),
    task({ id: "t2", files: ["src/core/two.ts"] }),
    task({ id: "t3" }),
  ];
  const decisions = planBatch(tasks, bots, state({ globalLimit: 5 }));
  assert.equal((decisions[0] as { botId: string }).botId, "bot-1");
  rejected(decisions[1], "deferred_file_conflict");
  assert.equal((decisions[2] as { botId: string }).botId, "bot-2");
});

test("routing does not mutate the state it is given", () => {
  const bots = [bot({ id: "bot-1" }), bot({ id: "bot-2" })];
  const original = state({ hostLimits: { "site-a": 1 } });
  const snapshot = JSON.stringify(original);
  route(task({ id: "t" }), bots, original);
  planBatch([task({ id: "t1" }), task({ id: "t2" })], bots, original);
  assert.equal(JSON.stringify(original), snapshot);
});
