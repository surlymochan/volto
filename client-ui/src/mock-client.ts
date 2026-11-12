// volto client UI: an in-memory BotdClient that fakes a daemon.
//
// The mock exists so the panel can be developed (and smoke tested) without a
// daemon: hosts and bots are invented, and a running task produces a small
// scripted sequence of normalized events with timers.
//
// Everything invented here is synthetic. No real host names, addresses or
// credentials appear in this file.

import type {
  BotEvent,
  BotKind,
  BotdClient,
  ModelFamily,
  RemoteBot,
  RemoteHost,
  Unsubscribe,
} from "./client.ts";

/** Options for the mock client. */
export interface MockClientOptions {
  /** Hosts the mock starts with. */
  hosts?: RemoteHost[];
  /** Milliseconds between two simulated events of a task. */
  stepMs?: number;
}

/** A task the mock is running for a bot. */
interface MockSession {
  id: string;
  host: string;
  botId: string;
  events: BotEvent[];
  listeners: Set<(event: BotEvent) => void>;
  timers: Set<ReturnType<typeof setTimeout>>;
  pendingPermission: string | null;
  finished: boolean;
}

const KINDS: BotKind[] = ["codex", "claude", "dsh"];

const FAMILY_OF: Record<BotKind, ModelFamily> = {
  codex: "gpt",
  claude: "claude",
  dsh: "deepseek",
  pi: "other",
  agy: "gemini",
  copilot: "gpt",
};

const LANES = ["primary", "review", "sandbox"];

/** Lease length of a busy bot, in milliseconds. */
const LEASE_MS = 300_000;

/** A BotdClient that simulates a daemon with timers. */
export class MockBotdClient implements BotdClient {
  #hosts = new Map<string, RemoteHost>();
  #bots = new Map<string, RemoteBot[]>();
  #sessions = new Map<string, MockSession>();
  #connected = new Set<string>();
  #stepMs: number;
  #sessionCounter = 0;

  constructor(options: MockClientOptions = {}) {
    this.#stepMs = options.stepMs ?? 300;
    for (const host of options.hosts ?? []) {
      this.#hosts.set(host.alias, { ...host });
      this.#bots.set(host.alias, this.#makeBots(host.alias));
    }
  }

  async listHosts(): Promise<RemoteHost[]> {
    return [...this.#hosts.values()].map((host) => ({ ...host }));
  }

  async addHost(input: { alias: string; label?: string }): Promise<RemoteHost> {
    const alias = input.alias.trim();
    if (alias.length === 0) throw new Error("an ssh alias is required");
    if (this.#hosts.has(alias)) throw new Error(`host "${alias}" is already known`);
    const host: RemoteHost = { alias, label: input.label?.trim() || undefined };
    this.#hosts.set(alias, host);
    this.#bots.set(alias, this.#makeBots(alias));
    return { ...host };
  }

  async connect(alias: string): Promise<void> {
    if (!this.#hosts.has(alias)) throw new Error(`unknown host "${alias}"`);
    this.#connected.add(alias);
    const bots = this.#bots.get(alias) ?? [];
    const worker = bots.find((bot) => bot.status !== "down");
    if (worker && worker.sessionId === null) this.#startTask(worker);
  }

  async disconnect(alias: string): Promise<void> {
    this.#connected.delete(alias);
    for (const session of this.#sessions.values()) {
      if (session.host === alias) this.#stopTask(session, false);
    }
    const bots = this.#bots.get(alias) ?? [];
    for (const bot of bots) {
      if (bot.status === "busy") {
        bot.status = "idle";
        bot.sessionId = null;
        bot.leaseExpiresAt = null;
      }
    }
  }

  async listBots(alias: string): Promise<RemoteBot[]> {
    return (this.#bots.get(alias) ?? []).map((bot) => ({ ...bot }));
  }

  subscribe(sessionId: string, onEvent: (event: BotEvent) => void): Unsubscribe {
    const session = this.#sessions.get(sessionId);
    if (!session) return () => {};
    for (const event of session.events) onEvent(event);
    session.listeners.add(onEvent);
    return () => {
      session.listeners.delete(onEvent);
    };
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session || session.finished) return;
    this.#stopTask(session, true);
  }

  async answerPermission(permissionId: string, allow: boolean): Promise<void> {
    for (const session of this.#sessions.values()) {
      if (session.pendingPermission !== permissionId) continue;
      session.pendingPermission = null;
      if (allow) {
        this.#schedule(session, this.#stepMs, () => {
          this.#emit(session, {
            kind: "text",
            sessionId: session.id,
            host: session.host,
            botId: session.botId,
            text: "test suite is green",
          });
          this.#schedule(session, this.#stepMs, () => {
            this.#emit(session, {
              kind: "turn_end",
              sessionId: session.id,
              host: session.host,
              botId: session.botId,
              status: "ok",
            });
            this.#finish(session);
          });
        });
      } else {
        this.#schedule(session, this.#stepMs, () => {
          this.#emit(session, {
            kind: "turn_end",
            sessionId: session.id,
            host: session.host,
            botId: session.botId,
            status: "cancelled",
          });
          this.#finish(session);
        });
      }
      return;
    }
  }

  #makeBots(alias: string): RemoteBot[] {
    return KINDS.map((kind, index) => ({
      id: `${alias}-bot-${index + 1}`,
      host: alias,
      kind,
      family: FAMILY_OF[kind],
      lane: LANES[index],
      status: index === 2 ? "down" : "idle",
      leaseExpiresAt: null,
      quotaUsedPct: 12 + index * 23,
      sessionId: null,
    }));
  }

  #startTask(bot: RemoteBot): void {
    this.#sessionCounter += 1;
    const session: MockSession = {
      id: `${bot.host}-session-${this.#sessionCounter}`,
      host: bot.host,
      botId: bot.id,
      events: [],
      listeners: new Set(),
      timers: new Set(),
      pendingPermission: null,
      finished: false,
    };
    this.#sessions.set(session.id, session);
    bot.status = "busy";
    bot.sessionId = session.id;
    bot.leaseExpiresAt = Date.now() + LEASE_MS;
    bot.quotaUsedPct = Math.min(99, bot.quotaUsedPct + 4);

    this.#emit(session, {
      kind: "text",
      sessionId: session.id,
      host: session.host,
      botId: session.botId,
      text: "picked up the task",
    });
    this.#schedule(session, this.#stepMs, () => {
      this.#emit(session, {
        kind: "tool",
        sessionId: session.id,
        host: session.host,
        botId: session.botId,
        name: "read_file",
        status: "start",
      });
    });
    this.#schedule(session, this.#stepMs * 2, () => {
      this.#emit(session, {
        kind: "tool",
        sessionId: session.id,
        host: session.host,
        botId: session.botId,
        name: "read_file",
        status: "end",
        summary: "18 lines",
      });
    });
    this.#schedule(session, this.#stepMs * 3, () => {
      const permissionId = `${session.id}-permission-1`;
      session.pendingPermission = permissionId;
      this.#emit(session, {
        kind: "permission",
        sessionId: session.id,
        host: session.host,
        botId: session.botId,
        permissionId,
        title: "run the test suite?",
        detail: "npm test",
      });
    });
  }

  #schedule(session: MockSession, delay: number, action: () => void): void {
    const timer = setTimeout(() => {
      session.timers.delete(timer);
      if (session.finished) return;
      action();
    }, delay);
    session.timers.add(timer);
  }

  #emit(session: MockSession, event: BotEvent): void {
    session.events.push(event);
    for (const listener of [...session.listeners]) listener(event);
  }

  #stopTask(session: MockSession, cancelled: boolean): void {
    for (const timer of session.timers) clearTimeout(timer);
    session.timers.clear();
    session.pendingPermission = null;
    if (cancelled) {
      this.#emit(session, {
        kind: "turn_end",
        sessionId: session.id,
        host: session.host,
        botId: session.botId,
        status: "cancelled",
      });
    }
    this.#finish(session);
  }

  #finish(session: MockSession): void {
    session.finished = true;
    for (const timer of session.timers) clearTimeout(timer);
    session.timers.clear();
    const bots = this.#bots.get(session.host) ?? [];
    const bot = bots.find((entry) => entry.id === session.botId);
    if (bot) {
      bot.status = "idle";
      bot.sessionId = null;
      bot.leaseExpiresAt = null;
    }
  }
}
