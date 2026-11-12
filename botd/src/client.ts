// volto — botd client (controller side).
//
// Speaks the botd NDJSON frame protocol: one JSON object per line.
//
//   client -> botd : hello, renew, open, send, cancel, ack, close, resume
//   botd  -> client: event, state, error, gap, stall
//
// The transport is injectable so the controller can be driven by an in-process
// fake botd during tests. The default transport shells out to
// `ssh -o BatchMode=yes -o ServerAliveInterval=15 <hostAlias> botd serve`;
// machines are always referenced by alias, never by name, address or secret.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { NormalizedEvent } from "./adapter-types.ts";

/** Wires the client to a botd instance. */
export interface BotdTransport {
  /** Frames written by the client. */
  stdin: Writable;
  /** Frames read by the client. */
  stdout: Readable;
  /** Tear the transport down (kill the ssh child, close the pipes). */
  kill(): void;
}

/** Creates a fresh transport; called once per connection attempt. */
export type TransportFactory = () => BotdTransport;

/** Opaque timer handle returned by a {@link Clock}. */
export type TimerHandle = unknown;

/** Injectable clock, so tests can drive renew/cancel/ack timers. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Events handed to a session consumer. */
export type ClientEvent =
  | NormalizedEvent
  | { kind: "gap"; from?: number; to?: number; message?: string }
  | { kind: "stall"; reason?: string };

/** Parameters accepted by `open`. */
export interface OpenParams {
  cwd?: string;
  model?: string;
  effort?: string;
  systemPrompt?: string;
  providerSessionId?: string;
  [key: string]: unknown;
}

/** A live botd session. */
export interface BotdSession {
  /** Session id used on the wire. */
  readonly sid: string;
  /** Last state reported by botd. */
  readonly state: string;
  /** Async iterator over the session events. */
  events(): AsyncIterableIterator<ClientEvent>;
  /** Send a message to the session. */
  send(message: unknown): void;
  /** Cancel the session; resolves true once botd reports exited/idle. */
  cancel(): Promise<boolean>;
  /** Close the session. */
  close(): void;
}

/** Reconnect backoff bounds. */
export interface BackoffOptions {
  /** Delay of the first reconnect attempt. */
  baseMs: number;
  /** Upper bound of the delay. */
  maxMs: number;
  /** Relative jitter applied to the delay (0 disables jitter). */
  jitter: number;
}

export interface BotdClientOptions {
  /** ssh alias of the machine running `botd serve`. */
  hostAlias: string;
  /** Transport factory; defaults to {@link sshTransport}. */
  transport?: TransportFactory;
  /** Clock used for every timer; defaults to the system clock. */
  clock?: Clock;
  /** Jitter source in [0,1); defaults to Math.random. */
  random?: () => number;
  /** Flush pending acks after this many events. */
  ackBatchSize?: number;
  /** Flush pending acks after this many milliseconds. */
  ackIntervalMs?: number;
  /** How long `cancel` waits for an exited/idle state. */
  cancelTimeoutMs?: number;
  /** How long a fresh connection waits for the hello handshake. */
  handshakeTimeoutMs?: number;
  /** How long `open` waits for the daemon to accept the session. */
  openTimeoutMs?: number;
  /** Reconnect backoff bounds. */
  backoff?: Partial<BackoffOptions>;
  /** Protocol version announced in hello. */
  protocol?: number;
  /** Optional token forwarded to botd in hello. */
  token?: string;
  /** Optional client identifier forwarded to botd in hello. */
  clientId?: string;
  /** Session id factory; defaults to a random uuid. */
  sidFactory?: () => string;
  /** Unit of the ttl announced by botd. */
  ttlUnit?: "ms" | "s" | "auto";
}

const DEFAULT_ACK_BATCH_SIZE = 20;
const DEFAULT_ACK_INTERVAL_MS = 500;
const DEFAULT_CANCEL_TIMEOUT_MS = 15_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_OPEN_TIMEOUT_MS = 30_000;
const DEFAULT_PROTOCOL = 1;

/** Reconnect backoff: 1s, doubling, capped at 30s, with jitter. */
export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1_000, maxMs: 30_000, jitter: 0.2 };

/** States after which a session is finished. */
const TERMINAL_STATES = new Set(["exited", "closed", "done", "failed", "error"]);

/** States that mean the session is no longer running. */
const IDLE_STATES = new Set(["exited", "idle", "closed", "done"]);

/** Frame keys that belong to the envelope rather than to the event payload. */
const ENVELOPE_KEYS = new Set(["type", "t", "frame", "sid", "session", "seq", "ts", "time", "timestamp"]);

/** The system clock, used when no clock is injected. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: TimerHandle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Delay of the n-th reconnect attempt (1-based): exponential growth from
 * `baseMs`, capped at `maxMs`, with symmetric relative jitter.
 */
export function backoffDelay(attempt: number, options: BackoffOptions, random: () => number): number {
  const step = Math.max(1, Math.floor(attempt));
  const raw = options.baseMs * Math.pow(2, step - 1);
  const factor = 1 - options.jitter + random() * 2 * options.jitter;
  return Math.min(options.maxMs, Math.max(options.baseMs, raw * factor));
}

/** Default transport: `ssh ... <hostAlias> botd serve`. */
export function sshArgs(hostAlias: string): string[] {
  return ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", hostAlias, "botd", "serve"];
}

/** Default transport: `ssh ... <hostAlias> botd serve`. */
export function sshTransport(hostAlias: string): BotdTransport {
  const child = spawn("ssh", sshArgs(hostAlias), { stdio: ["pipe", "pipe", "pipe"] });
  return {
    stdin: child.stdin as unknown as Writable,
    stdout: child.stdout as unknown as Readable,
    kill: () => {
      child.kill("SIGTERM");
    },
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** Frame discriminator; `type` wins, the aliases exist for tolerance. */
function frameType(frame: Record<string, unknown>): string {
  const value = frame.type ?? frame.t ?? frame.frame ?? frame.kind;
  return typeof value === "string" ? value.toLowerCase() : "";
}

/** Session id of a frame; `sid` wins, `session` is accepted as an alias. */
function readSid(frame: Record<string, unknown>): string | undefined {
  return readString(frame.sid) ?? readString(frame.session);
}

/** Unwraps the event payload carried by an event frame. */
function extractEventPayload(frame: Record<string, unknown>): ClientEvent {
  const nested = frame.event;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as ClientEvent;
  }
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frame)) {
    if (ENVELOPE_KEYS.has(key)) continue;
    payload[key] = value;
  }
  if (typeof payload.kind !== "string") payload.kind = "raw";
  return payload as ClientEvent;
}

interface SessionRecord {
  sid: string;
  state: string;
  /** Highest sequence number acknowledged to botd. */
  lastAckedSeq: number;
  /** Highest sequence number handed to the consumer. */
  lastDeliveredSeq: number;
  /** Highest sequence number received but not acknowledged yet. */
  pendingAckSeq: number | null;
  queue: ClientEvent[];
  waiters: Array<(result: IteratorResult<ClientEvent, undefined>) => void>;
  finished: boolean;
  open?: { resolve: () => void; reject: (err: Error) => void; timer: TimerHandle | null };
  cancel?: { resolve: (ok: boolean) => void; timer: TimerHandle | null };
}

/**
 * Controller side of the botd protocol.
 *
 * Emits: `connected`, `disconnected`, `reconnect`, `state`, `gap`, `stall`,
 * `fence` and `error`.
 */
export class BotdClient extends EventEmitter {
  readonly hostAlias: string;

  #transportFactory: TransportFactory;
  #clock: Clock;
  #random: () => number;
  #ackBatchSize: number;
  #ackIntervalMs: number;
  #cancelTimeoutMs: number;
  #handshakeTimeoutMs: number;
  #openTimeoutMs: number;
  #backoff: BackoffOptions;
  #protocol: number;
  #token?: string;
  #clientId?: string;
  #sidFactory: () => string;
  #ttlUnit: "ms" | "s" | "auto";

  #transport: BotdTransport | null = null;
  #connected = false;
  #stopping = false;
  #started = false;
  #startPromise: Promise<void> | null = null;
  #startResolve: (() => void) | null = null;
  #startReject: ((err: Error) => void) | null = null;
  #connectWaiters: Array<() => void> = [];

  #attempt = 0;
  #reconnectTimer: TimerHandle | null = null;
  #handshakeTimer: TimerHandle | null = null;
  #handshake: { resolve: () => void; reject: (err: Error) => void } | null = null;
  #buffer = "";

  #fence: number | null = null;
  #ttlMs: number | null = null;
  #renewTimer: TimerHandle | null = null;

  #ackTimer: TimerHandle | null = null;
  #ackCount = 0;

  #sessions = new Map<string, SessionRecord>();

  constructor(options: BotdClientOptions) {
    super();
    this.hostAlias = options.hostAlias;
    this.#transportFactory = options.transport ?? (() => sshTransport(options.hostAlias));
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? Math.random;
    this.#ackBatchSize = options.ackBatchSize ?? DEFAULT_ACK_BATCH_SIZE;
    this.#ackIntervalMs = options.ackIntervalMs ?? DEFAULT_ACK_INTERVAL_MS;
    this.#cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.#backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.#protocol = options.protocol ?? DEFAULT_PROTOCOL;
    this.#token = options.token;
    this.#clientId = options.clientId;
    this.#sidFactory = options.sidFactory ?? (() => randomUUID());
    this.#ttlUnit = options.ttlUnit ?? "auto";
  }

  /** True while a transport is up. */
  get connected(): boolean {
    return this.#connected;
  }

  /** Fence observed on the wire, if any. */
  get fence(): number | null {
    return this.#fence;
  }

  /** Lease ttl in milliseconds, if botd announced one. */
  get ttlMs(): number | null {
    return this.#ttlMs;
  }

  /** Connects and keeps the connection alive; resolves on the first handshake. */
  start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    this.#started = true;
    this.#startPromise = new Promise<void>((resolve, reject) => {
      this.#startResolve = resolve;
      this.#startReject = reject;
    });
    void this.#connect();
    return this.#startPromise;
  }

  /** Opens a session and waits until botd accepts it. */
  async open(params: OpenParams = {}): Promise<BotdSession> {
    await this.#ensureStarted();
    await this.#whenConnected();
    if (this.#stopping) throw new Error("botd: client stopped");
    const sid = this.#sidFactory();
    const record: SessionRecord = {
      sid,
      state: "opening",
      lastAckedSeq: 0,
      lastDeliveredSeq: 0,
      pendingAckSeq: null,
      queue: [],
      waiters: [],
      finished: false,
    };
    this.#sessions.set(sid, record);
    const opened = new Promise<void>((resolve, reject) => {
      record.open = {
        resolve: () => resolve(),
        reject: (err: Error) => reject(err),
        timer: this.#clock.setTimeout(() => {
          const pending = record.open;
          record.open = undefined;
          pending?.reject(new Error("botd: open timeout"));
        }, this.#openTimeoutMs),
      };
    });
    this.#writeFrame({ type: "open", sid, ...params });
    try {
      await opened;
    } catch (err) {
      this.#sessions.delete(record.sid);
      throw err;
    }
    return this.#sessionHandle(record);
  }

  /** Sends a message to an open session. */
  send(sid: string, message: unknown): void {
    this.#writeFrame({ type: "send", sid, message });
  }

  /**
   * Cancels a session. Resolves true once botd reports an exited/idle state,
   * false when the session did not settle within the cancel timeout.
   */
  async cancel(sid: string): Promise<boolean> {
    const record = this.#sessions.get(sid);
    if (!record) return false;
    if (IDLE_STATES.has(record.state)) return true;
    // The waiter is armed before the frame goes out: a fast daemon may
    // answer while the frame is still being written.
    const settled = new Promise<boolean>((resolve) => {
      record.cancel = {
        resolve,
        timer: this.#clock.setTimeout(() => {
          const pending = record.cancel;
          record.cancel = undefined;
          pending?.resolve(false);
          this.emit("cancel-timeout", { sid });
        }, this.#cancelTimeoutMs),
      };
    });
    this.#writeFrame({ type: "cancel", sid });
    return settled;
  }

  /** Closes a session. */
  close(sid: string): void {
    this.#writeFrame({ type: "close", sid });
    const record = this.#sessions.get(sid);
    if (record) this.#finishSession(record);
  }

  /** Stops the client, closing the transport and every session. */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#clearTimer("reconnect");
    this.#clearTimer("handshake");
    this.#clearTimer("renew");
    this.#clearTimer("ack");
    const error = new Error("botd: client stopped");
    for (const record of this.#sessions.values()) {
      if (record.open) {
        const pending = record.open;
        record.open = undefined;
        if (pending.timer !== null) this.#clock.clearTimeout(pending.timer);
        pending.reject(error);
      }
      if (record.cancel) {
        const pending = record.cancel;
        record.cancel = undefined;
        if (pending.timer !== null) this.#clock.clearTimeout(pending.timer);
        pending.resolve(false);
      }
      this.#finishSession(record);
    }
    this.#sessions.clear();
    this.#teardownTransport();
    const waiters = this.#connectWaiters;
    this.#connectWaiters = [];
    for (const waiter of waiters) waiter();
    if (this.#startReject) {
      const reject = this.#startReject;
      this.#startResolve = null;
      this.#startReject = null;
      reject(error);
    }
  }

  // -- connection lifecycle -------------------------------------------------

  async #ensureStarted(): Promise<void> {
    if (!this.#started) {
      await this.start();
      return;
    }
    if (this.#startPromise) await this.#startPromise;
  }

  #whenConnected(): Promise<void> {
    if (this.#connected) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#connectWaiters.push(resolve);
    });
  }

  async #connect(): Promise<void> {
    if (this.#stopping) return;
    try {
      await this.#connectOnce();
    } catch (err) {
      if (this.#stopping) return;
      this.#emitError(err instanceof Error ? err : new Error(String(err)));
      this.#scheduleReconnect(err instanceof Error ? err.message : String(err));
      return;
    }
    this.#attempt = 0;
    this.#connected = true;
    if (this.#startResolve) {
      const resolve = this.#startResolve;
      this.#startResolve = null;
      this.#startReject = null;
      resolve();
    }
    const waiters = this.#connectWaiters;
    this.#connectWaiters = [];
    for (const waiter of waiters) waiter();
    this.emit("connected", { hostAlias: this.hostAlias });
    this.#sendResumes();
  }

  #connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        this.#clearTimer("handshake");
        this.#handshake = null;
        if (err) reject(err);
        else resolve();
      };
      let transport: BotdTransport;
      try {
        transport = this.#transportFactory();
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.#transport = transport;
      this.#buffer = "";
      transport.stdout.on("data", (chunk: unknown) => this.#onData(chunk));
      transport.stdout.on("end", () => this.#onTransportClosed("stdout end"));
      transport.stdout.on("close", () => this.#onTransportClosed("stdout close"));
      transport.stdout.on("error", (err: Error) => this.#onTransportError(err));
      transport.stdin.on("error", (err: Error) => this.#onTransportError(err));
      this.#handshake = {
        resolve: () => finish(),
        reject: (err: Error) => finish(err),
      };
      this.#handshakeTimer = this.#clock.setTimeout(() => {
        this.#scheduleReconnect("handshake timeout");
        this.#teardownTransport();
        finish(new Error("botd: handshake timeout"));
      }, this.#handshakeTimeoutMs);
      this.#writeFrame({
        type: "hello",
        protocol: this.#protocol,
        fence: this.#fence,
        ...(this.#clientId ? { client: this.#clientId } : {}),
        ...(this.#token ? { token: this.#token } : {}),
      });
    });
  }

  #scheduleReconnect(reason: string): void {
    if (this.#stopping) return;
    if (this.#reconnectTimer !== null) return;
    this.#attempt += 1;
    const delay = backoffDelay(this.#attempt, this.#backoff, this.#random);
    this.emit("reconnect", { attempt: this.#attempt, delayMs: delay, reason });
    this.#reconnectTimer = this.#clock.setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connect();
    }, delay);
  }

  #onTransportClosed(reason: string): void {
    if (this.#stopping) return;
    if (!this.#transport) return;
    const wasConnected = this.#connected;
    this.#connected = false;
    this.#teardownTransport();
    if (this.#handshake) {
      const handshake = this.#handshake;
      this.#handshake = null;
      handshake.reject(new Error(`botd: transport closed (${reason})`));
    }
    if (wasConnected) this.emit("disconnected", { reason });
    this.#scheduleReconnect(reason);
  }

  #onTransportError(err: Error): void {
    if (this.#stopping) return;
    if (!this.#transport) return;
    this.#emitError(err);
    this.#onTransportClosed(`transport error: ${err.message}`);
  }

  #teardownTransport(): void {
    const transport = this.#transport;
    this.#transport = null;
    if (!transport) return;
    try {
      transport.kill();
    } catch {
      // the transport is going away anyway
    }
  }

  // -- wire -----------------------------------------------------------------

  #writeFrame(frame: Record<string, unknown>): void {
    const transport = this.#transport;
    if (!transport) return;
    let line: string;
    try {
      line = JSON.stringify(frame);
    } catch {
      return;
    }
    try {
      transport.stdin.write(line + "\n");
    } catch (err) {
      this.#emitError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  #onData(chunk: unknown): void {
    this.#buffer += typeof chunk === "string" ? chunk : String(chunk);
    let index = this.#buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length > 0) this.#handleLine(line);
      index = this.#buffer.indexOf("\n");
    }
  }

  #handleLine(line: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.#emitError(new Error("botd: malformed frame"));
      return;
    }
    if (!frame || typeof frame !== "object") return;
    // Any inbound frame completes the hello handshake.
    if (this.#handshake) {
      const handshake = this.#handshake;
      this.#handshake = null;
      handshake.resolve();
    }
    this.#noteFence(frame.fence);
    this.#noteTtl(frame.ttl);
    this.#handleFrame(frame);
  }

  #handleFrame(frame: Record<string, unknown>): void {
    const type = frameType(frame);
    switch (type) {
      case "event":
        this.#handleEvent(frame);
        return;
      case "state":
        this.#handleState(frame);
        return;
      case "error":
        this.#handleError(frame);
        return;
      case "gap":
        this.#handleGap(frame);
        return;
      case "stall":
        this.#handleStall(frame);
        return;
      default:
        break;
    }
    // Frames without an explicit discriminator but carrying a sequence number
    // are treated as events.
    if (readNumber(frame.seq) !== undefined) this.#handleEvent(frame);
  }

  #handleEvent(frame: Record<string, unknown>): void {
    const sid = readSid(frame);
    if (!sid) return;
    const record = this.#findSession(sid);
    if (!record) return;
    const seq = readNumber(frame.seq);
    if (seq === undefined) {
      this.#pushEvent(record, extractEventPayload(frame));
      return;
    }
    if (seq > record.lastDeliveredSeq) {
      record.lastDeliveredSeq = seq;
      this.#pushEvent(record, extractEventPayload(frame));
    }
    if (seq > record.lastAckedSeq) {
      record.pendingAckSeq = record.pendingAckSeq === null ? seq : Math.max(record.pendingAckSeq, seq);
    }
    this.#ackCount += 1;
    if (this.#ackCount >= this.#ackBatchSize) this.#flushAcks();
    else this.#scheduleAckFlush();
  }

  #handleState(frame: Record<string, unknown>): void {
    const sid = readSid(frame);
    const state = (readString(frame.state) ?? readString(frame.status) ?? "").toLowerCase();
    this.emit("state", { sid, state });
    if (!sid) return;
    const record = this.#findSession(sid);
    if (!record) return;
    if (state.length > 0) record.state = state;
    if (record.open && !TERMINAL_STATES.has(state)) {
      const pending = record.open;
      record.open = undefined;
      if (pending.timer !== null) this.#clock.clearTimeout(pending.timer);
      pending.resolve();
    }
    if (record.cancel && IDLE_STATES.has(state)) {
      const pending = record.cancel;
      record.cancel = undefined;
      if (pending.timer !== null) this.#clock.clearTimeout(pending.timer);
      pending.resolve(true);
    }
    if (TERMINAL_STATES.has(state)) this.#finishSession(record);
  }

  #handleError(frame: Record<string, unknown>): void {
    const message = readString(frame.message) ?? readString(frame.error) ?? "botd error";
    const sid = readSid(frame);
    const error = new Error(message);
    if (sid) {
      const record = this.#findSession(sid);
      if (record) {
        if (record.open) {
          const pending = record.open;
          record.open = undefined;
          if (pending.timer !== null) this.#clock.clearTimeout(pending.timer);
          pending.reject(error);
        }
        if (record.cancel) {
          const pending = record.cancel;
          record.cancel = undefined;
          if (pending.timer !== null) this.#clock.clearTimeout(pending.timer);
          pending.resolve(false);
        }
        this.#pushEvent(record, { kind: "error", message });
        return;
      }
    }
    this.#emitError(error);
  }

  #handleGap(frame: Record<string, unknown>): void {
    const sid = readSid(frame);
    const from = readNumber(frame.from ?? frame.fromSeq);
    const to = readNumber(frame.to ?? frame.toSeq);
    const message = readString(frame.message);
    const gap: ClientEvent = {
      kind: "gap",
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(message !== undefined ? { message } : {}),
    };
    this.emit("gap", { sid, from, to });
    if (!sid) return;
    const record = this.#findSession(sid);
    if (record) this.#pushEvent(record, gap);
  }

  #handleStall(frame: Record<string, unknown>): void {
    const sid = readSid(frame);
    const reason = readString(frame.reason) ?? readString(frame.message);
    this.emit("stall", { sid, reason });
    if (!sid) return;
    const record = this.#findSession(sid);
    if (record) record.state = "stalled";
  }

  // -- fence / lease --------------------------------------------------------

  #noteFence(value: unknown): void {
    const fence = readNumber(value);
    if (fence === undefined) return;
    if (this.#fence !== null && fence > this.#fence) {
      this.#fence = fence;
      this.#handleFenceConflict(fence);
      return;
    }
    this.#fence = fence;
  }

  #handleFenceConflict(fence: number): void {
    const error = new Error(`botd: fence advanced to ${fence}; stopping sessions`);
    for (const record of this.#sessions.values()) {
      if (record.open) {
        const pending = record.open;
        record.open = undefined;
        if (pending.timer !== null) this.#clock.clearTimeout(pending.timer);
        pending.reject(error);
      }
      if (record.cancel) {
        const pending = record.cancel;
        record.cancel = undefined;
        if (pending.timer !== null) this.#clock.clearTimeout(pending.timer);
        pending.resolve(false);
      }
      this.#pushEvent(record, { kind: "error", message: error.message });
      this.#finishSession(record);
    }
    this.#sessions.clear();
    this.emit("fence", { fence });
    this.#emitError(error);
  }

  #noteTtl(value: unknown): void {
    const ttl = readNumber(value);
    if (ttl === undefined || ttl <= 0) return;
    let ms = ttl;
    if (this.#ttlUnit === "s") ms = ttl * 1000;
    else if (this.#ttlUnit === "auto" && ttl < 1000) ms = ttl * 1000;
    if (this.#ttlMs === ms) return;
    this.#ttlMs = ms;
    this.#armRenew();
  }

  #armRenew(): void {
    this.#clearTimer("renew");
    if (this.#ttlMs === null || this.#stopping) return;
    const interval = Math.max(1, Math.round(this.#ttlMs / 3));
    const tick = () => {
      this.#renewTimer = null;
      this.#sendRenews();
      if (!this.#stopping) this.#armRenew();
    };
    this.#renewTimer = this.#clock.setTimeout(tick, interval);
  }

  /** Asks botd to replay the events of every open session. */
  #sendResumes(): void {
    for (const record of this.#sessions.values()) {
      if (TERMINAL_STATES.has(record.state)) continue;
      this.#writeFrame({ type: "resume", sid: record.sid, fromSeq: record.lastAckedSeq + 1 });
    }
  }

  #sendRenews(): void {
    for (const record of this.#sessions.values()) {
      if (TERMINAL_STATES.has(record.state)) continue;
      this.#writeFrame({ type: "renew", sid: record.sid });
    }
  }

  // -- acks -----------------------------------------------------------------

  #scheduleAckFlush(): void {
    if (this.#ackTimer !== null) return;
    this.#ackTimer = this.#clock.setTimeout(() => {
      this.#ackTimer = null;
      this.#flushAcks();
    }, this.#ackIntervalMs);
  }

  #flushAcks(): void {
    this.#clearTimer("ack");
    for (const record of this.#sessions.values()) {
      if (record.pendingAckSeq === null) continue;
      const seq = record.pendingAckSeq;
      record.pendingAckSeq = null;
      record.lastAckedSeq = Math.max(record.lastAckedSeq, seq);
      this.#writeFrame({ type: "ack", sid: record.sid, seq });
    }
    this.#ackCount = 0;
  }

  // -- sessions -------------------------------------------------------------

  #findSession(sid: string): SessionRecord | undefined {
    const direct = this.#sessions.get(sid);
    if (direct) return direct;
    // botd may assign the session id itself; adopt it for the single session
    // that is still waiting for its open handshake.
    const pending = [...this.#sessions.values()].filter((record) => record.open !== undefined);
    if (pending.length !== 1) return undefined;
    const record = pending[0];
    this.#sessions.delete(record.sid);
    record.sid = sid;
    this.#sessions.set(sid, record);
    return record;
  }

  #sessionHandle(record: SessionRecord): BotdSession {
    const client = this;
    return {
      get sid() {
        return record.sid;
      },
      get state() {
        return record.state;
      },
      events: () => client.#createIterator(record),
      send: (message: unknown) => client.send(record.sid, message),
      cancel: () => client.cancel(record.sid),
      close: () => client.close(record.sid),
    };
  }

  #createIterator(record: SessionRecord): AsyncIterableIterator<ClientEvent> {
    const client = this;
    const iterator: AsyncIterableIterator<ClientEvent> = {
      next: (): Promise<IteratorResult<ClientEvent, undefined>> => {
        if (record.queue.length > 0) {
          const value = record.queue.shift() as ClientEvent;
          return Promise.resolve({ value, done: false });
        }
        if (record.finished) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<ClientEvent, undefined>>((resolve) => {
          record.waiters.push(resolve);
        });
      },
      return: async (): Promise<IteratorResult<ClientEvent, undefined>> => {
        // Leaving the loop must not end the session itself.
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]: () => iterator,
    };
    return iterator;
  }

  #pushEvent(record: SessionRecord, event: ClientEvent): void {
    if (record.finished) return;
    const waiter = record.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else record.queue.push(event);
  }

  #finishSession(record: SessionRecord): void {
    if (record.finished) return;
    record.finished = true;
    const waiters = record.waiters;
    record.waiters = [];
    for (const waiter of waiters) waiter({ value: undefined, done: true });
  }

  // -- misc -----------------------------------------------------------------

  #clearTimer(which: "reconnect" | "handshake" | "renew" | "ack"): void {
    if (which === "reconnect" && this.#reconnectTimer !== null) {
      this.#clock.clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
      return;
    }
    if (which === "handshake" && this.#handshakeTimer !== null) {
      this.#clock.clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
      return;
    }
    if (which === "renew" && this.#renewTimer !== null) {
      this.#clock.clearTimeout(this.#renewTimer);
      this.#renewTimer = null;
      return;
    }
    if (which === "ack" && this.#ackTimer !== null) {
      this.#clock.clearTimeout(this.#ackTimer);
      this.#ackTimer = null;
    }
  }

  #emitError(error: Error): void {
    // An unhandled "error" event would take the process down.
    if (this.listenerCount("error") > 0) this.emit("error", error);
  }
}
