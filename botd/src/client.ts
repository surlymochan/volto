/**
 * The client of the volto bot daemon (botd).
 *
 * The client speaks the frame protocol of botd/src/protocol.ts over a
 * duplex transport (the stdin/stdout of a local daemon, the pipes of an ssh
 * child, ...). One JSON object per line, in both directions:
 *
 *   client -> botd : hello, renew, open, send, cancel, ack, close, resume
 *   botd  -> client: hello, event, state, error, gap, stall
 *
 * The lease is taken with `hello`; the answer carries the id and the fence
 * of the lease. The client renews the lease every `leaseTtlMs / 3` with a
 * `renew` frame — the daemon does not answer a renew, it only extends the
 * lease. The events of a session are confirmed with `ack` frames; they are
 * batched so that a busy session does not flood the wire.
 *
 * A broken transport is not fatal: the client reconnects, takes the lease
 * again and asks botd to replay the events it missed with a `resume` frame
 * (the daemon answers with the replayed events and one state frame).
 *
 * The events of a session are delivered unwrapped: the consumer of a
 * session sees the payload of the `event` frame, not the frame itself.
 * Everything else (states, gaps, stalls, errors) is reported through the
 * notifications of the client.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";
import { readFrames, writeFrame } from "./frames.ts";
import type { FrameReader } from "./frames.ts";
import type { BotSpec, ResumeSpec, SessionState } from "./protocol.ts";

/** Wires the client to a botd instance. */
export type BotdTransport = {
  /** Frames written by the client. */
  stdin: Writable;
  /** Frames read by the client. */
  stdout: Readable;
  /**
   * Tear the transport down (kill the child, close the pipes).
   *
   * The signal is optional: a transport that cannot be signalled ignores
   * it.
   */
  kill(signal?: NodeJS.Signals): void;
};

/** Creates a fresh transport; called once per connection attempt. */
export type TransportFactory = () => BotdTransport;

/** The lease the daemon granted to the client. */
export type LeaseInfo = {
  /** Id of the lease; a renew has to name it. */
  leaseId: string;
  /** Fencing token of the lease; it grows on every takeover. */
  fence: number;
  /** Time to live of the lease in milliseconds. */
  leaseTtlMs: number;
  /** Version of the daemon. */
  botdVersion: string;
};

/** Parameters of `open`. */
export type OpenOptions = {
  /** The bot the daemon runs for the session. */
  bot: BotSpec;
  /** Session id; a random one is used when it is missing. */
  sid?: string;
  /** Provider side information of a session that is continued. */
  resume?: ResumeSpec;
};

/** A live session of the daemon. */
export type BotdSession = {
  /** Session id used on the wire. */
  readonly sid: string;
  /** Last state reported by the daemon. */
  readonly state: SessionState;
  /** The payloads of the events of the session, in order. */
  events(): AsyncIterableIterator<unknown>;
  /** Send a payload to the bot of the session. */
  send(payload: unknown): void;
  /** Cancel the session; resolves true once the session settled. */
  cancel(payload?: unknown): Promise<boolean>;
  /** Close the session. */
  close(): void;
  /** Ask the daemon to replay the events of the session. */
  resume(fromSeq?: number): void;
};

/** The notifications of the client. */
export type ClientEvents = {
  /** The lease was taken; the client is connected. */
  connected: LeaseInfo & { reconnected: boolean };
  /** The transport is gone; the client reconnects. */
  disconnected: { reason: string };
  /** A reconnect attempt is scheduled. */
  reconnect: { attempt: number; delayMs: number; reason: string };
  /** An event of a session arrived. */
  event: { sid: string; seq: number; payload: unknown };
  /** The state of a session changed. */
  state: { sid: string; state: SessionState; progressAt: number };
  /** The daemon lost the events of a session; the range is gone. */
  gap: { sid: string; fromSeq: number; toSeq: number };
  /** A session did not produce anything for a while. */
  stall: { sid: string; idleMs: number };
  /** The daemon (or the transport) reported a problem. */
  error: { code: string; message: string; sid?: string };
};

/** Bounds of the delay between two reconnect attempts. */
export type BackoffOptions = {
  /** Delay of the first reconnect attempt. */
  baseMs: number;
  /** Upper bound of the delay. */
  maxMs: number;
  /** Relative jitter of the delay (0 disables it). */
  jitter: number;
};

/** Reconnect backoff: 500 ms, doubling, capped at 15 s, with jitter. */
export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, maxMs: 15_000, jitter: 0.2 };

/** Events after which the pending acknowledgements are flushed. */
const DEFAULT_ACK_BATCH_SIZE = 16;
/** Time after which the pending acknowledgements are flushed. */
const DEFAULT_ACK_INTERVAL_MS = 250;
/** How long the client waits for the answer of the hello. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
/** How long `open` waits for the daemon to accept the session. */
const DEFAULT_OPEN_TIMEOUT_MS = 30_000;
/** How long `cancel` waits for the session to settle. */
const DEFAULT_CANCEL_TIMEOUT_MS = 15_000;
/** TTL used when the daemon does not announce one. */
const DEFAULT_LEASE_TTL_MS = 15_000;

/** The entry point of the daemon. */
const MAIN_TS = fileURLToPath(new URL("./main.ts", import.meta.url));

/** Options of the client. */
export type BotdClientOptions = {
  /** Identifier of the client; the daemon keeps the lease of a client id. */
  clientId?: string;
  /** TTL of the lease in milliseconds; the daemon may raise it. */
  leaseTtlMs?: number;
  /** Transport factory; defaults to a local daemon over stdio. */
  transport?: TransportFactory;
  /** Command of the daemon; only used by the default transport. */
  daemonCommand?: string[];
  /** Home of the daemon; only used by the default transport. */
  daemonHome?: string;
  /** Events after which the pending acknowledgements are flushed. */
  ackBatchSize?: number;
  /** Time after which the pending acknowledgements are flushed. */
  ackIntervalMs?: number;
  /** How long the client waits for the answer of the hello. */
  handshakeTimeoutMs?: number;
  /** How long `open` waits for the daemon to accept the session. */
  openTimeoutMs?: number;
  /** How long `cancel` waits for the session to settle. */
  cancelTimeoutMs?: number;
  /** Reconnect after a broken transport (true by default). */
  reconnect?: boolean;
  /** Bounds of the delay between two reconnect attempts. */
  backoff?: Partial<BackoffOptions>;
  /** Factory of the session ids. */
  sidFactory?: () => string;
};

/**
 * Delay of the n-th reconnect attempt (1-based): exponential growth from
 * `baseMs`, capped at `maxMs`, with a relative jitter.
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number {
  const step = Math.max(1, Math.floor(attempt));
  const raw = options.baseMs * Math.pow(2, step - 1);
  const factor = 1 - options.jitter + random() * 2 * options.jitter;
  return Math.min(options.maxMs, Math.max(options.baseMs, raw * factor));
}

/**
 * The command that starts the daemon over stdio.
 *
 * The types are stripped by the runtime itself (node 23 and later); older
 * versions need the flag.
 */
export function daemonCommand(options: { home?: string } = {}): string[] {
  const args = [...typeStrippingFlags(), MAIN_TS, "serve"];
  if (options.home) args.push(`--home=${options.home}`);
  return [process.execPath, ...args];
}

/**
 * The command that starts the daemon on an executor host.
 *
 * The daemon runs as a forced command of the ssh session; the host is
 * always referenced by its alias in the ssh config, never by its name or
 * its address.
 */
export function sshArgs(hostAlias: string): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=15",
    hostAlias,
    "botd",
    "serve",
  ];
}

/** The transport of a daemon on an executor host. */
export function sshTransport(hostAlias: string): BotdTransport {
  return spawnTransport("ssh", sshArgs(hostAlias));
}

/** Start a command and talk to it over its stdin and stdout. */
export function spawnTransport(command: string, args: string[]): BotdTransport {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  // The daemon may be gone already: a broken pipe is not an error here.
  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});
  return {
    stdin: child.stdin as unknown as Writable,
    stdout: child.stdout as unknown as Readable,
    kill: (signal?: NodeJS.Signals) => {
      // The daemon stops when its stdin ends; the signal is the fallback
      // for a daemon that does not react.
      try {
        child.stdin.end();
      } catch {
        // The pipe is gone already.
      }
      child.kill(signal ?? "SIGTERM");
    },
  };
}

/** The state of one session, as the client sees it. */
type SessionRecord = {
  sid: string;
  /** The bot of the session; unknown for an adopted session. */
  bot: BotSpec | undefined;
  state: SessionState;
  /** Highest sequence number delivered to the consumer. */
  deliveredSeq: number;
  /** Highest sequence number acknowledged to the daemon. */
  ackedSeq: number;
  /** Highest sequence number received but not acknowledged yet. */
  pendingAckSeq: number | null;
  /** Events received since the last acknowledgement. */
  pendingAckCount: number;
  /** Payloads waiting for the consumer. */
  queue: unknown[];
  /** Waiters of the event iterator. */
  waiters: Array<(result: IteratorResult<unknown>) => void>;
  /** True once the session was closed. */
  finished: boolean;
  /** Resolver of the pending open. */
  open: { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout | null } | null;
  /** Resolver of the pending cancel. */
  cancel: { resolve: (ok: boolean) => void; timer: NodeJS.Timeout | null } | null;
};

/** A tiny typed emitter: the client reports a handful of notifications. */
class Emitter<Events extends Record<string, unknown>> {
  #listeners = new Map<string, Set<(payload: unknown) => void>>();

  /** Listen to an event; the returned function removes the listener. */
  on<K extends keyof Events>(name: K, listener: (payload: Events[K]) => void): () => void {
    let listeners = this.#listeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(name, listeners);
    }
    const entry = listener as (payload: unknown) => void;
    listeners.add(entry);
    return () => {
      listeners?.delete(entry);
    };
  }

  /** Report an event to every listener. */
  emit<K extends keyof Events>(name: K, payload: Events[K]): void {
    const listeners = this.#listeners.get(name);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        (listener as (payload: Events[K]) => void)(payload);
      } catch {
        // A broken listener must not take the client down.
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The controller side of the botd protocol.
 *
 * The client owns the lease of the daemon, the sessions and the
 * acknowledgements. Everything it needs is injected: the transport (the
 * tests use an in-process daemon), the session ids and the timeouts.
 */
export class BotdClient {
  /** Identifier of the client; the daemon keeps the lease of a client id. */
  readonly clientId: string;

  #transportFactory: TransportFactory;
  #leaseTtlMs: number | undefined;
  #ackBatchSize: number;
  #ackIntervalMs: number;
  #handshakeTimeoutMs: number;
  #openTimeoutMs: number;
  #cancelTimeoutMs: number;
  #reconnectEnabled: boolean;
  #backoff: BackoffOptions;
  #sidFactory: () => string;

  #transport: BotdTransport | null = null;
  #reader: FrameReader | null = null;
  #connected = false;
  #stopping = false;
  #everConnected = false;
  #resumeOnConnect = false;
  #attempt = 0;
  #startPromise: Promise<void> | null = null;
  #helloPending: {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout | null;
  } | null = null;
  #renewTimer: NodeJS.Timeout | null = null;
  #ackTimer: NodeJS.Timeout | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #lease: LeaseInfo | null = null;
  #sessions = new Map<string, SessionRecord>();
  #events = new Emitter<ClientEvents>();

  constructor(options: BotdClientOptions = {}) {
    this.clientId = options.clientId ?? "volto";
    this.#leaseTtlMs = options.leaseTtlMs;
    this.#ackBatchSize = Math.max(1, options.ackBatchSize ?? DEFAULT_ACK_BATCH_SIZE);
    this.#ackIntervalMs = Math.max(1, options.ackIntervalMs ?? DEFAULT_ACK_INTERVAL_MS);
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.#cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
    this.#reconnectEnabled = options.reconnect ?? true;
    this.#backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.#sidFactory = options.sidFactory ?? (() => `s-${randomUUID()}`);
    const command = options.daemonCommand ?? daemonCommand({ home: options.daemonHome });
    this.#transportFactory =
      options.transport ?? (() => spawnTransport(command[0], command.slice(1)));
  }

  /** True while the transport is up and the lease is taken. */
  get connected(): boolean {
    return this.#connected;
  }

  /** The lease the daemon granted, if any. */
  get lease(): LeaseInfo | null {
    return this.#lease;
  }

  /** The sessions the client knows about. */
  get sessions(): string[] {
    return [...this.#sessions.keys()];
  }

  /** Listen to a notification; the returned function removes the listener. */
  on<K extends keyof ClientEvents>(
    name: K,
    listener: (payload: ClientEvents[K]) => void,
  ): () => void {
    return this.#events.on(name, listener);
  }

  /** Connect to the daemon and take the lease. */
  start(): Promise<void> {
    this.#stopping = false;
    if (!this.#startPromise) {
      this.#startPromise = this.#connect().catch((err: unknown) => {
        this.#startPromise = null;
        throw err;
      });
    }
    return this.#startPromise;
  }

  /** Open a session and wait until the daemon accepted it. */
  async open(options: OpenOptions): Promise<BotdSession> {
    await this.#ensureConnected();
    const sid = options.sid ?? this.#sidFactory();
    if (this.#sessions.has(sid)) throw new Error(`botd: the session ${sid} is already open`);
    const record: SessionRecord = {
      sid,
      bot: options.bot,
      state: "starting",
      deliveredSeq: 0,
      ackedSeq: 0,
      pendingAckSeq: null,
      pendingAckCount: 0,
      queue: [],
      waiters: [],
      finished: false,
      open: null,
      cancel: null,
    };
    this.#sessions.set(sid, record);
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        record.open = null;
        reject(new Error(`botd: open timeout for the session ${sid}`));
      }, this.#openTimeoutMs);
      record.open = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      };
    });
    this.#write({
      op: "open",
      sid,
      bot: options.bot,
      ...(options.resume ? { resume: options.resume } : {}),
    });
    try {
      await opened;
    } catch (err) {
      this.#sessions.delete(sid);
      throw err;
    }
    return this.#sessionHandle(record);
  }

  /** Send a payload to the bot of a session. */
  send(sid: string, payload: unknown): void {
    this.#write({ op: "send", sid, payload: payload === undefined ? null : payload });
  }

  /**
   * Cancel a session.
   *
   * Resolves true once the session settled (the bot answered the cancel or
   * the bot is gone) and false when it did not settle in time.
   */
  async cancel(sid: string, payload?: unknown): Promise<boolean> {
    const record = this.#sessions.get(sid);
    if (!record) return false;
    if (record.state === "exited") return true;
    const settled = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        record.cancel = null;
        resolve(false);
      }, this.#cancelTimeoutMs);
      record.cancel = {
        resolve: (ok: boolean) => {
          clearTimeout(timer);
          resolve(ok);
        },
        timer,
      };
    });
    this.#write({
      op: "cancel",
      sid,
      ...(payload === undefined ? {} : { payload }),
    });
    return settled;
  }

  /** Close a session: the daemon stops the bot of the session. */
  close(sid: string): void {
    this.#write({ op: "close", sid });
    const record = this.#sessions.get(sid);
    if (!record) return;
    this.#finish(record);
    this.#sessions.delete(sid);
  }

  /** Ask the daemon to replay the events of a session. */
  resume(sid: string, fromSeq?: number): void {
    const record = this.#sessions.get(sid) ?? this.#adopt(sid);
    const from = fromSeq ?? record.ackedSeq + 1;
    this.#write({ op: "resume", sid, fromSeq: Math.max(1, Math.floor(from)) });
  }

  /**
   * The handle of a session.
   *
   * A session id the client does not know yet is adopted: the daemon may
   * replay the events of a session of an earlier run.
   */
  session(sid: string): BotdSession {
    const record = this.#sessions.get(sid) ?? this.#adopt(sid);
    return this.#sessionHandle(record);
  }

  /** Stop the client: the transport is closed and the sessions end. */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#clearRenew();
    this.#clearAckTimer();
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#helloPending) {
      const hello = this.#helloPending;
      this.#helloPending = null;
      hello.reject(new Error("botd: the client stopped"));
    }
    for (const record of this.#sessions.values()) {
      if (record.open) {
        const open = record.open;
        record.open = null;
        if (open.timer) clearTimeout(open.timer);
        open.reject(new Error("botd: the client stopped"));
      }
      if (record.cancel) {
        const cancel = record.cancel;
        record.cancel = null;
        if (cancel.timer) clearTimeout(cancel.timer);
        cancel.resolve(false);
      }
      this.#finish(record);
    }
    this.#sessions.clear();
    this.#teardown();
    this.#connected = false;
    this.#lease = null;
  }

  // -- connection -----------------------------------------------------------

  async #ensureConnected(): Promise<void> {
    if (this.#stopping) throw new Error("botd: the client stopped");
    if (this.#connected) return;
    if (!this.#everConnected) {
      await this.start();
      return;
    }
    await this.#whenConnected(this.#handshakeTimeoutMs);
  }

  #whenConnected(timeoutMs: number): Promise<void> {
    if (this.#connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let off = (): void => {};
      const timer = setTimeout(() => {
        off();
        reject(new Error("botd: the client is not connected"));
      }, timeoutMs);
      off = this.#events.on("connected", () => {
        clearTimeout(timer);
        off();
        resolve();
      });
    });
  }

  async #connect(): Promise<void> {
    const transport = this.#transportFactory();
    this.#transport = transport;
    this.#reader = readFrames(
      transport.stdout,
      (frame) => this.#onFrame(frame),
      (err) => this.#events.emit("error", { code: "bad_json", message: err.message }),
    );
    transport.stdout.on("end", () => this.#onTransportClosed("the transport ended"));
    transport.stdout.on("close", () => this.#onTransportClosed("the transport closed"));
    transport.stdout.on("error", (err: Error) =>
      this.#onTransportClosed(`transport error: ${err.message}`),
    );
    transport.stdin.on("error", (err: Error) =>
      this.#events.emit("error", { code: "transport_error", message: err.message }),
    );
    try {
      await this.#hello();
    } catch (err) {
      // The handshake failed: the transport is of no use.
      this.#teardown();
      throw err;
    }
    const reconnected = this.#everConnected;
    this.#everConnected = true;
    this.#connected = true;
    this.#attempt = 0;
    this.#armRenew();
    if (this.#lease) this.#events.emit("connected", { ...this.#lease, reconnected });
    if (this.#resumeOnConnect) {
      this.#resumeOnConnect = false;
      this.#resumeSessions();
    }
  }

  /** Take the lease: the daemon answers with its id, its fence and its TTL. */
  #hello(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#helloPending = null;
        reject(new Error("botd: handshake timeout"));
      }, this.#handshakeTimeoutMs);
      this.#helloPending = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      };
      this.#write({
        op: "hello",
        clientId: this.clientId,
        ...(this.#leaseTtlMs === undefined ? {} : { leaseTtlMs: this.#leaseTtlMs }),
      });
    });
  }

  #onTransportClosed(reason: string): void {
    if (this.#stopping) return;
    if (!this.#transport) return;
    const wasConnected = this.#connected;
    this.#connected = false;
    this.#clearRenew();
    this.#teardown();
    if (this.#helloPending) {
      const hello = this.#helloPending;
      this.#helloPending = null;
      hello.reject(new Error(`botd: transport closed (${reason})`));
    }
    if (wasConnected) this.#events.emit("disconnected", { reason });
    if (!this.#reconnectEnabled) return;
    this.#resumeOnConnect = true;
    this.#scheduleReconnect(reason);
  }

  #scheduleReconnect(reason: string): void {
    if (this.#reconnectTimer) return;
    this.#attempt += 1;
    const delayMs = backoffDelay(this.#attempt, this.#backoff);
    this.#events.emit("reconnect", { attempt: this.#attempt, delayMs, reason });
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#reconnect();
    }, delayMs);
  }

  async #reconnect(): Promise<void> {
    if (this.#stopping) return;
    try {
      await this.#connect();
    } catch (err) {
      if (this.#stopping) return;
      this.#events.emit("error", {
        code: "reconnect_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      this.#scheduleReconnect("the reconnect failed");
    }
  }

  #teardown(): void {
    this.#reader?.close();
    this.#reader = null;
    const transport = this.#transport;
    this.#transport = null;
    if (!transport) return;
    try {
      transport.kill();
    } catch {
      // The transport is going away anyway.
    }
  }

  // -- wire -----------------------------------------------------------------

  #write(frame: Record<string, unknown>): void {
    const transport = this.#transport;
    if (!transport) return;
    try {
      writeFrame(transport.stdin, frame);
    } catch (err) {
      this.#events.emit("error", {
        code: "write_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  #onFrame(raw: unknown): void {
    if (!isRecord(raw)) return;
    switch (raw.op) {
      case "hello":
        this.#onHello(raw);
        return;
      case "event":
        this.#onEvent(raw);
        return;
      case "state":
        this.#onState(raw);
        return;
      case "error":
        this.#onError(raw);
        return;
      case "gap":
        this.#onGap(raw);
        return;
      case "stall":
        this.#onStall(raw);
        return;
      default:
        // An unknown op is ignored: the daemon may know ops the client does
        // not need.
        return;
    }
  }

  #onHello(frame: Record<string, unknown>): void {
    const leaseId = readString(frame.leaseId);
    const fence = readNumber(frame.fence);
    if (leaseId === undefined || fence === undefined) {
      this.#events.emit("error", {
        code: "bad_hello",
        message: "the hello answer does not carry a lease",
      });
      return;
    }
    this.#lease = {
      leaseId,
      fence,
      leaseTtlMs: readNumber(frame.leaseTtlMs) ?? this.#leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      botdVersion: readString(frame.botdVersion) ?? "unknown",
    };
    const hello = this.#helloPending;
    this.#helloPending = null;
    if (hello) hello.resolve();
  }

  #onEvent(frame: Record<string, unknown>): void {
    const sid = readString(frame.sid);
    if (sid === undefined) return;
    const record = this.#sessions.get(sid);
    if (!record) return;
    const seq = readNumber(frame.seq) ?? 0;
    if (seq > 0 && seq <= record.deliveredSeq) {
      // A replayed event: it was delivered already, only the
      // acknowledgement is still missing.
      this.#noteAck(record, seq);
      return;
    }
    if (seq > 0) record.deliveredSeq = seq;
    this.#noteAck(record, seq);
    this.#push(record, frame.payload);
    this.#events.emit("event", { sid, seq, payload: frame.payload });
  }

  #onState(frame: Record<string, unknown>): void {
    const sid = readString(frame.sid);
    const state = readString(frame.state) as SessionState | undefined;
    if (sid === undefined || state === undefined) return;
    const progressAt = readNumber(frame.progressAt) ?? 0;
    const record = this.#sessions.get(sid);
    if (record) {
      record.state = state;
      if (record.open) {
        const open = record.open;
        record.open = null;
        if (open.timer) clearTimeout(open.timer);
        open.resolve();
      }
      if (record.cancel && (state === "running" || state === "exited")) {
        // The bot answered the cancel or it is gone: the cancel is over.
        const cancel = record.cancel;
        record.cancel = null;
        if (cancel.timer) clearTimeout(cancel.timer);
        cancel.resolve(true);
      }
    }
    this.#events.emit("state", { sid, state, progressAt });
  }

  #onError(frame: Record<string, unknown>): void {
    const code = readString(frame.code) ?? "unknown";
    const message = readString(frame.message) ?? code;
    const sid = readString(frame.sid);
    const record = sid === undefined ? undefined : this.#sessions.get(sid);
    if (record) {
      if (record.open) {
        const open = record.open;
        record.open = null;
        if (open.timer) clearTimeout(open.timer);
        open.reject(new Error(`botd: ${code}: ${message}`));
      }
      if (record.cancel) {
        const cancel = record.cancel;
        record.cancel = null;
        if (cancel.timer) clearTimeout(cancel.timer);
        cancel.resolve(false);
      }
    }
    this.#events.emit("error", sid === undefined ? { code, message } : { code, message, sid });
  }

  #onGap(frame: Record<string, unknown>): void {
    const sid = readString(frame.sid);
    if (sid === undefined) return;
    this.#events.emit("gap", {
      sid,
      fromSeq: readNumber(frame.fromSeq) ?? 0,
      toSeq: readNumber(frame.toSeq) ?? 0,
    });
  }

  #onStall(frame: Record<string, unknown>): void {
    const sid = readString(frame.sid);
    if (sid === undefined) return;
    this.#events.emit("stall", { sid, idleMs: readNumber(frame.idleMs) ?? 0 });
  }

  // -- lease ----------------------------------------------------------------

  /** Renew the lease of this connection; the daemon does not answer it. */
  #armRenew(): void {
    this.#clearRenew();
    const lease = this.#lease;
    if (!lease || this.#stopping) return;
    const interval = Math.max(50, Math.round(lease.leaseTtlMs / 3));
    this.#renewTimer = setInterval(() => {
      const current = this.#lease;
      if (!current || !this.#connected) return;
      this.#write({ op: "renew", leaseId: current.leaseId, fence: current.fence });
    }, interval);
  }

  #clearRenew(): void {
    if (!this.#renewTimer) return;
    clearInterval(this.#renewTimer);
    this.#renewTimer = null;
  }

  // -- acknowledgements -----------------------------------------------------

  #noteAck(record: SessionRecord, seq: number): void {
    if (seq <= 0 || seq <= record.ackedSeq) return;
    if (record.pendingAckSeq === null || seq > record.pendingAckSeq) {
      record.pendingAckSeq = seq;
    }
    record.pendingAckCount += 1;
    if (record.pendingAckCount >= this.#ackBatchSize) {
      this.#flushAcks();
      return;
    }
    this.#scheduleAckFlush();
  }

  #scheduleAckFlush(): void {
    if (this.#ackTimer) return;
    this.#ackTimer = setTimeout(() => {
      this.#ackTimer = null;
      this.#flushAcks();
    }, this.#ackIntervalMs);
  }

  #clearAckTimer(): void {
    if (!this.#ackTimer) return;
    clearTimeout(this.#ackTimer);
    this.#ackTimer = null;
  }

  /** Tell the daemon what the client processed; the acks are cumulative. */
  #flushAcks(): void {
    this.#clearAckTimer();
    for (const record of this.#sessions.values()) {
      const seq = record.pendingAckSeq;
      if (seq === null) continue;
      record.pendingAckSeq = null;
      record.pendingAckCount = 0;
      record.ackedSeq = Math.max(record.ackedSeq, seq);
      this.#write({ op: "ack", sid: record.sid, seq });
    }
  }

  // -- sessions -------------------------------------------------------------

  /** Take a session the client does not know yet into its own table. */
  #adopt(sid: string): SessionRecord {
    const record: SessionRecord = {
      sid,
      bot: undefined,
      state: "starting",
      deliveredSeq: 0,
      ackedSeq: 0,
      pendingAckSeq: null,
      pendingAckCount: 0,
      queue: [],
      waiters: [],
      finished: false,
      open: null,
      cancel: null,
    };
    this.#sessions.set(sid, record);
    return record;
  }

  /** Ask the daemon to replay the events the client did not see. */
  #resumeSessions(): void {
    for (const record of this.#sessions.values()) {
      if (record.finished) continue;
      this.#write({ op: "resume", sid: record.sid, fromSeq: Math.max(1, record.ackedSeq + 1) });
    }
  }

  #sessionHandle(record: SessionRecord): BotdSession {
    const client = this;
    return {
      get sid(): string {
        return record.sid;
      },
      get state(): SessionState {
        return record.state;
      },
      events: () => client.#iterator(record),
      send: (payload: unknown) => client.send(record.sid, payload),
      cancel: (payload?: unknown) => client.cancel(record.sid, payload),
      close: () => client.close(record.sid),
      resume: (fromSeq?: number) => client.resume(record.sid, fromSeq),
    };
  }

  #iterator(record: SessionRecord): AsyncIterableIterator<unknown> {
    const iterator: AsyncIterableIterator<unknown> = {
      next: (): Promise<IteratorResult<unknown>> => {
        if (record.queue.length > 0) {
          return Promise.resolve({ value: record.queue.shift(), done: false });
        }
        if (record.finished) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<unknown>>((resolve) => {
          record.waiters.push(resolve);
        });
      },
      return: (): Promise<IteratorResult<unknown>> =>
        Promise.resolve({ value: undefined, done: true }),
      [Symbol.asyncIterator]: () => iterator,
    };
    return iterator;
  }

  #push(record: SessionRecord, payload: unknown): void {
    if (record.finished) return;
    const waiter = record.waiters.shift();
    if (waiter) waiter({ value: payload, done: false });
    else record.queue.push(payload);
  }

  #finish(record: SessionRecord): void {
    if (record.finished) return;
    record.finished = true;
    const waiters = record.waiters;
    record.waiters = [];
    for (const waiter of waiters) waiter({ value: undefined, done: true });
  }
}

/**
 * The flags the runtime needs to run a TypeScript file.
 *
 * Node 23 and later strip the types on their own, older versions need the
 * flag. A runtime that is not node understands TypeScript natively and does
 * not know the flag.
 */
function typeStrippingFlags(): string[] {
  const versions = process.versions as Record<string, string | undefined>;
  if (versions.bun) return [];
  const major = Number(versions.node?.split(".")[0] ?? "0");
  if (!Number.isFinite(major) || major >= 23) return [];
  return ["--experimental-strip-types"];
}
