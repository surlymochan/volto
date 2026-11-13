// Tests for the add-host dialog of the "Remote bots" panel.
//
// The dialog is driven through the stub DOM of test-support/dom.ts: the
// button that opens it, the two fields of the form, the error line and the
// dialog itself are the elements the panel looks up by id. The mock client
// of src/mock-client.ts plays the daemon.
//
// The panel never talks to a daemon itself: it asks the client for a host
// with `addHost({alias, label})` and shows the message of the client when
// the daemon refuses. The rules of the daemon live in the relay
// (client-ui/relay.mjs): it only accepts a plain alias and answers with
// "Invalid host" when the alias carries anything else.
//
// The stub DOM knows no form validation, so every submit reaches the panel.
// In a browser the `required` attribute of the alias field would stop a
// blank alias on its own.
//
// The cases below belong to the dialog: what it opens, what it refuses and
// what it adds. The rest of the panel is covered by panel.test.ts.
//
// Two cases describe a defect of the panel and are marked as todo: the panel
// empties the fields of the form when the dialog is opened and not after a
// submit, and a second submit asks the daemon for the same host again, so
// the duplicate error is shown although the host was added.
//
// Every name, alias and payload below is synthetic.

import assert from "node:assert/strict";
import test from "node:test";

import { findAllByTestId, findByTestId, installDom, textOf } from "../test-support/dom.ts";
import { MockBotdClient } from "../src/mock-client.ts";
import { createPanel } from "../src/panel.ts";
import type { StubElement } from "../test-support/dom.ts";
import type { RemoteHost } from "../src/client.ts";

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
  const error = document.register("host-add-error", "p");
  // The markup of index.html carries the hidden attribute on the error line.
  error.hidden = true;
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

/** Opens the dialog and fills the two fields of the form. */
function fillDialog(alias: string, label = ""): void {
  element("host-add").dispatch("click");
  element("host-alias").value = alias;
  element("host-label").value = label;
}

/** Submits the form of the dialog. */
function submitDialog(): void {
  element("add-host-form").dispatch("submit");
}

/** Waits for the error line of the dialog and returns its message. */
async function waitForError(): Promise<string> {
  await waitFor(() => element("host-add-error").textContent !== "");
  return element("host-add-error").textContent;
}

/** The row of the host list that holds the given host button. */
function rowOf(host: StubElement): StubElement | null {
  return element("host-list").children.find((row) => row.children.includes(host)) ?? null;
}

/**
 * A client that refuses the aliases the relay refuses.
 *
 * The relay of client-ui/relay.mjs only accepts a plain alias and answers
 * with "Invalid host" when the alias carries anything else.
 */
class StrictAliasClient extends MockBotdClient {
  async addHost(input: { alias: string; label?: string }): Promise<RemoteHost> {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(input.alias.trim())) {
      throw new Error("Invalid host");
    }
    return super.addHost(input);
  }
}

/** A client whose daemon cannot be reached. */
class UnreachableClient extends MockBotdClient {
  async addHost(): Promise<RemoteHost> {
    throw new Error("the daemon is unreachable");
  }
}

/** A client that remembers the hosts the panel asked for. */
class RecordingClient extends MockBotdClient {
  /** Every host the panel asked the daemon for. */
  readonly asked: Array<{ alias: string; label?: string }> = [];

  async addHost(input: { alias: string; label?: string }): Promise<RemoteHost> {
    this.asked.push({ alias: input.alias, label: input.label });
    return super.addHost(input);
  }
}

/* --------------------------------------------------------- opening the dialog */

test("the add-host button opens the dialog", async () => {
  buildPage();
  const client = new MockBotdClient({ stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  const dialog = element("add-host-dialog");
  assert.equal(dialog.open, false, "the dialog starts closed");

  element("host-add").dispatch("click");

  assert.equal(dialog.open, true, "the dialog is open");
  assert.equal(element("host-alias").value, "", "the alias field is empty");
  assert.equal(element("host-label").value, "", "the label field is empty");
  panel.destroy();
});

test("the error of a refused host is cleared when the dialog is opened again", async () => {
  buildPage();
  const client = new MockBotdClient({ hosts: [{ alias: "workstation" }], stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  fillDialog("workstation");
  submitDialog();
  assert.match(await waitForError(), /already known/, "the error is shown");

  element("host-add").dispatch("click");

  const error = element("host-add-error");
  assert.equal(error.hidden, true, "the error is hidden again");
  assert.equal(error.textContent, "", "the error line is empty again");
  panel.destroy();
});

test("the fields of the dialog are emptied when it is opened again", async () => {
  buildPage();
  const client = new MockBotdClient({ stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  fillDialog("alpha", "smoke box");
  submitDialog();
  await waitFor(() => findByTestId(element("host-list"), "host-alpha") !== null);

  element("host-add").dispatch("click");

  assert.equal(element("host-alias").value, "", "the alias field is empty");
  assert.equal(element("host-label").value, "", "the label field is empty");
  panel.destroy();
});

/* ------------------------------------------------------------ refused hosts */

test("an empty alias is refused and no host is added", async () => {
  buildPage();
  const client = new MockBotdClient({ stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  fillDialog("");
  submitDialog();

  const message = await waitForError();
  assert.match(message, /ssh alias is required/, "the message of the client is shown");
  assert.equal(element("host-add-error").hidden, false, "the error is shown");
  assert.equal(panel.state.hosts.length, 0, "no host was added");
  assert.equal(element("host-list").children.length, 0, "the host list stays empty");
  assert.equal(element("add-host-dialog").open, true, "the dialog stays open");
  panel.destroy();
});

test("an alias with spaces is refused with the message of the client", async () => {
  buildPage();
  const client = new StrictAliasClient({ stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  fillDialog("my box");
  submitDialog();

  const message = await waitForError();
  assert.equal(message, "Invalid host", "the message of the client is shown as it is");
  assert.equal(element("host-add-error").hidden, false, "the error is shown");
  assert.equal(panel.state.hosts.length, 0, "no host was added");
  assert.equal(element("host-list").children.length, 0, "the host list stays empty");
  assert.equal(element("add-host-dialog").open, true, "the dialog stays open");
  panel.destroy();
});

test("an alias that is already known is refused with the message of the client", async () => {
  buildPage();
  const client = new MockBotdClient({ hosts: [{ alias: "workstation" }], stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  fillDialog("workstation");
  submitDialog();

  const message = await waitForError();
  assert.equal(
    message,
    'host "workstation" is already known',
    "the message of the client is shown as it is",
  );
  assert.equal(element("host-add-error").hidden, false, "the error is shown");
  assert.equal(element("host-list").children.length, 1, "the host list still holds one host");
  assert.equal(element("add-host-dialog").open, true, "the dialog stays open");
  panel.destroy();
});

test("a client that refuses the host leaves the dialog open with its message", async () => {
  buildPage();
  const client = new UnreachableClient({ stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  fillDialog("alpha");
  submitDialog();

  const message = await waitForError();
  assert.equal(message, "the daemon is unreachable", "the message of the client is shown as it is");
  assert.equal(element("host-add-error").hidden, false, "the error is shown");
  assert.equal(panel.state.hosts.length, 0, "no host was added");
  assert.equal(element("host-list").children.length, 0, "the host list stays empty");
  assert.equal(element("add-host-dialog").open, true, "the dialog stays open");
  panel.destroy();
});

/* -------------------------------------------------------------- added hosts */

test("a host that was added is listed and selected", async () => {
  buildPage();
  const client = new MockBotdClient({ hosts: [{ alias: "workstation" }], stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();
  assert.equal(panel.state.selectedHost, "workstation", "the first host is selected");

  fillDialog("alpha");
  submitDialog();
  await waitFor(() => findByTestId(element("host-list"), "host-alpha") !== null);

  const host = findByTestId(element("host-list"), "host-alpha");
  assert.ok(host, "the new host is listed");
  assert.equal(panel.state.hosts.length, 2, "the daemon knows two hosts now");
  assert.equal(panel.state.selectedHost, "alpha", "the new host is selected");
  const row = rowOf(host);
  assert.ok(row, "the row of the new host is drawn");
  assert.match(row.className, /host-selected/, "the row of the new host is marked as selected");
  panel.destroy();
});

test("a successful submit closes the dialog", async () => {
  buildPage();
  const client = new MockBotdClient({ stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  fillDialog("alpha");
  submitDialog();
  await waitFor(() => findByTestId(element("host-list"), "host-alpha") !== null);

  assert.equal(element("add-host-dialog").open, false, "the dialog is closed");
  assert.equal(element("host-add-error").hidden, true, "no error is shown");
  panel.destroy();
});

test("the panel asks the daemon for the host with its alias and its label", async () => {
  buildPage();
  const client = new RecordingClient({ stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  fillDialog("alpha", "smoke box");
  submitDialog();
  await waitFor(() => client.asked.length > 0);

  assert.equal(client.asked.length, 1, "the daemon was asked once");
  assert.equal(client.asked[0].alias, "alpha", "the alias is sent as it was typed");
  assert.equal(client.asked[0].label, "smoke box", "the label is sent along");
  panel.destroy();
});

test("the label of a host is optional", async () => {
  buildPage();
  const client = new RecordingClient({ stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  fillDialog("alpha");
  submitDialog();
  await waitFor(() => findByTestId(element("host-list"), "host-alpha") !== null);

  assert.equal(client.asked.length, 1, "the daemon was asked once");
  assert.equal(client.asked[0].label, undefined, "a host without a label carries none");
  const host = findByTestId(element("host-list"), "host-alpha");
  assert.ok(host, "the new host is listed");
  assert.equal(textOf(host), "alpha", "the row shows the alias alone");
  panel.destroy();
});

test("the label of a host is shown next to its alias", async () => {
  buildPage();
  const client = new MockBotdClient({ stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  fillDialog("alpha", "smoke box");
  submitDialog();
  await waitFor(() => findByTestId(element("host-list"), "host-alpha") !== null);

  const host = findByTestId(element("host-list"), "host-alpha");
  assert.ok(host, "the new host is listed");
  assert.equal(textOf(host), "alpha · smoke box", "the row shows the label next to the alias");
  panel.destroy();
});

/* --------------------------------------------------------- a second submit */

test("a second submit does not add the host twice", async () => {
  buildPage();
  const client = new MockBotdClient({ stepMs: 5 });
  const panel = createPanel({ client, pollMs: 0 });
  await panel.mount();

  fillDialog("alpha");
  submitDialog();
  submitDialog();
  await waitFor(() => findByTestId(element("host-list"), "host-alpha") !== null);

  assert.equal(
    findAllByTestId(element("host-list"), "host-alpha").length,
    1,
    "the host is listed once",
  );
  assert.equal(panel.state.hosts.length, 1, "the panel knows one host");
  assert.equal(panel.state.selectedHost, "alpha", "the host is selected");
  panel.destroy();
});

test(
  "a second submit does not show an error",
  { todo: "the second submit asks the daemon again and the duplicate error is shown" },
  async () => {
    buildPage();
    const client = new MockBotdClient({ stepMs: 5 });
    const panel = createPanel({ client, pollMs: 0 });
    await panel.mount();

    fillDialog("alpha");
    submitDialog();
    submitDialog();
    await waitFor(() => findByTestId(element("host-list"), "host-alpha") !== null);

    assert.equal(element("host-add-error").textContent, "", "no error is shown");
    panel.destroy();
  },
);

test(
  "the fields of the dialog are empty after a successful submit",
  { todo: "the panel empties the fields when the dialog is opened, not after the submit" },
  async () => {
    buildPage();
    const client = new MockBotdClient({ stepMs: 5 });
    const panel = createPanel({ client, pollMs: 0 });
    await panel.mount();

    fillDialog("alpha", "smoke box");
    submitDialog();
    await waitFor(() => findByTestId(element("host-list"), "host-alpha") !== null);

    assert.equal(element("host-alias").value, "", "the alias field is empty");
    assert.equal(element("host-label").value, "", "the label field is empty");
    panel.destroy();
  },
);
