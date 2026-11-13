// Tests for the boot of the "Remote bots" panel: client-ui/src/app.ts.
//
// The module picks the client the query string asks for, mounts the panel
// with it and says so when the relay does not answer. The DOM is the stub of
// test-support/dom.ts and the relay is a stubbed global fetch, so the whole
// file runs headless: no server, no browser.
//
// The client of the panel reads the relay through the global fetch, so the
// stub of the fetch is enough to drive a boot: the relay either answers or
// it does not.
//
// Every alias, id and payload below is synthetic.

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { findAllByTestId, installDom, textOf } from "../test-support/dom.ts";
import { MockBotdClient } from "../src/mock-client.ts";
import { RealBotdClient } from "../src/real-client.ts";
import { RELAY_UNREACHABLE, boot, selectClient, showRelayUnreachable } from "../src/app.ts";
import type { Panel } from "../src/panel.ts";
import type { StubDocument, StubElement } from "../test-support/dom.ts";

/* ------------------------------------------------------------- the harness */

/** The answer of the stubbed relay. */
interface RelayAnswer {
  /** True when the relay answered with a 2xx status. */
  ok: boolean;
  /** The status of the answer. */
  status: number;
  /** The body of the answer. */
  body: string;
}

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

/** Every element carrying the given class, in document order. */
function findAllByClass(root: StubElement, className: string): StubElement[] {
  const found: StubElement[] = [];
  for (const child of root.children) {
    if (child.className.split(/\s+/).includes(className)) found.push(child);
    found.push(...findAllByClass(child, className));
  }
  return found;
}

/**
 * Stubs the global fetch with a relay that answers as `handler` says.
 *
 * The handler may throw, which is how a relay that does not answer at all
 * is simulated. The URLs the panel asked for are collected in the list the
 * function returns.
 */
function installFetch(
  t: TestContext,
  handler: (url: string) => RelayAnswer | Promise<RelayAnswer>,
): string[] {
  const requests: string[] = [];
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = globals.fetch;
  globals.fetch = async (input: string): Promise<unknown> => {
    requests.push(input);
    const answer = await handler(input);
    return {
      ok: answer.ok,
      status: answer.status,
      body: null,
      async text(): Promise<string> {
        return answer.body;
      },
    };
  };
  t.after(() => {
    if (original === undefined) delete globals.fetch;
    else globals.fetch = original;
  });
  return requests;
}

/** A relay that answers with the given hosts and with no bots at all. */
function relayWithHosts(hosts: Array<{ alias: string; label?: string }>): (url: string) => RelayAnswer {
  return (url: string) => {
    if (url.endsWith("/api/hosts")) {
      return { ok: true, status: 200, body: JSON.stringify(hosts) };
    }
    if (/\/api\/hosts\/[^/]+\/bots$/.test(url)) {
      return { ok: true, status: 200, body: "[]" };
    }
    throw new Error(`the relay was asked for something else: ${url}`);
  };
}

/** Boots the panel and stops its timers when the test is over. */
async function bootPanel(t: TestContext, search?: string): Promise<Panel | null> {
  const panel = search === undefined ? await boot() : await boot(search);
  t.after(() => panel?.destroy());
  return panel;
}

/** The globals of the runtime, as a bag of values a test may replace. */
function globals(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

/* --------------------------------------------------------- the client mode */

test("only ?mock=1 asks for the mock client", () => {
  assert.ok(selectClient("?mock=1") instanceof MockBotdClient, "?mock=1 picks the mock");
  assert.ok(
    selectClient("?mock=1&relay=http://relay.test") instanceof MockBotdClient,
    "the mock wins over a configured relay",
  );
  assert.ok(selectClient("?mock=0") instanceof RealBotdClient, "?mock=0 asks for the relay");
  assert.ok(selectClient("?mock=true") instanceof RealBotdClient, "only the value 1 asks for the mock");
});

test("a configured relay means the real client talks to that relay", () => {
  const client = selectClient("?relay=http://relay.test:8080/");
  assert.ok(client instanceof RealBotdClient, "a configured relay means the real client");
  assert.equal(client.base, "http://relay.test:8080", "the base is the relay of the query string");
});

test("without a relay the client falls back to the page origin", (t) => {
  const original = globals().location;
  globals().location = { origin: "http://panel.test", search: "" };
  t.after(() => {
    globals().location = original;
  });
  const client = selectClient("");
  assert.ok(client instanceof RealBotdClient, "the relay is the default");
  assert.equal(client.base, "http://panel.test", "the base is the origin of the page");
});

/* --------------------------------------------------------------- the boot */

test("the mock stands in for the relay when the page asks for it", async (t) => {
  buildPage();
  const requests = installFetch(t, relayWithHosts([]));
  const panel = await bootPanel(t, "?mock=1");

  assert.ok(panel, "the boot returns the panel");
  assert.deepEqual(requests, [], "no relay is contacted in mock mode");
  const hosts = findAllByTestId(element("host-list"), "host-workstation");
  assert.equal(hosts.length, 1, "the host of the mock is listed");
});

test("the boot reads the query string of the page when it is given none", async (t) => {
  buildPage();
  const original = globals().location;
  globals().location = { origin: "http://panel.test", search: "?mock=1" };
  t.after(() => {
    globals().location = original;
  });
  const requests = installFetch(t, relayWithHosts([]));
  await bootPanel(t);

  assert.deepEqual(requests, [], "the relay of the page is not contacted in mock mode");
  const hosts = findAllByTestId(element("host-list"), "host-workstation");
  assert.equal(hosts.length, 1, "the host of the mock is listed");
});

test("the booted panel knows the hosts of the relay", async (t) => {
  buildPage();
  installFetch(t, relayWithHosts([{ alias: "alpha", label: "first box" }]));
  const panel = await bootPanel(t, "?relay=http://relay.test");

  assert.ok(panel, "the boot returns the panel");
  assert.deepEqual(
    panel?.state.hosts.map((host) => host.alias),
    ["alpha"],
    "the panel knows the host of the relay",
  );
});

/* ---------------------------------------------------------- the banner */

test("a relay that does not answer leaves the unreachable banner on the page", async (t) => {
  buildPage();
  installFetch(t, () => {
    throw new Error("fetch failed");
  });
  const panel = await bootPanel(t, "?relay=http://relay.test");

  assert.ok(panel, "the panel is returned even when the relay does not answer");
  const line = element("status-line");
  assert.match(line.textContent, new RegExp(RELAY_UNREACHABLE), "the banner names the relay");
  assert.match(line.className, /sidebar-sub-error/, "the banner is drawn as an error");
  assert.match(textOf(element("bots-panel")), new RegExp(RELAY_UNREACHABLE), "the bots panel says so too");
});

test("a relay that answers with an error is reported as unreachable", async (t) => {
  buildPage();
  installFetch(t, () => ({ ok: false, status: 503, body: "" }));
  await bootPanel(t, "?relay=http://relay.test");

  const line = element("status-line");
  assert.match(line.textContent, new RegExp(RELAY_UNREACHABLE), "the banner names the relay");
  assert.match(line.textContent, /503/, "the status of the relay is named as well");
});

test("a retry after an unreachable relay clears the banner", async (t) => {
  buildPage();
  let reachable = false;
  installFetch(t, (url) => {
    if (!reachable) throw new Error("fetch failed");
    return relayWithHosts([{ alias: "alpha", label: "first box" }])(url);
  });

  await bootPanel(t, "?relay=http://relay.test");
  assert.match(element("status-line").textContent, new RegExp(RELAY_UNREACHABLE), "the banner is there");

  reachable = true;
  await bootPanel(t, "?relay=http://relay.test");

  const line = element("status-line");
  assert.doesNotMatch(line.textContent, new RegExp(RELAY_UNREACHABLE), "the banner is gone");
  assert.match(line.textContent, /alpha/, "the status line names the host again");
  assert.doesNotMatch(line.className, /sidebar-sub-error/, "the status line is not an error any more");
  assert.doesNotMatch(textOf(element("bots-panel")), new RegExp(RELAY_UNREACHABLE), "the bots panel is drawn again");
});

test("booting twice does not duplicate the page", async (t) => {
  buildPage();
  await bootPanel(t, "?mock=1");
  await bootPanel(t, "?mock=1");

  const hosts = findAllByTestId(element("host-list"), "host-workstation");
  assert.equal(hosts.length, 1, "the host is listed once");
  assert.equal(findAllByClass(element("bots-panel"), "panel-title").length, 1, "the bots panel has one title");
  assert.equal(findAllByClass(element("stream-panel"), "panel-title").length, 1, "the stream panel has one title");
});

/* ------------------------------------------------------ the banner itself */

test("the banner names the relay even when the error does not", () => {
  buildPage();
  const message = showRelayUnreachable(new Error("the connection was refused"));

  assert.match(message, new RegExp(RELAY_UNREACHABLE), "the message names the relay");
  assert.match(message, /the connection was refused/, "the message keeps the detail of the error");
  assert.match(element("status-line").textContent, new RegExp(RELAY_UNREACHABLE), "the banner is on the page");
});

test("a page without a status line still reports the unreachable relay", () => {
  installDom();
  const message = showRelayUnreachable(new Error("fetch failed"));

  assert.match(message, new RegExp(RELAY_UNREACHABLE), "the message names the relay");
});
