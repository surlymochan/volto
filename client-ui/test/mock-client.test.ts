// Tests for the mock BotdClient.
//
// The mock simulates a daemon with timers, so the tests use very short steps
// and wait for the events they expect. All names are synthetic.

import assert from "node:assert/strict";
import test from "node:test";

import { MockBotdClient } from "../src/mock-client.ts";
import type { BotEvent } from "../src/client.ts";

const STEP = 5;

/** Waits until `predicate` holds or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the mock");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("lists the hosts it was seeded with", async () => {
  const client = new MockBotdClient({ hosts: [{ alias: "alpha", label: "first" }] });
  const hosts = await client.listHosts();
  assert.deepEqual(hosts, [{ alias: "alpha", label: "first" }]);
});

test("adds a host and refuses a duplicate alias", async () => {
  const client = new MockBotdClient({ stepMs: STEP });
  const added = await client.addHost({ alias: "alpha", label: "  " });
  assert.equal(added.alias, "alpha");
  assert.equal(added.label, undefined, "a blank label is dropped");
  await assert.rejects(() => client.addHost({ alias: "alpha" }), /already known/);
  await assert.rejects(() => client.addHost({ alias: "  " }), /ssh alias is required/);
});

test("a new host gets bots with kind, family, lane and quota", async () => {
  const client = new MockBotdClient({ stepMs: STEP });
  await client.addHost({ alias: "alpha" });
  const bots = await client.listBots("alpha");
  assert.equal(bots.length, 3);
  assert.deepEqual(
    bots.map((bot) => bot.kind),
    ["codex", "claude", "dsh"],
  );
  assert.deepEqual(
    bots.map((bot) => bot.lane),
    ["primary", "review", "sandbox"],
  );
  assert.ok(bots.every((bot) => bot.host === "alpha"));
  assert.ok(bots.every((bot) => bot.quotaUsedPct >= 0 && bot.quotaUsedPct <= 100));
  assert.equal(bots[2].status, "down");
});

test("connecting starts a task that streams events", async () => {
  const client = new MockBotdClient({ stepMs: STEP });
  await client.addHost({ alias: "alpha" });
  await client.connect("alpha");

  const bots = await client.listBots("alpha");
  const busy = bots.find((bot) => bot.status === "busy");
  assert.ok(busy, "one bot is busy after connecting");
  assert.ok(busy.sessionId, "the busy bot runs a session");
  assert.ok(busy.leaseExpiresAt, "a busy bot holds a lease");

  const events: BotEvent[] = [];
  client.subscribe(busy.sessionId as string, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.kind === "permission"));

  const kinds = events.map((event) => event.kind);
  assert.deepEqual(kinds.slice(0, 3), ["text", "tool", "tool"]);
  const permission = events.find((event) => event.kind === "permission");
  assert.ok(permission && permission.kind === "permission");
  assert.ok(permission.permissionId.length > 0);
});

test("subscribing replays the events that already happened", async () => {
  const client = new MockBotdClient({ stepMs: STEP });
  await client.addHost({ alias: "alpha" });
  await client.connect("alpha");
  const bots = await client.listBots("alpha");
  const sessionId = bots.find((bot) => bot.status === "busy")?.sessionId as string;

  await waitFor(async () => true);
  const events: BotEvent[] = [];
  client.subscribe(sessionId, (event) => events.push(event));
  assert.ok(events.length > 0, "the replay is not empty");
});

test("allowing a permission finishes the turn", async () => {
  const client = new MockBotdClient({ stepMs: STEP });
  await client.addHost({ alias: "alpha" });
  await client.connect("alpha");
  const bots = await client.listBots("alpha");
  const sessionId = bots.find((bot) => bot.status === "busy")?.sessionId as string;

  const events: BotEvent[] = [];
  client.subscribe(sessionId, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.kind === "permission"));
  const permission = events.find((event) => event.kind === "permission");
  await client.answerPermission((permission as { permissionId: string }).permissionId, true);

  await waitFor(() => events.some((event) => event.kind === "turn_end"));
  const turn = events.find((event) => event.kind === "turn_end");
  assert.ok(turn && turn.kind === "turn_end");
  assert.equal(turn.status, "ok");
});

test("denying a permission ends the turn as cancelled", async () => {
  const client = new MockBotdClient({ stepMs: STEP });
  await client.addHost({ alias: "alpha" });
  await client.connect("alpha");
  const bots = await client.listBots("alpha");
  const sessionId = bots.find((bot) => bot.status === "busy")?.sessionId as string;

  const events: BotEvent[] = [];
  client.subscribe(sessionId, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.kind === "permission"));
  const permission = events.find((event) => event.kind === "permission");
  await client.answerPermission((permission as { permissionId: string }).permissionId, false);

  await waitFor(() => events.some((event) => event.kind === "turn_end"));
  const turn = events.find((event) => event.kind === "turn_end");
  assert.ok(turn && turn.kind === "turn_end");
  assert.equal(turn.status, "cancelled");
});

test("cancelling a session emits a cancelled turn and frees the bot", async () => {
  const client = new MockBotdClient({ stepMs: STEP });
  await client.addHost({ alias: "alpha" });
  await client.connect("alpha");
  const bots = await client.listBots("alpha");
  const sessionId = bots.find((bot) => bot.status === "busy")?.sessionId as string;

  const events: BotEvent[] = [];
  client.subscribe(sessionId, (event) => events.push(event));
  await client.cancel(sessionId);

  const turn = events.find((event) => event.kind === "turn_end");
  assert.ok(turn && turn.kind === "turn_end");
  assert.equal(turn.status, "cancelled");

  const after = await client.listBots("alpha");
  assert.ok(after.every((bot) => bot.status !== "busy"));
  assert.ok(after.every((bot) => bot.sessionId === null));
});

test("disconnecting stops the bots of that host", async () => {
  const client = new MockBotdClient({ stepMs: STEP });
  await client.addHost({ alias: "alpha" });
  await client.connect("alpha");
  await client.disconnect("alpha");
  const bots = await client.listBots("alpha");
  assert.ok(bots.every((bot) => bot.status !== "busy"));
});

test("unsubscribing stops the events", async () => {
  const client = new MockBotdClient({ stepMs: STEP });
  await client.addHost({ alias: "alpha" });
  await client.connect("alpha");
  const bots = await client.listBots("alpha");
  const sessionId = bots.find((bot) => bot.status === "busy")?.sessionId as string;

  const events: BotEvent[] = [];
  const unsubscribe = client.subscribe(sessionId, (event) => events.push(event));
  unsubscribe();
  const seen = events.length;
  await waitFor(() => false, 50).catch(() => {});
  assert.equal(events.length, seen, "no event arrives after unsubscribing");
});
