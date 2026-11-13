import test from "node:test";
import assert from "node:assert/strict";

import { route } from "../src/router.ts";
import type { Bot, RouterState, RouterTask } from "../src/router.ts";
import type { BotKind } from "../src/adapter-types.ts";

const task: RouterTask = { id: "task-synthetic", type: "impl", difficulty: 2 };
const state: RouterState = { running: [], hostLimits: {}, familyLimits: {}, globalLimit: 10 };

function bot(id: string, overrides: Partial<Bot> = {}): Bot {
  return {
    id, kind: "codex", family: "gpt", host: "synthetic-site", lane: "synthetic-lane",
    status: "idle", quotaUsedPct: 0, costTier: 1, ...overrides,
  };
}

function withRunningId(botId: string): RouterState {
  return { ...state, running: [{ botId, taskId: "other-synthetic" }] };
}

test("an unknown running bot id does not exclude a registered bot", () => {
  const result = route(task, [bot("unit-a")], withRunningId("unit-missing"));
  assert.equal(result.ok && result.botId, "unit-a");
});

test("an empty running id matches only the empty bot id", () => {
  const result = route(task, [bot(""), bot("unit-a")], withRunningId(""));
  assert.equal(result.ok && result.botId, "unit-a");
});

test("whitespace in a running id is not trimmed", () => {
  const result = route(task, [bot("unit-a"), bot(" unit-a ")], withRunningId(" unit-a "));
  assert.equal(result.ok && result.botId, "unit-a");
});

test("whitespace-only bot ids are distinct from empty ids", () => {
  const result = route(task, [bot(""), bot(" ")], withRunningId(""));
  assert.equal(result.ok && result.botId, " ");
});

test("running bot ids are case sensitive", () => {
  const result = route(task, [bot("Unit-a"), bot("unit-a")], withRunningId("Unit-a"));
  assert.equal(result.ok && result.botId, "unit-a");
});

test("path-like bot ids are compared literally", () => {
  const result = route(task, [bot("unit/a"), bot("unit/../unit/a")], withRunningId("unit/a"));
  assert.equal(result.ok && result.botId, "unit/../unit/a");
});

test("odd characters in bot ids are compared literally", () => {
  const result = route(task, [bot("unit*?[]"), bot("unit-x")], withRunningId("unit*?[]"));
  assert.equal(result.ok && result.botId, "unit-x");
});

test("an unknown preferred kind falls back to ranking registered bots", () => {
  const result = route(
    { ...task, preferKinds: ["synthetic-unknown" as BotKind] },
    [bot("unit-expensive", { costTier: 3 }), bot("unit-cheap", { costTier: 1 })],
    state,
  );
  assert.equal(result.ok && result.botId, "unit-cheap");
});

test("a failed route returns the documented rejection without throwing", () => {
  const result = route({ ...task, id: "" }, [bot("unit-a")], withRunningId("unit-a"));
  assert.deepEqual(result, { ok: false, taskId: "", reason: "no_eligible_bot" });
});
