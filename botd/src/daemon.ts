/**
 * The bot daemon.
 *
 * The daemon owns the lease, the sessions and the session table. It is
 * transport agnostic: `connect()` attaches a client connection (NDJSON over
 * stdin/stdout in production, an in-memory stream in the tests) and every
 * frame of every session is multiplexed over that connection.
 *
 * The daemon is deliberately free of I/O dependencies: no sockets, no shell,
 * no third party modules.
 */
import type { Readable, Writable } from "node:stream";
import { DEFAULT_CONFIG } from "./config.ts";
import type { BotdConfig } from "./config.ts";
import { sessionTablePath } from "./config.ts";
import { readFrames, writeFrame } from "./frames.ts";
import { LeaseManager } from "./lease.ts";
import type { LeaseState } from "./lease.ts";
import { parseClientFrame } from "./protocol.ts";
import type { ClientFrame, ServerFrame, SessionState } from "./protocol.ts";
import { EventRing } from "./ring.ts";
import { Session } from "./session.ts";
import { SessionStore } from "./store.ts";
import type { SessionRecord } from "./store.ts";

export type BotdHooks = {
  /** Called for every frame that goes to the client. */
  onFrame: (frame: ServerFrame) => void;
  /** Diagnostics; never part of the protocol. */
  onLog?: (message: string) => void;
};

/** A client connection. */
export type Connection = {
  readonly id: number;
  /** Fence the connection holds, `null` before the first `hello`. */
  readonly fence: number | null;
  /** Detach the connection. */
  close(): void;
};

type ConnectionState = {
  id: number;
  fence: number | null;
  leaseId: string | null;
  send: (frame: ServerFrame) => void;
  close: () => void;
};

/** Snapshot of a session, used by the tests and by diagnostics. */
export type SessionStatus = {
  sid: string;
  state: SessionState;
  seq: number;
  ackedSeq: number;
  live: boolean;
  cancelling: boolean;
  providerSessionId?: string | undefined;
};

export class Botd {
  private config: BotdConfig;
  private hooks: BotdHooks;
  private lease: LeaseManager;
  private store: SessionStore;
  private sessions = new Map<string, Session>();
  private records = new Map<string, SessionRecord>();
  private connections = new Map<number, ConnectionState>();
  private leaseConnectionId: number | null = null;
  private nextConnectionId = 1;
  private leaseState: LeaseState = "none";
  private watchdog: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(config: Partial<BotdConfig> = {}, hooks: BotdHooks = { onFrame: () => {} }) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.hooks = hooks;
    this.lease = new LeaseManager({
      defaultTtlMs: this.config.leaseTtlMs,
      minTtlMs: this.config.minLeaseTtlMs,
      now: this.config.now,
    });
    this.store = new SessionStore(sessionTablePath(this.config));
    for (const record of this.store.load()) {
      // A session that outlived the daemon keeps its metadata so that the
      // client can resume the provider session; the child itself is gone.
      this.records.set(record.sid, { ...record, state: "exited" });
    }
    this.watchdog = setInterval(() => this.tick(), Math.max(10, this.config.watchdogIntervalMs));
    this.watchdog.unref?.();
  }

  /** Attach a client connection. */
  connect(input: Readable, output: Writable): Connection {
    const id = this.nextConnectionId++;
    const state: ConnectionState = {
      id,
      fence: null,
      leaseId: null,
      send: (frame: ServerFrame) => writeFrame(output, frame),
      close: () => {},
    };
    this.connections.set(id, state);

    const reader = readFrames(
      input,
      (frame) => this.handleFrame(state, frame),
      (err) => {
        this.emitTo(state, { op: "error", code: "bad_json", message: err.message });
      },
    );

    const detach = (): void => {
      reader.close();
      this.connections.delete(id);
      if (this.leaseConnectionId === id) this.leaseConnectionId = null;
    };
    state.close = detach;
    input.on("end", detach);
    input.on("close", detach);

    return {
      id,
      get fence(): number | null {
        return state.fence;
      },
      close: detach,
    };
  }

  /** Handle one untrusted frame of a connection. */
  handleFrame(connection: ConnectionState, raw: unknown): void {
    const parsed = parseClientFrame(raw);
    if (!parsed.ok) {
      this.emitTo(connection, { op: "error", code: "bad_frame", message: parsed.message });
      return;
    }
    const frame = parsed.frame;
    if (frame.op === "hello") {
      this.onHello(connection, frame);
      return;
    }
    const lease = this.lease.current;
    if (!lease) {
      this.emitTo(connection, {
        op: "error",
        code: "no_lease",
        message: "send hello before other frames",
      });
      return;
    }
    if (frame.op === "renew") {
      this.onRenew(connection, frame);
      return;
    }
    if (connection.fence !== lease.fence || connection.leaseId !== lease.leaseId) {
      this.emitTo(connection, {
        op: "error",
        code: "stale_fence",
        message: `fence ${connection.fence ?? "none"} is stale, the current fence is ${lease.fence}`,
      });
      return;
    }
    switch (frame.op) {
      case "open":
        this.onOpen(connection, frame);
        return;
      case "send":
        this.onSend(connection, frame);
        return;
      case "cancel":
        this.onCancel(connection, frame);
        return;
      case "ack":
        this.onAck(connection, frame);
        return;
      case "close":
        this.onClose(connection, frame);
        return;
      case "resume":
        this.onResume(connection, frame);
        return;
      default:
        return;
    }
  }

  /** Snapshot of a live session. */
  sessionStatus(sid: string): SessionStatus | undefined {
    const session = this.sessions.get(sid);
    if (!session) return undefined;
    return {
      sid: session.sid,
      state: session.state,
      seq: session.seq,
      ackedSeq: session.ackedSeq,
      live: session.isLive,
      cancelling: session.cancelling,
      providerSessionId: session.providerSessionId,
    };
  }

  /** Snapshot of every known session (live ones first). */
  listSessions(): SessionStatus[] {
    return [...this.sessions.values()].map((session) => ({
      sid: session.sid,
      state: session.state,
      seq: session.seq,
      ackedSeq: session.ackedSeq,
      live: session.isLive,
      cancelling: session.cancelling,
      providerSessionId: session.providerSessionId,
    }));
  }

  /** The session table: the live sessions plus the sessions that are gone. */
  table(): SessionRecord[] {
    const now = this.config.now();
    const records: SessionRecord[] = [];
    for (const session of this.sessions.values()) {
      records.push({
        sid: session.sid,
        kind: session.bot.kind,
        command: session.bot.command.slice(),
        cwd: session.bot.cwd,
        providerSessionId: session.providerSessionId,
        state: session.state,
        createdAt: session.createdAt,
        updatedAt: now,
        lastSeq: session.seq,
        ackedSeq: session.ackedSeq,
        progressAt: session.progressAt,
      });
    }
    for (const [sid, record] of this.records) {
      if (this.sessions.has(sid)) continue;
      records.push({ ...record, updatedAt: now });
    }
    return records;
  }

  /** Stop the watchdog and clean up every child. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
    this.persist();
  }

  private emit(frame: ServerFrame): void {
    const target = this.target();
    if (target) target.send(frame);
  }

  private emitTo(connection: ConnectionState, frame: ServerFrame): void {
    connection.send(frame);
  }

  /** The connection that receives the session events. */
  private target(): ConnectionState | undefined {
    if (this.leaseConnectionId !== null) {
      const connection = this.connections.get(this.leaseConnectionId);
      if (connection) return connection;
    }
    let last: ConnectionState | undefined;
    for (const connection of this.connections.values()) last = connection;
    return last;
  }

  private onHello(connection: ConnectionState, frame: Extract<ClientFrame, { op: "hello" }>): void {
    const result = this.lease.hello(frame.clientId, frame.leaseTtlMs);
    if (!result.ok) {
      this.emitTo(connection, { op: "error", code: result.code, message: result.message });
      return;
    }
    connection.fence = result.value.fence;
    connection.leaseId = result.value.leaseId;
    this.leaseConnectionId = connection.id;
    this.emitTo(connection, {
      op: "hello",
      botdVersion: this.config.botdVersion,
      leaseId: result.value.leaseId,
      fence: result.value.fence,
      leaseTtlMs: result.value.ttlMs,
    });
    // A fresh lease brings the paused sessions back to life.
    this.resumeSessions();
  }

  private onRenew(connection: ConnectionState, frame: Extract<ClientFrame, { op: "renew" }>): void {
    const result = this.lease.renew(frame.leaseId, frame.fence);
    if (!result.ok) {
      this.emitTo(connection, { op: "error", code: result.code, message: result.message });
      return;
    }
    connection.fence = result.value.fence;
    connection.leaseId = result.value.leaseId;
    this.leaseConnectionId = connection.id;
    this.resumeSessions();
  }

  private onOpen(connection: ConnectionState, frame: Extract<ClientFrame, { op: "open" }>): void {
    const existing = this.sessions.get(frame.sid);
    if (existing && existing.isLive) {
      this.emitTo(connection, {
        op: "error",
        code: "session_exists",
        sid: frame.sid,
        message: `session ${frame.sid} is already running`,
      });
      return;
    }
    if (existing) this.sessions.delete(frame.sid);

    const session = new Session({
      sid: frame.sid,
      bot: frame.bot,
      providerSessionId: frame.resume?.providerSessionId,
      ring: new EventRing(this.config.ringMaxEvents, this.config.ringMaxBytes),
      now: this.config.now,
      hooks: {
        onOutput: (current, payload) => {
          this.emit({ op: "event", sid: current.sid, seq: current.seq, payload });
        },
        onState: (current, state) => {
          this.emit({ op: "state", sid: current.sid, state, progressAt: current.progressAt });
          this.persist();
        },
        onExit: () => {
          this.persist();
        },
        onError: (current, message) => {
          this.emit({ op: "error", code: "child_error", sid: current.sid, message });
        },
      },
    });
    this.sessions.set(frame.sid, session);
    this.emit({
      op: "state",
      sid: session.sid,
      state: "starting",
      progressAt: session.progressAt,
    });
    session.start();
    this.persist();
  }

  private onSend(connection: ConnectionState, frame: Extract<ClientFrame, { op: "send" }>): void {
    const session = this.sessions.get(frame.sid);
    if (!session) {
      this.emitTo(connection, {
        op: "error",
        code: "unknown_session",
        sid: frame.sid,
        message: `no session ${frame.sid}`,
      });
      return;
    }
    const leaseState = this.lease.state(this.config.now());
    if (leaseState === "paused" || leaseState === "dead") {
      this.emitTo(connection, {
        op: "error",
        code: "lease_paused",
        sid: frame.sid,
        message: "the lease expired, input is not forwarded",
      });
      return;
    }
    if (!session.isLive) {
      this.emitTo(connection, {
        op: "error",
        code: "session_exited",
        sid: frame.sid,
        message: `session ${frame.sid} has exited`,
      });
      return;
    }
    if (session.cancelling) {
      this.emitTo(connection, {
        op: "error",
        code: "session_cancelling",
        sid: frame.sid,
        message: `session ${frame.sid} is being cancelled`,
      });
      return;
    }
    session.send(frame.payload);
  }

  private onCancel(connection: ConnectionState, frame: Extract<ClientFrame, { op: "cancel" }>): void {
    const session = this.sessions.get(frame.sid);
    if (!session) {
      this.emitTo(connection, {
        op: "error",
        code: "unknown_session",
        sid: frame.sid,
        message: `no session ${frame.sid}`,
      });
      return;
    }
    if (!session.isLive) {
      this.emitTo(connection, {
        op: "error",
        code: "session_exited",
        sid: frame.sid,
        message: `session ${frame.sid} has exited`,
      });
      return;
    }
    session.requestCancel(frame.payload, {
      graceMs: this.config.cancelGraceMs,
      killGraceMs: this.config.cancelKillGraceMs,
    });
    // The session reports its new state through the state hook.
  }

  private onAck(connection: ConnectionState, frame: Extract<ClientFrame, { op: "ack" }>): void {
    const session = this.sessions.get(frame.sid);
    if (!session) {
      this.emitTo(connection, {
        op: "error",
        code: "unknown_session",
        sid: frame.sid,
        message: `no session ${frame.sid}`,
      });
      return;
    }
    if (frame.seq > session.ackedSeq) session.ackedSeq = frame.seq;
    this.persist();
  }

  private onClose(connection: ConnectionState, frame: Extract<ClientFrame, { op: "close" }>): void {
    const session = this.sessions.get(frame.sid);
    if (!session) {
      this.emitTo(connection, {
        op: "error",
        code: "unknown_session",
        sid: frame.sid,
        message: `no session ${frame.sid}`,
      });
      return;
    }
    session.terminate(this.config.terminateGraceMs);
    this.sessions.delete(frame.sid);
    this.records.delete(frame.sid);
    this.persist();
  }

  private onResume(connection: ConnectionState, frame: Extract<ClientFrame, { op: "resume" }>): void {
    const session = this.sessions.get(frame.sid);
    if (session) {
      const { events, gap } = session.ring.since(frame.fromSeq);
      if (gap) {
        this.emit({ op: "gap", sid: session.sid, fromSeq: gap.fromSeq, toSeq: gap.toSeq });
      }
      for (const event of events) {
        this.emit({ op: "event", sid: session.sid, seq: event.seq, payload: event.payload });
      }
      this.emit({
        op: "state",
        sid: session.sid,
        state: session.state,
        progressAt: session.progressAt,
      });
      return;
    }
    const record = this.records.get(frame.sid);
    if (!record) {
      this.emitTo(connection, {
        op: "error",
        code: "unknown_session",
        sid: frame.sid,
        message: `no session ${frame.sid}`,
      });
      return;
    }
    // The session is gone (the lease killed the child or botd restarted): the
    // buffered events are lost, so the hole is reported.
    if (record.lastSeq >= frame.fromSeq) {
      this.emit({ op: "gap", sid: record.sid, fromSeq: frame.fromSeq, toSeq: record.lastSeq });
    }
    this.emit({
      op: "state",
      sid: record.sid,
      state: record.state,
      progressAt: record.progressAt,
    });
  }

  /** Bring the paused sessions back to life after a renew or a new hello. */
  private resumeSessions(): void {
    if (this.lease.state(this.config.now()) !== "ok") return;
    const now = this.config.now();
    for (const session of this.sessions.values()) {
      if (!session.isLive || session.cancelling) continue;
      session.setState(this.computeState(session, now));
    }
  }

  private computeState(session: Session, now: number): SessionState {
    const reference = session.hasOutput ? session.progressAt : session.createdAt;
    if (now - reference >= this.config.idleAfterMs) return "idle";
    return session.hasOutput ? "running" : "starting";
  }

  private tick(): void {
    if (this.closed) return;
    const now = this.config.now();
    this.updateLease(now);
    const leaseState = this.lease.state(now);
    for (const session of this.sessions.values()) {
      if (!session.isLive) continue;
      if (session.cancelling) continue;
      if (leaseState === "paused") {
        session.setState("paused");
        continue;
      }
      if (leaseState === "dead") continue;
      session.setState(this.computeState(session, now));
      const idleMs = session.idleMs(now);
      if (idleMs >= this.config.stallMs && !session.stalled) {
        session.stalled = true;
        this.emit({ op: "stall", sid: session.sid, idleMs });
      }
    }
  }

  private updateLease(now: number): void {
    const state = this.lease.state(now);
    if (state === this.leaseState) return;
    this.leaseState = state;
    if (state === "paused") {
      // Stop forwarding the input but keep the children alive.
      for (const session of this.sessions.values()) {
        if (session.isLive) session.setState("paused");
      }
      this.log("lease expired, the sessions are paused");
      return;
    }
    if (state === "dead") {
      // Terminate gracefully, then kill the process group.
      for (const session of this.sessions.values()) {
        if (session.isLive) session.terminate(this.config.terminateGraceMs);
      }
      this.log("lease expired twice, the sessions are terminated");
      return;
    }
    if (state === "ok") this.resumeSessions();
  }

  private persist(): void {
    const records = this.table();
    try {
      this.store.save(records);
    } catch (err) {
      this.log(
        `could not persist the session table: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private log(message: string): void {
    this.hooks.onLog?.(message);
  }
}
