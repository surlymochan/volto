// Gap tests for the volto-botd task orchestrator.
//
// botd/test/orchestrator.test.ts and botd/test/orchestrator-stall.test.ts
// cover the happy paths of a run; this file covers the branches they leave
// open: the truth table of the reviewer independence, the pinned defaults,
// every run status, the bot-down retry, the cancel of a pending timer, a bot
// without an adapter, an event stream that throws or ends early and the
// watchdog that has to fire exactly once.
//
// Fixtures are synthetic: bots, hosts, lanes and session ids are made-up
// names, never real hosts, addresses or credentials.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BOT_DOWN,
  DEFAULT_CANCEL_GRACE_MS,
  DEFAULT_DIFFICULTY,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_WATCHDOG_MS,
  isIndependentReviewer,
  runTask,
} from "../src/orchestrator.ts";
import type {
  BotdClient,
  Clock,
  OpenRequest,
  OrchestratorDeps,
  RunResult,
  RunStatus,
} from "../src/orchestrator.ts";
import type { Bot, RouterState } from "../src/router.ts";
import type {
  BotAdapter,
  BotKind,
  ModelFamily,
  NormalizedEvent,
  OpenOptions,
  SpawnSpec,
} from "../src/adapter-types.ts";

/** An adapter that knows nothing but its own kind. */
class FakeAdapter implements BotAdapter {
  readonly kind: BotKind;
  readonly family: ModelFamily;
  /** Messages the adapter writes right after the bot was spawned. */
  readonly handshakeMessages: unknown[];

  constructor(
    kind: BotKind,
    family: ModelFamily,
    handshakeMessages: unknown[] = [{ handshake: kind }],
  ) {
    this.kind = kind;
    this.family = family;
    this.handshakeMessages = handshakeMessages;
  }

  spawn(opts: OpenOptions): SpawnSpec {
    return { command: [this.kind], env: {}, cwd: opts.cwd };
  }

  handshake(_opts: OpenOptions): unknown[] {
    return this.handshakeMessages;
  }

  prompt(text: string, ctx: { providerSessionId?: string }): unknown {
    return ctx.providerSessionId
      ? { prompt: text, session: ctx.providerSessionId }
      : { prompt: text };
  }

  cancel(ctx: { providerSessionId?: string }): unknown[] {
    return ctx.providerSessionId
      ? [{ cancel: true, session: ctx.providerSessionId }]
      : [{ cancel: true }];
  }

  parse(line: string): NormalizedEvent[] {
    return [{ kind: "raw", payload: line }];
  }

  answerPermission(id: string, allow: boolean): unknown | null {
    return { id, allow };
  }
}

/** An adapter whose bot process cannot be started. */
class BrokenSpawnAdapter extends FakeAdapter {
  override spawn(_opts: OpenOptions): SpawnSpec {
    throw new Error("cannot spawn the bot");
  }
}

/** A client that records everything and replays queued events. */
class FakeClient implements BotdClient {
  readonly sent: unknown[] = [];
  readonly opened: OpenRequest[] = [];
  cancels = 0;
  kills = 0;
  closes = 0;
  /** Kinds of bots that cannot be started. */
  readonly downKinds = new Set<BotKind>();
  /** How many of the next sends fail. */
  failSends = 0;
  /** Message of a failing send. */
  failMessage = "the bot refuses the message";

  #queue: NormalizedEvent[] = [];
  #wake: (() => void) | undefined;

  async open(request: OpenRequest): Promise<void> {
    if (this.downKinds.has(request.adapter.kind)) {
      throw new Error(`bot ${request.adapter.kind} is down`);
    }
    this.opened.push(request);
  }

  async send(message: unknown): Promise<void> {
    if (this.failSends > 0) {
      this.failSends -= 1;
      throw new Error(this.failMessage);
    }
    this.sent.push(message);
  }

  async cancel(): Promise<void> {
    this.cancels += 1;
  }

  async kill(): Promise<void> {
    this.kills += 1;
  }

  async close(): Promise<void> {
    this.closes += 1;
  }

  /** Queue an event of the bot. */
  emit(event: NormalizedEvent): void {
    this.#queue.push(event);
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  async *events(): AsyncIterable<NormalizedEvent> {
    for (;;) {
      const event = this.#queue.shift();
      if (event) {
        yield event;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}

/** A client whose bots cannot be started, each with its own error. */
class DownClient implements BotdClient {
  readonly sent: unknown[] = [];
  /** How many times a bot was asked to start. */
  opens = 0;

  readonly #errors: string[];

  constructor(errors: string[]) {
    this.#errors = errors;
  }

  async open(_request: OpenRequest): Promise<void> {
    const message = this.#errors[Math.min(this.opens, this.#errors.length - 1)];
    this.opens += 1;
    throw new Error(message);
  }

  async send(message: unknown): Promise<void> {
    this.sent.push(message);
  }

  async cancel(): Promise<void> {}

  async *events(): AsyncIterable<NormalizedEvent> {
    for (;;) {
      await new Promise<void>(() => {});
    }
  }
}

/** A clock the test drives by hand. */
class FakeClock implements Clock {
  #now = 0;
  #seq = 0;
  #timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** Number of armed timers. */
  pending(): number {
    return this.#timers.size;
  }

  /** Move the time forward and fire the timers that come due. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.#timers) {
        if (entry[1].at > target) continue;
        if (!due || entry[1].at < due[1].at) due = entry;
      }
      if (!due) break;
      const [id, timer] = due;
      this.#timers.delete(id);
      this.#now = timer.at;
      timer.fn();
      await flush();
    }
    this.#now = target;
    await flush();
  }
}

function bot(overrides: Partial<Bot> & { id: string }): Bot {
  return {
    kind: "codex",
    family: "gpt",
    host: "site-a",
    lane: "primary",
    status: "idle",
    quotaUsedPct: 10,
    costTier: 1,
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

function deps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  const codex = new FakeAdapter("codex", "gpt");
  const claude = new FakeAdapter("claude", "claude");
  return {
    bots: [bot({ id: "bot-1" })],
    state: state(),
    client: new FakeClient(),
    adapterFor: (kind) => {
      if (kind === "codex") return codex;
      if (kind === "claude") return claude;
      return undefined;
    },
    ...overrides,
  };
}

/** Let the pending promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Wait until the clock has an armed timer. */
async function waitForTimer(clock: FakeClock): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (clock.pending() > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("no timer was armed");
}

/** True when the message is a provider cancel. */
function isCancel(message: unknown): boolean {
  return typeof message === "object" && message !== null && "cancel" in message;
}

/**
 * Wait for a run that is expected to end on its own.
 *
 * When the run does not end, the watchdog and the cancel escalation are
 * driven with the fake clock: the test then fails with an assertion instead
 * of hanging forever.
 */
async function settle(running: Promise<RunResult>, clock: FakeClock): Promise<RunResult> {
  let done = false;
  const tracked = running.then((result) => {
    done = true;
    return result;
  });
  tracked.catch(() => {});
  await flush();
  if (!done) {
    await clock.advance(DEFAULT_WATCHDOG_MS);
    await clock.advance(DEFAULT_CANCEL_GRACE_MS);
    await clock.advance(DEFAULT_CANCEL_GRACE_MS);
    await flush();
  }
  if (!done) {
    // the run is stuck: the test fails instead of waiting for it forever
    throw new Error("the run did not end");
  }
  return tracked;
}

// --- the reviewer independence -------------------------------------------

test("isIndependentReviewer: the implementer family may not review itself", () => {
  assert.equal(isIndependentReviewer("gpt", "gpt"), false);
});

test("isIndependentReviewer: another bot of the same family may not review either", () => {
  // the rule is about the model family, not about the bot instance
  assert.equal(isIndependentReviewer("gpt", "gpt"), false);
  assert.equal(isIndependentReviewer("claude", "claude"), false);
});

test("isIndependentReviewer: a bot of another family may review", () => {
  assert.equal(isIndependentReviewer("claude", "gpt"), true);
  assert.equal(isIndependentReviewer("gpt", "claude"), true);
});

test("isIndependentReviewer: without a known implementer anybody may review", () => {
  assert.equal(isIndependentReviewer("gpt", undefined), true);
  assert.equal(isIndependentReviewer("claude", undefined), true);
});

// --- the pinned defaults -------------------------------------------------

test("the default constants are pinned", () => {
  assert.equal(DEFAULT_WATCHDOG_MS, 120_000);
  assert.equal(DEFAULT_CANCEL_GRACE_MS, 5_000);
  assert.equal(DEFAULT_MAX_ATTEMPTS, 3);
  assert.equal(DEFAULT_DIFFICULTY, 3);
  assert.equal(BOT_DOWN, "bot_down");
});

test("a task without a type or a difficulty reaches the router with the defaults", async () => {
  const seen: Record<string, unknown>[] = [];
  await runTask(
    { id: "defaults", prompt: "work" },
    deps({
      clock: new FakeClock(),
      route: (task) => {
        seen.push(task as unknown as Record<string, unknown>);
        return { ok: false, taskId: task.id, reason: "no_eligible_bot" };
      },
    }),
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "impl");
  assert.equal(seen[0].difficulty, DEFAULT_DIFFICULTY);
});

// --- the run statuses ----------------------------------------------------

test("every run status is reachable", async () => {
  const statuses = new Set<RunStatus>();

  const okClock = new FakeClock();
  const okClient = new FakeClient();
  okClient.emit({ kind: "turn_end", status: "ok" });
  statuses.add(
    (
      await settle(
        runTask({ id: "s-ok", prompt: "work" }, deps({ client: okClient, clock: okClock })),
        okClock,
      )
    ).status,
  );

  const errorClock = new FakeClock();
  const errorClient = new FakeClient();
  errorClient.emit({ kind: "error", message: "the provider exploded" });
  statuses.add(
    (
      await settle(
        runTask({ id: "s-error", prompt: "work" }, deps({ client: errorClient, clock: errorClock })),
        errorClock,
      )
    ).status,
  );

  const controller = new AbortController();
  const cancelledClock = new FakeClock();
  const cancelledClient = new FakeClient();
  const cancelled = runTask(
    { id: "s-cancelled", prompt: "work" },
    deps({ client: cancelledClient, clock: cancelledClock, signal: controller.signal }),
  );
  await flush();
  controller.abort();
  cancelledClient.emit({ kind: "turn_end", status: "cancelled" });
  statuses.add((await settle(cancelled, cancelledClock)).status);

  statuses.add(
    (await runTask({ id: "s-unroutable", prompt: "work" }, deps({ bots: [], clock: new FakeClock() })))
      .status,
  );

  const downClock = new FakeClock();
  const downClient = new DownClient(["the bot is down"]);
  statuses.add(
    (
      await settle(
        runTask({ id: "s-failed", prompt: "work" }, deps({ client: downClient, clock: downClock })),
        downClock,
      )
    ).status,
  );

  assert.deepEqual(
    [...statuses].sort(),
    ["cancelled", "error", "failed", "ok", "unroutable"],
  );
});

test("the prompt is written once when the bot says ready twice", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();
  client.emit({ kind: "ready", providerSessionId: "session-r" });
  client.emit({ kind: "ready", providerSessionId: "session-r" });
  client.emit({ kind: "turn_end", status: "ok" });

  const result = await settle(
    runTask({ id: "ready-twice", prompt: "work" }, deps({ client, clock })),
    clock,
  );

  assert.equal(result.status, "ok");
  const prompts = client.sent.filter(
    (message) => typeof message === "object" && message !== null && "prompt" in message,
  );
  assert.equal(prompts.length, 1);
});

test("an error event ends the run with the error status", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();
  client.emit({ kind: "error", message: "the provider exploded" });

  const result = await settle(
    runTask({ id: "error-event", prompt: "work" }, deps({ client, clock })),
    clock,
  );

  assert.equal(result.status, "error");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "the provider exploded");
  assert.equal(result.error, "the provider exploded");
  assert.equal(clock.pending(), 0);
});

test("a task without a bot is not routed", async () => {
  const result = await runTask(
    { id: "no-bot", prompt: "work" },
    deps({ bots: [], clock: new FakeClock() }),
  );
  assert.equal(result.status, "unroutable");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_eligible_bot");
  assert.equal(result.text, "");
  assert.deepEqual(result.events, []);
});

// --- the bot-down retry ---------------------------------------------------

test("a bot that is down is retried up to DEFAULT_MAX_ATTEMPTS and the last error is kept", async () => {
  const clock = new FakeClock();
  const client = new DownClient(["first down", "second down", "third down"]);
  const bots = Array.from({ length: DEFAULT_MAX_ATTEMPTS + 1 }, (_, i) => bot({ id: `bot-${i}` }));

  const result = await runTask({ id: "down-retry", prompt: "work" }, deps({ client, clock, bots }));

  assert.equal(result.status, "failed");
  assert.equal(result.ok, false);
  assert.equal(result.reason, BOT_DOWN);
  assert.equal(result.attempts, DEFAULT_MAX_ATTEMPTS);
  assert.equal(client.opens, DEFAULT_MAX_ATTEMPTS);
  // the error of the last try is the one that is reported
  assert.equal(result.error, "third down");
});

test("a bot that stays down ends the run as failed with the bot-down reason", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();
  client.downKinds.add("codex");
  const bots = Array.from({ length: DEFAULT_MAX_ATTEMPTS + 1 }, (_, i) => bot({ id: `bot-${i}` }));

  const result = await runTask({ id: "down-failed", prompt: "work" }, deps({ client, clock, bots }));

  assert.equal(result.status, "failed");
  assert.equal(result.reason, BOT_DOWN);
  assert.equal(result.attempts, DEFAULT_MAX_ATTEMPTS);
  assert.match(result.error ?? "", /down/);
  // every try released the session of the client
  assert.equal(client.closes, DEFAULT_MAX_ATTEMPTS);
});

test("a bot that refuses the handshake is down and the task is rerouted", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();
  client.failSends = 1;
  client.failMessage = "the handshake was refused";
  client.emit({ kind: "ready", providerSessionId: "session-h" });
  client.emit({ kind: "turn_end", status: "ok" });

  const result = await settle(
    runTask(
      { id: "handshake-down", prompt: "work" },
      deps({
        client,
        clock,
        bots: [
          bot({ id: "bot-codex", kind: "codex", family: "gpt", costTier: 1 }),
          bot({ id: "bot-claude", kind: "claude", family: "claude", costTier: 2 }),
        ],
      }),
    ),
    clock,
  );

  assert.equal(result.status, "ok");
  assert.equal(result.attempts, 2);
  assert.equal(result.botId, "bot-claude");
  // the handshake of the second bot went through
  assert.deepEqual(client.sent, [{ handshake: "claude" }, { prompt: "work", session: "session-h" }]);
});

test("an adapter that cannot spawn the bot is down", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();
  const broken = new BrokenSpawnAdapter("codex", "gpt");

  const result = await runTask(
    { id: "spawn-down", prompt: "work" },
    deps({
      client,
      clock,
      maxAttempts: 1,
      adapterFor: (kind) => (kind === "codex" ? broken : undefined),
    }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.reason, BOT_DOWN);
  assert.equal(result.error, "cannot spawn the bot");
  assert.equal(client.opened.length, 0);
  assert.equal(client.closes, 1);
});

test("a thrown string is kept as the error message", async () => {
  const clock = new FakeClock();
  class StringClient extends FakeClient {
    override async open(_request: OpenRequest): Promise<void> {
      throw "the bot did not start";
    }
  }
  const client = new StringClient();

  const result = await runTask({ id: "thrown-string", prompt: "work" }, deps({ client, clock }));

  assert.equal(result.status, "failed");
  assert.equal(result.reason, BOT_DOWN);
  assert.equal(result.error, "the bot did not start");
});

test("a thrown value that is not an error is stringified", async () => {
  const clock = new FakeClock();
  class NumberClient extends FakeClient {
    override async open(_request: OpenRequest): Promise<void> {
      throw 42;
    }
  }
  const client = new NumberClient();

  const result = await runTask({ id: "thrown-number", prompt: "work" }, deps({ client, clock }));

  assert.equal(result.status, "failed");
  assert.equal(result.reason, BOT_DOWN);
  assert.equal(result.error, "42");
});

// --- the cancel of a pending timer ---------------------------------------

test("a cancel clears the pending timer and opens no further session", async () => {
  const clock = new FakeClock();
  const controller = new AbortController();
  const client = new FakeClient();

  const running = runTask(
    { id: "cancel-timer", prompt: "work" },
    deps({
      client,
      clock,
      signal: controller.signal,
      watchdogMs: 1_000,
      cancelGraceMs: 500,
    }),
  );

  await waitForTimer(clock);
  controller.abort();
  await flush();
  client.emit({ kind: "turn_end", status: "cancelled" });

  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(result.reason, "aborted");
  // the pending timer is gone
  assert.equal(clock.pending(), 0);
  // and nothing fires later: no escalation, no second session
  await clock.advance(10_000);
  assert.equal(client.cancels, 0);
  assert.equal(client.kills, 0);
  assert.equal(client.opened.length, 1);
});

test("a cancel the bot acknowledges stops the escalation and clears the timer", async () => {
  const clock = new FakeClock();
  const controller = new AbortController();
  const client = new FakeClient();

  const running = runTask(
    { id: "cancel-acked", prompt: "work" },
    deps({
      client,
      clock,
      signal: controller.signal,
      watchdogMs: 60_000,
      cancelGraceMs: 500,
    }),
  );

  await waitForTimer(clock);
  controller.abort();
  await flush();
  client.emit({ kind: "turn_end", status: "cancelled" });

  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(result.cancelled, true);
  assert.equal(result.reason, "aborted");
  assert.equal(clock.pending(), 0);

  // the escalation never happens
  await clock.advance(10_000);
  assert.equal(client.cancels, 0);
  assert.equal(client.kills, 0);
  assert.equal(client.sent.filter(isCancel).length, 1);
});

test("a cancel that starts before the stream is read is not lost", async () => {
  const clock = new FakeClock();
  const controller = new AbortController();
  controller.abort();
  const seen: NormalizedEvent[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  /** A client whose cancel write blocks until the test opens the gate. */
  class SlowSendClient extends FakeClient {
    override async send(message: unknown): Promise<void> {
      if (isCancel(message)) await gate;
      this.sent.push(message);
    }
  }
  const client = new SlowSendClient();
  client.emit({ kind: "text", delta: "hello" });

  const running = runTask(
    { id: "cancel-lost", prompt: "work" },
    deps({
      client,
      clock,
      signal: controller.signal,
      watchdogMs: 60_000,
      cancelGraceMs: 500,
      onEvent: (event) => {
        seen.push(event);
      },
    }),
  );

  await flush();
  // the cancel is written before the stream is read and it blocks: the event
  // of the bot is not handled before the cancel is done
  assert.deepEqual(seen, []);
  release();
  await flush();

  await clock.advance(500); // the escalation interrupts the bot
  await clock.advance(500); // and kills it
  const result = await settle(running, clock);
  assert.equal(result.status, "cancelled");
  assert.equal(result.reason, "aborted");
  assert.deepEqual(seen.map((event) => event.kind), ["text"]);
});

test("a signal that is already aborted cancels the run right away", async () => {
  const clock = new FakeClock();
  const controller = new AbortController();
  controller.abort();
  const client = new FakeClient();

  const running = runTask(
    { id: "pre-aborted", prompt: "work" },
    deps({
      client,
      clock,
      signal: controller.signal,
      watchdogMs: 60_000,
      cancelGraceMs: 500,
    }),
  );

  await waitForTimer(clock);
  await clock.advance(500); // the escalation interrupts the bot
  await clock.advance(500); // and kills it

  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(result.cancelled, true);
  assert.equal(result.reason, "aborted");
  assert.equal(result.watchdog, false);
  assert.equal(client.sent.filter(isCancel).length, 1);
  assert.equal(clock.pending(), 0);
});

test("an abort during the watchdog escalation does not restart the escalation", async () => {
  const clock = new FakeClock();
  const controller = new AbortController();
  const client = new FakeClient();

  const running = runTask(
    { id: "abort-during-escalation", prompt: "work" },
    deps({
      client,
      clock,
      signal: controller.signal,
      watchdogMs: 1_000,
      cancelGraceMs: 5_000,
    }),
  );

  await waitForTimer(clock);
  await clock.advance(1_000); // the watchdog fires and starts the escalation
  assert.equal(client.sent.filter(isCancel).length, 1);

  controller.abort(); // the caller aborts while the escalation runs
  await flush();
  // the escalation is not started a second time
  assert.equal(client.sent.filter(isCancel).length, 1);

  await clock.advance(5_000); // the escalation interrupts the bot
  assert.equal(client.cancels, 1);
  await clock.advance(5_000); // and kills it
  assert.equal(client.kills, 1);

  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(result.watchdog, true);
  assert.equal(result.reason, "watchdog");
});

// --- the watchdog ---------------------------------------------------------

test("the watchdog fires exactly once and is cleared when the run ends", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();

  const running = runTask(
    { id: "watchdog-once", prompt: "work" },
    deps({ client, clock, watchdogMs: 1_000, cancelGraceMs: 500 }),
  );

  await waitForTimer(clock);
  await clock.advance(1_000); // the watchdog fires
  await flush();
  // exactly one provider cancel
  assert.equal(client.sent.filter(isCancel).length, 1);

  // the bot speaks again while the cancel runs: the escalation is not
  // restarted and the watchdog is not armed a second time
  client.emit({ kind: "text", delta: "still here" });
  await flush();
  assert.equal(client.sent.filter(isCancel).length, 1);

  await clock.advance(500); // the escalation interrupts the bot
  assert.equal(client.cancels, 1);
  await clock.advance(500); // and kills it
  assert.equal(client.kills, 1);

  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(result.cancelled, true);
  assert.equal(result.watchdog, true);
  assert.equal(result.reason, "watchdog");
  assert.equal(clock.pending(), 0);

  // the watchdog does not fire a second time
  await clock.advance(10_000);
  assert.equal(client.sent.filter(isCancel).length, 1);
  assert.equal(client.cancels, 1);
  assert.equal(client.kills, 1);
});

test("the watchdog timer is cleared when the run completes", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();
  client.emit({ kind: "turn_end", status: "ok" });

  const result = await runTask(
    { id: "watchdog-cleared", prompt: "work" },
    deps({ client, clock, watchdogMs: 1_000 }),
  );

  assert.equal(result.status, "ok");
  assert.equal(result.watchdog, false);
  assert.equal(clock.pending(), 0);

  // the watchdog never fires after the run
  await clock.advance(10_000);
  assert.equal(client.sent.filter(isCancel).length, 0);
  assert.equal(client.cancels, 0);
  assert.equal(client.kills, 0);
});

test("a client without a kill step still ends the run as cancelled", async () => {
  const clock = new FakeClock();
  /** A client without the optional kill() and close() steps. */
  class MinimalClient implements BotdClient {
    readonly sent: unknown[] = [];
    cancels = 0;

    async open(_request: OpenRequest): Promise<void> {}

    async send(message: unknown): Promise<void> {
      this.sent.push(message);
    }

    async cancel(): Promise<void> {
      this.cancels += 1;
    }

    async *events(): AsyncIterable<NormalizedEvent> {
      for (;;) {
        await new Promise<void>(() => {});
      }
    }
  }
  const client = new MinimalClient();

  const running = runTask(
    { id: "no-kill", prompt: "work" },
    deps({ client, clock, watchdogMs: 1_000, cancelGraceMs: 500 }),
  );

  await waitForTimer(clock);
  await clock.advance(1_000); // the watchdog fires
  await clock.advance(500); // the escalation interrupts the bot
  await clock.advance(500); // there is no kill step, the run ends anyway

  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(result.watchdog, true);
  assert.equal(client.cancels, 1);
  assert.equal(clock.pending(), 0);
});

// --- the adapters ---------------------------------------------------------

test("a bot without an adapter is skipped and the task is rerouted", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();
  client.emit({ kind: "ready", providerSessionId: "session-a" });
  client.emit({ kind: "turn_end", status: "ok" });
  const claude = new FakeAdapter("claude", "claude");

  const result = await runTask(
    { id: "no-adapter", prompt: "work" },
    deps({
      client,
      clock,
      bots: [
        bot({ id: "bot-codex", kind: "codex", family: "gpt", costTier: 1 }),
        bot({ id: "bot-claude", kind: "claude", family: "claude", costTier: 2 }),
      ],
      adapterFor: (kind) => (kind === "claude" ? claude : undefined),
    }),
  );

  assert.equal(result.status, "ok");
  assert.equal(result.botId, "bot-claude");
  assert.equal(result.attempts, 2);
  // the bot without an adapter was never started
  assert.equal(client.opened.length, 1);
  assert.equal(client.opened[0].adapter.kind, "claude");
});

test("a task whose bots have no adapter is not routed", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();

  const result = await runTask(
    { id: "no-adapter-any", prompt: "work" },
    deps({ client, clock, adapterFor: () => undefined }),
  );

  assert.equal(result.status, "unroutable");
  assert.equal(result.ok, false);
  assert.equal(client.opened.length, 0);
  assert.equal(client.sent.length, 0);
});

test("the no-adapter reason is reported when no attempt is left", async () => {
  const result = await runTask(
    { id: "no-adapter-reason", prompt: "work" },
    deps({
      client: new FakeClient(),
      clock: new FakeClock(),
      adapterFor: () => undefined,
      maxAttempts: 1,
    }),
  );

  assert.equal(result.status, "unroutable");
  assert.equal(result.reason, "no_adapter");
});

test("a custom router may not slip a reviewer of the implementer family through", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();
  // the bot would answer, so a run that is started anyway ends right away
  client.emit({ kind: "turn_end", status: "ok" });

  const result = await settle(
    runTask(
      { id: "review-check", type: "review", implementerFamily: "gpt", prompt: "review" },
      deps({
        client,
        clock,
        bots: [bot({ id: "bot-gpt", family: "gpt" })],
        // a router that ignores the independence rule
        route: (task) => ({
          ok: true,
          taskId: task.id,
          botId: "bot-gpt",
          kind: "codex",
          family: "gpt",
          host: "site-a",
          lane: "primary",
          costTier: 1,
          reason: "assigned",
        }),
      }),
    ),
    clock,
  );

  assert.equal(result.status, "unroutable");
  assert.equal(result.reason, "no_independent_reviewer");
  // the reviewer of the implementer family was never started
  assert.equal(client.opened.length, 0);
});

// --- the defects the orchestrator still has --------------------------------

test("a run that was aborted before it started does not start the bot", async (t) => {
  t.todo("DEFECT: botd/src/orchestrator.ts opens the bot before it looks at the abort signal");
  const clock = new FakeClock();
  const controller = new AbortController();
  controller.abort();
  const client = new FakeClient();

  const running = runTask(
    { id: "aborted-open", prompt: "work" },
    deps({
      client,
      clock,
      signal: controller.signal,
      watchdogMs: 60_000,
      cancelGraceMs: 500,
    }),
  );

  await waitForTimer(clock);
  await clock.advance(500); // the escalation interrupts the bot
  await clock.advance(500); // and kills it
  const result = await settle(running, clock);

  assert.equal(result.status, "cancelled");
  assert.equal(result.reason, "aborted");
  // the bot of a run that was cancelled before it started is never started
  assert.equal(client.opened.length, 0);
});

test("a run that was aborted while it was rerouted does not start the next bot", async (t) => {
  t.todo("DEFECT: botd/src/orchestrator.ts opens the bot before it looks at the abort signal");
  const clock = new FakeClock();
  const controller = new AbortController();
  let attempts = 0;
  /** The first bot is down and the caller aborts while the task is rerouted. */
  class AbortingClient extends FakeClient {
    override async open(request: OpenRequest): Promise<void> {
      attempts += 1;
      if (attempts === 1) {
        controller.abort();
        throw new Error("the bot is down");
      }
      this.opened.push(request);
    }
  }
  const client = new AbortingClient();
  const bots = Array.from({ length: 3 }, (_, i) => bot({ id: `bot-${i}` }));

  const running = runTask(
    { id: "aborted-reroute", prompt: "work" },
    deps({
      client,
      clock,
      bots,
      signal: controller.signal,
      watchdogMs: 60_000,
      cancelGraceMs: 500,
    }),
  );

  await waitForTimer(clock);
  await clock.advance(500); // the escalation interrupts the bot
  await clock.advance(500); // and kills it
  const result = await settle(running, clock);

  assert.equal(result.status, "cancelled");
  assert.equal(result.reason, "aborted");
  // the reroute of a run that was cancelled does not start another bot
  assert.equal(client.opened.length, 0);
});

test("the event stream of the bot is closed when the run returns", async (t) => {
  t.todo("DEFECT: botd/src/orchestrator.ts fires the close of the event stream but does not await it");
  const clock = new FakeClock();
  let closed = false;
  /** A client whose stream needs a tick to be closed. */
  class SlowCleanupClient extends FakeClient {
    override async *events(): AsyncIterable<NormalizedEvent> {
      try {
        yield { kind: "turn_end", status: "ok" };
        yield { kind: "text", delta: "never seen" };
      } finally {
        await new Promise<void>((resolve) => setImmediate(resolve));
        closed = true;
      }
    }
  }
  const client = new SlowCleanupClient();

  // no flush in between: the run has to hand the result back with the stream
  // of the bot closed
  const result = await runTask({ id: "stream-close", prompt: "work" }, deps({ client, clock }));

  assert.equal(result.status, "ok");
  // the stream of the bot is closed before the run hands the result back
  assert.equal(closed, true);
});

// --- the event stream -----------------------------------------------------

test("an event stream that ends before the first event is down and the task is rerouted", async () => {
  const clock = new FakeClock();
  /** The first bot dies without a word, the second one answers. */
  class EndingClient extends FakeClient {
    streams = 0;

    override async *events(): AsyncIterable<NormalizedEvent> {
      this.streams += 1;
      if (this.streams === 1) return;
      yield* super.events();
    }
  }
  const client = new EndingClient();
  client.emit({ kind: "turn_end", status: "ok" });

  const result = await settle(
    runTask(
      { id: "empty-stream", prompt: "work" },
      deps({
        client,
        clock,
        bots: [
          bot({ id: "bot-codex", kind: "codex", family: "gpt", costTier: 1 }),
          bot({ id: "bot-claude", kind: "claude", family: "claude", costTier: 2 }),
        ],
      }),
    ),
    clock,
  );

  assert.equal(result.status, "ok");
  assert.equal(result.botId, "bot-claude");
  assert.equal(result.attempts, 2);
});

test("an event stream that ends in the middle of a turn fails with stream_ended", async () => {
  const clock = new FakeClock();
  /** The bot speaks once and then stops. */
  class EndingClient extends FakeClient {
    override async *events(): AsyncIterable<NormalizedEvent> {
      yield { kind: "text", delta: "partial" };
      return;
    }
  }
  const client = new EndingClient();

  const result = await settle(
    runTask(
      { id: "ended-stream", prompt: "work" },
      deps({
        client,
        clock,
        bots: [
          bot({ id: "bot-codex", kind: "codex", family: "gpt", costTier: 1 }),
          bot({ id: "bot-claude", kind: "claude", family: "claude", costTier: 2 }),
        ],
      }),
    ),
    clock,
  );

  assert.equal(result.status, "failed");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stream_ended");
  assert.equal(result.text, "partial");
  assert.equal(result.events.length, 1);
  // the task is not rerouted: the bot was there, it just stopped talking
  assert.equal(result.attempts, 1);
  assert.equal(clock.pending(), 0);
});

test("an event stream that throws fails the run with the client error", async () => {
  const clock = new FakeClock();
  /** The bot speaks once and then the stream breaks. */
  class ThrowingClient extends FakeClient {
    override async *events(): AsyncIterable<NormalizedEvent> {
      yield { kind: "text", delta: "partial" };
      throw new Error("the stream broke");
    }
  }
  const client = new ThrowingClient();

  const result = await settle(
    runTask({ id: "throwing-stream", prompt: "work" }, deps({ client, clock })),
    clock,
  );

  assert.equal(result.status, "failed");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "client_error");
  assert.equal(result.error, "the stream broke");
  assert.equal(result.text, "partial");
  assert.equal(result.events.length, 1);
  assert.equal(clock.pending(), 0);
});

test("an event stream that throws before the first event fails with the client error", async () => {
  const clock = new FakeClock();
  /** The stream breaks before the bot says anything. */
  class ThrowingClient extends FakeClient {
    override async *events(): AsyncIterable<NormalizedEvent> {
      throw new Error("the stream broke right away");
    }
  }
  const client = new ThrowingClient();

  const result = await settle(
    runTask({ id: "throwing-stream-early", prompt: "work" }, deps({ client, clock })),
    clock,
  );

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "client_error");
  assert.equal(result.error, "the stream broke right away");
  assert.deepEqual(result.events, []);
  assert.equal(clock.pending(), 0);
});

test("a failing stream cleanup does not break the run", async () => {
  const clock = new FakeClock();
  /** The cleanup of the stream fails when the run ends. */
  class BadCleanupClient extends FakeClient {
    override async *events(): AsyncIterable<NormalizedEvent> {
      try {
        yield { kind: "turn_end", status: "ok" };
        yield { kind: "text", delta: "never seen" };
      } finally {
        throw new Error("the cleanup failed");
      }
    }
  }
  const client = new BadCleanupClient();

  const result = await settle(
    runTask({ id: "bad-cleanup", prompt: "work" }, deps({ client, clock })),
    clock,
  );

  assert.equal(result.status, "ok");
  assert.equal(result.ok, true);
  assert.equal(result.text, "");
  await flush();
});

test("a client that cannot be closed does not fail the run", async () => {
  const clock = new FakeClock();
  /** A client whose close step fails. */
  class BadCloseClient extends FakeClient {
    override async close(): Promise<void> {
      this.closes += 1;
      throw new Error("the session cannot be released");
    }
  }
  const client = new BadCloseClient();
  client.emit({ kind: "turn_end", status: "ok" });

  const result = await settle(
    runTask({ id: "bad-close", prompt: "work" }, deps({ client, clock })),
    clock,
  );

  assert.equal(result.status, "ok");
  assert.equal(result.ok, true);
  assert.equal(client.closes, 1);
});
