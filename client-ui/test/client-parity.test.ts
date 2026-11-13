// Tests that keep the mock client and the real client in step.
//
// The panel talks to a `BotdClient` (client-ui/src/client.ts) and does not
// know whether it talks to the mock (src/mock-client.ts) or to the relay
// (src/real-client.ts). The two clients have to behave the same, or the
// panel behaves differently depending on the mode it runs in.
//
// The file has three parts:
//
//   1. the shape of the two classes: the members of the interface, their
//      arity, their return values and the members the clients add,
//   2. the event names: the set of the events both clients hand to the panel,
//   3. a table driven contract run: the steps of a session run against both
//      clients, and the outcomes are compared.
//
// The differences that are intended are listed in the allow list below; every
// other difference fails the run. An allow list entry that no longer describes
// a difference fails as well, so the list cannot rot.
//
// The relay is faked by a tiny http server that implements the endpoints of
// client-ui/relay.mjs: hosts, connect, sessions, send, cancel and the event
// stream. Every alias, id and payload below is synthetic.

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { MockBotdClient } from "../src/mock-client.ts";
import { RealBotdClient } from "../src/real-client.ts";
import type { BotEvent, BotKind, RemoteBot, RemoteHost } from "../src/client.ts";

/** The source of the contract between the panel and a daemon. */
const clientSource = await readFile(new URL("../src/client.ts", import.meta.url), "utf8");

/* ------------------------------------------------------------ the contract */

/** One member of an interface: a method or a property. */
interface InterfaceMember {
  /** The name of the member. */
  name: string;
  /** The number of parameters of a method; -1 for a property. */
  arity: number;
  /** The return type of the member, as the source writes it. */
  returns: string;
}

/** Reads the members of an interface out of the source of a module. */
function readInterface(source: string, name: string): InterfaceMember[] {
  const header = `export interface ${name} {`;
  const start = source.indexOf(header);
  assert.ok(start >= 0, `the source has no interface ${name}`);
  const body = source.slice(start + header.length);
  const end = body.indexOf("\n}");
  assert.ok(end >= 0, `the interface ${name} is never closed`);
  const members: InterfaceMember[] = [];
  for (const line of body.slice(0, end).split("\n")) {
    const match = /^\s*(\w+)\s*(?:\((.*)\))?\s*:\s*(.+);\s*$/.exec(line);
    if (!match) continue;
    const [, memberName, parameters, returns] = match;
    members.push({
      name: memberName,
      arity: parameters === undefined ? -1 : countParameters(parameters),
      returns: returns.trim(),
    });
  }
  return members;
}

/** Counts the parameters of a method; the commas of the nested types do not count. */
function countParameters(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  let depth = 0;
  let count = 1;
  for (const char of trimmed) {
    if (char === "(" || char === "{" || char === "[") depth += 1;
    else if (char === ")" || char === "}" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) count += 1;
  }
  return count;
}

/** Reads the kinds of the events of the panel out of the source of a module. */
function readEventKinds(source: string): string[] {
  const start = source.indexOf("export type BotEvent =");
  assert.ok(start >= 0, "the source has no type BotEvent");
  const end = source.indexOf("\n\n", start);
  const body = source.slice(start, end === -1 ? undefined : end);
  const kinds = new Set<string>();
  for (const match of body.matchAll(/kind:\s*"([a-z_]+)"/g)) kinds.add(match[1]);
  return [...kinds].sort();
}

/* ------------------------------------------------------------ the allow list */

/** A difference between the mock and the real client that is intended. */
interface AllowEntry {
  /** The surface the difference shows on: a step of the contract or a member. */
  surface: string;
  /** What the mock does. */
  mock: string;
  /** What the real client does. */
  real: string;
  /** Why the difference is intended. */
  reason: string;
  /** The members only one of the clients has, when the surface is about the shape. */
  extraMembers?: { mock: string[]; real: string[] };
}

/**
 * The differences between the mock and the real client that are intended.
 *
 * Every entry names the surface it shows on, so a test can tell an intended
 * difference from an accident. A surface that is a step of the contract table
 * has to differ; a surface that does not differ any more fails the run, so
 * the list stays honest.
 */
const ALLOW_LIST: AllowEntry[] = [
  {
    surface: "extra members",
    mock: "the mock has no member beyond the interface of the panel",
    real: "the real client adds the base url of the relay, openSession and send",
    reason:
      "the panel never opens a session and never prompts one: it watches the sessions the daemon runs. " +
      "The demo opens and prompts a session, and it needs the url of the relay to do so.",
    extraMembers: { mock: [], real: ["base", "openSession", "send"] },
  },
  {
    surface: "list bots",
    mock: "a connect starts a scripted task, so one bot is busy, holds a lease and spent quota right away",
    real: "a connect only starts the bots of the host, so every bot is idle until a session is opened",
    reason:
      "the mock has to show a running session without a daemon behind it. " +
      "The relay opens a session only when it is asked to, so the bots stay idle until then.",
  },
  {
    surface: "send",
    mock: "the mock has no send: a prompt is not part of the interface of the panel",
    real: "the real client sends the prompt to the daemon",
    reason:
      "the panel watches the sessions of the daemon and never prompts one. " +
      "The mock stands in for the panel, not for the demo that prompts a session.",
  },
  {
    surface: "call after disconnect",
    mock: "the bots of the host stay idle and keep the quota of the task they ran",
    real: "the bots of the host go down after a disconnect",
    reason:
      "the mock does not model a broken ssh connection: it keeps the bots of the host listed. " +
      "The relay marks them down, because the host is not connected any more.",
  },
  {
    surface: "list bots of an unknown host",
    mock: "the mock answers with an empty list",
    real: "the relay refuses the host with a 404",
    reason:
      "the mock looks the bots of a host up in a map and answers with an empty list when it does not know the host. " +
      "The relay refuses the host. The panel only asks for the bots of a host the daemon named.",
  },
];

/** The entry of the allow list that belongs to a surface. */
function allowEntry(surface: string): AllowEntry {
  const entry = ALLOW_LIST.find((candidate) => candidate.surface === surface);
  assert.ok(entry, `the allow list has no entry for ${surface}`);
  return entry;
}

/* -------------------------------------------------------------- the members */

/** The members a class has beyond the interface of the panel. */
function extraMembers(ctor: Function): string[] {
  const names = Object.getOwnPropertyNames(ctor.prototype).filter((name) => name !== "constructor");
  const members = readInterface(clientSource, "BotdClient").map((member) => member.name);
  return names.filter((name) => !members.includes(name)).sort();
}

/* ------------------------------------------------------------- the contract */

/** What a step of the contract did, in a form both clients can be compared by. */
type Outcome =
  | { kind: "resolved"; value?: unknown }
  | { kind: "rejected" }
  | { kind: "unsupported" };

/** The parts of the real client that are beyond the interface of the panel. */
interface SessionCommands {
  /** Opens a session on a host. */
  openSession(alias: string, options: { kind: BotKind }): Promise<{ sessionId: string; botId: string }>;
  /** Sends a prompt to a session. */
  send(sessionId: string, text: string): Promise<void>;
}

/** A client under test, with the bits that differ between the two of them. */
interface Harness {
  /** The name of the client. */
  name: string;
  /** The client itself. */
  client: BotdClient & Partial<SessionCommands>;
  /** The host the steps work with. */
  alias: string;
  /** Opens a session and returns its id. */
  openSession(): Promise<string>;
  /** Sends a prompt to a session. */
  send(sessionId: string): Promise<Outcome>;
}

/** The state the steps of the contract share. */
interface StepContext extends Harness {
  /** The session the steps opened. */
  sessionId: string | null;
}

/** One step of the contract, run against both clients. */
interface ContractStep {
  /** The name of the step; it names the allow list entry when it may differ. */
  surface: string;
  /** Runs the step and describes what happened. */
  run(context: StepContext): Promise<Outcome>;
}

/** The steps of the contract, in the order the panel walks through them. */
const STEPS: ContractStep[] = [
  {
    surface: "list hosts",
    async run(context) {
      const hosts = await context.client.listHosts();
      return { kind: "resolved", value: hosts };
    },
  },
  {
    surface: "connect",
    async run(context) {
      await context.client.connect(context.alias);
      return { kind: "resolved" };
    },
  },
  {
    surface: "list bots",
    async run(context) {
      const bots = await context.client.listBots(context.alias);
      return { kind: "resolved", value: shapeOfBots(bots) };
    },
  },
  {
    surface: "open session",
    async run(context) {
      context.sessionId = await context.openSession();
      // The ids of the sessions are made by the daemon, so they are compared
      // by their presence and not by their shape.
      return { kind: "resolved", value: { sessionId: "<session>" } };
    },
  },
  {
    surface: "send",
    async run(context) {
      return context.send(context.sessionId as string);
    },
  },
  {
    surface: "cancel",
    async run(context) {
      await context.client.cancel(context.sessionId as string);
      return { kind: "resolved" };
    },
  },
  {
    surface: "disconnect",
    async run(context) {
      await context.client.disconnect(context.alias);
      return { kind: "resolved" };
    },
  },
  {
    surface: "call after disconnect",
    async run(context) {
      const bots = await context.client.listBots(context.alias);
      return { kind: "resolved", value: shapeOfBots(bots) };
    },
  },
  {
    surface: "connect after disconnect",
    async run(context) {
      await context.client.connect(context.alias);
      return { kind: "resolved" };
    },
  },
  {
    surface: "connect an unknown host",
    async run(context) {
      try {
        await context.client.connect("bravo");
      } catch {
        // The wording of the error differs: the mock names the host, the relay
        // answers with a 404. Both refuse the host.
        return { kind: "rejected" };
      }
      return { kind: "resolved" };
    },
  },
  {
    surface: "list bots of an unknown host",
    async run(context) {
      try {
        const bots = await context.client.listBots("bravo");
        return { kind: "resolved", value: shapeOfBots(bots) };
      } catch {
        return { kind: "rejected" };
      }
    },
  },
];

/** Describes the bots of a host in a form both clients can be compared by. */
function shapeOfBots(bots: RemoteBot[]): Record<string, unknown> {
  return {
    count: bots.length,
    kinds: bots.map((bot) => bot.kind).sort(),
    lanes: bots.map((bot) => bot.lane).sort(),
    statuses: bots.map((bot) => bot.status).sort(),
    busy: bots.filter((bot) => bot.status === "busy").length,
    withSession: bots.filter((bot) => bot.sessionId !== null).length,
    withLease: bots.filter((bot) => bot.leaseExpiresAt !== null).length,
    quota: bots.map((bot) => bot.quotaUsedPct).sort((a, b) => a - b),
  };
}

/** Runs the steps against a client and returns the outcome of every step. */
async function runSteps(harness: Harness): Promise<Map<string, Outcome>> {
  const outcomes = new Map<string, Outcome>();
  const context: StepContext = { ...harness, sessionId: null };
  for (const step of STEPS) {
    outcomes.set(step.surface, await step.run(context));
  }
  return outcomes;
}

/** The steps of the contract that the allow list names. */
function allowedSteps(): string[] {
  return ALLOW_LIST.filter((entry) => STEPS.some((step) => step.surface === entry.surface))
    .map((entry) => entry.surface)
    .sort();
}

/** Calls a method of a client with the arguments the test needs. */
function call(client: BotdClient, name: string): Promise<unknown> {
  const argumentsOf: Record<string, unknown[]> = {
    listHosts: [],
    addHost: [{ alias: "beta" }],
    connect: ["alpha"],
    disconnect: ["alpha"],
    listBots: ["alpha"],
    cancel: ["session-1"],
    answerPermission: ["permission-1", true],
  };
  const method = (client as unknown as Record<string, (...values: unknown[]) => unknown>)[name];
  return Promise.resolve(method.apply(client, argumentsOf[name] ?? []));
}

/* --------------------------------------------------------------- the harnesses */

/** The mock client, with the fast clock of the tests. */
function mockHarness(): Harness {
  const client = new MockBotdClient({ hosts: [{ alias: "alpha", label: "first" }], stepMs: 5 });
  return {
    name: "mock",
    client,
    alias: "alpha",
    async openSession() {
      // The mock opens its session on the connect; there is nothing to ask for.
      const bots = await client.listBots("alpha");
      const busy = bots.find((bot) => bot.sessionId !== null);
      assert.ok(busy, "the mock runs a session on the host");
      return busy.sessionId as string;
    },
    async send() {
      return { kind: "unsupported" };
    },
  };
}

/** The real client, talking to the fake relay. */
function realHarness(relay: FakeRelay): Harness {
  const client = new RealBotdClient({ base: relay.base, reconnectDelayMs: 10, onError: () => {} });
  return {
    name: "real",
    client,
    alias: "alpha",
    async openSession() {
      const session = await client.openSession("alpha", { kind: "codex" });
      return session.sessionId;
    },
    async send(sessionId) {
      try {
        await client.send(sessionId, "hello");
      } catch {
        return { kind: "rejected" };
      }
      return { kind: "resolved" };
    },
  };
}

/* ---------------------------------------------------------------- the relay */

/** A session of the fake relay. */
interface FakeSession {
  id: string;
  host: string;
  botId: string;
  events: Array<{ id: number; data: BotEvent }>;
  listeners: Set<ServerResponse>;
  /** The permission the session waits for, if any. */
  permissionId: string | null;
  /** True while the session runs. */
  running: boolean;
}

/** The fake relay: the endpoints of client-ui/relay.mjs, in miniature. */
class FakeRelay {
  readonly server: Server;
  readonly hosts = new Map<string, RemoteHost>();
  readonly bots = new Map<string, RemoteBot[]>();
  readonly sessions = new Map<string, FakeSession>();
  /** The hosts that are connected. */
  readonly connected = new Set<string>();
  /** The base url of the relay. */
  base = "";
  #counter = 0;

  constructor() {
    this.server = createServer((request, response) => {
      void this.#handle(request, response);
    });
  }

  /** Starts the relay and returns its base url. */
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

  /** Adds a host with the bots the mock invents for it. */
  addHost(alias: string, label?: string): RemoteHost {
    const host: RemoteHost = label === undefined ? { alias } : { alias, label };
    this.hosts.set(alias, host);
    this.bots.set(alias, [
      makeBot(alias, 1, "codex", "gpt", "primary", "idle", 12),
      makeBot(alias, 2, "claude", "claude", "review", "idle", 35),
      makeBot(alias, 3, "dsh", "deepseek", "sandbox", "down", 58),
    ]);
    return host;
  }

  /** Writes an event to a session, the way the daemon hands one out. */
  push(sessionId: string, data: BotEvent): void {
    const session = this.sessions.get(sessionId);
    assert.ok(session, `the session ${sessionId} is unknown`);
    this.#push(session, data);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter((part) => part !== "");
    const method = request.method ?? "GET";
    let raw = "";
    for await (const chunk of request) raw += chunk;

    if (parts[0] !== "api") return this.#error(response, 404, "not_found", "Not found");

    if (parts[1] === "hosts" && parts.length === 2) {
      if (method === "GET") return this.#json(response, [...this.hosts.values()]);
      if (method === "POST") {
        const data = parseJson(raw);
        const alias = typeof data?.alias === "string" ? data.alias.trim() : "";
        if (alias === "") return this.#error(response, 400, "invalid_host", "Invalid host");
        if (this.hosts.has(alias)) {
          return this.#error(response, 409, "host_exists", `Host ${alias} already exists`);
        }
        return this.#json(response, this.addHost(alias));
      }
    }

    if (parts[1] === "hosts" && parts.length === 4) {
      const alias = decodeURIComponent(parts[2]);
      if (!this.hosts.has(alias)) {
        return this.#error(response, 404, "not_found", "Host not found");
      }
      if (parts[3] === "connect" && method === "POST") {
        // The relay starts the bots of the host; a session comes later.
        for (const bot of this.bots.get(alias) ?? []) bot.status = bot.sessionId ? "busy" : "idle";
        this.connected.add(alias);
        response.writeHead(204);
        response.end();
        return;
      }
      if (parts[3] === "disconnect" && method === "POST") {
        this.connected.delete(alias);
        for (const bot of this.bots.get(alias) ?? []) {
          bot.status = "down";
          bot.sessionId = null;
        }
        for (const session of this.sessions.values()) {
          if (session.host === alias) session.running = false;
        }
        response.writeHead(204);
        response.end();
        return;
      }
      if (parts[3] === "bots" && method === "GET") {
        return this.#json(response, this.bots.get(alias) ?? []);
      }
      if (parts[3] === "sessions" && method === "POST") {
        const data = parseJson(raw);
        const kind = typeof data?.kind === "string" ? data.kind : "";
        if (kind === "") return this.#error(response, 400, "invalid_body", "Invalid session request");
        if (!this.connected.has(alias)) {
          return this.#error(response, 409, "disconnected", `Host ${alias} is disconnected`);
        }
        const bot = (this.bots.get(alias) ?? []).find((entry) => entry.kind === kind);
        if (!bot) return this.#error(response, 400, "invalid_body", "Invalid session request");
        if (bot.sessionId) return this.#error(response, 409, "busy", `Bot on ${alias} is busy`);
        const session = this.openSession(alias, bot);
        return this.#json(response, { sessionId: session.id, botId: session.botId });
      }
    }

    if (parts[1] === "sessions" && parts.length === 4) {
      const id = decodeURIComponent(parts[2]);
      const session = this.sessions.get(id);
      if (!session) return this.#error(response, 404, "not_found", "Session not found");
      if (parts[3] === "send" && method === "POST") {
        const data = parseJson(raw);
        if (typeof data?.text !== "string") {
          return this.#error(response, 400, "invalid_body", "Invalid message");
        }
        if (!session.running) {
          return this.#error(response, 409, "session_ended", "Session is not running");
        }
        response.writeHead(204);
        response.end();
        return;
      }
      if (parts[3] === "cancel" && method === "POST") {
        if (!session.running) {
          return this.#error(response, 409, "session_ended", "Session is not running");
        }
        session.running = false;
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
        const last = Number(request.headers["last-event-id"] ?? 0);
        const from = Number.isFinite(last) ? last : 0;
        for (const item of session.events) {
          if (item.id > from) response.write(`id: ${item.id}\ndata: ${JSON.stringify(item.data)}\n\n`);
        }
        session.listeners.add(response);
        response.on("close", () => {
          session.listeners.delete(response);
        });
        return;
      }
    }

    if (parts[1] === "permissions" && parts.length === 3 && method === "POST") {
      const id = decodeURIComponent(parts[2]);
      const data = parseJson(raw);
      if (typeof data?.allow !== "boolean") {
        return this.#error(response, 400, "invalid_body", "Invalid permission answer");
      }
      const session = [...this.sessions.values()].find((entry) => entry.permissionId === id);
      if (!session) return this.#error(response, 404, "not_found", "Permission not found");
      session.permissionId = null;
      this.#answer(session, data.allow);
      response.writeHead(204);
      response.end();
      return;
    }

    this.#error(response, 404, "not_found", "Not found");
  }

  /** Opens a session and scripts the events it hands out. */
  openSession(alias: string, bot: RemoteBot): FakeSession {
    this.#counter += 1;
    const id = `session-${this.#counter}`;
    const session: FakeSession = {
      id,
      host: alias,
      botId: bot.id,
      events: [],
      listeners: new Set(),
      permissionId: null,
      running: true,
    };
    this.sessions.set(id, session);
    bot.status = "busy";
    bot.sessionId = id;
    const base = { sessionId: id, host: alias, botId: bot.id };
    this.#push(session, { ...base, kind: "text", text: "picked up the task" });
    this.#push(session, { ...base, kind: "tool", name: "read_file", status: "start" });
    this.#push(session, { ...base, kind: "tool", name: "read_file", status: "end", summary: "18 lines" });
    const permissionId = `${id}-permission-1`;
    session.permissionId = permissionId;
    this.#push(session, {
      ...base,
      kind: "permission",
      permissionId,
      title: "run the test suite?",
      detail: "npm test",
    });
    return session;
  }

  /** Answers the permission of a session, the way the relay does. */
  #answer(session: FakeSession, allow: boolean): void {
    const base = { sessionId: session.id, host: session.host, botId: session.botId };
    if (allow) {
      this.#push(session, { ...base, kind: "text", text: "test suite is green" });
      this.#push(session, { ...base, kind: "turn_end", status: "ok" });
      return;
    }
    this.#push(session, { ...base, kind: "turn_end", status: "cancelled" });
  }

  /** Keeps an event and writes it to the listeners of the session. */
  #push(session: FakeSession, data: BotEvent): void {
    const item = { id: session.events.length + 1, data };
    session.events.push(item);
    for (const listener of [...session.listeners]) {
      listener.write(`id: ${item.id}\ndata: ${JSON.stringify(data)}\n\n`);
    }
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

/** Builds a bot of a host, the way the mock invents them. */
function makeBot(
  alias: string,
  index: number,
  kind: BotKind,
  family: RemoteBot["family"],
  lane: string,
  status: RemoteBot["status"],
  quotaUsedPct: number,
): RemoteBot {
  return {
    id: `${alias}-bot-${index}`,
    host: alias,
    kind,
    family,
    lane,
    status,
    leaseExpiresAt: null,
    quotaUsedPct,
    sessionId: null,
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

/** Runs the body with a started fake relay and stops it afterwards. */
async function withRelay<T>(body: (relay: FakeRelay) => Promise<T>): Promise<T> {
  const relay = new FakeRelay();
  relay.addHost("alpha", "first");
  await relay.start();
  try {
    return await body(relay);
  } finally {
    await relay.stop();
  }
}

/** Waits until `predicate` holds or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the client");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/* --------------------------------------------------------------- the events */

/** Describes an event in a form both clients can be compared by. */
function normalizeEvent(event: BotEvent): Record<string, unknown> {
  const { sessionId, permissionId, ...rest } = event as BotEvent & { permissionId?: string };
  const normalized: Record<string, unknown> = { ...rest };
  if (permissionId !== undefined) normalized.permissionId = permissionId.split(sessionId).join("<session>");
  return normalized;
}

/** The kinds of the events the mock hands to the panel. */
async function mockEventKinds(): Promise<string[]> {
  const events = await mockSessionEvents();
  return [...new Set(events.map((event) => String(event.kind)))].sort();
}

/** The kinds of the events the real client hands to the panel. */
async function realEventKinds(relay: FakeRelay): Promise<string[]> {
  // An event the panel does not know is dropped by the client.
  const gossip = {
    kind: "gossip",
    sessionId: "session-1",
    host: "alpha",
    botId: "alpha-bot-1",
    text: "not an event of the interface",
  } as unknown as BotEvent;
  const events = await realSessionEvents(relay, gossip);
  return [...new Set(events.map((event) => String(event.kind)))].sort();
}

/** The events the mock hands to the panel for one scripted session. */
async function mockSessionEvents(): Promise<Array<Record<string, unknown>>> {
  const client = new MockBotdClient({ hosts: [{ alias: "alpha", label: "first" }], stepMs: 5 });
  await client.connect("alpha");
  const bots = await client.listBots("alpha");
  const busy = bots.find((bot) => bot.sessionId !== null);
  assert.ok(busy, "the mock runs a session on the host");
  const sessionId = busy.sessionId as string;

  const events: BotEvent[] = [];
  const unsubscribe = client.subscribe(sessionId, (event) => events.push(event));
  try {
    await waitFor(() => events.some((event) => event.kind === "permission"));
    const permission = events.find((event) => event.kind === "permission") as { permissionId: string };
    await client.answerPermission(permission.permissionId, true);
    await waitFor(() => events.some((event) => event.kind === "turn_end"));
  } finally {
    unsubscribe();
  }
  return events.map(normalizeEvent);
}

/** The events the real client hands to the panel for one scripted session. */
async function realSessionEvents(
  relay: FakeRelay,
  extra?: BotEvent,
): Promise<Array<Record<string, unknown>>> {
  const client = new RealBotdClient({ base: relay.base, reconnectDelayMs: 10, onError: () => {} });
  await client.connect("alpha");
  const session = await client.openSession("alpha", { kind: "codex" });
  if (extra) relay.push(session.sessionId, extra);

  const events: BotEvent[] = [];
  const unsubscribe = client.subscribe(session.sessionId, (event) => events.push(event));
  try {
    await waitFor(() => events.some((event) => event.kind === "permission"));
    const permission = events.find((event) => event.kind === "permission") as { permissionId: string };
    await client.answerPermission(permission.permissionId, true);
    await waitFor(() => events.some((event) => event.kind === "turn_end"));
  } finally {
    unsubscribe();
  }
  return events.map(normalizeEvent);
}

/* ---------------------------------------------------------------- the tests */

test("every member of the interface exists on both clients", () => {
  const members = readInterface(clientSource, "BotdClient");
  assert.equal(members.length, 8, "the interface of the panel is read from the source");
  for (const member of members) {
    for (const ctor of [MockBotdClient, RealBotdClient]) {
      assert.ok(member.name in ctor.prototype, `${ctor.name} has no member ${member.name}`);
    }
  }
});

test("the methods of the interface have the same arity on both clients", () => {
  const methods = readInterface(clientSource, "BotdClient").filter((member) => member.arity >= 0);
  assert.equal(methods.length, 8, "the interface of the panel has methods only");
  for (const method of methods) {
    const mock = MockBotdClient.prototype[method.name as keyof MockBotdClient] as Function;
    const real = RealBotdClient.prototype[method.name as keyof RealBotdClient] as Function;
    assert.equal(typeof mock, "function", `the mock has no method ${method.name}`);
    assert.equal(typeof real, "function", `the real client has no method ${method.name}`);
    assert.equal(mock.length, method.arity, `the mock method ${method.name} takes ${method.arity} parameters`);
    assert.equal(real.length, method.arity, `the real method ${method.name} takes ${method.arity} parameters`);
  }
});

test("the members beyond the interface are the ones of the allow list", () => {
  const allowed = allowEntry("extra members").extraMembers;
  assert.ok(allowed, "the allow list names the members of the clients");
  assert.deepEqual(extraMembers(MockBotdClient), allowed.mock);
  assert.deepEqual(extraMembers(RealBotdClient), allowed.real);
});

test("the methods of the interface return promises on both clients", async () => {
  const members = readInterface(clientSource, "BotdClient");
  const promised = members.filter((member) => member.returns.startsWith("Promise"));
  assert.equal(promised.length, 7, "seven methods of the interface return a promise");
  const others = members.filter((member) => !member.returns.startsWith("Promise"));
  assert.deepEqual(others.map((member) => member.name), ["subscribe"]);

  await withRelay(async (relay) => {
    const mock = new MockBotdClient({ hosts: [{ alias: "alpha" }], stepMs: 5 });
    const real = new RealBotdClient({ base: relay.base, onError: () => {} });
    for (const member of promised) {
      for (const client of [mock, real]) {
        const answer = call(client, member.name);
        assert.equal(typeof (answer as { then?: unknown }).then, "function", `${member.name} returns a promise`);
        await answer.catch(() => {});
      }
    }
    // The subscription of a session that does not exist is released right
    // away: a subscription that is not released keeps the runtime busy.
    const mockStop = mock.subscribe("session-1", () => {});
    assert.equal(typeof mockStop, "function", "subscribe returns a function");
    mockStop();
    const realStop = real.subscribe("session-1", () => {});
    assert.equal(typeof realStop, "function", "subscribe returns a function");
    realStop();
  });
});

test("the event names of both clients are the same set", async () => {
  const canonical = readEventKinds(clientSource);
  assert.deepEqual(canonical, ["permission", "text", "tool", "turn_end"]);
  const mock = await mockEventKinds();
  await withRelay(async (relay) => {
    const real = await realEventKinds(relay);
    assert.deepEqual(mock, canonical, "the mock hands the events of the interface to the panel");
    assert.deepEqual(real, canonical, "the real client hands the events of the interface to the panel");
  });
});

test("the contract table behaves alike on both clients", async () => {
  const mock = await runSteps(mockHarness());
  const real = await withRelay((relay) => runSteps(realHarness(relay)));
  const allowed = new Set(ALLOW_LIST.map((entry) => entry.surface));

  const unexpected: string[] = [];
  const intended: string[] = [];
  for (const step of STEPS) {
    const left = mock.get(step.surface);
    const right = real.get(step.surface);
    if (isDeepStrictEqual(left, right)) continue;
    if (allowed.has(step.surface)) {
      intended.push(step.surface);
      continue;
    }
    unexpected.push(
      `${step.surface}: the mock answers ${JSON.stringify(left)}, the real client ${JSON.stringify(right)}`,
    );
  }
  assert.deepEqual(unexpected, [], "the clients differ in a step that is not in the allow list");
  assert.deepEqual(
    intended.sort(),
    allowedSteps(),
    "the clients differ in the steps of the allow list and in no other",
  );
});

test("the allow list is up to date", async () => {
  const known = new Set([...STEPS.map((step) => step.surface), "extra members"]);
  for (const entry of ALLOW_LIST) {
    assert.ok(entry.reason.trim().length > 0, `the allow list entry for ${entry.surface} has no reason`);
    assert.ok(entry.mock.trim().length > 0, `the allow list entry for ${entry.surface} does not say what the mock does`);
    assert.ok(entry.real.trim().length > 0, `the allow list entry for ${entry.surface} does not say what the real client does`);
    assert.ok(known.has(entry.surface), `the allow list names an unknown surface ${entry.surface}`);
  }

  const mock = await runSteps(mockHarness());
  const real = await withRelay((relay) => runSteps(realHarness(relay)));
  const stale: string[] = [];
  for (const entry of ALLOW_LIST) {
    if (!STEPS.some((step) => step.surface === entry.surface)) continue;
    if (isDeepStrictEqual(mock.get(entry.surface), real.get(entry.surface))) {
      stale.push(entry.surface);
    }
  }
  assert.deepEqual(stale, [], "the allow list names a difference the clients do not have any more");
});

test("the same scripted session hands the same events to the panel", async () => {
  const mock = await mockSessionEvents();
  await withRelay(async (relay) => {
    const real = await realSessionEvents(relay);
    assert.deepEqual(real, mock, "the two clients hand the same events to the panel");
  });
});
