// Tests for the session subscription lifecycle of the "Remote bots" panel.
//
// The panel subscribes to the events of every session it learns about and
// releases the subscriptions when it is torn down. These tests drive that
// lifecycle through the stub DOM of test-support/dom.ts and a mock client
// that records what the panel asked of it.
//
// The mock of src/mock-client.ts plays the daemon: it starts a task when a
// host connects, streams the events of the task and asks for a permission.
// The harness below extends it, so that a test can watch the subscriptions,
// push an event by hand and count the answers the panel sent.
//
// The polling cadence, the host dialog and the look of the screens are
// covered elsewhere (panel-polling, panel-host-dialog, screens); this file
// is about the lifecycle of the subscriptions.
//
// The defects the tests below found are described in the body of the pull
// request of the card. The tests that pin them down are marked as todo.
//
// All names, aliases and payloads below are synthetic.

import assert from "node:assert/strict";
import test from "node:test";

import { findByTestId, installDom, textOf } from "../test-support/dom.ts";
import { MockBotdClient } from "../src/mock-client.ts";
import { createPanel } from "../src/panel.ts";
import type { StubElement } from "../test-support/dom.ts";
import type { BotEvent, RemoteBot, Unsubscribe } from "../src/client.ts";

/**
 * The number of events a session may keep.
 *
 * The daemon keeps at most 1000 events per session (botd/PROTOCOL.md, the
 * ring of botd/src/ring.ts) and drops the oldest ones. The state of the
 * panel has to work with the same bound; it defines none of its own yet.
 */
const MAX_SESSION_EVENTS = 1000;

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
  const found = globalThis.document.getElementById(id);
  assert.ok(found, `the element #${id} exists`);
  return found as unknown as StubElement;
}

/** Waits until `predicate` holds or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the panel");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** The number of events the panel draws in the stream. */
function eventCount(root: StubElement): number {
  let count = 0;
  for (const child of root.children) {
    const testId = child.getAttribute("data-testid") ?? "";
    if (/^event-\d+$/.test(testId)) count += 1;
    count += eventCount(child);
  }
  return count;
}

/** A text event of a session. */
function textEvent(sessionId: string, text: string, botId = "alpha-bot-1"): BotEvent {
  return { kind: "text", sessionId, host: "alpha", botId, text };
}

/** The end of a turn of a session. */
function turnEndEvent(sessionId: string, status: "ok" | "error" | "cancelled"): BotEvent {
  return { kind: "turn_end", sessionId, host: "alpha", botId: "alpha-bot-1", status };
}

/** One subscription the panel opened. */
interface Subscription {
  /** The session the panel listens to. */
  sessionId: string;
  /** The callback the panel handed to the client. */
  listener: (event: BotEvent) => void;
  /** Whether the subscription is still open. */
  live: boolean;
}

/**
 * A mock client that records what the panel asked of it.
 *
 * The scripted part of the daemon (the task, its events and the permission
 * request) comes from the mock; the harness only watches the subscriptions
 * and counts the answers.
 */
class HarnessClient extends MockBotdClient {
  /** Every subscription the panel opened, in the order it opened them. */
  readonly opened: Subscription[] = [];
  /** The sessions whose subscription was released, in the order it happened. */
  readonly released: string[] = [];
  /** Every answer the panel sent to a permission request. */
  readonly answers: Array<{ permissionId: string; allow: boolean }> = [];
  /** How often the panel asked the client for the bots of a host. */
  listBotsCalls = 0;

  /** The number of subscriptions that are still open. */
  get live(): number {
    return this.opened.filter((entry) => entry.live).length;
  }

  override subscribe(sessionId: string, onEvent: (event: BotEvent) => void): Unsubscribe {
    const unsubscribe = super.subscribe(sessionId, onEvent);
    const entry: Subscription = { sessionId, listener: onEvent, live: true };
    this.opened.push(entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.live = false;
      this.released.push(sessionId);
      unsubscribe();
    };
  }

  override async answerPermission(permissionId: string, allow: boolean): Promise<void> {
    this.answers.push({ permissionId, allow });
    await super.answerPermission(permissionId, allow);
  }

  override async listBots(alias: string): Promise<RemoteBot[]> {
    this.listBotsCalls += 1;
    return super.listBots(alias);
  }

  /** Hands an event to every open subscription, the way the daemon pushes it. */
  deliver(event: BotEvent): void {
    for (const entry of this.opened) {
      if (!entry.live) continue;
      entry.listener(event);
    }
  }
}

/** Connects a host through the panel and waits until its session is opened. */
async function connectHost(client: HarnessClient, alias: string): Promise<string> {
  findByTestId(element("host-list"), `connect-${alias}`)?.dispatch("click");
  await waitFor(() => client.opened.some((entry) => entry.sessionId.startsWith(`${alias}-session-`)));
  const entry = client.opened.find((item) => item.sessionId.startsWith(`${alias}-session-`));
  assert.ok(entry, `the panel subscribed to a session of ${alias}`);
  return entry.sessionId;
}

/* ------------------------------------------------------------- subscribing */

test("opening a session subscribes to it exactly once", async (t) => {
  buildPage();
  const client = new HarnessClient({ hosts: [{ alias: "alpha" }], stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  t.after(() => panel.destroy());
  await panel.mount();

  const sessionId = await connectHost(client, "alpha");

  assert.equal(client.opened.length, 1, "the panel subscribed once");
  assert.equal(sessionId, "alpha-session-1");
  assert.equal(client.live, 1, "the subscription is open");

  await panel.tick();
  await panel.tick();

  assert.equal(client.opened.length, 1, "a refresh does not subscribe again");
  assert.equal(client.live, 1, "no second subscription was opened");

  const session = panel.state.sessions[sessionId];
  assert.ok(session, "the session is in the state");
  const greetings = session.events.filter(
    (event) => event.kind === "text" && event.text === "picked up the task",
  );
  assert.equal(greetings.length, 1, "the events of the session are not replayed twice");
});

test("switching the host keeps the session state of the other host", async (t) => {
  buildPage();
  const client = new HarnessClient({ hosts: [{ alias: "alpha" }, { alias: "bravo" }], stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  t.after(() => panel.destroy());
  await panel.mount();

  const alphaSession = await connectHost(client, "alpha");
  await connectHost(client, "bravo");

  findByTestId(element("host-list"), "host-bravo")?.dispatch("click");
  await waitFor(() => panel.state.selectedHost === "bravo");

  assert.ok(
    panel.state.sessions[alphaSession],
    "the session of the other host is still in the state",
  );
  assert.equal(client.live, 2, "both subscriptions are still open");

  client.deliver(textEvent(alphaSession, "still working", "alpha-bot-1"));
  const events = panel.state.sessions[alphaSession].events;
  assert.ok(
    events.some((event) => event.kind === "text" && event.text === "still working"),
    "the events of the other host still arrive",
  );
});

test(
  "a session that ends is unsubscribed",
  { todo: "the panel keeps the subscription of a session that ended" },
  async (t) => {
    buildPage();
    const client = new HarnessClient({ hosts: [{ alias: "alpha" }], stepMs: 5 });
    const panel = createPanel({ client, pollMs: 0 });
    t.after(() => panel.destroy());
    await panel.mount();

    const sessionId = await connectHost(client, "alpha");

    client.deliver(turnEndEvent(sessionId, "ok"));

    assert.equal(panel.state.sessions[sessionId].status, "ended", "the session ended");
    assert.equal(client.live, 0, "the panel unsubscribed from the finished session");
    assert.deepEqual(client.released, [sessionId], "the unsubscribe was called once");
  },
);

test("the bot of an ended session is drawn as idle", async (t) => {
  buildPage();
  const client = new HarnessClient({ hosts: [{ alias: "alpha" }], stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  t.after(() => panel.destroy());
  await panel.mount();

  const sessionId = await connectHost(client, "alpha");

  const allowId = `perm-allow-${sessionId}-permission-1`;
  await waitFor(() => findByTestId(element("stream-panel"), allowId) !== null);
  findByTestId(element("stream-panel"), allowId)?.dispatch("click");
  await waitFor(() => panel.state.sessions[sessionId].status === "ended");

  await panel.tick();

  const bot = findByTestId(element("bots-panel"), "bot-alpha-bot-1");
  assert.ok(bot, "the bot is listed");
  const badge = findByTestId(element("bots-panel"), "bot-status-alpha-bot-1");
  assert.ok(badge, "the bot shows its status");
  assert.equal(textOf(badge), "idle", "the bot is idle again");
});

/* ---------------------------------------------------------------- teardown */

test("destroying the panel releases every subscription", async (t) => {
  buildPage();
  const client = new HarnessClient({ hosts: [{ alias: "alpha" }, { alias: "bravo" }], stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  t.after(() => panel.destroy());
  await panel.mount();

  await connectHost(client, "alpha");
  await connectHost(client, "bravo");
  const sessionIds = client.opened.map((entry) => entry.sessionId);
  assert.equal(client.live, 2, "both subscriptions are open");

  panel.destroy();

  assert.equal(client.live, 0, "no subscription is left open");
  assert.deepEqual(
    [...client.released].sort(),
    [...sessionIds].sort(),
    "every unsubscribe was called",
  );
});

test("destroying the panel stops the poll timer", async (t) => {
  buildPage();
  const client = new HarnessClient({ hosts: [{ alias: "alpha" }], stepMs: 5 });
  const panel = createPanel({ client, pollMs: 10 });
  t.after(() => panel.destroy());
  await panel.mount();

  await connectHost(client, "alpha");
  const before = panel.state.now;
  await waitFor(() => panel.state.now !== before, 1000);

  panel.destroy();

  // Let the refresh that was in flight settle before counting.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const now = panel.state.now;
  const calls = client.listBotsCalls;
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(panel.state.now, now, "the clock of the panel did not move any more");
  assert.equal(client.listBotsCalls, calls, "the panel did not ask for the bots any more");
});

test("destroying the panel twice does not throw", async (t) => {
  buildPage();
  const client = new HarnessClient({ hosts: [{ alias: "alpha" }], stepMs: 5 });
  const panel = createPanel({ client, pollMs: 10 });
  t.after(() => panel.destroy());
  await panel.mount();

  await connectHost(client, "alpha");

  panel.destroy();
  assert.doesNotThrow(() => panel.destroy());
  assert.equal(client.live, 0, "no subscription is left open");
  assert.equal(client.released.length, 1, "the unsubscribe is not called twice");
});

/* ------------------------------------------------------------ permissions */

test("a permission event is answered once and its prompt disappears", async (t) => {
  buildPage();
  const client = new HarnessClient({ hosts: [{ alias: "alpha" }], stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  t.after(() => panel.destroy());
  await panel.mount();

  const sessionId = await connectHost(client, "alpha");

  const allowId = `perm-allow-${sessionId}-permission-1`;
  const denyId = `perm-deny-${sessionId}-permission-1`;
  await waitFor(() => findByTestId(element("stream-panel"), allowId) !== null);
  assert.ok(
    findByTestId(element("stream-panel"), allowId),
    "the prompt is drawn in the stream panel",
  );

  findByTestId(element("stream-panel"), allowId)?.dispatch("click");

  await waitFor(() => client.answers.length > 0);
  assert.deepEqual(
    client.answers,
    [{ permissionId: `${sessionId}-permission-1`, allow: true }],
    "the client was asked once",
  );
  await waitFor(() => findByTestId(element("stream-panel"), allowId) === null);
  assert.equal(
    findByTestId(element("stream-panel"), denyId),
    null,
    "the prompt is gone from the stream panel",
  );
});

/* ------------------------------------------------------------- odd events */

test("an event of an unknown session is ignored", async (t) => {
  buildPage();
  const client = new HarnessClient({ hosts: [{ alias: "alpha" }], stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  t.after(() => panel.destroy());
  await panel.mount();

  const sessionId = await connectHost(client, "alpha");
  const events = panel.state.sessions[sessionId].events.length;
  const drawn = eventCount(element("stream-panel"));

  client.deliver(textEvent("ghost-session", "hello?", "alpha-bot-1"));

  assert.equal(panel.state.sessions["ghost-session"], undefined, "no session was created");
  assert.equal(
    panel.state.sessions[sessionId].events.length,
    events,
    "the known session did not change",
  );
  assert.equal(eventCount(element("stream-panel")), drawn, "the stream did not change");
});

test(
  "the events of a long session stay within the limit of the state",
  { todo: "state.ts defines no limit for the events of a session: they pile up" },
  async (t) => {
    buildPage();
    const client = new HarnessClient({ hosts: [{ alias: "alpha" }], stepMs: 5 });
    const panel = createPanel({ client, pollMs: 0 });
    t.after(() => panel.destroy());
    await panel.mount();

    const sessionId = await connectHost(client, "alpha");

    for (let index = 0; index < MAX_SESSION_EVENTS + 100; index += 1) {
      client.deliver(textEvent(sessionId, `line ${index}`, "alpha-bot-1"));
    }

    const events = panel.state.sessions[sessionId].events;
    assert.ok(
      events.length <= MAX_SESSION_EVENTS,
      `the session keeps at most ${MAX_SESSION_EVENTS} events, it keeps ${events.length}`,
    );
    assert.ok(
      eventCount(element("stream-panel")) <= MAX_SESSION_EVENTS,
      "the stream draws at most the events the state keeps",
    );
  },
);
