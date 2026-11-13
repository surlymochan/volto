import { test } from "node:test";
import assert from "node:assert/strict";
import { RealBotdClient, RelayError } from "../src/real-client.ts";
import type { FetchResponse } from "../src/real-client.ts";

const response = (body: string): FetchResponse => ({
  ok: true, status: 200, body: null, async text() { return body; },
});
const clientWith = (body: string) => new RealBotdClient({
  base: "https://relay.invalid", fetch: async () => response(body),
});
const badAnswer = (message: string) => (error: unknown) =>
  error instanceof RelayError && error.code === "bad_answer" && error.status === 200 && error.message === message;

test("rejects a non-array host list", async () => {
  await assert.rejects(clientWith("{}").listHosts(), badAnswer("the relay did not answer with a list of hosts"));
});

test("rejects a host without an alias", async () => {
  await assert.rejects(clientWith('[{}]').listHosts(), badAnswer("the relay did not answer with a host"));
});

test("rejects a non-array bot list", async () => {
  await assert.rejects(clientWith("{}").listBots("host"), badAnswer("the relay did not answer with a list of bots"));
});

test("rejects a bot without an id", async () => {
  await assert.rejects(clientWith('[{"host":"host"}]').listBots("host"), badAnswer("the relay did not answer with a bot"));
});

test("rejects a bot without a host", async () => {
  await assert.rejects(clientWith('[{"id":"bot"}]').listBots("host"), badAnswer("the relay did not answer with a bot"));
});

test("rejects a session without a session id", async () => {
  await assert.rejects(clientWith('{"botId":"bot"}').openSession("host", { kind: "codex" }), badAnswer("the relay did not answer with a session"));
});

test("rejects a session without a bot id", async () => {
  await assert.rejects(clientWith('{"sessionId":"session"}').openSession("host", { kind: "codex" }), badAnswer("the relay did not answer with a session"));
});

test("rejects a successful response that is not JSON", async () => {
  await assert.rejects(clientWith("not JSON").listHosts(), badAnswer("the relay answered with something that is not JSON"));
});

test("an empty successful response returns undefined", async () => {
  assert.equal(await clientWith("").connect("host"), undefined);
});

test("a whitespace successful response returns undefined", async () => {
  assert.equal(await clientWith(" \n\t ").connect("host"), undefined);
});

test("trims the alias and label before adding a host", async () => {
  let sent = "";
  const client = new RealBotdClient({ base: "https://relay.invalid", fetch: async (_input, init) => {
    sent = init?.body ?? "";
    return response('{"alias":"host","label":"label"}');
  } });
  assert.deepEqual(await client.addHost({ alias: " host ", label: " label " }), { alias: "host", label: "label" });
  assert.deepEqual(JSON.parse(sent), { alias: "host", label: "label" });
});

test("a rejected fetch reports the unreachable code", async () => {
  const client = new RealBotdClient({ base: "https://relay.invalid", fetch: async () => { throw new Error("offline"); } });
  await assert.rejects(client.listHosts(), (error: unknown) =>
    error instanceof RelayError && error.code === "unreachable" && error.status === 0 && error.message === "relay unreachable: offline");
});
