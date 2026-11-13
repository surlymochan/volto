// Tests for the volto-botd task orchestrator.
//
// Fixtures are synthetic: bots, hosts, lanes and session ids are made-up
// names, never real hosts, addresses or credentials.

import test from "node:test";
import assert from "node:assert/strict";

import { BOT_DOWN, DEFAULT_WATCHDOG_MS, DEFAULT_CANCEL_GRACE_MS, DEFAULT_MAX_ATTEMPTS, isIndependentReviewer, runTask } from "../src/orchestrator.ts";
import type {
  BotdClient,
  Clock,
  OpenRequest,
  OrchestratorDeps,
  OrchestratorTask,
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

/** A client that records everything and replays queued events. */
class FakeClient implements BotdClient {
  readonly sent: unknown[] = [];
  readonly opened: OpenRequest[] = [];
  cancels = 0;
  kills = 0;
  closes = 0;
  /** Kinds of bots that cannot be started. */
  readonly downKinds = new Set<BotKind>();

  #queue: NormalizedEvent[] = [];
  #wake: (() => void) | undefined;

  async open(request: OpenRequest): Promise<void> {
    if (this.downKinds.has(request.adapter.kind)) {
      throw new Error(`bot ${request.adapter.kind} is down`);
    }
    this.opened.push(request);
  }

  async send(message: unknown): Promise<void> {
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

test("default watchdog fires at the silence deadline", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();
  const running = runTask({ id: "deadline", prompt: "work" }, deps({ client, clock }));
  await waitForTimer(clock);
  await clock.advance(DEFAULT_WATCHDOG_MS - 1);
  assert.deepEqual(client.sent, [{ handshake: "codex" }]);
  await clock.advance(1);
  assert.deepEqual(client.sent, [{ handshake: "codex" }, { cancel: true }]);
  client.emit({ kind: "turn_end", status: "cancelled" });
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(result.reason, "watchdog");
  assert.equal(clock.pending(), 0);
});

test("activity moves the exact silence deadline", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();
  const running = runTask({ id: "activity", prompt: "work" }, deps({ client, clock, watchdogMs: 100 }));
  await waitForTimer(clock);
  await clock.advance(99);
  client.emit({ kind: "text", delta: "progress" });
  await flush();
  await clock.advance(99);
  assert.equal(client.sent.length, 1);
  await clock.advance(1);
  assert.equal(client.sent.length, 2);
  client.emit({ kind: "turn_end", status: "cancelled" });
  assert.equal((await running).text, "progress");
});

test("cancel acknowledgement within grace prevents escalation", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();
  const running = runTask({ id: "ack", prompt: "work" }, deps({ client, clock, watchdogMs: 10 }));
  await waitForTimer(clock);
  await clock.advance(10);
  await clock.advance(DEFAULT_CANCEL_GRACE_MS - 1);
  client.emit({ kind: "turn_end", status: "cancelled" });
  const result = await running;
  await clock.advance(DEFAULT_CANCEL_GRACE_MS * 2);
  assert.equal(result.status, "cancelled");
  assert.equal(client.cancels, 0);
  assert.equal(client.kills, 0);
  assert.equal(clock.pending(), 0);
});

test("default grace separates interrupt and kill", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();
  const running = runTask({ id: "escalate", prompt: "work" }, deps({ client, clock, watchdogMs: 10 }));
  await waitForTimer(clock);
  await clock.advance(10 + DEFAULT_CANCEL_GRACE_MS - 1);
  assert.equal(client.cancels, 0);
  await clock.advance(1);
  assert.equal(client.cancels, 1);
  await clock.advance(DEFAULT_CANCEL_GRACE_MS - 1);
  assert.equal(client.kills, 0);
  await clock.advance(1);
  assert.equal(client.kills, 1);
  assert.equal((await running).status, "cancelled");
});

test("open failure reroutes and reports the successful attempt", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();
  client.downKinds.add("codex");
  client.emit({ kind: "turn_end", status: "ok" });
  const result = await runTask({ id: "reroute", prompt: "work" }, deps({ client, clock, bots: [
    bot({ id: "first", costTier: 1 }),
    bot({ id: "second", kind: "claude", family: "claude", costTier: 2 }),
  ] }));
  assert.equal(result.status, "ok");
  assert.equal(result.attempts, 2);
  assert.equal(result.botId, "second");
  assert.equal(client.closes, 2);
});

test("default maximum attempts retains the last open failure", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();
  client.downKinds.add("codex");
  const result = await runTask({ id: "exhaust", prompt: "work" }, deps({ client, clock,
    bots: Array.from({ length: DEFAULT_MAX_ATTEMPTS + 1 }, (_, i) => bot({ id: `bot-${i}` })),
  }));
  assert.equal(result.status, "failed");
  assert.equal(result.reason, BOT_DOWN);
  assert.equal(result.attempts, DEFAULT_MAX_ATTEMPTS);
  assert.equal(client.closes, DEFAULT_MAX_ATTEMPTS);
  assert.match(result.error ?? "", /down/);
});

test("an iterator throwing mid-stream fails with prior events retained", async () => {
  const clock = new FakeClock();
  class ThrowingClient extends FakeClient {
    override async *events(): AsyncIterable<NormalizedEvent> {
      yield { kind: "text", delta: "partial" };
      throw new Error("stream broke");
    }
  }
  const client = new ThrowingClient();
  const result = await runTask({ id: "throw", prompt: "work" }, deps({ client, clock }));
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "client_error");
  assert.equal(result.error, "stream broke");
  assert.equal(result.text, "partial");
  assert.equal(result.events.length, 1);
  assert.equal(clock.pending(), 0);
});

test("events arriving after cancellation completes are ignored", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();
  const seen: NormalizedEvent[] = [];
  const running = runTask({ id: "late", prompt: "work" }, deps({ client, clock, watchdogMs: 10,
    cancelGraceMs: 5, onEvent: (event) => { seen.push(event); } }));
  await waitForTimer(clock);
  await clock.advance(20);
  const result = await running;
  client.emit({ kind: "text", delta: "late" });
  await flush();
  assert.equal(result.status, "cancelled");
  assert.equal(result.text, "");
  assert.deepEqual(seen, []);
});

for (const [turnStatus, expected] of [["ok", "ok"], ["error", "error"], ["cancelled", "cancelled"]] as const) {
  test(`turn_end ${turnStatus} produces ${expected} status`, async () => {
    const clock = new FakeClock();
    const client = new FakeClient();
    client.emit({ kind: "turn_end", status: turnStatus });
    const result = await runTask({ id: `status-${turnStatus}`, prompt: "work" }, deps({ client, clock }));
    assert.equal(result.status, expected);
    assert.equal(result.ok, expected === "ok");
    assert.equal(clock.pending(), 0);
  });
}

test("no candidates produces unroutable status", async () => {
  const result = await runTask({ id: "unroutable", prompt: "work" }, deps({ bots: [], clock: new FakeClock() }));
  assert.equal(result.status, "unroutable");
  assert.equal(result.ok, false);
});

test("reviewer independence excludes the implementer family", () => {
  assert.equal(isIndependentReviewer("gpt", "gpt"), false);
  assert.equal(isIndependentReviewer("claude", "gpt"), true);
});

test("review reroute preserves the down failure when only the implementer family remains", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();
  client.downKinds.add("claude");
  const result = await runTask(
    { id: "review-reroute", type: "review", implementerFamily: "gpt", prompt: "review" },
    deps({ client, clock, bots: [
      bot({ id: "implementer" }),
      bot({ id: "reviewer", kind: "claude", family: "claude" }),
    ] }),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.reason, BOT_DOWN);
  assert.equal(result.attempts, 2);
});
