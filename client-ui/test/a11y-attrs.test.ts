// Accessibility attribute checks for the "Remote bots" panel.
//
// The panel is driven through the stub DOM of test-support/dom.ts, the same
// way screens.test.ts and panel.test.ts drive it, and the markup of
// client-ui/index.html is read from disk. The panel sources were not
// touched: every gap below is reported, not fixed.
//
// The checks cover the five screens of the panel — no hosts, a connected host
// with bots, a running session, a pending permission and a failed connection —
// and answer four questions:
//
//   * does every button have an accessible name (its text or an aria-label)?
//   * does every control carry a stable data-testid or id, and are the test
//     ids of one screen unique?
//   * is the permission prompt announced (role="alertdialog", or an
//     equivalent the project documents)?
//   * do the status chips say their status in words, instead of in colour
//     alone?
//
// The project documents no equivalent for the permission prompt (there is no
// accessibility note in the repository), so the check below accepts the two
// roles that would announce it: alertdialog, and dialog with aria-modal.
//
// The gaps the `todo` tests pin down:
//
//   1. The permission prompt has no role at all. It is a list item of the
//      event stream, so it is announced as ordinary text and the Allow/Deny
//      buttons are not announced as a dialog that asks for an answer.
//   2. The quota of a bot is a bare bar: it carries no text, no aria-label
//      and no role, so its value is only visible.
//   3. The status of the open session is drawn without a data-testid, unlike
//      the status of a host and the status of a bot.
//   4. A failed connection shows the word "error" only. The panel has no
//      error banner of its own: state.error is never set, and the message of
//      the failure is dropped.
//   5. The add-host dialog has no accessible name (neither aria-label nor
//      aria-labelledby), although it carries a heading.
//   6. The error of the add-host form is not announced (no role="alert").
//
// Every test destroys its panel through the test context, so a failing
// assertion cannot leave a panel behind that redraws the page of the next
// test.
//
// Everything the tests look at is synthetic: the hosts, the bots and the
// events come from the mock client of src/mock-client.ts.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { findByTestId, installDom, textOf } from "../test-support/dom.ts";
import { MockBotdClient } from "../src/mock-client.ts";
import { createPanel } from "../src/panel.ts";
import type { Panel } from "../src/panel.ts";
import type { StubElement } from "../test-support/dom.ts";
import type { BotEvent, BotdClient, RemoteBot, RemoteHost, Unsubscribe } from "../src/client.ts";

/* ------------------------------------------------------------------ setup */

/**
 * Builds the page skeleton the panel expects.
 *
 * The chrome of client-ui/index.html is mirrored: the add-host button carries
 * the name the markup gives it ("Add host", hidden visually) and the status
 * line is the live region the markup declares. The panels themselves are
 * empty; the panel fills them.
 */
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

  const status = document.getElementById("status-line");
  status?.setAttribute("aria-live", "polite");
  const add = document.getElementById("host-add");
  if (add) add.textContent = "Add host";
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

/* ----------------------------------------------------------------- screen */

/** The screens of the panel the accessibility is checked in. */
type Screen = "no-hosts" | "connected" | "session" | "permission" | "error";

/**
 * A client that refuses every connection.
 *
 * The mock plays the daemon for the happy path; this one stands in for a
 * host that cannot be reached, so the panel can be checked in the state of a
 * failed connection.
 */
class UnreachableClient implements BotdClient {
  /** The client that plays the daemon for everything but the connection. */
  private readonly inner: BotdClient;

  constructor(inner: BotdClient) {
    this.inner = inner;
  }

  listHosts(): Promise<RemoteHost[]> {
    return this.inner.listHosts();
  }

  addHost(input: { alias: string; label?: string }): Promise<RemoteHost> {
    return this.inner.addHost(input);
  }

  connect(): Promise<void> {
    return Promise.reject(new Error("the host refused the connection"));
  }

  disconnect(): Promise<void> {
    return this.inner.disconnect();
  }

  listBots(alias: string): Promise<RemoteBot[]> {
    return this.inner.listBots(alias);
  }

  subscribe(sessionId: string, onEvent: (event: BotEvent) => void): Unsubscribe {
    return this.inner.subscribe(sessionId, onEvent);
  }

  cancel(): Promise<void> {
    return this.inner.cancel();
  }

  answerPermission(permissionId: string, allow: boolean): Promise<void> {
    return this.inner.answerPermission(permissionId, allow);
  }
}

/**
 * Mounts the panel in the given screen.
 *
 * The mock client plays the daemon: connecting starts a task, the task asks
 * for a permission after a few steps. The caller gets the panel back and has
 * to destroy it.
 */
async function mountScreen(screen: Screen): Promise<Panel> {
  buildPage();

  if (screen === "no-hosts") {
    const panel = createPanel({ client: new MockBotdClient({ stepMs: 5 }), pollMs: 0 });
    await panel.mount();
    return panel;
  }

  if (screen === "error") {
    const client = new UnreachableClient(
      new MockBotdClient({ hosts: [{ alias: "alpha", label: "main box" }], stepMs: 5 }),
    );
    const panel = createPanel({ client, pollMs: 0 });
    await panel.mount();
    findByTestId(element("host-list"), "connect-alpha")?.dispatch("click");
    await waitFor(() => textOf(element("status-line")).includes("error"));
    return panel;
  }

  const client = new MockBotdClient({ hosts: [{ alias: "alpha", label: "main box" }], stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  findByTestId(element("host-list"), "connect-alpha")?.dispatch("click");
  await waitFor(() => {
    const status = findByTestId(element("bots-panel"), "bot-status-alpha-bot-1");
    return status !== null && textOf(status) === "busy";
  });

  if (screen === "connected") return panel;

  await waitFor(() => findByTestId(element("stream-panel"), "session-chip-alpha-session-1") !== null);
  if (screen === "session") return panel;

  await waitFor(
    () =>
      findByTestId(element("stream-panel"), "perm-allow-alpha-session-1-permission-1") !== null,
  );
  return panel;
}

/* ----------------------------------------------------------------- markup */

let cachedMarkup: string | null = null;

/** The markup of the page the panel is served in. */
async function pageMarkup(): Promise<string> {
  if (cachedMarkup === null) {
    cachedMarkup = await readFile(new URL("../index.html", import.meta.url), "utf8");
  }
  return cachedMarkup;
}

/** The value of an attribute in the body of a tag. */
function attr(attributes: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(attributes);
  return match ? match[1] : null;
}

/** The text of a fragment of markup, without its tags. */
function textOfMarkup(fragment: string): string {
  const withoutHidden = fragment.replace(
    /<[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/[^>]+>/gi,
    " ",
  );
  const text = withoutHidden.replace(/<[^>]*>/g, " ");
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every button of the markup, with its attributes and its content. */
function buttonsOf(html: string): Array<{ attributes: string; content: string }> {
  const found: Array<{ attributes: string; content: string }> = [];
  for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    found.push({ attributes: match[1], content: match[2] });
  }
  return found;
}

/** Every input of the markup, with its attributes. */
function inputsOf(html: string): Array<{ attributes: string }> {
  const found: Array<{ attributes: string }> = [];
  for (const match of html.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    found.push({ attributes: match[1] });
  }
  return found;
}

/** The content of every label of the markup. */
function labelsOf(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)) {
    found.push(match[1]);
  }
  return found;
}

/** The opening tag of the element with the given id. */
function tagOfId(html: string, id: string): { name: string; attributes: string } | null {
  const pattern = new RegExp(`<(\\w+)([^>]*\\bid="${id}"[^>]*)>`, "i");
  const match = pattern.exec(html);
  if (!match) return null;
  return { name: match[1], attributes: match[2] };
}

/* ------------------------------------------------------------------- tree */

/** Every element of the tree, in document order, the root included. */
function allElements(root: StubElement): StubElement[] {
  const found: StubElement[] = [root];
  for (const child of root.children) {
    found.push(...allElements(child));
  }
  return found;
}

/** Every element of the tree with the given tag name. */
function byTag(root: StubElement, tag: string): StubElement[] {
  return allElements(root).filter((element) => element.tagName === tag.toUpperCase());
}

/** Every element of the tree a user can operate. */
function interactiveElements(root: StubElement): StubElement[] {
  return allElements(root).filter((element) => {
    if (["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(element.tagName)) return true;
    if (element.tagName === "A" && element.getAttribute("href") !== null) return true;
    return element.getAttribute("role") === "button";
  });
}

/** The first element of the tree with the given class. */
function byClass(root: StubElement, className: string): StubElement | null {
  for (const element of allElements(root)) {
    if (element.className.split(/\s+/).includes(className)) return element;
  }
  return null;
}

/** The accessible name of an element: its aria-label, else its text. */
function accessibleName(element: StubElement): string {
  const label = element.getAttribute("aria-label");
  if (label !== null && label.trim() !== "") return label.trim();
  return textOf(element).replace(/\s+/g, " ").trim();
}

/** A short description of an element, for the failure messages. */
function describe(element: StubElement): string {
  const testId = element.getAttribute("data-testid");
  if (testId !== null) return `[data-testid="${testId}"]`;
  if (element.id !== "") return `#${element.id}`;
  return `<${element.tagName.toLowerCase()} class="${element.className}">`;
}

/**
 * The parts of the page a user sees in one screen.
 *
 * The three panels the panel draws into, plus the chrome around them (the
 * add-host button), which client-ui/index.html provides.
 */
function screenRoots(): StubElement[] {
  return [element("host-list"), element("bots-panel"), element("stream-panel"), element("host-add")];
}

/* ------------------------------------------------------------ the markup */

test("the page declares the language of its content", async () => {
  const html = await pageMarkup();
  const language = /<html\b[^>]*\blang="([^"]*)"/i.exec(html);
  assert.ok(language, "the html element carries a lang attribute");
  assert.notEqual(language[1].trim(), "", "the language is not empty");
});

test("the page has a title", async () => {
  const html = await pageMarkup();
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html);
  assert.ok(title, "the page has a title element");
  assert.notEqual(title[1].trim(), "", "the title is not empty");
});

test("the page has a main landmark", async () => {
  const html = await pageMarkup();
  assert.match(html, /<main\b/i, "the page has a main element");
});

test("the panels of the page are named landmarks", async () => {
  const html = await pageMarkup();
  for (const id of ["bots-panel", "stream-panel"]) {
    const tag = tagOfId(html, id);
    assert.ok(tag, `the panel #${id} exists`);
    assert.ok(
      attr(tag.attributes, "aria-label") !== null || attr(tag.attributes, "aria-labelledby") !== null,
      `the panel #${id} is named`,
    );
  }
});

test("the status line is a live region", async () => {
  const html = await pageMarkup();
  const tag = tagOfId(html, "status-line");
  assert.ok(tag, "the status line exists");
  assert.ok(
    attr(tag.attributes, "aria-live") !== null || attr(tag.attributes, "role") === "status",
    "the status line is announced when it changes",
  );
});

test("every control of the page has an accessible name", async () => {
  const html = await pageMarkup();

  for (const button of buttonsOf(html)) {
    const label = attr(button.attributes, "aria-label");
    const name = label !== null && label.trim() !== "" ? label : textOfMarkup(button.content);
    assert.notEqual(name, "", "every button of the page has a name");
  }

  const labels = labelsOf(html);
  for (const input of inputsOf(html)) {
    const id = attr(input.attributes, "id");
    const label = attr(input.attributes, "aria-label");
    const named =
      (label !== null && label.trim() !== "") ||
      (id !== null && labels.some((block) => block.includes(`id="${id}"`)));
    assert.ok(named, `the input ${id ?? "(without id)"} has a label`);
  }
});

test("every control of the page carries a stable id or test id", async () => {
  const html = await pageMarkup();
  for (const button of buttonsOf(html)) {
    assert.ok(
      attr(button.attributes, "id") !== null || attr(button.attributes, "data-testid") !== null,
      "every button of the page can be addressed",
    );
  }
  for (const input of inputsOf(html)) {
    assert.ok(
      attr(input.attributes, "id") !== null || attr(input.attributes, "data-testid") !== null,
      "every input of the page can be addressed",
    );
  }
});

test(
  "the add host dialog has an accessible name",
  { todo: "A11Y: the add-host dialog has neither an aria-label nor an aria-labelledby" },
  async () => {
    const html = await pageMarkup();
    const dialog = /<dialog\b([^>]*)>/i.exec(html);
    assert.ok(dialog, "the page has a dialog");
    assert.ok(
      attr(dialog[1], "aria-label") !== null || attr(dialog[1], "aria-labelledby") !== null,
      "the dialog is named",
    );
  },
);

test(
  "the error of the add host form is announced",
  { todo: "A11Y: the error message of the add-host form has no role=alert and no live region" },
  async () => {
    const html = await pageMarkup();
    const error = tagOfId(html, "host-add-error");
    assert.ok(error, "the form has an error message");
    assert.ok(
      attr(error.attributes, "role") === "alert" || attr(error.attributes, "aria-live") !== null,
      "the error message is announced when it appears",
    );
  },
);

/* ------------------------------------------------------------- the panel */

test("the panel without hosts draws no button without an accessible name", async (t) => {
  const panel = await mountScreen("no-hosts");
  t.after(() => panel.destroy());
  const buttons = screenRoots().flatMap((root) => byTag(root, "button"));
  assert.ok(buttons.length > 0, "the screen has buttons to check");
  for (const button of buttons) {
    assert.notEqual(accessibleName(button), "", `the button ${describe(button)} has a name`);
  }
});

test("every button of a connected host has an accessible name", async (t) => {
  const panel = await mountScreen("connected");
  t.after(() => panel.destroy());
  const buttons = screenRoots().flatMap((root) => byTag(root, "button"));
  assert.ok(buttons.length >= 3, "the host, its connect button and its bot are drawn");
  for (const button of buttons) {
    assert.notEqual(accessibleName(button), "", `the button ${describe(button)} has a name`);
  }
});

test("every button of a running session has an accessible name", async (t) => {
  const panel = await mountScreen("session");
  t.after(() => panel.destroy());
  const buttons = screenRoots().flatMap((root) => byTag(root, "button"));
  assert.ok(buttons.length >= 4, "the session chip and the cancel button are drawn");
  for (const button of buttons) {
    assert.notEqual(accessibleName(button), "", `the button ${describe(button)} has a name`);
  }
});

test("the permission prompt offers Allow and Deny as real buttons", async (t) => {
  const panel = await mountScreen("permission");
  t.after(() => panel.destroy());
  const allow = findByTestId(element("stream-panel"), "perm-allow-alpha-session-1-permission-1");
  const deny = findByTestId(element("stream-panel"), "perm-deny-alpha-session-1-permission-1");
  assert.ok(allow, "the prompt offers Allow");
  assert.ok(deny, "the prompt offers Deny");
  assert.equal(allow.tagName, "BUTTON", "Allow is a button");
  assert.equal(deny.tagName, "BUTTON", "Deny is a button");
  assert.equal(accessibleName(allow), "Allow");
  assert.equal(accessibleName(deny), "Deny");
});

test(
  "the permission prompt is announced as a dialog",
  { todo: "A11Y: the permission prompt has no role=alertdialog, it is an ordinary list item" },
  async (t) => {
    const panel = await mountScreen("permission");
    t.after(() => panel.destroy());
    const prompt = byClass(element("stream-panel"), "event-permission");
    assert.ok(prompt, "the prompt is drawn");
    const role = prompt.getAttribute("role");
    assert.ok(
      role === "alertdialog" || (role === "dialog" && prompt.getAttribute("aria-modal") === "true"),
      "the prompt is announced as a dialog that asks for an answer",
    );
  },
);

test("every control of the panel carries a stable test id or id", async (t) => {
  const panel = await mountScreen("permission");
  t.after(() => panel.destroy());
  const controls = screenRoots().flatMap((root) => interactiveElements(root));
  assert.ok(controls.length > 0, "the screen has controls to check");
  for (const control of controls) {
    assert.ok(
      control.getAttribute("data-testid") !== null || control.getAttribute("id") !== null,
      `the control ${describe(control)} can be addressed`,
    );
  }
});

test("the test ids of a screen are unique", async (t) => {
  const panel = await mountScreen("permission");
  t.after(() => panel.destroy());
  const counts = new Map<string, number>();
  for (const root of screenRoots()) {
    for (const element of allElements(root)) {
      const testId = element.getAttribute("data-testid");
      if (testId === null) continue;
      counts.set(testId, (counts.get(testId) ?? 0) + 1);
    }
  }
  assert.ok(counts.size > 0, "the screen carries test ids");
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([testId]) => testId);
  assert.deepEqual(duplicates, [], "no test id is used twice");
});

test("the test ids of the controls are built from stable ids", async (t) => {
  const panel = await mountScreen("permission");
  t.after(() => panel.destroy());
  const testIds = screenRoots()
    .flatMap((root) => interactiveElements(root))
    .map((control) => control.getAttribute("data-testid"))
    .filter((testId): testId is string => testId !== null)
    .sort();
  assert.deepEqual(testIds, [
    "cancel-alpha-session-1",
    "connect-alpha",
    "host-alpha",
    "perm-allow-alpha-session-1-permission-1",
    "perm-deny-alpha-session-1-permission-1",
    "session-alpha-session-1",
    "session-chip-alpha-session-1",
  ]);
});

test("the status of a host is not carried by colour alone", async (t) => {
  const panel = await mountScreen("connected");
  t.after(() => panel.destroy());
  const status = findByTestId(element("host-list"), "host-status-alpha");
  assert.ok(status, "the host shows its status");
  assert.equal(textOf(status).trim(), "connected", "the status is written out");
});

test("the status of a bot is not carried by colour alone", async (t) => {
  const panel = await mountScreen("connected");
  t.after(() => panel.destroy());
  const status = findByTestId(element("bots-panel"), "bot-status-alpha-bot-1");
  assert.ok(status, "the bot shows its status");
  assert.equal(textOf(status).trim(), "busy", "the status is written out");
});

test("the status of the open session is not carried by colour alone", async (t) => {
  const panel = await mountScreen("session");
  t.after(() => panel.destroy());
  const badge = byClass(element("stream-panel"), "badge");
  assert.ok(badge, "the session shows its status");
  assert.equal(textOf(badge).trim(), "running", "the status is written out");
});

test(
  "the status chip of the open session carries a stable test id",
  { todo: "A11Y: the status of the open session is drawn without a data-testid" },
  async (t) => {
    const panel = await mountScreen("session");
    t.after(() => panel.destroy());
    const badge = byClass(element("stream-panel"), "badge");
    assert.ok(badge, "the session shows its status");
    assert.ok(badge.getAttribute("data-testid") !== null, "the chip can be addressed by a test");
  },
);

test(
  "the quota of a bot is not a bare bar",
  { todo: "A11Y: the quota bar of a bot has no text, no aria-label and no role" },
  async (t) => {
    const panel = await mountScreen("connected");
    t.after(() => panel.destroy());
    const bar = byClass(element("bots-panel"), "quota-fill");
    assert.ok(bar, "the bot shows its quota");
    assert.ok(
      accessibleName(bar) !== "" || bar.getAttribute("role") !== null,
      "the quota is exposed as text or as a value",
    );
  },
);

test(
  "a failed connection shows the message of the failure",
  { todo: "A11Y: a failed connection shows the word error only, the message is dropped" },
  async (t) => {
    const panel = await mountScreen("error");
    t.after(() => panel.destroy());
    const line = element("status-line");
    assert.match(
      textOf(line),
      /the host refused the connection/,
      "the failure is spelled out for the user",
    );
  },
);
