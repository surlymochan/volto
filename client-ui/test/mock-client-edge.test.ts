import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { MockBotdClient } from "../src/mock-client.ts";
import type { BotEvent, RemoteHost } from "../src/client.ts";

function makeClient(t: TestContext, hosts: RemoteHost[] = [{ alias: "alpha" }]) {
  const client = new MockBotdClient({ hosts, stepMs: 5 });
  t.after(async () => {
    for (const host of await client.listHosts()) {
      await client.disconnect(host.alias);
      const bots = await client.listBots(host.alias);
      assert.ok(bots.every((bot) => bot.status !== "busy" && bot.sessionId === null));
    }
  });
  return client;
}

async function start(client: MockBotdClient, host = "alpha") {
  await client.connect(host);
  const bot = (await client.listBots(host)).find((entry) => entry.sessionId !== null);
  assert.ok(bot?.sessionId);
  return { bot, sessionId: bot.sessionId };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the mock");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function permission(events: BotEvent[]) {
  const event = events.find((entry) => entry.kind === "permission");
  assert.ok(event && event.kind === "permission");
  return event.permissionId;
}

test("connecting an unknown host rejects without creating it", async (t) => {
  const client = makeClient(t);
  await assert.rejects(client.connect("missing"), { message: 'unknown host "missing"' });
  assert.deepEqual(await client.listHosts(), [{ alias: "alpha" }]);
  assert.deepEqual(await client.listBots("missing"), []);
});

test("disconnecting an unknown host resolves without creating it", async (t) => {
  const client = makeClient(t);
  await client.disconnect("missing");
  assert.deepEqual(await client.listHosts(), [{ alias: "alpha" }]);
  assert.deepEqual(await client.listBots("missing"), []);
});

test("listing bots of an unknown host returns an empty list without creating it", async (t) => {
  const client = makeClient(t);
  assert.deepEqual(await client.listBots("missing"), []);
  assert.deepEqual(await client.listHosts(), [{ alias: "alpha" }]);
});

test("connecting twice does not start another task", async (t) => {
  const client = makeClient(t);
  await start(client);
  const before = await client.listBots("alpha");
  await client.connect("alpha");
  assert.deepEqual(await client.listBots("alpha"), before);
});

test("disconnecting a known host that is not connected is a no-op", async (t) => {
  const client = makeClient(t);
  const before = await client.listBots("alpha");
  await client.disconnect("alpha");
  assert.deepEqual(await client.listBots("alpha"), before);
});

test("adding hosts trims aliases and labels and preserves order", async (t) => {
  const client = makeClient(t);
  assert.deepEqual(await client.addHost({ alias: " beta ", label: " Second " }), {
    alias: "beta", label: "Second",
  });
  await client.addHost({ alias: "gamma" });
  assert.deepEqual((await client.listHosts()).map((host) => host.alias), ["alpha", "beta", "gamma"]);
});

test("adding a whitespace alias rejects without adding a host", async (t) => {
  const client = makeClient(t);
  await assert.rejects(client.addHost({ alias: "  " }), { message: "an ssh alias is required" });
  assert.deepEqual(await client.listHosts(), [{ alias: "alpha" }]);
});

test("subscribers receive the same ordered events and late subscribers receive replay", async (t) => {
  const client = makeClient(t);
  const { sessionId } = await start(client);
  const first: BotEvent[] = [];
  const second: BotEvent[] = [];
  client.subscribe(sessionId, (event) => first.push(event));
  client.subscribe(sessionId, (event) => second.push(event));
  await waitFor(() => first.some((event) => event.kind === "permission"));
  const late: BotEvent[] = [];
  client.subscribe(sessionId, (event) => late.push(event));
  assert.deepEqual(late, first);
  await client.answerPermission(permission(first), true);
  await waitFor(() => first.some((event) => event.kind === "turn_end"));
  assert.deepEqual(second, first);
  assert.deepEqual(late, first);
});

test("unsubscribing twice is harmless", async (t) => {
  const client = makeClient(t);
  const { sessionId } = await start(client);
  const events: BotEvent[] = [];
  const unsubscribe = client.subscribe(sessionId, (event) => events.push(event));
  unsubscribe();
  unsubscribe();
  await client.cancel(sessionId);
  assert.deepEqual(events.map((event) => event.kind), ["text"]);
});

test("an unknown session subscription returns a harmless unsubscribe", async (t) => {
  const client = makeClient(t);
  const events: BotEvent[] = [];
  const unsubscribe = client.subscribe("missing", (event) => events.push(event));
  await start(client);
  unsubscribe();
  unsubscribe();
  assert.deepEqual(events, []);
});

test("cancelling an unknown or finished session resolves without extra events", async (t) => {
  const client = makeClient(t);
  await client.cancel("missing");
  const { sessionId } = await start(client);
  const events: BotEvent[] = [];
  client.subscribe(sessionId, (event) => events.push(event));
  await client.cancel(sessionId);
  const snapshot = [...events];
  await client.cancel(sessionId);
  assert.deepEqual(events, snapshot);
});

test("answering an unknown permission does nothing", async (t) => {
  const client = makeClient(t);
  const { sessionId } = await start(client);
  const events: BotEvent[] = [];
  client.subscribe(sessionId, (event) => events.push(event));
  await client.answerPermission("missing", true);
  await waitFor(() => events.some((event) => event.kind === "permission"));
  assert.ok(!events.some((event) => event.kind === "turn_end"));
});

test("answering a permission twice only schedules one ending", async (t) => {
  const client = makeClient(t);
  const { sessionId } = await start(client);
  const events: BotEvent[] = [];
  client.subscribe(sessionId, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.kind === "permission"));
  const id = permission(events);
  await client.answerPermission(id, true);
  await client.answerPermission(id, false);
  await waitFor(() => events.some((event) => event.kind === "turn_end"));
  assert.deepEqual(events.filter((event) => event.kind === "turn_end").map((event) => event.status), ["ok"]);
});

test("answering after cancellation does not restart the session", async (t) => {
  const client = makeClient(t);
  const { sessionId } = await start(client);
  const events: BotEvent[] = [];
  client.subscribe(sessionId, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.kind === "permission"));
  const id = permission(events);
  await client.cancel(sessionId);
  const snapshot = [...events];
  await client.answerPermission(id, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, snapshot);
});

test("events identify their session, host and bot", async (t) => {
  const client = makeClient(t, [{ alias: "alpha" }, { alias: "beta" }]);
  for (const host of ["alpha", "beta"]) {
    const { bot, sessionId } = await start(client, host);
    const events: BotEvent[] = [];
    client.subscribe(sessionId, (event) => events.push(event));
    await waitFor(() => events.some((event) => event.kind === "permission"));
    assert.ok(events.every((event) => event.sessionId === sessionId && event.host === host && event.botId === bot.id));
  }
});

test("seed hosts are copied from the options array and its entries", async (t) => {
  const hosts: RemoteHost[] = [{ alias: "alpha", label: "original" }];
  const client = makeClient(t, hosts);
  hosts[0].alias = "changed";
  hosts[0].label = "changed";
  hosts.push({ alias: "beta" });
  assert.deepEqual(await client.listHosts(), [{ alias: "alpha", label: "original" }]);
  assert.equal((await client.listBots("alpha")).length, 3);
  assert.deepEqual(await client.listBots("changed"), []);
});

test("a throwing listener must not stop other listeners or the script", { todo: "listener exceptions currently propagate" }, async (t) => {
  const client = makeClient(t);
  const { sessionId } = await start(client);
  const events: BotEvent[] = [];
  client.subscribe(sessionId, (event) => {
    if (event.kind === "turn_end") throw new Error("listener failed");
  });
  client.subscribe(sessionId, (event) => events.push(event));
  await assert.doesNotReject(client.cancel(sessionId));
  assert.ok(events.some((event) => event.kind === "turn_end"));
});

test("event IDs increase per session", { todo: "mock events currently have no IDs" }, async (t) => {
  const client = makeClient(t);
  const { sessionId } = await start(client);
  const events: BotEvent[] = [];
  client.subscribe(sessionId, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.kind === "permission"));
  const ids = events.map((event) => (event as BotEvent & { id?: number }).id);
  assert.ok(ids.every((id) => typeof id === "number"));
  assert.ok(ids.every((id, index) => index === 0 || id! > ids[index - 1]!));
});
