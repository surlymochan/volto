// Tests for the volto-botd task orchestrator.
//
// Fixtures are synthetic: bots, hosts, lanes and session ids are made-up
// names, never real hosts, addresses or credentials.

import test from "node:test";
import assert from "node:assert/strict";

import { BOT_DOWN, isIndependentReviewer, runTask } from "../src/orchestrator.ts";
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

test("runs a task: spawns the bot, handshakes, prompts and streams the events", async () => {
  const client = new FakeClient();
  client.emit({ kind: "ready", providerSessionId: "session-a" });
  client.emit({ kind: "text", delta: "hello " });
  client.emit({ kind: "text", delta: "world" });
  client.emit({ kind: "turn_end", status: "ok", usage: { inputTokens: 12, outputTokens: 3 } });

  const seen: NormalizedEvent[] = [];
  const result = await runTask(
    { id: "task-1", prompt: "do the thing", cwd: "/work/site-a" },
    deps({
      client,
      onEvent: (event) => {
        seen.push(event);
      },
    }),
  );

  assert.equal(result.status, "ok");
  assert.equal(result.ok, true);
  assert.equal(result.botId, "bot-1");
  assert.equal(result.kind, "codex");
  assert.equal(result.family, "gpt");
  assert.equal(result.text, "hello world");
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3 });

  // every event reached the callback
  assert.deepEqual(seen.map((event) => event.kind), ["ready", "text", "text", "turn_end"]);

  // the bot was spawned in the working directory of the task
  assert.equal(client.opened.length, 1);
  assert.deepEqual(client.opened[0].spec.command, ["codex"]);
  assert.equal(client.opened[0].spec.cwd, "/work/site-a");

  // the handshake comes first, the prompt after the session is ready
  assert.deepEqual(client.sent, [
    { handshake: "codex" },
    { prompt: "do the thing", session: "session-a" },
  ]);
});

test("prompts right away when the protocol has no handshake", async () => {
  const client = new FakeClient();
  const adapter = new FakeAdapter("claude", "claude", []);
  client.emit({ kind: "text", delta: "hi" });
  client.emit({ kind: "turn_end", status: "ok" });

  const result = await runTask(
    { id: "task-2", prompt: "do the thing" },
    deps({
      client,
      bots: [bot({ id: "bot-claude", kind: "claude", family: "claude" })],
      adapterFor: (kind) => (kind === "claude" ? adapter : undefined),
    }),
  );

  assert.equal(result.status, "ok");
  assert.deepEqual(client.sent, [{ prompt: "do the thing" }]);
});

test("reroutes the task when the bot is down", async () => {
  const client = new FakeClient();
  client.downKinds.add("codex");
  client.emit({ kind: "ready", providerSessionId: "session-b" });
  client.emit({ kind: "text", delta: "done" });
  client.emit({ kind: "turn_end", status: "ok" });

  const result = await runTask(
    { id: "task-3", prompt: "do the thing" },
    deps({
      client,
      bots: [
        bot({ id: "bot-codex", kind: "codex", family: "gpt", costTier: 1 }),
        bot({ id: "bot-claude", kind: "claude", family: "claude", costTier: 2 }),
      ],
    }),
  );

  assert.equal(result.status, "ok");
  assert.equal(result.ok, true);
  assert.equal(result.botId, "bot-claude");
  assert.equal(result.family, "claude");
  // the down bot was tried first, the reroute used another one
  assert.equal(result.attempts, 2);
  assert.equal(client.opened.length, 1);
  assert.equal(client.opened[0].adapter.kind, "claude");
});

test("gives up when every bot is down", async () => {
  const client = new FakeClient();
  client.downKinds.add("codex");
  client.downKinds.add("claude");

  const result = await runTask(
    { id: "task-4", prompt: "do the thing" },
    deps({
      client,
      bots: [
        bot({ id: "bot-codex", kind: "codex", family: "gpt" }),
        bot({ id: "bot-claude", kind: "claude", family: "claude" }),
      ],
      maxAttempts: 2,
    }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.ok, false);
  assert.equal(result.reason, BOT_DOWN);
  assert.equal(result.attempts, 2);
});

test("runs a review on a bot of another family", async () => {
  const client = new FakeClient();
  client.emit({ kind: "ready", providerSessionId: "session-c" });
  client.emit({ kind: "text", delta: "looks good" });
  client.emit({ kind: "turn_end", status: "ok" });

  const result = await runTask(
    { id: "task-5", type: "review", implementerFamily: "gpt", prompt: "review the change" },
    deps({
      client,
      bots: [
        bot({ id: "bot-gpt", kind: "codex", family: "gpt", costTier: 1 }),
        bot({ id: "bot-claude", kind: "claude", family: "claude", costTier: 2 }),
      ],
    }),
  );

  assert.equal(result.status, "ok");
  assert.equal(result.botId, "bot-claude");
  assert.equal(result.family, "claude");
  assert.notEqual(result.family, "gpt");
});

test("a review needs a reviewer of another family", () => {
  assert.equal(isIndependentReviewer("claude", "gpt"), true);
  assert.equal(isIndependentReviewer("gpt", "gpt"), false);
  // without a known implementer anybody may review
  assert.equal(isIndependentReviewer("gpt", undefined), true);
});

test("a review without an independent reviewer is not routed", async () => {
  const client = new FakeClient();
  const result = await runTask(
    { id: "task-6", type: "review", implementerFamily: "gpt", prompt: "review the change" },
    deps({
      client,
      bots: [bot({ id: "bot-gpt", kind: "codex", family: "gpt" })],
    }),
  );

  assert.equal(result.status, "unroutable");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_independent_reviewer");
  assert.equal(client.opened.length, 0);
});

test("cancels a bot that goes quiet (watchdog)", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();
  const adapter = new FakeAdapter("codex", "gpt");

  const running = runTask(
    { id: "task-7", prompt: "do the thing" },
    deps({
      client,
      adapterFor: (kind) => (kind === "codex" ? adapter : undefined),
      clock,
      watchdogMs: 1_000,
      cancelGraceMs: 500,
    }),
  );

  await waitForTimer(clock);
  await clock.advance(1_000); // the watchdog fires
  await clock.advance(500); // escalation: interrupt the bot
  await clock.advance(500); // escalation: kill the bot

  const result = await running;

  assert.equal(result.status, "cancelled");
  assert.equal(result.cancelled, true);
  assert.equal(result.watchdog, true);
  assert.equal(result.reason, "watchdog");
  assert.equal(result.ok, false);
  // the provider cancel came first, then the interrupt, then the kill
  assert.deepEqual(client.sent, [{ handshake: "codex" }, { cancel: true }]);
  assert.equal(client.cancels, 1);
  assert.equal(client.kills, 1);
});

test("the watchdog is reset by every event", async () => {
  const clock = new FakeClock();
  const client = new FakeClient();

  const running = runTask(
    { id: "task-8", prompt: "do the thing" },
    deps({ client, clock, watchdogMs: 1_000, cancelGraceMs: 500 }),
  );

  await waitForTimer(clock);
  // the bot speaks every 600 ms, so the watchdog never fires
  for (let i = 0; i < 3; i++) {
    await clock.advance(600);
    client.emit({ kind: "text", delta: "still working" });
    await flush();
  }
  assert.equal(client.cancels, 0);
  assert.equal(client.kills, 0);

  client.emit({ kind: "turn_end", status: "ok" });
  const result = await running;
  assert.equal(result.status, "ok");
  assert.equal(result.text, "still workingstill workingstill working");
});

test("aborting the run cancels the turn", async () => {
  const controller = new AbortController();
  const client = new FakeClient();

  const running = runTask(
    { id: "task-9", prompt: "do the thing" },
    deps({ client, signal: controller.signal, watchdogMs: 60_000, cancelGraceMs: 5 }),
  );

  await flush();
  controller.abort();

  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(result.cancelled, true);
  assert.equal(result.reason, "aborted");
  assert.equal(result.watchdog, false);
  assert.ok(client.sent.some((message) => isCancel(message)));
});

test("a task without an eligible bot is not routed", async () => {
  const result = await runTask(
    { id: "task-10", prompt: "do the thing" },
    deps({ bots: [] }),
  );

  assert.equal(result.status, "unroutable");
  assert.equal(result.reason, "no_eligible_bot");
  assert.equal(result.attempts, 1);
});

test("the router sees the task of the orchestrator", async () => {
  const seen: unknown[] = [];
  const client = new FakeClient();
  client.emit({ kind: "turn_end", status: "ok" });

  const result = await runTask(
    { id: "task-11", prompt: "do the thing", difficulty: 4, avoidHosts: ["site-b"] },
    deps({
      client,
      route: (task, bots, state) => {
        seen.push({ task, bots, state });
        return { ok: false, taskId: task.id, reason: "no_eligible_bot" };
      },
    }),
  );

  assert.equal(result.status, "unroutable");
  assert.equal(seen.length, 1);
  const call = seen[0] as { task: Record<string, unknown> };
  assert.equal(call.task.id, "task-11");
  assert.equal(call.task.type, "impl");
  assert.equal(call.task.difficulty, 4);
  assert.deepEqual(call.task.avoidHosts, ["site-b"]);
});

function isCancel(message: unknown): boolean {
  return typeof message === "object" && message !== null && "cancel" in message;
}
