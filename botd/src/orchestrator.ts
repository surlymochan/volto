// botd/src/orchestrator.ts
//
// Task orchestration for volto-botd.
//
// runTask() glues three pieces together:
//
//   * the collaboration router (botd/src/router.ts) picks the bot,
//   * the provider adapter (botd/src/adapter-types.ts) knows how to start the
//     bot and how to speak its protocol,
//   * the client (injected) owns the bot process and hands the normalized
//     events back.
//
// A run looks like this:
//
//   1. route the task to a bot -- for a review the reviewer must come from a
//      different model family than the implementer,
//   2. spawn the bot, write the handshake and then the prompt,
//   3. stream every normalized event to the caller's callback,
//   4. stop the bot when it goes quiet (the watchdog) or when the caller
//      aborts, escalating the cancel step by step.
//
// Everything the orchestrator touches is injected (bots, state, client,
// adapter, clock), so the whole flow runs without a real bot:
// botd/test/orchestrator.test.ts drives it with fakes.

import { route as routerRoute } from "./router.ts";
import type { Bot, Decision, RouterState, RouterTask, TaskType } from "./router.ts";
import type {
  BotAdapter,
  BotKind,
  ModelFamily,
  NormalizedEvent,
  OpenOptions,
  SpawnSpec,
} from "./adapter-types.ts";

/** A silent bot is cancelled after this many milliseconds. */
export const DEFAULT_WATCHDOG_MS = 120_000;

/** Wait this long between two steps of a cancel escalation. */
export const DEFAULT_CANCEL_GRACE_MS = 5_000;

/** How many bots are tried before a task is given up on. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Difficulty of a task that does not name one. */
export const DEFAULT_DIFFICULTY = 3;

/** Reason of a run that never got a bot to start. */
export const BOT_DOWN = "bot_down";

/** A task the orchestrator can run: a router task plus the prompt. */
export interface OrchestratorTask extends Omit<RouterTask, "type" | "difficulty"> {
  /** Prompt handed to the bot. */
  prompt: string;
  /** Kind of work; "impl" when the task does not say. */
  type?: TaskType;
  /** 1 (trivial) .. 5 (very hard); {@link DEFAULT_DIFFICULTY} when not given. */
  difficulty?: number;
  /** Working directory of the bot process. */
  cwd?: string;
  /** Model the bot should use. */
  model?: string;
  /** Reasoning effort the bot should use. */
  effort?: string;
  /** System prompt for the bot. */
  systemPrompt?: string;
  /** Provider session to resume, when the bot supports it. */
  resumeProviderSessionId?: string;
}

/** Everything the client needs to start a bot session. */
export interface OpenRequest {
  /** How the bot process is started (argv, env, cwd -- no shell). */
  spec: SpawnSpec;
  /** The options the spec was built from. */
  opts: OpenOptions;
  /** Adapter that turns provider lines into normalized events. */
  adapter: BotAdapter;
}

/**
 * The bot runtime the orchestrator drives.
 *
 * `open` starts the bot, `send` writes one message to its stdin, `cancel`
 * interrupts the running turn and `events` streams the normalized events of
 * the session.  `kill` and `close` are optional: `kill` is the last step of
 * a cancel escalation, `close` releases the session when the run is over.
 */
export interface BotdClient {
  /** Spawn the bot and open a session. */
  open(request: OpenRequest): Promise<void> | void;
  /** Write one message to the bot's stdin. */
  send(message: unknown): Promise<void> | void;
  /** Interrupt the running turn (transport level). */
  cancel(): Promise<void> | void;
  /** Normalized events of the running session. */
  events(): AsyncIterable<NormalizedEvent>;
  /** Hard stop of the bot process; last step of a cancel escalation. */
  kill?(reason?: string): Promise<void> | void;
  /** Release the session; called when the run is over. */
  close?(): Promise<void> | void;
}

/** Context handed to the event callback. */
export interface EventContext {
  taskId: string;
  botId: string;
  /** 1 for the first bot, 2 for the reroute, ... */
  attempt: number;
}

/** Clock used by the watchdog and the cancel escalation. */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The system clock, used when the caller does not inject one. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** How a run ended. */
export type RunStatus = "ok" | "error" | "cancelled" | "unroutable" | "failed";

/** The outcome of one {@link runTask}. */
export interface RunResult {
  taskId: string;
  status: RunStatus;
  /** True only for a run that ended with a successful turn. */
  ok: boolean;
  /** Bot that ran the task. */
  botId?: string;
  /** Kind of the bot that ran the task. */
  kind?: BotKind;
  /** Model family of the bot that ran the task. */
  family?: ModelFamily;
  /** Text the bot produced. */
  text: string;
  /** How many bots were tried. */
  attempts: number;
  /** Why the run ended (a router reason, "bot_down", "watchdog", ...). */
  reason?: string;
  /** Message of the failure, when there was one. */
  error?: string;
  /** True when the watchdog stopped the run. */
  watchdog?: boolean;
  /** True when the turn was cancelled. */
  cancelled?: boolean;
  /** Token usage reported by the bot. */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Every normalized event of the run, in order. */
  events: NormalizedEvent[];
}

/** Everything {@link runTask} needs; all of it is injected. */
export interface OrchestratorDeps {
  /** Bots the router may choose from. */
  bots: Bot[];
  /** Router state; the orchestrator never mutates it. */
  state: RouterState;
  /** Runtime that talks to the bot processes. */
  client: BotdClient;
  /** Adapter of a bot kind; a bot without an adapter is never started. */
  adapterFor(kind: BotKind): BotAdapter | undefined;
  /** Called for every normalized event, as soon as it arrives. */
  onEvent?(event: NormalizedEvent, ctx: EventContext): void | Promise<void>;
  /** No event for this many milliseconds cancels the turn. */
  watchdogMs?: number;
  /** Wait this long between two steps of a cancel escalation. */
  cancelGraceMs?: number;
  /** How many bots are tried before the task is given up on. */
  maxAttempts?: number;
  /** Working directory used when the task does not name one. */
  cwd?: string;
  /** Aborting this signal cancels the turn. */
  signal?: AbortSignal;
  /** Router; defaults to `route()` of botd/src/router.ts. */
  route?: (task: RouterTask, bots: Bot[], state: RouterState) => Decision;
  /** Clock; defaults to the system clock. */
  clock?: Clock;
}

/**
 * True when a reviewer may judge the work of an implementer.
 *
 * A review is re-run on a bot of another model family, so the reviewer
 * cannot simply agree with the implementer.  A review without a known
 * implementer family may be done by anybody.
 */
export function isIndependentReviewer(
  reviewerFamily: ModelFamily,
  implementerFamily: ModelFamily | undefined,
): boolean {
  if (implementerFamily === undefined) return true;
  return reviewerFamily !== implementerFamily;
}

/**
 * Run one task.
 *
 * The task is routed to a bot, the bot is spawned and prompted and its
 * normalized events are streamed to `deps.onEvent`.  When the bot cannot be
 * started the task is rerouted to another bot; when the bot goes quiet the
 * watchdog cancels the turn.
 */
export async function runTask(
  task: OrchestratorTask,
  deps: OrchestratorDeps,
): Promise<RunResult> {
  const route = deps.route ?? routerRoute;
  const clock = deps.clock ?? systemClock;
  const watchdogMs = deps.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const cancelGraceMs = deps.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  const maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const routerTask = toRouterTask(task);

  /** Bots that could not be used, so the reroute picks another one. */
  const unusable = new Set<string>();
  let lastFailure: RunResult | undefined;
  let lastReason = "no_eligible_bot";
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    const candidates = deps.bots.filter((bot) => !unusable.has(bot.id));
    const decision = route(routerTask, candidates, deps.state);
    if (!decision.ok) {
      lastReason = decision.reason;
      break;
    }

    // A review is re-run on a bot of another family: the router rejects the
    // implementers of the same family, and the assignment is checked again
    // here so a custom router cannot slip a reviewer through.
    if (
      routerTask.type === "review" &&
      !isIndependentReviewer(decision.family, routerTask.implementerFamily)
    ) {
      unusable.add(decision.botId);
      lastReason = "no_independent_reviewer";
      continue;
    }

    const adapter = deps.adapterFor(decision.kind);
    if (!adapter) {
      unusable.add(decision.botId);
      lastReason = "no_adapter";
      continue;
    }

    const result = await runOnBot({
      task,
      decision,
      adapter,
      attempt,
      deps,
      clock,
      watchdogMs,
      cancelGraceMs,
    });

    // A bot that cannot be started is down: reroute the task.
    if (result.reason === BOT_DOWN) {
      unusable.add(decision.botId);
      lastFailure = result;
      lastReason = BOT_DOWN;
      continue;
    }
    return result;
  }

  if (lastFailure) {
    return { ...lastFailure, attempts };
  }
  return {
    taskId: task.id,
    status: "unroutable",
    ok: false,
    text: "",
    attempts,
    reason: lastReason,
    events: [],
  };
}

/** The router task of an orchestrator task. */
function toRouterTask(task: OrchestratorTask): RouterTask {
  return {
    id: task.id,
    type: task.type ?? "impl",
    difficulty: task.difficulty ?? DEFAULT_DIFFICULTY,
    implementerFamily: task.implementerFamily,
    preferKinds: task.preferKinds,
    avoidHosts: task.avoidHosts,
    files: task.files,
  };
}

interface RunContext {
  task: OrchestratorTask;
  decision: Extract<Decision, { ok: true }>;
  adapter: BotAdapter;
  attempt: number;
  deps: OrchestratorDeps;
  clock: Clock;
  watchdogMs: number;
  cancelGraceMs: number;
}

/** State of the turn that is shared between the helpers below. */
interface TurnState {
  wakeup: Wakeup;
  timer: unknown;
  providerSessionId?: string;
  promptSent: boolean;
  /** 0: no cancel, 1: provider cancel sent, 2: interrupted, 3: killed. */
  cancelStage: number;
  cancelReason?: string;
  stageAction?: Promise<void>;
  watchdog: boolean;
}

/** Spawn one bot and run the task on it. */
async function runOnBot(ctx: RunContext): Promise<RunResult> {
  const { task, decision, adapter, deps, clock, attempt } = ctx;
  const result: RunResult = {
    taskId: task.id,
    status: "failed",
    ok: false,
    botId: decision.botId,
    kind: decision.kind,
    family: decision.family,
    text: "",
    attempts: attempt,
    events: [],
  };

  const openOptions: OpenOptions = {
    cwd: task.cwd ?? deps.cwd ?? process.cwd(),
    model: task.model,
    effort: task.effort,
    systemPrompt: task.systemPrompt,
    resumeProviderSessionId: task.resumeProviderSessionId,
  };

  let spec: SpawnSpec;
  let handshake: unknown[];
  try {
    spec = adapter.spawn(openOptions);
    handshake = adapter.handshake(openOptions);
    await deps.client.open({ spec, opts: openOptions, adapter });
  } catch (error) {
    // The bot did not even start: it is down.
    result.reason = BOT_DOWN;
    result.error = messageOf(error);
    await closeClient(deps.client);
    return result;
  }

  const state: TurnState = {
    wakeup: new Wakeup(),
    timer: undefined,
    promptSent: false,
    cancelStage: 0,
    watchdog: false,
  };

  const sendPrompt = async () => {
    const message = adapter.prompt(task.prompt, { providerSessionId: state.providerSessionId });
    await deps.client.send(message);
    state.promptSent = true;
  };

  try {
    try {
      for (const message of handshake) {
        await deps.client.send(message);
      }

      // A protocol with a handshake needs its session id before the prompt
      // can be written, so the prompt waits for the "ready" event.  A
      // protocol without a handshake (the first message opens the session) is
      // prompted right away.
      if (handshake.length === 0) {
        await sendPrompt();
      }
    } catch (error) {
      result.reason = BOT_DOWN;
      result.error = messageOf(error);
    }

    if (result.reason !== BOT_DOWN) {
      try {
        await streamTurn(ctx, result, state, sendPrompt);
      } catch (error) {
        result.status = "failed";
        result.reason = result.reason ?? "client_error";
        result.error = messageOf(error);
      }
    }
  } finally {
    await closeClient(deps.client);
  }

  result.ok = result.status === "ok";
  result.watchdog = state.watchdog;
  if (result.status === "cancelled" && state.cancelReason) {
    result.reason = state.cancelReason;
  }
  return result;
}

/**
 * Stream the events of the running turn.
 *
 * The loop waits for the next event of the bot or for a wake-up (a timer
 * fired, the caller aborted).  While the bot is quiet the watchdog cancels
 * the turn; the cancel is escalated step by step until the bot stops.
 */
async function streamTurn(
  ctx: RunContext,
  result: RunResult,
  state: TurnState,
  sendPrompt: () => Promise<void>,
): Promise<void> {
  const { task, decision, adapter, deps, clock, attempt } = ctx;
  const wakeup = state.wakeup;
  let iterator: AsyncIterator<NormalizedEvent> | undefined;
  let pending: Promise<IteratorResult<NormalizedEvent>> | undefined;

  const clearTimer = () => {
    if (state.timer === undefined) return;
    clock.clearTimeout(state.timer);
    state.timer = undefined;
  };

  const armTimer = (deadline: number, fire: () => void) => {
    clearTimer();
    state.timer = clock.setTimeout(() => {
      state.timer = undefined;
      fire();
    }, Math.max(0, deadline - clock.now()));
  };

  /** Step 1 of the escalation: the provider-native cancel messages. */
  const startCancel = (why: string) => {
    if (state.cancelStage > 0) return;
    state.cancelStage = 1;
    state.cancelReason = why;
    state.stageAction = (async () => {
      for (const message of adapter.cancel({ providerSessionId: state.providerSessionId })) {
        await deps.client.send(message);
      }
    })();
    armTimer(clock.now() + ctx.cancelGraceMs, escalate);
    wakeup.fire();
  };

  /** Step 2 and 3 of the escalation: interrupt the bot, then kill it. */
  const escalate = () => {
    state.cancelStage += 1;
    if (state.cancelStage === 2) {
      state.stageAction = (async () => {
        await deps.client.cancel();
      })();
    } else if (state.cancelStage === 3) {
      state.stageAction = (async () => {
        await deps.client.kill?.(state.cancelReason ?? "cancelled");
      })();
    }
    if (state.cancelStage < 3) armTimer(clock.now() + ctx.cancelGraceMs, escalate);
    wakeup.fire();
  };

  const onWatchdog = () => {
    state.watchdog = true;
    startCancel("watchdog");
  };

  const onAbort = () => {
    startCancel("aborted");
  };

  try {
    const stream = deps.client.events();
    iterator = stream[Symbol.asyncIterator]();
    armTimer(clock.now() + ctx.watchdogMs, onWatchdog);
    if (deps.signal) {
      if (deps.signal.aborted) onAbort();
      else deps.signal.addEventListener("abort", onAbort, { once: true });
    }

    let done = false;
    while (!done) {
      const next = pending ?? iterator.next();
      pending = next;
      const winner = await Promise.race([
        next.then((value) => ({ type: "event" as const, value })),
        wakeup.wait().then(() => ({ type: "wakeup" as const })),
      ]);

      if (winner.type === "wakeup") {
        const action = state.stageAction;
        state.stageAction = undefined;
        if (action) await action;
        if (state.cancelStage >= 3) {
          // The bot was killed: the turn is over.
          result.status = "cancelled";
          result.cancelled = true;
          result.reason = state.cancelReason;
          done = true;
          break;
        }
        continue;
      }

      pending = undefined;
      const step = winner.value;
      if (step.done) {
        // The stream ended without a turn end: the bot died (or never spoke).
        result.status = "failed";
        result.reason = result.events.length === 0 ? BOT_DOWN : "stream_ended";
        done = true;
        break;
      }

      const event = step.value;
      result.events.push(event);
      if (deps.onEvent) {
        await deps.onEvent(event, {
          taskId: task.id,
          botId: decision.botId,
          attempt,
        });
      }

      if (event.kind === "ready") {
        state.providerSessionId = event.providerSessionId ?? state.providerSessionId;
        if (!state.promptSent) {
          try {
            await sendPrompt();
          } catch (error) {
            result.status = "failed";
            result.reason = BOT_DOWN;
            result.error = messageOf(error);
            done = true;
            break;
          }
        }
      } else if (event.kind === "text") {
        result.text += event.delta;
      } else if (event.kind === "turn_end") {
        result.usage = event.usage;
        result.cancelled = event.status === "cancelled";
        if (event.status === "ok") {
          result.status = "ok";
        } else if (event.status === "cancelled") {
          result.status = "cancelled";
        } else {
          result.status = "error";
          result.reason = "turn_error";
        }
        done = true;
      } else if (event.kind === "error") {
        result.status = "error";
        result.reason = event.message;
        result.error = event.message;
        done = true;
      }

      // Progress: the watchdog measures the silence between two events.
      if (!done && state.cancelStage === 0) {
        armTimer(clock.now() + ctx.watchdogMs, onWatchdog);
      }
    }
  } finally {
    clearTimer();
    if (deps.signal) deps.signal.removeEventListener("abort", onAbort);
    const closing = iterator?.return?.();
    if (closing) closing.then(undefined, () => {});
  }
}

/** Release the session of the client, ignoring its complaints. */
async function closeClient(client: BotdClient): Promise<void> {
  try {
    await client.close?.();
  } catch {
    // A bot that cannot be closed is not worth failing the run for.
  }
}

/** Message of a thrown value. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/**
 * A one-shot wake-up.
 *
 * The event loop waits for either the next event of the bot or a wake-up
 * (a timer fired, the caller aborted, ...).
 */
class Wakeup {
  #resolve: (() => void) | undefined;
  #promise: Promise<void> = Promise.resolve();
  #fired = false;

  /** Resolves as soon as `fire()` is called. */
  wait(): Promise<void> {
    if (this.#fired) {
      this.#fired = false;
      return Promise.resolve();
    }
    if (!this.#resolve) {
      this.#promise = new Promise<void>((resolve) => {
        this.#resolve = resolve;
      });
    }
    return this.#promise;
  }

  /** Wakes the current waiter, if there is one. */
  fire(): void {
    const resolve = this.#resolve;
    if (!resolve) {
      this.#fired = true;
      return;
    }
    this.#resolve = undefined;
    resolve();
  }
}
