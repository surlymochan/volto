import assert from "node:assert/strict";
import test from "node:test";

import { findByTestId, installDom, textOf } from "../test-support/dom.ts";
import { createPanel } from "../src/panel.ts";
import type { StubElement } from "../test-support/dom.ts";
import type {
  BotEvent,
  BotdClient,
  RemoteBot,
  RemoteHost,
  Unsubscribe,
} from "../src/client.ts";

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

/** The first element carrying the given class, in document order. */
function findByClass(root: StubElement, className: string): StubElement | null {
  for (const child of root.children) {
    if (child.className.split(/\s+/).includes(className)) return child;
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
}

/** The chips of the session list, in the order the panel draws them. */
function sessionChips(root: StubElement): StubElement[] {
  const list = findByClass(root, "session-list");
  if (!list) return [];
  const chips: StubElement[] = [];
  for (const item of list.children) {
    for (const child of item.children) {
      if (child.className.split(/\s+/).includes("chip")) chips.push(child);
    }
  }
  return chips;
}

/** A bot of the scripted client. */
function bot(id: string, sessionId: string | null, host = "alpha"): RemoteBot {
  return {
    id,
    host,
    kind: "codex",
    family: "gpt",
    lane: "primary",
    status: sessionId === null ? "idle" : "busy",
    leaseExpiresAt: null,
    quotaUsedPct: 12,
    sessionId,
  };
}

/** A permission request of a session. */
function permissionEvent(
  sessionId: string,
  permissionId: string,
  title: string,
  detail?: string,
  botId = "alpha-bot-1",
): BotEvent {
  return { kind: "permission", sessionId, host: "alpha", botId, permissionId, title, detail };
}

/** The end of a turn of a session. */
function turnEndEvent(sessionId: string, status: "ok" | "error" | "cancelled"): BotEvent {
  return { kind: "turn_end", sessionId, host: "alpha", botId: "alpha-bot-1", status };
}

/**
 * A client the test drives by hand: no timers, no scripts.
 *
 * The panel asks it for the hosts, the bots and the events; the test pushes
 * the events itself and reads the answers the panel sent back.
 */
class ScriptedClient implements BotdClient {
  /** Every answer the panel sent, in the order it sent them. */
  readonly answers: Array<{ permissionId: string; allow: boolean }> = [];
  private readonly hosts: RemoteHost[];
  private readonly bots: Record<string, RemoteBot[]>;
  private readonly listeners = new Map<string, Set<(event: BotEvent) => void>>();

  constructor(hosts: RemoteHost[], bots: Record<string, RemoteBot[]>) {
    this.hosts = hosts;
    this.bots = bots;
  }

  async listHosts(): Promise<RemoteHost[]> {
    return this.hosts.map((host) => ({ ...host }));
  }

  async addHost(): Promise<RemoteHost> {
    throw new Error("the scripted client cannot add hosts");
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async listBots(alias: string): Promise<RemoteBot[]> {
    return (this.bots[alias] ?? []).map((entry) => ({ ...entry }));
  }

  subscribe(sessionId: string, onEvent: (event: BotEvent) => void): Unsubscribe {
    const listeners = this.listeners.get(sessionId) ?? new Set<(event: BotEvent) => void>();
    listeners.add(onEvent);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(onEvent);
    };
  }

  async cancel(): Promise<void> {}

  async answerPermission(permissionId: string, allow: boolean): Promise<void> {
    this.answers.push({ permissionId, allow });
  }

  /** Sends an event to the panel, the way the daemon would. */
  emit(event: BotEvent): void {
    for (const listener of [...(this.listeners.get(event.sessionId) ?? [])]) listener(event);
  }
}

test("session entries show their bot and status and follow latest activity", async () => {
  buildPage();
  const client = new ScriptedClient([{ alias: "alpha" }], {
    alpha: [bot("bot-1", "session-1"), bot("bot-2", "session-10")],
  });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();
  let chips = sessionChips(element("stream-panel"));
  assert.match(textOf(chips[0]), /session-10.*bot-2.*running/);
  assert.match(textOf(chips[1]), /session-1.*bot-1.*running/);
  client.emit(turnEndEvent("session-1", "ok"));
  chips = sessionChips(element("stream-panel"));
  assert.match(textOf(chips[0]), /session-1.*bot-1.*ended/);
  assert.match(textOf(chips[1]), /session-10.*bot-2.*running/);
  panel.destroy();
});

test("requests from other sessions appear in a global alert and can be answered", async () => {
  buildPage();
  const client = new ScriptedClient([{ alias: "alpha" }, { alias: "bravo" }], {
    alpha: [bot("bot-1", "session-1")],
    bravo: [bot("bot-2", "session-2", "bravo")],
  });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();
  findByTestId(element("host-list"), "host-bravo")?.dispatch("click");
  await waitFor(() => panel.state.selectedSession === "session-2");
  client.emit(permissionEvent("session-1", "perm-1", "May I?", "Details"));
  const alert = findByTestId(element("stream-panel"), "permission-alert");
  assert.ok(alert);
  assert.match(textOf(alert), /1 pending permission/);
  assert.match(textOf(alert), /alpha.*bot-1.*session-1.*May I\?.*Details/);
  findByTestId(alert, "perm-deny-perm-1")?.dispatch("click");
  await waitFor(() => findByTestId(element("stream-panel"), "permission-alert") === null);
  assert.deepEqual(client.answers, [{ permissionId: "perm-1", allow: false }]);
  panel.destroy();
});
