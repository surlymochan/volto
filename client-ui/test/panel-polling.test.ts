// Tests for the polling and the lifecycle of the "Remote bots" panel.
//
// The panel of client-ui/src/panel.ts polls the daemon: every POLL_MS
// milliseconds it refreshes the bots of the selected host, and it stops its
// timers when it is destroyed. These tests drive that loop without waiting
// for real time: the global timers are taken over by a fake clock, the wall
// clock is stubbed, and the mock client of src/mock-client.ts plays the
// daemon.
//
// The behaviour of the panel as it is today is asserted as it is. The four
// tests marked `todo` describe the behaviour the panel does not have yet;
// the marker of each of them says what is missing. They fail on purpose and
// are reported as todo, like the ones of test/screens.test.ts.
//
// The errors of the daemon are the ones of botd/PROTOCOL.md: a connection
// that dies leaves the client with a transport error (botd/src/client.ts
// rejects with "botd: transport closed"), which is what the failing polls
// of these tests simulate.

import assert from "node:assert/strict";
import test from "node:test";

import { findAllByTestId, findByTestId, installDom, textOf } from "../test-support/dom.ts";
import { MockBotdClient } from "../src/mock-client.ts";
import { createPanel, POLL_MS } from "../src/panel.ts";
import type { Panel } from "../src/panel.ts";
import type { StubDocument, StubElement } from "../test-support/dom.ts";
import type {
  BotEvent,
  BotdClient,
  RemoteBot,
  RemoteHost,
  Unsubscribe,
} from "../src/client.ts";

/* ------------------------------------------------------------- the harness */

/** The real wall clock, captured before a test replaces `Date.now`. */
const realNow = Date.now;

/** Builds the page skeleton the panel expects. */
function buildPage(): void {
  const { document } = installDom();
  document.register("status-line", "p");
  document.register("host-list", "ul");
  document.register("bots-panel", "section");
  document.register("stream-panel", "section");
  document.register("host-add", "button");
  document.register("add-host-dialog", "dialog");
  document.register("add-host-form", "form");
  document.register("host-alias", "input");
  document.register("host-label", "input");
  document.register("host-add-error", "p");
}

/** The element with the given id, which the page skeleton has to provide. */
function element(id: string): StubElement {
  const document = (globalThis as unknown as { document: StubDocument }).document;
  const found = document.getElementById(id);
  assert.ok(found, `the element #${id} exists`);
  return found as unknown as StubElement;
}

/** Waits until `predicate` holds or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = realNow() + timeoutMs;
  while (!predicate()) {
    if (realNow() > deadline) throw new Error("timed out waiting for the panel");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * The global timers, captured instead of run for real.
 *
 * The panel starts its poll timer with the global `setInterval`, so the
 * timer is taken over here: the test decides when it fires, and it can
 * check that the panel clears the timer again.
 */
class FakeTimers {
  /** Every interval the panel started, in the order it started them. */
  readonly intervals: Array<{ id: number; handler: () => void; delay: number }> = [];
  /** The ids of the intervals that were cleared. */
  readonly cleared: number[] = [];
  #nextId = 1;
  #originalSetInterval: unknown = null;
  #originalClearInterval: unknown = null;

  /** Takes the global timers over. */
  install(): void {
    const globals = globalThis as unknown as Record<string, unknown>;
    this.#originalSetInterval = globals.setInterval;
    this.#originalClearInterval = globals.clearInterval;
    globals.setInterval = (handler: () => void, delay?: number): number => {
      const id = this.#nextId;
      this.#nextId += 1;
      this.intervals.push({ id, handler, delay: delay ?? 0 });
      return id;
    };
    globals.clearInterval = (id?: number): void => {
      if (id === undefined) return;
      this.cleared.push(id);
      const index = this.intervals.findIndex((entry) => entry.id === id);
      if (index >= 0) this.intervals.splice(index, 1);
    };
  }

  /** Gives the global timers back. */
  restore(): void {
    const globals = globalThis as unknown as Record<string, unknown>;
    globals.setInterval = this.#originalSetInterval;
    globals.clearInterval = this.#originalClearInterval;
  }

  /** The interval the panel started, if any. */
  get started(): { id: number; handler: () => void; delay: number } | null {
    return this.intervals[0] ?? null;
  }

  /** Runs the handler of every interval, as the clock would. */
  fire(): void {
    for (const interval of [...this.intervals]) interval.handler();
  }
}

/** A wall clock the test controls, so the lease countdown can be checked. */
class TestClock {
  #current: number;
  #original: typeof Date.now;

  constructor(start: number) {
    this.#current = start;
    this.#original = Date.now;
  }

  /** Takes the wall clock over. */
  install(): void {
    Date.now = (): number => this.#current;
  }

  /** Moves the clock forward. */
  advance(ms: number): void {
    this.#current += ms;
  }

  /** Gives the real clock back. */
  restore(): void {
    Date.now = this.#original;
  }
}

/**
 * The mock client with a counter on top.
 *
 * The panel talks to a `BotdClient`; this wrapper counts the calls the panel
 * makes and can make `listBots` fail, the way a daemon whose transport died
 * does.
 */
class CountingClient implements BotdClient {
  /** How often the panel asked for the hosts. */
  listHostsCalls = 0;
  /** How often the panel asked for the bots of a host. */
  listBotsCalls = 0;
  /** The aliases the panel asked the bots of, in order. */
  listBotsAliases: string[] = [];
  /** The sessions the panel listens to, in order. */
  subscribeCalls: string[] = [];
  /** How often the panel gave up a subscription. */
  unsubscribeCalls = 0;
  /** The error `listBots` fails with, or null when it works. */
  listBotsError: Error | null = null;
  readonly inner: BotdClient;

  constructor(inner: BotdClient) {
    this.inner = inner;
  }

  async listHosts(): Promise<RemoteHost[]> {
    this.listHostsCalls += 1;
    return this.inner.listHosts();
  }

  async listBots(alias: string): Promise<RemoteBot[]> {
    this.listBotsCalls += 1;
    this.listBotsAliases.push(alias);
    if (this.listBotsError) throw this.listBotsError;
    return this.inner.listBots(alias);
  }

  async addHost(input: { alias: string; label?: string }): Promise<RemoteHost> {
    return this.inner.addHost(input);
  }

  async connect(alias: string): Promise<void> {
    await this.inner.connect(alias);
  }

  async disconnect(alias: string): Promise<void> {
    await this.inner.disconnect(alias);
  }

  subscribe(sessionId: string, onEvent: (event: BotEvent) => void): Unsubscribe {
    this.subscribeCalls.push(sessionId);
    const unsubscribe = this.inner.subscribe(sessionId, onEvent);
    return (): void => {
      this.unsubscribeCalls += 1;
      unsubscribe();
    };
  }

  async cancel(sessionId: string): Promise<void> {
    await this.inner.cancel(sessionId);
  }

  async answerPermission(permissionId: string, allow: boolean): Promise<void> {
    await this.inner.answerPermission(permissionId, allow);
  }
}

/** Connects a host through the panel and waits until it is connected. */
async function connectHost(panel: Panel, alias: string): Promise<void> {
  findByTestId(element("host-list"), `connect-${alias}`)?.dispatch("click");
  await waitFor(() =>
    panel.state.hosts.some((host) => host.alias === alias && host.status === "connected"),
  );
}

/** The lease label of a bot, e.g. "lease 4:30". */
function leaseOf(root: StubElement, botId: string): string {
  const bot = findByTestId(root, `bot-${botId}`);
  assert.ok(bot, `the bot ${botId} is drawn`);
  const match = /lease \d+:\d\d/.exec(textOf(bot));
  assert.ok(match, `the bot ${botId} shows its lease`);
  return match[0];
}

/* ------------------------------------------------------------ the poll timer */

test("the panel starts a poll timer of POLL_MS when it is mounted", async (t) => {
  buildPage();
  const timers = new FakeTimers();
  timers.install();
  t.after(() => timers.restore());

  const client = new CountingClient(new MockBotdClient({ hosts: [{ alias: "alpha" }] }));
  const panel = createPanel({ client });
  await panel.mount();

  const interval = timers.started;
  assert.ok(interval, "the panel started a timer");
  assert.equal(interval.delay, POLL_MS, "the timer runs every POLL_MS milliseconds");
  assert.equal(POLL_MS, 1000, "the panel polls once a second");

  panel.destroy();
});

test("a panel with pollMs 0 starts no timer", async (t) => {
  buildPage();
  const timers = new FakeTimers();
  timers.install();
  t.after(() => timers.restore());

  const client = new CountingClient(new MockBotdClient({ hosts: [{ alias: "alpha" }] }));
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  assert.equal(timers.started, null, "the poll timer is off");

  panel.destroy();
});

test("the poll timer is cleared when the panel is destroyed", async (t) => {
  buildPage();
  const timers = new FakeTimers();
  timers.install();
  t.after(() => timers.restore());

  const client = new CountingClient(new MockBotdClient({ hosts: [{ alias: "alpha" }] }));
  const panel = createPanel({ client });
  await panel.mount();

  const interval = timers.started;
  assert.ok(interval, "the panel started a timer");
  panel.destroy();

  assert.deepEqual(timers.cleared, [interval.id], "the timer of the panel was cleared");
  assert.equal(timers.started, null, "no timer is left behind");

  const before = client.listBotsCalls;
  timers.fire();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(client.listBotsCalls, before, "the destroyed panel does not poll any more");
});

test("destroying the panel twice is safe", async (t) => {
  buildPage();
  const timers = new FakeTimers();
  timers.install();
  t.after(() => timers.restore());

  const client = new CountingClient(new MockBotdClient({ hosts: [{ alias: "alpha" }], stepMs: 5 }));
  const panel = createPanel({ client });
  await panel.mount();
  await connectHost(panel, "alpha");

  const interval = timers.started;
  assert.ok(interval, "the panel started a timer");

  assert.doesNotThrow(() => panel.destroy());
  assert.doesNotThrow(() => panel.destroy());

  assert.deepEqual(timers.cleared, [interval.id], "the timer is cleared once");
  assert.equal(client.unsubscribeCalls, 1, "the subscription is given up once");
});

test("the poll timer refreshes the bots of the selected host", async (t) => {
  buildPage();
  const timers = new FakeTimers();
  timers.install();
  t.after(() => timers.restore());

  const client = new CountingClient(new MockBotdClient({ hosts: [{ alias: "alpha" }], stepMs: 5 }));
  const panel = createPanel({ client });
  await panel.mount();
  await connectHost(panel, "alpha");

  const before = client.listBotsCalls;
  timers.fire();
  await waitFor(() => client.listBotsCalls > before);

  assert.deepEqual(
    client.listBotsAliases.slice(-1),
    ["alpha"],
    "the timer polls the selected host",
  );

  const after = client.listBotsCalls;
  timers.fire();
  await waitFor(() => client.listBotsCalls > after);

  assert.equal(client.listBotsCalls, after + 1, "the timer polls again and again");

  panel.destroy();
});

/* ---------------------------------------------------------------- the ticks */

test("a tick refreshes the bots of the selected host", async () => {
  buildPage();
  const client = new CountingClient(new MockBotdClient({ hosts: [{ alias: "alpha" }], stepMs: 5 }));
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();
  await connectHost(panel, "alpha");

  const before = client.listBotsCalls;
  await panel.tick();

  assert.equal(client.listBotsCalls, before + 1, "the tick asks the daemon for the bots again");
  assert.deepEqual(client.listBotsAliases.slice(-1), ["alpha"], "the selected host is refreshed");

  panel.destroy();
});

test("a tick refreshes the bots of the selected host only", async () => {
  buildPage();
  const client = new CountingClient(
    new MockBotdClient({ hosts: [{ alias: "alpha" }, { alias: "bravo" }], stepMs: 5 }),
  );
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();
  await connectHost(panel, "alpha");

  client.listBotsAliases.length = 0;
  await panel.tick();

  assert.deepEqual(client.listBotsAliases, ["alpha"], "the host that is not selected is left alone");

  panel.destroy();
});

test("a tick does not refresh a host that is not connected", async () => {
  buildPage();
  const client = new CountingClient(new MockBotdClient({ hosts: [{ alias: "alpha" }] }));
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  const before = client.listBotsCalls;
  await panel.tick();

  assert.equal(client.listBotsCalls, before, "a host that is not connected is not polled");
  assert.equal(panel.state.hosts[0].status, "disconnected");

  panel.destroy();
});

test("a tick keeps the sessions of the host and subscribes to them only once", async () => {
  buildPage();
  const client = new CountingClient(new MockBotdClient({ hosts: [{ alias: "alpha" }], stepMs: 5 }));
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();
  await connectHost(panel, "alpha");

  assert.deepEqual(client.subscribeCalls, ["alpha-session-1"], "the panel listens to the session");

  await panel.tick();

  assert.deepEqual(
    client.subscribeCalls,
    ["alpha-session-1"],
    "the tick does not subscribe to the session twice",
  );
  assert.ok(panel.state.sessions["alpha-session-1"], "the session of the host is still known");

  panel.destroy();
});

test("a tick moves the clock of the panel forward", async (t) => {
  buildPage();
  const clock = new TestClock(1_700_000_000_000);
  clock.install();
  t.after(() => clock.restore());

  const client = new CountingClient(new MockBotdClient({ hosts: [{ alias: "alpha" }] }));
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  const before = panel.state.now;
  assert.equal(before, 1_700_000_000_000, "the panel took the clock at the mount");

  clock.advance(5_000);
  await panel.tick();

  assert.equal(panel.state.now, 1_700_000_005_000, "the tick moves the clock of the panel");

  panel.destroy();
});

test("the lease countdown of a bot changes between two ticks", async (t) => {
  buildPage();
  const clock = new TestClock(1_700_000_000_000);
  clock.install();
  t.after(() => clock.restore());

  const client = new CountingClient(new MockBotdClient({ hosts: [{ alias: "alpha" }], stepMs: 5 }));
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();
  await connectHost(panel, "alpha");
  await waitFor(() => findByTestId(element("bots-panel"), "bot-alpha-bot-1") !== null);

  // the mock gives a busy bot a lease of five minutes (LEASE_MS of src/mock-client.ts)
  assert.equal(leaseOf(element("bots-panel"), "alpha-bot-1"), "lease 5:00");

  clock.advance(30_000);
  await panel.tick();

  assert.equal(
    leaseOf(element("bots-panel"), "alpha-bot-1"),
    "lease 4:30",
    "the countdown follows the clock of the panel",
  );

  panel.destroy();
});

test("overlapping ticks do not duplicate the bots in the panel", async () => {
  buildPage();
  const client = new CountingClient(new MockBotdClient({ hosts: [{ alias: "alpha" }], stepMs: 5 }));
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();
  await connectHost(panel, "alpha");

  await Promise.all([panel.tick(), panel.tick()]);

  const bots = findAllByTestId(element("bots-panel"), "bot-alpha-bot-1");
  assert.equal(bots.length, 1, "the bot is drawn once, not once per tick");
  assert.equal(findAllByTestId(element("bots-panel"), "bot-alpha-bot-2").length, 1);

  panel.destroy();
});

/* ------------------------------------------------------------- the failures */

test("a failing tick leaves the panel mounted", async () => {
  buildPage();
  const client = new CountingClient(new MockBotdClient({ hosts: [{ alias: "alpha" }], stepMs: 5 }));
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();
  await connectHost(panel, "alpha");

  client.listBotsError = new Error("botd: transport closed (EOF)");
  await assert.rejects(() => panel.tick(), /transport closed/);

  assert.ok(findByTestId(element("host-list"), "host-alpha"), "the hosts are still drawn");
  assert.equal(panel.state.hosts.length, 1, "the panel still knows its host");

  panel.destroy();
});

test("a failing tick does not stop the next tick", async () => {
  buildPage();
  const client = new CountingClient(new MockBotdClient({ hosts: [{ alias: "alpha" }], stepMs: 5 }));
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();
  await connectHost(panel, "alpha");

  client.listBotsError = new Error("botd: transport closed (EOF)");
  await assert.rejects(() => panel.tick(), /transport closed/);

  client.listBotsError = null;
  const before = client.listBotsCalls;
  await panel.tick();

  assert.equal(client.listBotsCalls, before + 1, "the next tick polls the daemon again");
  assert.ok(
    findByTestId(element("bots-panel"), "bot-alpha-bot-1"),
    "the bots of the host are drawn again",
  );

  panel.destroy();
});

test("destroying the panel stops the session subscriptions", async () => {
  buildPage();
  const client = new CountingClient(new MockBotdClient({ hosts: [{ alias: "alpha" }], stepMs: 5 }));
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();
  await connectHost(panel, "alpha");

  assert.deepEqual(client.subscribeCalls, ["alpha-session-1"]);

  panel.destroy();

  assert.equal(client.unsubscribeCalls, 1, "the panel gave up the subscription of the session");
});

/* ------------------------------------------------------------ what is missing */

test(
  "a tick refreshes the hosts of the daemon",
  { todo: "the panel loads the hosts once at the mount; a tick refreshes the bots only" },
  async () => {
    buildPage();
    const client = new CountingClient(new MockBotdClient({ hosts: [{ alias: "alpha" }], stepMs: 5 }));
    const panel = createPanel({ client, pollMs: 0 });
    await panel.mount();
    await connectHost(panel, "alpha");

    const before = client.listHostsCalls;
    await panel.tick();

    assert.ok(client.listHostsCalls > before, "the tick asks the daemon for the hosts again");

    panel.destroy();
  },
);

test(
  "a failing tick shows the error in the status line",
  { todo: "the panel never dispatches error/set, so a rejected tick leaves the status line as it was" },
  async () => {
    buildPage();
    const client = new CountingClient(new MockBotdClient({ hosts: [{ alias: "alpha" }], stepMs: 5 }));
    const panel = createPanel({ client, pollMs: 0 });
    await panel.mount();
    await connectHost(panel, "alpha");

    client.listBotsError = new Error("botd: transport closed (EOF)");
    await panel.tick().catch(() => {});

    assert.match(
      textOf(element("status-line")),
      /transport closed/,
      "the status line shows the failure of the poll",
    );

    panel.destroy();
  },
);

test(
  "a tick that overlaps another one does not refresh the bots twice",
  { todo: "the panel has no single flight guard: every tick refreshes the bots on its own" },
  async () => {
    buildPage();
    const client = new CountingClient(new MockBotdClient({ hosts: [{ alias: "alpha" }], stepMs: 5 }));
    const panel = createPanel({ client, pollMs: 0 });
    await panel.mount();
    await connectHost(panel, "alpha");

    const before = client.listBotsCalls;
    await Promise.all([panel.tick(), panel.tick()]);

    assert.equal(
      client.listBotsCalls - before,
      1,
      "the overlapping tick does not ask the daemon again",
    );

    panel.destroy();
  },
);

test(
  "a host that goes away while the panel polls shows the error state",
  { todo: "a failed poll rejects the tick; the panel does not mark the host as failed" },
  async () => {
    buildPage();
    const client = new CountingClient(new MockBotdClient({ hosts: [{ alias: "alpha" }], stepMs: 5 }));
    const panel = createPanel({ client, pollMs: 0 });
    await panel.mount();
    await connectHost(panel, "alpha");

    // the daemon drops the host while the panel polls it
    await client.inner.disconnect("alpha");
    client.listBotsError = new Error("botd: transport closed (EOF)");
    await panel.tick().catch(() => {});

    const host = panel.state.hosts.find((entry) => entry.alias === "alpha");
    assert.equal(host?.status, "error", "the host is marked as failed");
    const status = findByTestId(element("host-list"), "host-status-alpha");
    assert.ok(status, "the host row shows its status");
    assert.match(textOf(status), /error/);

    panel.destroy();
  },
);
