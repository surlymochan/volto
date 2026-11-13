// Tests for the session list and the permission prompt of the panel.
//
// The panel is driven through the stub DOM of test-support/dom.ts. The mock
// client of src/mock-client.ts plays the daemon for the flow it scripts (a
// task that asks for a permission and waits for the answer); a small scripted
// client takes over for the cases the mock cannot produce (several sessions
// per host, several queued permissions, redacted payloads).
//
// Every name, alias and payload below is synthetic.
//
// The panel never talks to a daemon itself: it answers a request through the
// client, with `answerPermission(permissionId, allow)`. That call is the
// frame the UI sends; the NDJSON framing of the daemon lives in
// botd/src/frames.ts.
//
// The defects found while writing these tests are listed in
// DEFECTS-screens.md. The tests that pin those defects down are marked as
// todo: they are expected to fail until the panel is fixed.

import assert from "node:assert/strict";
import test from "node:test";

import { findByTestId, installDom, textOf } from "../test-support/dom.ts";
import { MockBotdClient } from "../src/mock-client.ts";
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

/** The events of the stream, in the order the panel draws them. */
function eventElements(root: StubElement): StubElement[] {
  const events: StubElement[] = [];
  for (let index = 0; ; index += 1) {
    const found = findByTestId(root, `event-${index}`);
    if (!found) break;
    events.push(found);
  }
  return events;
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

/** A text event of a session. */
function textEvent(sessionId: string, text: string, botId = "alpha-bot-1"): BotEvent {
  return { kind: "text", sessionId, host: "alpha", botId, text };
}

/** A tool event of a session. */
function toolEvent(
  sessionId: string,
  name: string,
  summary: string,
  botId = "alpha-bot-1",
): BotEvent {
  return { kind: "tool", sessionId, host: "alpha", botId, name, status: "end", summary };
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

/** A client that remembers the answers the panel sent and passes them on. */
class RecordingClient implements BotdClient {
  /** Every answer the panel sent, in the order it sent them. */
  readonly answers: Array<{ permissionId: string; allow: boolean }> = [];
  private readonly inner: BotdClient;

  constructor(inner: BotdClient) {
    this.inner = inner;
  }

  async listHosts(): Promise<RemoteHost[]> {
    return this.inner.listHosts();
  }

  async addHost(input: { alias: string; label?: string }): Promise<RemoteHost> {
    return this.inner.addHost(input);
  }

  async connect(alias: string): Promise<void> {
    return this.inner.connect(alias);
  }

  async disconnect(alias: string): Promise<void> {
    return this.inner.disconnect(alias);
  }

  async listBots(alias: string): Promise<RemoteBot[]> {
    return this.inner.listBots(alias);
  }

  subscribe(sessionId: string, onEvent: (event: BotEvent) => void): Unsubscribe {
    return this.inner.subscribe(sessionId, onEvent);
  }

  async cancel(sessionId: string): Promise<void> {
    return this.inner.cancel(sessionId);
  }

  async answerPermission(permissionId: string, allow: boolean): Promise<void> {
    this.answers.push({ permissionId, allow });
    await this.inner.answerPermission(permissionId, allow);
  }
}

/* ------------------------------------------------------------ session list */

test("the session list shows one entry per bot that runs a session", async () => {
  buildPage();
  const client = new ScriptedClient([{ alias: "alpha" }], {
    alpha: [bot("alpha-bot-1", "alpha-session-1"), bot("alpha-bot-2", "alpha-session-2")],
  });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  const chips = sessionChips(element("stream-panel"));
  assert.equal(chips.length, 2, "both sessions are listed");
  assert.deepEqual(
    chips.map((chip) => textOf(chip)),
    ["alpha-session-1", "alpha-session-2"],
  );
  panel.destroy();
});

test("the session list only shows the sessions of the selected host", async () => {
  buildPage();
  const client = new ScriptedClient([{ alias: "alpha" }, { alias: "bravo" }], {
    alpha: [bot("alpha-bot-1", "alpha-session-1")],
    bravo: [bot("bravo-bot-1", "bravo-session-1", "bravo")],
  });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  assert.deepEqual(
    sessionChips(element("stream-panel")).map((chip) => textOf(chip)),
    ["alpha-session-1"],
  );

  findByTestId(element("host-list"), "host-bravo")?.dispatch("click");
  await waitFor(() => sessionChips(element("stream-panel")).length > 0);

  assert.deepEqual(
    sessionChips(element("stream-panel")).map((chip) => textOf(chip)),
    ["bravo-session-1"],
    "the list follows the selected host",
  );
  panel.destroy();
});

test("the session list is empty when no session runs", async () => {
  buildPage();
  const client = new ScriptedClient([{ alias: "alpha" }], {
    alpha: [bot("alpha-bot-1", null)],
  });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  assert.equal(findByClass(element("stream-panel"), "session-list"), null, "no list is drawn");
  assert.match(textOf(element("stream-panel")), /No session yet/);
  panel.destroy();
});

test(
  "the session list is ordered oldest first",
  { todo: "the list is sorted by id, so alpha-session-10 comes before alpha-session-2" },
  async () => {
    buildPage();
    const bots: RemoteBot[] = [];
    for (let index = 1; index <= 12; index += 1) {
      bots.push(bot(`alpha-bot-${index}`, `alpha-session-${index}`));
    }
    const client = new ScriptedClient([{ alias: "alpha" }], { alpha: bots });
    const panel = createPanel({ client, pollMs: 0 });
    await panel.mount();

    const expected = bots.map((entry) => entry.sessionId as string);
    assert.deepEqual(
      sessionChips(element("stream-panel")).map((chip) => textOf(chip)),
      expected,
      "the oldest session comes first",
    );
    panel.destroy();
  },
);

test(
  "every session entry shows the status of its session",
  { todo: "the entries carry the session id only, the status is not shown" },
  async () => {
    buildPage();
    const client = new ScriptedClient([{ alias: "alpha" }], {
      alpha: [bot("alpha-bot-1", "alpha-session-1")],
    });
    const panel = createPanel({ client, pollMs: 0 });
    await panel.mount();

    client.emit(turnEndEvent("alpha-session-1", "ok"));

    const chips = sessionChips(element("stream-panel"));
    assert.equal(chips.length, 1);
    assert.match(textOf(chips[0]), /ended/, "the entry shows that the session ended");
    panel.destroy();
  },
);

/* --------------------------------------------------------- permission prompt */

test("the permission prompt appears when the daemon asks for one", async () => {
  buildPage();
  const client = new MockBotdClient({ hosts: [{ alias: "alpha" }], stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  findByTestId(element("host-list"), "connect-alpha")?.dispatch("click");

  const allowId = "perm-allow-alpha-session-1-permission-1";
  await waitFor(() => findByTestId(element("stream-panel"), allowId) !== null);

  const allow = findByTestId(element("stream-panel"), allowId);
  const deny = findByTestId(element("stream-panel"), "perm-deny-alpha-session-1-permission-1");
  assert.ok(allow, "the prompt offers Allow");
  assert.ok(deny, "the prompt offers Deny");
  assert.equal(textOf(allow), "Allow");
  assert.equal(textOf(deny), "Deny");

  const prompt = eventElements(element("stream-panel")).find((event) =>
    textOf(event).includes("run the test suite?"),
  );
  assert.ok(prompt, "the prompt shows what the daemon asked for");
  assert.match(textOf(prompt), /npm test/, "the prompt shows the detail of the request");
  panel.destroy();
});

test("approving a permission sends the answer to the client", async () => {
  buildPage();
  const inner = new MockBotdClient({ hosts: [{ alias: "alpha" }], stepMs: 5 });
  const client = new RecordingClient(inner);
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  findByTestId(element("host-list"), "connect-alpha")?.dispatch("click");

  const allowId = "perm-allow-alpha-session-1-permission-1";
  await waitFor(() => findByTestId(element("stream-panel"), allowId) !== null);
  findByTestId(element("stream-panel"), allowId)?.dispatch("click");

  await waitFor(() => client.answers.length > 0);
  assert.deepEqual(client.answers, [
    { permissionId: "alpha-session-1-permission-1", allow: true },
  ]);
  panel.destroy();
});

test("denying a permission sends the answer to the client", async () => {
  buildPage();
  const inner = new MockBotdClient({ hosts: [{ alias: "alpha" }], stepMs: 5 });
  const client = new RecordingClient(inner);
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  findByTestId(element("host-list"), "connect-alpha")?.dispatch("click");

  const denyId = "perm-deny-alpha-session-1-permission-1";
  await waitFor(() => findByTestId(element("stream-panel"), denyId) !== null);
  findByTestId(element("stream-panel"), denyId)?.dispatch("click");

  await waitFor(() => client.answers.length > 0);
  assert.deepEqual(client.answers, [
    { permissionId: "alpha-session-1-permission-1", allow: false },
  ]);
  panel.destroy();
});

test("the prompt is dismissed once it is answered", async () => {
  buildPage();
  const client = new MockBotdClient({ hosts: [{ alias: "alpha" }], stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  findByTestId(element("host-list"), "connect-alpha")?.dispatch("click");

  const allowId = "perm-allow-alpha-session-1-permission-1";
  await waitFor(() => findByTestId(element("stream-panel"), allowId) !== null);
  findByTestId(element("stream-panel"), allowId)?.dispatch("click");

  await waitFor(() => findByTestId(element("stream-panel"), allowId) === null);
  assert.equal(
    findByTestId(element("stream-panel"), "perm-deny-alpha-session-1-permission-1"),
    null,
    "the deny button is gone as well",
  );

  const prompt = eventElements(element("stream-panel")).find((event) =>
    textOf(event).includes("run the test suite?"),
  );
  assert.ok(prompt, "the request stays in the stream");
  assert.match(textOf(prompt), /answered/, "the request is marked as answered");
  panel.destroy();
});

test("several queued prompts are shown in the order they arrived", async () => {
  buildPage();
  const client = new ScriptedClient([{ alias: "alpha" }], {
    alpha: [bot("alpha-bot-1", "alpha-session-1")],
  });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  client.emit(permissionEvent("alpha-session-1", "perm-1", "first question", "step one"));
  client.emit(permissionEvent("alpha-session-1", "perm-2", "second question", "step two"));
  client.emit(permissionEvent("alpha-session-1", "perm-3", "third question", "step three"));

  const events = eventElements(element("stream-panel"));
  assert.equal(events.length, 3, "the three requests are shown");
  assert.match(textOf(events[0]), /first question/);
  assert.match(textOf(events[1]), /second question/);
  assert.match(textOf(events[2]), /third question/);

  for (const permissionId of ["perm-1", "perm-2", "perm-3"]) {
    assert.ok(
      findByTestId(element("stream-panel"), `perm-allow-${permissionId}`),
      `the request ${permissionId} can be allowed`,
    );
    assert.ok(
      findByTestId(element("stream-panel"), `perm-deny-${permissionId}`),
      `the request ${permissionId} can be denied`,
    );
  }
  panel.destroy();
});

test("answering one prompt leaves the other prompts waiting", async () => {
  buildPage();
  const client = new ScriptedClient([{ alias: "alpha" }], {
    alpha: [bot("alpha-bot-1", "alpha-session-1")],
  });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  client.emit(permissionEvent("alpha-session-1", "perm-1", "first question"));
  client.emit(permissionEvent("alpha-session-1", "perm-2", "second question"));

  findByTestId(element("stream-panel"), "perm-allow-perm-1")?.dispatch("click");

  await waitFor(() => findByTestId(element("stream-panel"), "perm-allow-perm-1") === null);
  assert.ok(
    findByTestId(element("stream-panel"), "perm-allow-perm-2"),
    "the second request still waits for an answer",
  );
  assert.deepEqual(client.answers, [{ permissionId: "perm-1", allow: true }]);
  panel.destroy();
});

test(
  "the prompt of a session that is not shown is still offered",
  { todo: "the panel only draws the events of the selected session" },
  async () => {
    buildPage();
    const client = new ScriptedClient([{ alias: "alpha" }], {
      alpha: [bot("alpha-bot-1", "alpha-session-1"), bot("alpha-bot-2", "alpha-session-2")],
    });
    const panel = createPanel({ client, pollMs: 0 });
    await panel.mount();

    findByTestId(element("stream-panel"), "session-chip-alpha-session-2")?.dispatch("click");
    await waitFor(() => panel.state.selectedSession === "alpha-session-2");

    client.emit(permissionEvent("alpha-session-1", "perm-1", "may I?", undefined, "alpha-bot-1"));

    assert.ok(
      findByTestId(element("stream-panel"), "perm-allow-perm-1"),
      "the request of the other session is offered",
    );
    panel.destroy();
  },
);

/* -------------------------------------------------------------- redaction */

test("content the daemon redacted is shown redacted", async () => {
  buildPage();
  const client = new ScriptedClient([{ alias: "alpha" }], {
    alpha: [bot("alpha-bot-1", "alpha-session-1")],
  });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  client.emit(textEvent("alpha-session-1", "the token is <redacted>"));
  client.emit(toolEvent("alpha-session-1", "run_command", "token=<redacted>"));
  client.emit(
    permissionEvent("alpha-session-1", "perm-1", "use the token <redacted>", "token=<redacted>"),
  );

  const events = eventElements(element("stream-panel"));
  assert.equal(events.length, 3);
  assert.equal(textOf(events[0]), "the token is <redacted>", "the text is shown as it arrived");
  assert.equal(
    textOf(events[1]),
    "run_command (end) — token=<redacted>",
    "the summary is shown as it arrived",
  );
  assert.match(textOf(events[2]), /use the token <redacted>/, "the title keeps the placeholder");
  assert.match(textOf(events[2]), /token=<redacted>/, "the detail keeps the placeholder");
  assert.doesNotMatch(
    textOf(element("stream-panel")),
    /token=[^<]/,
    "every value the daemon sent is masked",
  );
  panel.destroy();
});

test(
  "the panel masks a secret that reaches it unredacted",
  { todo: "the panel has no redaction of its own, it trusts the daemon" },
  async () => {
    buildPage();
    const client = new ScriptedClient([{ alias: "alpha" }], {
      alpha: [bot("alpha-bot-1", "alpha-session-1")],
    });
    const panel = createPanel({ client, pollMs: 0 });
    await panel.mount();

    client.emit(textEvent("alpha-session-1", "token=not-a-real-token"));

    const events = eventElements(element("stream-panel"));
    assert.equal(events.length, 1);
    assert.doesNotMatch(textOf(events[0]), /not-a-real-token/, "the secret is masked");
    assert.match(textOf(events[0]), /<redacted>/, "the secret is replaced by the placeholder");
    panel.destroy();
  },
);
