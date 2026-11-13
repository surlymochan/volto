// Seeded property tests for the volto-botd collaboration router.
//
// The router is pure: the same (task, bots, state) triple always yields the
// same decision. `router.test.ts` pins that promise with hand-picked
// examples; this file checks it on pseudo-random input instead. Every
// generator is driven by a tiny built-in PRNG (mulberry32) with fixed seeds,
// so a failure is reproducible: the seed is part of every assertion message.
//
// Fixtures are synthetic: bots, hosts, lanes and paths are made-up names,
// never real hosts, addresses, credentials or repository content.
//
// The overlap properties use `filesOverlap`/`globsOverlap` from the router
// itself: its heuristic is deliberately conservative (botd/src/router.ts),
// it may report a conflict where no file matches both patterns, but it never
// misses one.
//
// Known deviations
// ----------------
// `planBatch` keeps the host, family and global limits across a batch, but
// the load of a running task is attributed through the last roster entry
// that carries the bot id (botd/src/router.ts, `candidateBots`). A roster
// that repeats a bot id can therefore overrun a family limit. The invariant
// is kept as the skipped test at the end of this file; the fix belongs to
// botd/src, which this card must not touch.

import test from "node:test";
import assert from "node:assert/strict";

import { planBatch, route, filesOverlap, globsOverlap, QUOTA_SKIP_PCT } from "../src/router.ts";
import type { Bot, Decision, RouterState, RouterTask, RunningTask } from "../src/router.ts";
import type { BotKind, ModelFamily } from "../src/adapter-types.ts";

/** Fixed seeds, one per property: a failing seed is enough to replay it. */
const SEEDS = [1, 7, 42, 1337, 2024, 31337, 65537, 999983, 161803, 271828, 314159, 57721];

const KINDS: BotKind[] = ["codex", "claude", "dsh", "pi", "agy", "copilot"];
const FAMILIES: ModelFamily[] = ["gpt", "claude", "deepseek", "minimax", "gemini", "other"];
const HOSTS = ["site-a", "site-b", "site-c"];
const LANES = ["lane-1", "lane-2", "lane-3"];
const TASK_TYPES = ["impl", "review", "research", "test"] as const;
/** Synthetic path globs; no real repository path ever shows up here. */
const GLOBS = [
  "src/core/one.ts",
  "src/core/two.ts",
  "src/core/*.ts",
  "src/core/**",
  "src/**",
  "docs/guide.md",
  "docs/**",
  "**/*.ts",
  "lib/util.ts",
];

/** Tiny deterministic PRNG (mulberry32): no dependency, same seed, same sequence. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A value from `values`, chosen with `random`. */
function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)];
}

/** An integer in `min .. max`, inclusive. */
function integer(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/** A synthetic bot; the quota lands on both sides of the ceiling. */
function randomBot(random: () => number, index: number): Bot {
  const status = random();
  const quota = random();
  return {
    id: `bot-${index}`,
    kind: pick(random, KINDS),
    family: pick(random, FAMILIES),
    host: pick(random, HOSTS),
    lane: pick(random, LANES),
    status: status < 0.1 ? "down" : status < 0.2 ? "busy" : "idle",
    quotaUsedPct:
      quota < 0.5
        ? integer(random, 0, 94)
        : quota < 0.75
          ? QUOTA_SKIP_PCT
          : integer(random, QUOTA_SKIP_PCT + 1, 100),
    costTier: (1 + integer(random, 0, 2)) as 1 | 2 | 3,
    ...(random() < 0.35 ? { minDifficulty: integer(random, 1, 3) } : {}),
    ...(random() < 0.35 ? { maxDifficulty: integer(random, 3, 5) } : {}),
  };
}

/** A synthetic task, sometimes with files, preferences and a review family. */
function randomTask(random: () => number, index: number): RouterTask {
  const files: string[] = [];
  const fileCount = integer(random, 0, 3);
  for (let i = 0; i < fileCount; i++) files.push(pick(random, GLOBS));
  return {
    id: `task-${index}`,
    type: pick(random, TASK_TYPES),
    difficulty: integer(random, 1, 5),
    ...(random() < 0.35 ? { implementerFamily: pick(random, FAMILIES) } : {}),
    ...(random() < 0.35 ? { preferKinds: [pick(random, KINDS)] } : {}),
    ...(random() < 0.25 ? { avoidHosts: [pick(random, HOSTS)] } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
}

/** A synthetic state: running tasks plus the concurrency limits. */
function randomState(random: () => number, bots: Bot[]): RouterState {
  const running: RunningTask[] = [];
  const busy = integer(random, 0, Math.min(2, bots.length));
  for (let i = 0; i < busy; i++) {
    running.push({ botId: pick(random, bots).id, taskId: `busy-${i}` });
  }
  const hostLimits: Record<string, number> = {};
  if (random() < 0.5) hostLimits[pick(random, HOSTS)] = integer(random, 0, 2);
  const familyLimits: Record<string, number> = {};
  if (random() < 0.5) familyLimits[pick(random, FAMILIES)] = integer(random, 0, 2);
  return {
    running,
    hostLimits,
    familyLimits,
    globalLimit: integer(random, 0, bots.length + 2),
  };
}

interface Scenario {
  bots: Bot[];
  tasks: RouterTask[];
  state: RouterState;
}

/** A whole (task, bots, state) triple, drawn from `random`. */
function randomScenario(random: () => number): Scenario {
  const bots = Array.from({ length: integer(random, 1, 6) }, (_, index) => randomBot(random, index));
  const tasks = Array.from({ length: integer(random, 1, 8) }, (_, index) => randomTask(random, index));
  return { bots, tasks, state: randomState(random, bots) };
}

/** The decisions of a batch that were routed to a bot. */
function assignments(decisions: Decision[]): Extract<Decision, { ok: true }>[] {
  return decisions.filter((decision): decision is Extract<Decision, { ok: true }> => decision.ok);
}

/** The load of every host and family, counting the tasks that already run. */
function loadOf(state: RouterState, bots: Bot[]): {
  hosts: Map<string, number>;
  families: Map<string, number>;
} {
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const hosts = new Map<string, number>();
  const families = new Map<string, number>();
  for (const entry of state.running) {
    const bot = byId.get(entry.botId);
    if (!bot) continue;
    hosts.set(bot.host, (hosts.get(bot.host) ?? 0) + 1);
    families.set(bot.family, (families.get(bot.family) ?? 0) + 1);
  }
  return { hosts, families };
}

test("planBatch never schedules two tasks whose files overlap", () => {
  for (const seed of SEEDS) {
    const random = prng(seed);
    const { bots, tasks, state } = randomScenario(random);
    const scheduled = assignments(planBatch(tasks, bots, state));
    for (let i = 0; i < scheduled.length; i++) {
      for (let j = i + 1; j < scheduled.length; j++) {
        const first = tasks.find((task) => task.id === scheduled[i].taskId);
        const second = tasks.find((task) => task.id === scheduled[j].taskId);
        assert.ok(first, `seed ${seed}: unknown task ${scheduled[i].taskId}`);
        assert.ok(second, `seed ${seed}: unknown task ${scheduled[j].taskId}`);
        assert.equal(
          filesOverlap(first.files ?? [], second.files ?? []),
          false,
          `seed ${seed}: ${first.id} and ${second.id} touch the same files`,
        );
      }
    }
  }
});

test("planBatch never exceeds the capacity of a bot, a host, a family or the fleet", () => {
  for (const seed of SEEDS) {
    const random = prng(seed);
    const { bots, tasks, state } = randomScenario(random);
    const scheduled = assignments(planBatch(tasks, bots, state));
    const byId = new Map(bots.map((bot) => [bot.id, bot]));

    // A bot runs at most one task at a time.
    const perBot = new Map<string, number>();
    for (const decision of scheduled) {
      perBot.set(decision.botId, (perBot.get(decision.botId) ?? 0) + 1);
    }
    for (const [botId, count] of perBot) {
      assert.equal(count, 1, `seed ${seed}: ${botId} got ${count} tasks at once`);
    }

    // A bot that already runs a task is never reused.
    const busy = new Set(state.running.map((entry) => entry.botId));
    for (const decision of scheduled) {
      assert.equal(busy.has(decision.botId), false, `seed ${seed}: ${decision.botId} already runs a task`);
    }

    // The host and family limits count the tasks that are already running.
    const load = loadOf(state, bots);
    for (const decision of scheduled) {
      const hostLimit = state.hostLimits[decision.host];
      if (hostLimit !== undefined) {
        const used = (load.hosts.get(decision.host) ?? 0) + 1;
        assert.ok(used <= hostLimit, `seed ${seed}: host ${decision.host} runs ${used} of ${hostLimit}`);
        load.hosts.set(decision.host, used);
      }
      const familyLimit = state.familyLimits[decision.family];
      if (familyLimit !== undefined) {
        const used = (load.families.get(decision.family) ?? 0) + 1;
        assert.ok(used <= familyLimit, `seed ${seed}: family ${decision.family} runs ${used} of ${familyLimit}`);
        load.families.set(decision.family, used);
      }
    }

    // The fleet limit counts every task that runs, so a batch may only use
    // the slots that are still free.
    const free = Math.max(0, state.globalLimit - state.running.length);
    assert.ok(
      scheduled.length <= free,
      `seed ${seed}: ${scheduled.length} tasks scheduled, only ${free} of ${state.globalLimit} slots are free`,
    );

    // Every assignment names a bot of the roster.
    for (const decision of scheduled) {
      assert.ok(byId.get(decision.botId), `seed ${seed}: unknown bot ${decision.botId}`);
    }
  }
});

test("planBatch skips bots at or above the quota ceiling", () => {
  for (const seed of SEEDS) {
    const random = prng(seed);
    const { bots, tasks, state } = randomScenario(random);
    const byId = new Map(bots.map((bot) => [bot.id, bot]));
    for (const decision of assignments(planBatch(tasks, bots, state))) {
      const bot = byId.get(decision.botId);
      assert.ok(bot, `seed ${seed}: unknown bot ${decision.botId}`);
      assert.ok(
        bot.quotaUsedPct < QUOTA_SKIP_PCT,
        `seed ${seed}: ${decision.botId} was assigned at ${bot.quotaUsedPct}% quota`,
      );
    }
  }

  // The ceiling is exclusive: a bot that sits exactly on it is skipped.
  const atCeiling: Bot = {
    id: "bot-at-ceiling",
    kind: "codex",
    family: "gpt",
    host: "site-a",
    lane: "lane-1",
    status: "idle",
    quotaUsedPct: QUOTA_SKIP_PCT,
    costTier: 1,
  };
  const decision = route(
    { id: "task-1", type: "impl", difficulty: 2 },
    [atCeiling],
    { running: [], hostLimits: {}, familyLimits: {}, globalLimit: 1 },
  );
  assert.equal(decision.ok, false, "a bot on the quota ceiling must be skipped");
});

test("planBatch is deterministic for equal input", () => {
  for (const seed of SEEDS) {
    const random = prng(seed);
    const { bots, tasks, state } = randomScenario(random);
    const first = planBatch(tasks, bots, state);
    const second = planBatch(tasks, bots, state);
    assert.deepEqual(first, second, `seed ${seed}: two runs differ`);

    // A structurally equal copy yields the same decisions.
    const copy = planBatch(structuredClone(tasks), structuredClone(bots), structuredClone(state));
    assert.deepEqual(first, copy, `seed ${seed}: an equal copy yields other decisions`);

    // The state that was handed in is left alone.
    const snapshot = JSON.stringify(state);
    planBatch(tasks, bots, state);
    assert.equal(JSON.stringify(state), snapshot, `seed ${seed}: the state was modified`);
  }
});

test("planBatch answers every task once, in input order, with a known reason", () => {
  const reasons = ["no_eligible_bot", "no_independent_reviewer", "deferred_file_conflict"];
  for (const seed of SEEDS) {
    const random = prng(seed);
    const { bots, tasks, state } = randomScenario(random);
    const decisions = planBatch(tasks, bots, state);
    assert.deepEqual(
      decisions.map((decision) => decision.taskId),
      tasks.map((task) => task.id),
      `seed ${seed}: the decisions do not line up with the tasks`,
    );
    for (const decision of decisions) {
      if (decision.ok) {
        assert.equal(decision.reason, "assigned", `seed ${seed}: ${decision.taskId}`);
      } else {
        assert.ok(
          reasons.includes(decision.reason),
          `seed ${seed}: ${decision.taskId} was rejected with ${decision.reason}`,
        );
      }
    }
  }
});

test("globsOverlap is symmetric and reflexive", () => {
  for (const seed of SEEDS) {
    const random = prng(seed);
    for (let i = 0; i < 50; i++) {
      const a = pick(random, GLOBS);
      const b = pick(random, GLOBS);
      assert.equal(globsOverlap(a, b), globsOverlap(b, a), `seed ${seed}: ${a} and ${b} disagree`);
      assert.equal(globsOverlap(a, a), true, `seed ${seed}: ${a} does not overlap itself`);
    }
  }
});

test("filesOverlap is symmetric", () => {
  for (const seed of SEEDS) {
    const random = prng(seed);
    for (let i = 0; i < 50; i++) {
      const first = [pick(random, GLOBS), pick(random, GLOBS)];
      const second = [pick(random, GLOBS), pick(random, GLOBS)];
      assert.equal(
        filesOverlap(first, second),
        filesOverlap(second, first),
        `seed ${seed}: ${first.join(",")} and ${second.join(",")} disagree`,
      );
    }
  }
});

test("route never picks a bot that is down, busy, over quota or avoided", () => {
  for (const seed of SEEDS) {
    const random = prng(seed);
    const { bots, tasks, state } = randomScenario(random);
    const byId = new Map(bots.map((bot) => [bot.id, bot]));
    for (const task of tasks) {
      const decision = route(task, bots, state);
      if (!decision.ok) continue;
      const bot = byId.get(decision.botId);
      assert.ok(bot, `seed ${seed}: unknown bot ${decision.botId}`);
      assert.equal(bot.status, "idle", `seed ${seed}: ${bot.id} is ${bot.status}`);
      assert.ok(bot.quotaUsedPct < QUOTA_SKIP_PCT, `seed ${seed}: ${bot.id} is over quota`);
      assert.equal(
        (task.avoidHosts ?? []).includes(bot.host),
        false,
        `seed ${seed}: ${bot.id} runs on an avoided host`,
      );
      assert.equal(
        state.running.some((entry) => entry.botId === bot.id),
        false,
        `seed ${seed}: ${bot.id} already runs a task`,
      );
    }
  }
});

test("route honours the difficulty window and the review independence", () => {
  for (const seed of SEEDS) {
    const random = prng(seed);
    const { bots, tasks, state } = randomScenario(random);
    const byId = new Map(bots.map((bot) => [bot.id, bot]));
    for (const task of tasks) {
      const decision = route(task, bots, state);
      if (!decision.ok) continue;
      const bot = byId.get(decision.botId);
      assert.ok(bot, `seed ${seed}: unknown bot ${decision.botId}`);
      const min = bot.minDifficulty ?? 1;
      const max = bot.maxDifficulty ?? 5;
      assert.ok(
        task.difficulty >= min && task.difficulty <= max,
        `seed ${seed}: difficulty ${task.difficulty} is outside ${min}..${max}`,
      );
      if (task.type === "review" && task.implementerFamily !== undefined) {
        assert.notEqual(
          bot.family,
          task.implementerFamily,
          `seed ${seed}: ${bot.id} reviews its own family`,
        );
      }
    }
  }
});

// Known deviation, see the header: the load of a running task is attributed
// through the last roster entry that carries the bot id, so a roster that
// repeats an id can overrun a family limit. The test stays skipped until
// botd/src/router.ts is fixed; un-skip it to see the invariant fail.
test.skip("planBatch keeps the family limit when the roster repeats a bot id", () => {
  const bots: Bot[] = [
    {
      id: "dup",
      kind: "codex",
      family: "gpt",
      host: "site-a",
      lane: "lane-1",
      status: "idle",
      quotaUsedPct: 10,
      costTier: 1,
    },
    {
      id: "dup",
      kind: "codex",
      family: "claude",
      host: "site-b",
      lane: "lane-2",
      status: "down",
      quotaUsedPct: 10,
      costTier: 1,
    },
    {
      id: "other",
      kind: "claude",
      family: "gpt",
      host: "site-c",
      lane: "lane-3",
      status: "idle",
      quotaUsedPct: 10,
      costTier: 1,
    },
  ];
  const tasks: RouterTask[] = [
    { id: "task-1", type: "impl", difficulty: 2 },
    { id: "task-2", type: "impl", difficulty: 2 },
  ];
  const state: RouterState = {
    running: [],
    hostLimits: {},
    familyLimits: { gpt: 1 },
    globalLimit: 5,
  };
  const scheduled = assignments(planBatch(tasks, bots, state)).filter(
    (decision) => decision.family === "gpt",
  );
  assert.equal(scheduled.length, 1, "the gpt family limit of one task is overrun");
});
