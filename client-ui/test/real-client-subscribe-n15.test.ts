import assert from "node:assert/strict";
import test from "node:test";
import { RealBotdClient, RelayError } from "../src/real-client.ts";
import type { FetchInit, FetchResponse } from "../src/real-client.ts";
import type { BotEvent } from "../src/client.ts";

const event = { kind: "text", sessionId: "session-1", host: "host-1", botId: "bot-1" };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail("timed out waiting for subscription");
}

function response(status: number, data: string | null = null): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: data === null ? null : new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(data));
        controller.close();
      },
    }),
    text: async () => "",
  };
}

function message(data: string, id?: string): string {
  return `${id === undefined ? "" : `id: ${id}\n`}data: ${data}\n\n`;
}

test("a 4xx subscription response reports one error and does not retry", async () => {
  let calls = 0;
  const errors: Error[] = [];
  const client = new RealBotdClient({ fetch: async () => { calls++; return response(403); }, reconnectDelayMs: 2, onError: (error) => errors.push(error) });
  const unsubscribe = client.subscribe("session-1", () => assert.fail("unexpected event"));
  try {
    await waitFor(() => errors.length === 1);
    await sleep(25);
    assert.equal(calls, 1);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof RelayError);
    assert.equal(errors[0].status, 403);
  } finally { unsubscribe(); }
});

test("a 5xx response retries with the last event id", async () => {
  const requests: FetchInit[] = [];
  const errors: Error[] = [];
  const client = new RealBotdClient({
    fetch: async (_url, init) => {
      requests.push(init!);
      if (requests.length === 1) return response(200, message(JSON.stringify(event), "42"));
      if (requests.length === 2) return response(503);
      return response(403);
    },
    reconnectDelayMs: 2,
    onError: (error) => errors.push(error),
  });
  const events: BotEvent[] = [];
  const unsubscribe = client.subscribe("session-1", (value) => events.push(value));
  try {
    await waitFor(() => requests.length === 3);
    assert.deepEqual(events, [event]);
    assert.equal(requests[0].headers?.["last-event-id"], undefined);
    assert.equal(requests[1].headers?.["last-event-id"], "42");
    assert.equal(requests[2].headers?.["last-event-id"], "42");
    assert.ok(errors[0] instanceof RelayError);
    assert.equal(errors[0].status, 503);
  } finally { unsubscribe(); }
});

test("a missing stream body reports bad_answer and retries", async () => {
  let calls = 0;
  const errors: Error[] = [];
  const client = new RealBotdClient({ fetch: async () => response(++calls === 1 ? 200 : 403), reconnectDelayMs: 2, onError: (error) => errors.push(error) });
  const unsubscribe = client.subscribe("session-1", () => assert.fail("unexpected event"));
  try {
    await waitFor(() => calls === 2);
    assert.ok(errors[0] instanceof RelayError);
    assert.equal(errors[0].code, "bad_answer");
    assert.equal(errors[0].status, 200);
    assert.equal(errors[0].message, "the relay sent no event stream");
  } finally { unsubscribe(); }
});

for (const [label, data] of [
  ["unknown kind", JSON.stringify({ ...event, kind: "unknown" })],
  ["missing sessionId", JSON.stringify({ kind: "text", host: "host-1", botId: "bot-1" })],
  ["missing host", JSON.stringify({ kind: "text", sessionId: "session-1", botId: "bot-1" })],
  ["missing botId", JSON.stringify({ kind: "text", sessionId: "session-1", host: "host-1" })],
  ["invalid JSON", "{invalid"],
  ["empty data", ""],
]) {
  test(`subscription silently skips ${label}`, async () => {
    const events: BotEvent[] = [];
    const errors: Error[] = [];
    const client = new RealBotdClient({ fetch: async () => response(200, message(data) + message(JSON.stringify(event))), reconnectDelayMs: 100, onError: (error) => errors.push(error) });
    const unsubscribe = client.subscribe("session-1", (value) => events.push(value));
    try {
      await waitFor(() => events.length > 0);
      assert.deepEqual(events, [event]);
      assert.deepEqual(errors, []);
    } finally { unsubscribe(); }
  });
}

test("subscription passes each supported event kind", async () => {
  const expected = ["text", "tool", "permission", "turn_end"].map((kind) => ({ ...event, kind }));
  const events: BotEvent[] = [];
  const client = new RealBotdClient({ fetch: async () => response(200, expected.map((value) => message(JSON.stringify(value))).join("")), reconnectDelayMs: 100 });
  const unsubscribe = client.subscribe("session-1", (value) => events.push(value));
  try {
    await waitFor(() => events.length === expected.length);
    assert.deepEqual(events, expected);
  } finally { unsubscribe(); }
});

test("unsubscribe during retry delay prevents another fetch", async () => {
  let calls = 0;
  const errors: Error[] = [];
  const client = new RealBotdClient({ fetch: async () => { calls++; return response(503); }, reconnectDelayMs: 20, onError: (error) => errors.push(error) });
  const unsubscribe = client.subscribe("session-1", () => assert.fail("unexpected event"));
  await waitFor(() => errors.length === 1);
  unsubscribe();
  await sleep(50);
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
});
