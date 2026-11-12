// volto-botd collaboration router.
//
// Pure, dependency-free assignment of tasks to bots. No I/O, no clocks, no
// randomness: the same (task, bots, state) triple always yields the same
// decision, which keeps the control plane reproducible and testable.

import type { BotKind, ModelFamily } from "./adapter-types.ts";

/** Kind of work the control plane wants done. */
export type TaskType = "impl" | "review" | "research" | "test";

export interface RouterTask {
  id: string;
  type: TaskType;
  /** 1 (trivial) .. 5 (very hard). */
  difficulty: number;
  /** Family of the bot that implemented the change; reviewers must differ. */
  implementerFamily?: ModelFamily;
  /** Preferred bot kinds (soft preference — see `route`). */
  preferKinds?: BotKind[];
  /** Hosts that must not be used for this task. */
  avoidHosts?: string[];
  /** Optional path globs the task touches; used for conflict detection. */
  files?: string[];
}

export interface Bot {
  id: string;
  kind: BotKind;
  family: ModelFamily;
  host: string;
  lane: string;
  status: "idle" | "busy" | "down";
  /** Share of the bot's quota already consumed, in percent. */
  quotaUsedPct: number;
  minDifficulty?: number;
  maxDifficulty?: number;
  costTier: 1 | 2 | 3;
}

export interface RunningTask {
  botId: string;
  taskId: string;
}

export interface RouterState {
  /** Tasks currently in flight. */
  running: RunningTask[];
  /** Max concurrent tasks per host; a missing host means "no limit". */
  hostLimits: Record<string, number>;
  /** Max concurrent tasks per model family; a missing family means "no limit". */
  familyLimits: Record<string, number>;
  /** Max concurrent tasks overall. */
  globalLimit: number;
}

/** Why a task was not assigned to a bot. */
export type DecisionReason =
  | "no_eligible_bot"
  | "no_independent_reviewer"
  | "deferred_file_conflict";

export interface RouteAssignment {
  ok: true;
  taskId: string;
  botId: string;
  kind: BotKind;
  family: ModelFamily;
  host: string;
  lane: string;
  costTier: 1 | 2 | 3;
  reason: "assigned";
}

export interface RouteRejection {
  ok: false;
  taskId: string;
  reason: DecisionReason;
}

export type Decision = RouteAssignment | RouteRejection;

/** Convenience aliases for callers that prefer the shorter names. */
export type Task = RouterTask;
export type State = RouterState;

/** Bots at (or above) this quota share are skipped. */
export const QUOTA_SKIP_PCT = 95;

const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 5;

interface Candidate {
  bot: Bot;
  /** Number of tasks already running on the bot's host. */
  hostLoad: number;
}

/**
 * Pick a bot for `task`.
 *
 * Hard rules (a bot that breaks one of them is never chosen):
 *  - only `idle` bots that are not already running a task are considered;
 *  - bots whose quota is at/over 95% are skipped;
 *  - hosts listed in `task.avoidHosts` are skipped;
 *  - the bot's optional difficulty window must contain the task difficulty;
 *  - host, family and global concurrency limits must have room;
 *  - a `review` task with an `implementerFamily` needs a bot from a
 *    different family — if there is none the task fails with
 *    `no_independent_reviewer`.
 *
 * Soft preferences, in order: `preferKinds`, then the lowest `costTier`, then
 * the lowest quota use, then spreading the load over hosts (the host with the
 * fewest tasks in flight wins). Remaining ties are broken by bot id so the
 * result is deterministic.
 */
export function route(task: RouterTask, bots: Bot[], state: RouterState): Decision {
  let candidates = candidateBots(task, bots, state);

  // Independence is a hard rule for reviews: an implementer may not review
  // its own family. When nobody qualifies the task is not routed at all.
  if (task.type === "review" && task.implementerFamily !== undefined) {
    const implementerFamily = task.implementerFamily;
    const independent = candidates.filter((c) => c.bot.family !== implementerFamily);
    if (independent.length === 0) return reject(task, "no_independent_reviewer");
    candidates = independent;
  }

  if (candidates.length === 0) return reject(task, "no_eligible_bot");

  const preferred = new Set<BotKind>(task.preferKinds ?? []);
  const ranked = [...candidates].sort((a, b) => {
    const kindRank = Number(preferred.has(b.bot.kind)) - Number(preferred.has(a.bot.kind));
    if (kindRank !== 0) return kindRank;
    if (a.bot.costTier !== b.bot.costTier) return a.bot.costTier - b.bot.costTier;
    if (a.bot.quotaUsedPct !== b.bot.quotaUsedPct) return a.bot.quotaUsedPct - b.bot.quotaUsedPct;
    if (a.hostLoad !== b.hostLoad) return a.hostLoad - b.hostLoad;
    if (a.bot.id === b.bot.id) return 0;
    return a.bot.id < b.bot.id ? -1 : 1;
  });

  const chosen = ranked[0].bot;
  return {
    ok: true,
    taskId: task.id,
    botId: chosen.id,
    kind: chosen.kind,
    family: chosen.family,
    host: chosen.host,
    lane: chosen.lane,
    costTier: chosen.costTier,
    reason: "assigned",
  };
}

/**
 * Plan a batch of tasks.
 *
 * Tasks are handled in input order and the returned decisions line up with the
 * given tasks. Every assignment is booked in a working copy of the state, so
 * host/family/global limits hold across the whole batch and a bot never gets
 * two tasks at once.
 *
 * Two tasks whose `files` globs overlap must not run at the same time: the
 * later one is deferred (`deferred_file_conflict`) instead of being routed.
 */
export function planBatch(tasks: RouterTask[], bots: Bot[], state: RouterState): Decision[] {
  const working: RouterState = {
    running: [...(state.running ?? [])],
    hostLimits: { ...(state.hostLimits ?? {}) },
    familyLimits: { ...(state.familyLimits ?? {}) },
    globalLimit: state.globalLimit,
  };

  const decisions: Decision[] = [];
  const scheduled: { taskId: string; files: string[] }[] = [];

  for (const task of tasks) {
    const files = task.files ?? [];
    if (files.length > 0 && conflictsWithScheduled(files, scheduled)) {
      decisions.push(reject(task, "deferred_file_conflict"));
      continue;
    }

    const decision = route(task, bots, working);
    decisions.push(decision);
    if (decision.ok) {
      working.running.push({ botId: decision.botId, taskId: task.id });
      scheduled.push({ taskId: task.id, files });
    }
  }

  return decisions;
}

/** True when any glob of `files` overlaps any glob of `other`. */
export function filesOverlap(files: string[], other: string[]): boolean {
  for (const a of files) {
    for (const b of other) {
      if (globsOverlap(a, b)) return true;
    }
  }
  return false;
}

/**
 * True when two path globs can match the same file.
 *
 * A glob matches a literal path exactly; two patterns are considered
 * overlapping when their literal prefixes and suffixes are compatible, which
 * is the usual "might touch the same file" heuristic (conservative on
 * purpose: a false conflict only defers a task, a missed one would corrupt
 * the working tree).
 */
export function globsOverlap(a: string, b: string): boolean {
  const pa = normalizeGlob(a);
  const pb = normalizeGlob(b);
  if (pa === pb) return true;

  const wildcardA = hasWildcard(pa);
  const wildcardB = hasWildcard(pb);
  if (!wildcardA) return globToRegExp(pb).test(pa);
  if (!wildcardB) return globToRegExp(pa).test(pb);

  if (!prefixCompatible(literalPrefix(pa), literalPrefix(pb))) return false;
  if (!suffixCompatible(literalSuffix(pa), literalSuffix(pb))) return false;
  return true;
}

function reject(task: RouterTask, reason: DecisionReason): RouteRejection {
  return { ok: false, taskId: task.id, reason };
}

function candidateBots(task: RouterTask, bots: Bot[], state: RouterState): Candidate[] {
  const running = state?.running ?? [];
  const runningBotIds = new Set(running.map((entry) => entry.botId));
  const byId = new Map(bots.map((bot) => [bot.id, bot]));

  const hostLoad = new Map<string, number>();
  const familyLoad = new Map<string, number>();
  for (const entry of running) {
    const bot = byId.get(entry.botId);
    if (!bot) continue;
    hostLoad.set(bot.host, (hostLoad.get(bot.host) ?? 0) + 1);
    familyLoad.set(bot.family, (familyLoad.get(bot.family) ?? 0) + 1);
  }

  const globalLimit = Number.isFinite(state?.globalLimit) ? state.globalLimit : Infinity;
  const avoidHosts = new Set(task.avoidHosts ?? []);
  const candidates: Candidate[] = [];

  for (const bot of bots) {
    if (bot.status !== "idle") continue;
    if (runningBotIds.has(bot.id)) continue;
    if (bot.quotaUsedPct >= QUOTA_SKIP_PCT) continue;
    if (avoidHosts.has(bot.host)) continue;
    if (!difficultyFits(bot, task.difficulty)) continue;

    const host = hostLoad.get(bot.host) ?? 0;
    const hostLimit = state?.hostLimits?.[bot.host];
    if (hostLimit !== undefined && host >= hostLimit) continue;

    const family = familyLoad.get(bot.family) ?? 0;
    const familyLimit = state?.familyLimits?.[bot.family];
    if (familyLimit !== undefined && family >= familyLimit) continue;

    if (running.length >= globalLimit) continue;

    candidates.push({ bot, hostLoad: host });
  }

  return candidates;
}

function difficultyFits(bot: Bot, difficulty: number): boolean {
  const min = bot.minDifficulty ?? MIN_DIFFICULTY;
  const max = bot.maxDifficulty ?? MAX_DIFFICULTY;
  return difficulty >= min && difficulty <= max;
}

function conflictsWithScheduled(files: string[], scheduled: { taskId: string; files: string[] }[]): boolean {
  for (const entry of scheduled) {
    if (filesOverlap(files, entry.files)) return true;
  }
  return false;
}

function normalizeGlob(pattern: string): string {
  return pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function hasWildcard(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

/** Literal part of the glob before its first wildcard. */
function literalPrefix(pattern: string): string {
  const index = pattern.search(/[*?]/);
  return index === -1 ? pattern : pattern.slice(0, index);
}

/** Literal part of the glob after its last wildcard. */
function literalSuffix(pattern: string): string {
  const index = pattern.lastIndexOf("*");
  const question = pattern.lastIndexOf("?");
  const last = Math.max(index, question);
  return last === -1 ? pattern : pattern.slice(last + 1);
}

/** Two prefixes are compatible when one of them is empty or they nest. */
function prefixCompatible(a: string, b: string): boolean {
  if (a === "" || b === "") return true;
  return a.startsWith(b) || b.startsWith(a);
}

/** Two suffixes are compatible when one of them is empty or they nest. */
function suffixCompatible(a: string, b: string): boolean {
  if (a === "" || b === "") return true;
  return a.endsWith(b) || b.endsWith(a);
}

function globToRegExp(pattern: string): RegExp {
  let p = normalizeGlob(pattern);
  let tail = "";
  if (p.endsWith("/**")) {
    p = p.slice(0, -3);
    tail = "(?:/.*)?";
  }

  let source = "";
  for (let i = 0; i < p.length; i++) {
    const char = p[i];
    if (char === "*") {
      if (p[i + 1] === "*") {
        i++;
        if (p[i + 1] === "/") {
          i++;
          source += "(?:[^/]+/)*";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      source += "\\" + char;
    } else {
      source += char;
    }
  }

  return new RegExp("^" + source + tail + "$");
}
