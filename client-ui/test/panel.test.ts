// Tests for the "Remote bots" panel.
//
// The panel is driven through a stub DOM, so the rendering, the test ids and
// the wiring to the client are all exercised without a browser.

import assert from "node:assert/strict";
import test from "node:test";

import { findAllByTestId, findByTestId, installDom, textOf } from "../test-support/dom.ts";
import { MockBotdClient } from "../src/mock-client.ts";
import { createPanel } from "../src/panel.ts";
import type { StubElement } from "../test-support/dom.ts";

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

/** Waits until `predicate` holds or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the panel");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function element(id: string): StubElement {
  const found = globalThis.document.getElementById(id);
  assert.ok(found, `the element #${id} exists`);
  return found as unknown as StubElement;
}

test("the panel lists the hosts of the daemon", async () => {
  buildPage();
  const client = new MockBotdClient({ hosts: [{ alias: "workstation", label: "main box" }], stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  const host = findByTestId(element("host-list"), "host-workstation");
  assert.ok(host, "the seeded host is listed");
  assert.match(textOf(host), /workstation/);
  panel.destroy();
});

test("a host can be added through the dialog", async () => {
  buildPage();
  const client = new MockBotdClient({ stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  element("host-add").dispatch("click");
  element("host-alias").value = "alpha";
  element("host-label").value = "smoke box";
  element("add-host-form").dispatch("submit");

  await waitFor(() => findByTestId(element("host-list"), "host-alpha") !== null);
  const host = findByTestId(element("host-list"), "host-alpha") as StubElement;
  assert.match(textOf(host), /smoke box/);
  panel.destroy();
});

test("adding a duplicate host shows an error", async () => {
  buildPage();
  const client = new MockBotdClient({ hosts: [{ alias: "workstation" }], stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  element("host-add").dispatch("click");
  element("host-alias").value = "workstation";
  element("add-host-form").dispatch("submit");

  await waitFor(() => element("host-add-error").hidden === false);
  assert.match(element("host-add-error").textContent, /already known/);
  panel.destroy();
});

test("connecting shows the bots of the host with their status", async () => {
  buildPage();
  const client = new MockBotdClient({ stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  element("host-add").dispatch("click");
  element("host-alias").value = "alpha";
  element("add-host-form").dispatch("submit");
  await waitFor(() => findByTestId(element("host-list"), "host-alpha") !== null);

  findByTestId(element("host-list"), "connect-alpha")?.dispatch("click");
  await waitFor(() => findByTestId(element("bots-panel"), "bot-alpha-bot-1") !== null);
  await waitFor(() => {
    const status = findByTestId(element("bots-panel"), "bot-status-alpha-bot-1");
    return status !== null && textOf(status) === "busy";
  });

  const status = findByTestId(element("bots-panel"), "bot-status-alpha-bot-1");
  assert.ok(status, "the bot shows its status");
  assert.equal(textOf(status), "busy");
  panel.destroy();
});

test("events stream into the session view", async () => {
  buildPage();
  const client = new MockBotdClient({ stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  element("host-add").dispatch("click");
  element("host-alias").value = "alpha";
  element("add-host-form").dispatch("submit");
  await waitFor(() => findByTestId(element("host-list"), "host-alpha") !== null);
  findByTestId(element("host-list"), "connect-alpha")?.dispatch("click");

  await waitFor(() => findAllByTestId(element("stream-panel"), "event-0").length > 0);
  const events = findAllByTestId(element("stream-panel"), "event-0");
  assert.match(textOf(events[0]), /picked up the task/);
  panel.destroy();
});

test("a permission request offers Allow and Deny", async () => {
  buildPage();
  const client = new MockBotdClient({ stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  element("host-add").dispatch("click");
  element("host-alias").value = "alpha";
  element("add-host-form").dispatch("submit");
  await waitFor(() => findByTestId(element("host-list"), "host-alpha") !== null);
  findByTestId(element("host-list"), "connect-alpha")?.dispatch("click");

  await waitFor(() => findAllByTestId(element("stream-panel"), "perm-allow-alpha-session-1-permission-1").length > 0);
  const allow = findByTestId(element("stream-panel"), "perm-allow-alpha-session-1-permission-1");
  const deny = findByTestId(element("stream-panel"), "perm-deny-alpha-session-1-permission-1");
  assert.ok(allow && deny, "both answers are offered");
  panel.destroy();
});

test("answering a permission removes it", async () => {
  buildPage();
  const client = new MockBotdClient({ stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  element("host-add").dispatch("click");
  element("host-alias").value = "alpha";
  element("add-host-form").dispatch("submit");
  await waitFor(() => findByTestId(element("host-list"), "host-alpha") !== null);
  findByTestId(element("host-list"), "connect-alpha")?.dispatch("click");

  const testId = "perm-allow-alpha-session-1-permission-1";
  await waitFor(() => findByTestId(element("stream-panel"), testId) !== null);
  findByTestId(element("stream-panel"), testId)?.dispatch("click");

  await waitFor(() => findByTestId(element("stream-panel"), testId) === null);
  panel.destroy();
});

test("the running task can be cancelled", async () => {
  buildPage();
  const client = new MockBotdClient({ stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  element("host-add").dispatch("click");
  element("host-alias").value = "alpha";
  element("add-host-form").dispatch("submit");
  await waitFor(() => findByTestId(element("host-list"), "host-alpha") !== null);
  findByTestId(element("host-list"), "connect-alpha")?.dispatch("click");

  const cancelId = "cancel-alpha-session-1";
  await waitFor(() => findByTestId(element("stream-panel"), cancelId) !== null);
  findByTestId(element("stream-panel"), cancelId)?.dispatch("click");

  await waitFor(() => findByTestId(element("stream-panel"), cancelId) === null);
  const turn = findAllByTestId(element("stream-panel"), "event-0")
    .concat(findAllByTestId(element("stream-panel"), "event-1"))
    .concat(findAllByTestId(element("stream-panel"), "event-2"))
    .concat(findAllByTestId(element("stream-panel"), "event-3"))
    .concat(findAllByTestId(element("stream-panel"), "event-4"))
    .concat(findAllByTestId(element("stream-panel"), "event-5"));
  assert.ok(
    turn.some((event) => textOf(event).includes("turn cancelled")),
    "the turn ends as cancelled",
  );
  panel.destroy();
});

test("the lease countdown is shown", async () => {
  buildPage();
  const client = new MockBotdClient({ stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  element("host-add").dispatch("click");
  element("host-alias").value = "alpha";
  element("add-host-form").dispatch("submit");
  await waitFor(() => findByTestId(element("host-list"), "host-alpha") !== null);
  findByTestId(element("host-list"), "connect-alpha")?.dispatch("click");

  await waitFor(() => findByTestId(element("bots-panel"), "bot-alpha-bot-1") !== null);
  await waitFor(() => {
    const bot = findByTestId(element("bots-panel"), "bot-alpha-bot-1");
    return bot !== null && /lease \d+:\d\d/.test(textOf(bot));
  });
  const bot = findByTestId(element("bots-panel"), "bot-alpha-bot-1") as StubElement;
  assert.match(textOf(bot), /lease \d+:\d\d/);
  assert.match(textOf(bot), /quota \d+%/);
  panel.destroy();
});
