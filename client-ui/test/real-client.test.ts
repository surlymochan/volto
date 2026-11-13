// Tests for the real BotdClient: the browser side of the relay.
//
// The relay is faked by a tiny http server that implements the endpoints of
// client-ui/relay.mjs, including the event stream with its ids, its pings
// and the replay from a Last-Event-ID header. The last test runs against the
// real relay with a fake child as the host, so the wiring is checked against
// the code that ships.
//
// Every alias, id and payload below is synthetic.

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { IncomingMessage, IncomingHttpHeaders, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { MockBotdClient } from "../src/mock-client.ts";
import { RealBotdClient, createSseParser, readSseStream } from "../src/real-client.ts";
import { boot, selectClient, showRelayUnreachable } from "../src/app.ts";
import { installDom } from "../test-support/dom.ts";
import type { ByteStream } from "../src/real-client.ts";
import type { BotEvent, BotKind, RemoteBot, RemoteHost } from "../src/client.ts";

const removeDir = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

/* ------------------------------------------------------------- the fakes */

/** One session of the fake relay. */
interface FakeSession {
  id: string;
  host: string;
  botId: string;
  events: Array<{ id: number; data: BotEvent }>;
  listeners: Set<ServerResponse>;
  /** How many stream requests of this session ended. */
  closed: number;
}

/** A request the fake relay saw. */
interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** The fake relay: the endpoints of client-ui/relay.mjs, in miniature. */
class FakeRelay {
  readonly server: Server;
  readonly requests: RecordedRequest[] = [];
  readonly hosts = new Map<string, RemoteHost>();
  readonly bots = new Map<string, RemoteBot[]>();
  readonly sessions = new Map<string, FakeSession>();
  readonly permissions = new Map<string, { sessionId: string; allow: boolean }>();
  /** Base URL of the relay. */
  base = "";
  #counter = 0;

  constructor() {
    this.server = createServer((request, response) => {
      void this.#handle(request, response);
    });
  }

  /** Starts the relay and returns its base URL. */
  async start(): Promise<string> {
    await new Promise<void>((ready) => this.server.listen(0, "127.0.0.1", ready));
    const address = this.server.address() as AddressInfo;
    this.base = `http://127.0.0.1:${address.port}`;
    return this.base;
  }

  /** Stops the relay. */
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((closed) => this.server.close(() => closed()));
  }

  /** Adds a host with one bot. */
  addHost(alias: string, label?: string): RemoteHost {
    const host: RemoteHost = label === undefined ? { alias } : { alias, label };
    this.hosts.set(alias, host);
    const bot: RemoteBot = {
      id: `${alias}:codex`,
      host: alias,
      kind: "codex",
      family: "gpt",
      lane: "primary",
      status: "idle",
      leaseExpiresAt: null,
      quotaUsedPct: 0,
      sessionId: null,
    };
    this.bots.set(alias, [bot]);
    return host;
  }

  /** Opens a session, the way the relay does for a connected host. */
  openSession(alias: string, kind: BotKind = "codex"): FakeSession {
    this.#counter += 1;
    const id = `session-${this.#counter}`;
    const session: FakeSession = {
      id,
      host: alias,
      botId: `${alias}:${kind}`,
      events: [],
      listeners: new Set(),
      closed: 0,
    };
    this.sessions.set(id, session);
    return session;
  }

  /** Writes an event to the listeners of a session. */
  push(sessionId: string, event: BotEvent): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`the session ${sessionId} is unknown`);
    const item = { id: session.events.length + 1, data: event };
    session.events.push(item);
    for (const listener of [...session.listeners]) {
      listener.write(`id: ${item.id}\ndata: ${JSON.stringify(item.data)}\n\n`);
    }
  }

  /** Ends the streams of a session, the way a broken connection does. */
  drop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const listener of [...session.listeners]) listener.end();
    session.listeners.clear();
  }

  /** The requests of the relay that went to a path. */
  requestsTo(path: string): RecordedRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter((part) => part !== "");
    const method = request.method ?? "GET";
    let body = "";
    for await (const chunk of request) body += chunk;
    this.requests.push({ method, path: url.pathname, headers: request.headers, body });

    if (parts[0] !== "api") return this.#error(response, 404, "not_found", "Not found");

    if (parts[1] === "hosts" && parts.length === 2) {
      if (method === "GET") return this.#json(response, [...this.hosts.values()]);
      if (method === "POST") {
        const data = parseJson(body);
        const alias = typeof data?.alias === "string" ? data.alias : "";
        if (alias === "") return this.#error(response, 400, "invalid_host", "Invalid host");
        if (this.hosts.has(alias)) {
          return this.#error(response, 409, "host_exists", `Host ${alias} already exists`);
        }
        const label = typeof data?.label === "string" ? data.label : undefined;
        return this.#json(response, this.addHost(alias, label));
      }
    }

    if (parts[1] === "hosts" && parts.length === 4) {
      const alias = decodeURIComponent(parts[2]);
      if (!this.hosts.has(alias)) {
        return this.#error(response, 404, "not_found", "Host not found");
      }
      if (parts[3] === "connect" && method === "POST") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (parts[3] === "disconnect" && method === "POST") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (parts[3] === "bots" && method === "GET") {
        return this.#json(response, this.bots.get(alias) ?? []);
      }
      if (parts[3] === "sessions" && method === "POST") {
        const data = parseJson(body);
        const kind = typeof data?.kind === "string" ? data.kind : "";
        if (kind === "") return this.#error(response, 400, "invalid_body", "Invalid session request");
        const session = this.openSession(alias, kind as BotKind);
        return this.#json(response, { sessionId: session.id, botId: session.botId });
      }
    }

    if (parts[1] === "sessions" && parts.length === 4) {
      const id = decodeURIComponent(parts[2]);
      const session = this.sessions.get(id);
      if (!session) return this.#error(response, 404, "not_found", "Session not found");
      if (parts[3] === "send" && method === "POST") {
        const data = parseJson(body);
        if (typeof data?.text !== "string") {
          return this.#error(response, 400, "invalid_body", "Invalid message");
        }
        response.writeHead(204);
        response.end();
        return;
      }
      if (parts[3] === "cancel" && method === "POST") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (parts[3] === "events" && method === "GET") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        // The relay pings every 15 seconds; a comment is not an event.
        response.write(": ping\n\n");
        const last = Number(request.headers["last-event-id"] ?? 0);
        const from = Number.isFinite(last) ? last : 0;
        for (const item of session.events) {
          if (item.id > from) response.write(`id: ${item.id}\ndata: ${JSON.stringify(item.data)}\n\n`);
        }
        session.listeners.add(response);
        response.on("close", () => {
          session.listeners.delete(response);
          session.closed += 1;
        });
        return;
      }
    }

    if (parts[1] === "permissions" && parts.length === 3 && method === "POST") {
      const id = decodeURIComponent(parts[2]);
      const data = parseJson(body);
      if (typeof data?.allow !== "boolean") {
        return this.#error(response, 400, "invalid_body", "Invalid permission answer");
      }
      this.permissions.set(id, { sessionId: "session-1", allow: data.allow });
      response.writeHead(204);
      response.end();
      return;
    }

    return this.#error(response, 404, "not_found", "Not found");
  }

  #json(response: ServerResponse, value: unknown): void {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  }

  #error(response: ServerResponse, status: number, code: string, message: string): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code, message } }));
  }
}

/** A byte stream that hands out the given chunks. */
function fakeStream(chunks: string[]): ByteStream {
  let index = 0;
  const encoder = new TextEncoder();
  return {
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) return { done: true };
          const value = encoder.encode(chunks[index]);
          index += 1;
          return { value, done: false };
        },
        releaseLock(): void {},
      };
    },
  };
}

/** The body of a request, parsed; null when it is not a JSON object. */
function parseJson(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A text event of a session. */
function textEvent(session: FakeSession, text: string): BotEvent {
  return {
    kind: "text",
    sessionId: session.id,
    host: session.host,
    botId: session.botId,
    text,
  };
}

/* ------------------------------------------------------------- the helpers */

/** Runs the body with a started fake relay and stops it afterwards. */
async function withRelay(body: (relay: FakeRelay) => Promise<void>): Promise<void> {
  const relay = new FakeRelay();
  await relay.start();
  try {
    await body(relay);
  } finally {
    await relay.stop();
  }
}

/** Waits until `predicate` holds or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the relay");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A port nobody listens on. */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address() as AddressInfo;
  await new Promise<void>((closed) => server.close(() => closed()));
  return address.port;
}

/* --------------------------------------------------------- the event stream */

test("the event stream parser reads a message that is split over several chunks", () => {
  const parser = createSseParser();
  assert.deepEqual(parser.push('id: 1\ndata: {"kind"'), []);
  assert.deepEqual(parser.push(': "text"}'), []);
  const messages = parser.push("\n\n");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "1");
  assert.equal(messages[0].data, '{"kind": "text"}');
});

test("the event stream parser ignores the comments and the pings", () => {
  const parser = createSseParser();
  assert.deepEqual(parser.push(": ping\n\n"), []);
  assert.deepEqual(parser.push(": ping\n"), []);
  assert.deepEqual(parser.push("\n"), []);
});

test("the event stream parser keeps the id of the last message", () => {
  const parser = createSseParser();
  parser.push("id: 7\ndata: one\n\n");
  const messages = parser.push("data: two\n\n");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "7", "the id of the stream is kept");
  assert.equal(messages[0].data, "two");
});

test("the event stream parser reads the lines of every flavour of newline", () => {
  const parser = createSseParser();
  const messages = parser.push("id: 1\r\ndata: one\r\n\r\nid: 2\ndata: two\n\n");
  assert.deepEqual(
    messages.map((message) => message.data),
    ["one", "two"],
  );
});

test("the event stream reader hands out the messages of a stream", async () => {
  const stream = fakeStream(["id: 1\r\ndata: one\r\n\r\n", ": ping\n\n", "id: 2\ndata: two\n\n"]);
  const messages: Array<{ id: string | null; data: string }> = [];
  for await (const message of readSseStream(stream)) {
    messages.push({ id: message.id, data: message.data });
  }
  assert.deepEqual(
    messages.map((message) => message.data),
    ["one", "two"],
  );
  assert.deepEqual(
    messages.map((message) => message.id),
    ["1", "2"],
  );
});

/* -------------------------------------------------------------- the client */

test("the client lists the hosts of the relay", async () => {
  await withRelay(async (relay) => {
    relay.addHost("alpha", "first");
    const client = new RealBotdClient({ base: relay.base });
    assert.deepEqual(await client.listHosts(), [{ alias: "alpha", label: "first" }]);
  });
});

test("the client adds a host and reports a duplicate alias", async () => {
  await withRelay(async (relay) => {
    const client = new RealBotdClient({ base: relay.base });
    const added = await client.addHost({ alias: "alpha", label: "first" });
    assert.deepEqual(added, { alias: "alpha", label: "first" });
    const blank = await client.addHost({ alias: "bravo", label: "  " });
    assert.deepEqual(blank, { alias: "bravo" }, "a blank label is dropped");
    await assert.rejects(() => client.addHost({ alias: "alpha" }), /already exists/);
    await assert.rejects(() => client.addHost({ alias: "  " }), /ssh alias is required/);
  });
});

test("the client connects and disconnects a host", async () => {
  await withRelay(async (relay) => {
    relay.addHost("alpha");
    const client = new RealBotdClient({ base: relay.base });
    await client.connect("alpha");
    await client.disconnect("alpha");
    const paths = relay.requests.map((request) => `${request.method} ${request.path}`);
    assert.ok(paths.includes("POST /api/hosts/alpha/connect"));
    assert.ok(paths.includes("POST /api/hosts/alpha/disconnect"));
  });
});

test("the client lists the bots of a host", async () => {
  await withRelay(async (relay) => {
    relay.addHost("alpha");
    const client = new RealBotdClient({ base: relay.base });
    const bots = await client.listBots("alpha");
    assert.equal(bots.length, 1);
    assert.equal(bots[0].id, "alpha:codex");
    assert.equal(bots[0].host, "alpha");
    assert.equal(bots[0].kind, "codex");
  });
});

test("the client opens a session, sends a prompt and streams the events", async () => {
  await withRelay(async (relay) => {
    relay.addHost("alpha");
    const client = new RealBotdClient({ base: relay.base });
    const session = await client.openSession("alpha", { kind: "codex", cwd: "/tmp" });
    assert.match(session.sessionId, /^session-/);
    assert.equal(session.botId, "alpha:codex");

    await client.send(session.sessionId, "hello");
    const sent = relay.requestsTo(`/api/sessions/${session.sessionId}/send`);
    assert.equal(sent.length, 1);
    assert.deepEqual(JSON.parse(sent[0].body), { text: "hello" });

    const events: BotEvent[] = [];
    const unsubscribe = client.subscribe(session.sessionId, (event) => events.push(event));
    const fake = relay.sessions.get(session.sessionId);
    assert.ok(fake);
    try {
      relay.push(session.sessionId, textEvent(fake, "picked up the task"));
      await waitFor(() => events.length > 0);
      assert.equal(events[0].kind, "text");
      assert.equal((events[0] as { text: string }).text, "picked up the task");
    } finally {
      unsubscribe();
    }
  });
});

test("the client cancels a session", async () => {
  await withRelay(async (relay) => {
    relay.addHost("alpha");
    const client = new RealBotdClient({ base: relay.base });
    const session = await client.openSession("alpha", { kind: "codex" });
    await client.cancel(session.sessionId);
    const cancelled = relay.requestsTo(`/api/sessions/${session.sessionId}/cancel`);
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].method, "POST");
  });
});

test("the client answers a permission request", async () => {
  await withRelay(async (relay) => {
    relay.addHost("alpha");
    const client = new RealBotdClient({ base: relay.base });
    await client.answerPermission("perm-1", true);
    const answers = relay.requestsTo("/api/permissions/perm-1");
    assert.equal(answers.length, 1);
    assert.deepEqual(JSON.parse(answers[0].body), { allow: true });
  });
});

test("unsubscribing ends the stream of the session", async () => {
  await withRelay(async (relay) => {
    relay.addHost("alpha");
    const client = new RealBotdClient({ base: relay.base });
    const session = await client.openSession("alpha", { kind: "codex" });
    const fake = relay.sessions.get(session.sessionId);
    assert.ok(fake);

    const events: BotEvent[] = [];
    const unsubscribe = client.subscribe(session.sessionId, (event) => events.push(event));
    try {
      relay.push(session.sessionId, textEvent(fake, "one"));
      await waitFor(() => events.length === 1);

      unsubscribe();
      await waitFor(() => fake.closed === 1);
      assert.equal(events.length, 1, "no event arrives after unsubscribing");
    } finally {
      unsubscribe();
    }
  });
});

test("the client opens the stream again when the relay drops it", async () => {
  await withRelay(async (relay) => {
    relay.addHost("alpha");
    const client = new RealBotdClient({
      base: relay.base,
      reconnectDelayMs: 10,
      onError: () => {},
    });
    const session = await client.openSession("alpha", { kind: "codex" });
    const fake = relay.sessions.get(session.sessionId);
    assert.ok(fake);

    const events: BotEvent[] = [];
    const unsubscribe = client.subscribe(session.sessionId, (event) => events.push(event));
    try {
      relay.push(session.sessionId, textEvent(fake, "first"));
      await waitFor(() => events.length === 1);

      relay.drop(session.sessionId);
      await waitFor(() => relay.requestsTo(`/api/sessions/${session.sessionId}/events`).length === 2);
      const resumed = relay.requestsTo(`/api/sessions/${session.sessionId}/events`)[1];
      assert.equal(resumed.headers["last-event-id"], "1", "the client asks for the rest");

      relay.push(session.sessionId, textEvent(fake, "second"));
      await waitFor(() => events.length === 2);
      assert.equal((events[1] as { text: string }).text, "second");
    } finally {
      unsubscribe();
    }
  });
});

test("a relay that does not answer is reported as an error", async () => {
  const port = await deadPort();
  const client = new RealBotdClient({ base: `http://127.0.0.1:${port}` });
  await assert.rejects(() => client.listHosts(), /relay unreachable/);
});

/* ---------------------------------------------------------------- the panel */

test("the panel talks to the relay, unless the page asks for the mock", () => {
  assert.ok(selectClient("") instanceof RealBotdClient, "the relay is the default");
  assert.ok(selectClient("?relay=http://127.0.0.1:1234") instanceof RealBotdClient);
  assert.ok(selectClient("?mock=1") instanceof MockBotdClient, "?mock=1 picks the mock");
});

test("the panel says that the relay is unreachable", () => {
  const { document } = installDom();
  const line = document.register("status-line", "p");
  const bots = document.register("bots-panel", "section");
  const message = showRelayUnreachable(new Error("relay unreachable: fetch failed"));
  assert.match(message, /relay unreachable/);
  assert.match(line.textContent, /relay unreachable/, "the error is visible");
  assert.match(line.className, /sidebar-sub-error/);
  assert.match(bots.textContent, /relay unreachable/);
});

test("booting against a relay that does not answer shows the error", async () => {
  const { document } = installDom();
  const line = document.register("status-line", "p");
  document.register("bots-panel", "section");
  const port = await deadPort();
  await boot(`?relay=http://127.0.0.1:${port}`);
  assert.match(line.textContent, /relay unreachable/, "the error is visible");
});

/* -------------------------------------------------------------- the smoke test */

test("the client talks to the real relay", async () => {
  const { startRelay } = await import("../relay.mjs");
  const { daemonCommand } = await import("../../botd/src/client.ts");
  const dir = await mkdtemp(join(tmpdir(), "real-client-"));
  const fixture = resolve("botd/test/fixtures/fake-child.mjs");
  const binary = join(dir, "codex");
  await writeFile(
    binary,
    `#!${process.execPath}\nimport ${JSON.stringify(fixture)};\n` +
      "process.stdin.on('data', () => process.stdout.write(JSON.stringify(" +
      "{method:'item/agentMessage/delta',params:{delta:'hello from the fake'}}) + '\\n'));\n",
  );
  await chmod(binary, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  const relay = await startRelay({
    hosts: [{ alias: "test", command: daemonCommand({ home: join(dir, "home") }) }],
  });
  const base = relay.url.replace(/\/$/, "");
  const client = new RealBotdClient({ base });
  try {
    assert.deepEqual(await client.listHosts(), [{ alias: "test" }]);
    await client.connect("test");
    const bots = await client.listBots("test");
    assert.ok(bots.length > 0, "the host reports its bots");

    const session = await client.openSession("test", { kind: "codex", cwd: process.cwd() });
    assert.ok(session.sessionId.length > 0);

    const events: BotEvent[] = [];
    const unsubscribe = client.subscribe(session.sessionId, (event) => events.push(event));
    try {
      await client.send(session.sessionId, "hello");
      await waitFor(() => events.length > 0, 15000);
      const first = events[0] as { kind: string; text?: string };
      assert.equal(first.kind, "text");
      assert.match(first.text ?? "", /hello from the fake/);
    } finally {
      unsubscribe();
    }
  } finally {
    try {
      relay.server.closeAllConnections();
      await new Promise<void>((closed) => relay.server.close(() => closed()));
    } finally {
      process.env.PATH = oldPath;
      await removeDir(dir);
    }
  }
});
