/**
 * One bot session: a child process plus the bookkeeping around it.
 *
 * The child is started in its own process group so that botd can signal the
 * whole tree (SIGINT, then SIGKILL) instead of only the direct child. Every
 * stdout line becomes one event with a monotonically increasing sequence
 * number; the events are kept in a bounded ring buffer so that a client can
 * resume a session it lost track of.
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { BotKind, BotSpec, SessionState } from "./protocol.ts";
import type { EventRing } from "./ring.ts";

export type SessionHooks = {
  /** A stdout line of the child was read. */
  onOutput: (session: Session, payload: unknown) => void;
  /** The session changed its state. */
  onState: (session: Session, state: SessionState) => void;
  /** The child is gone. */
  onExit: (session: Session) => void;
  /** Something went wrong (stderr of the child, spawn failure, ...). */
  onError: (session: Session, message: string) => void;
};

export type SessionOptions = {
  sid: string;
  bot: BotSpec;
  providerSessionId?: string | undefined;
  ring: EventRing;
  now: () => number;
  hooks: SessionHooks;
  env?: Record<string, string> | undefined;
};

/** Default cancel message per bot flavour; the client usually sends its own. */
export function defaultCancelMessage(
  kind: BotKind,
  providerSessionId?: string | undefined,
): unknown {
  switch (kind) {
    case "acp":
      return {
        jsonrpc: "2.0",
        method: "session/cancel",
        params: providerSessionId ? { sessionId: providerSessionId } : {},
      };
    case "codex-app-server":
      return { jsonrpc: "2.0", method: "turn/interrupt", params: {} };
    case "pi-rpc":
      return { jsonrpc: "2.0", method: "abort", params: {} };
    default:
      return { jsonrpc: "2.0", method: "abort", params: {} };
  }
}

/** Turn a raw stdout line into an event payload. */
export function parseOutputLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
}

export class Session {
  readonly sid: string;
  readonly bot: BotSpec;
  readonly ring: EventRing;
  readonly createdAt: number;
  providerSessionId: string | undefined;
  state: SessionState = "starting";
  /** Sequence number of the last event. */
  seq = 0;
  /** Highest sequence number acknowledged by the client. */
  ackedSeq = 0;
  /** Timestamp of the last child output. */
  progressAt: number;
  /** True once the child produced at least one line. */
  hasOutput = false;
  /** True while the session is stalled (no output for too long). */
  stalled = false;
  /** True while a cancel is waiting for an answer of the child. */
  cancelling = false;
  child: ChildProcessWithoutNullStreams | null = null;

  private hooks: SessionHooks;
  private now: () => number;
  private stdoutBuffer = "";
  private timers = new Set<NodeJS.Timeout>();
  private cancelSatisfied = false;
  /** The pending escalation timers of the current cancel. */
  private cancelTimers: NodeJS.Timeout[] = [];
  private disposed = false;

  constructor(options: SessionOptions) {
    this.sid = options.sid;
    this.bot = options.bot;
    this.ring = options.ring;
    this.hooks = options.hooks;
    this.now = options.now;
    this.providerSessionId = options.providerSessionId;
    this.createdAt = options.now();
    this.progressAt = this.createdAt;
  }

  /** True while the child process is running. */
  get isLive(): boolean {
    const child = this.child;
    if (!child) return false;
    return child.exitCode === null && child.signalCode === null;
  }

  /** Milliseconds since the last child output. */
  idleMs(now: number = this.now()): number {
    return Math.max(0, now - this.progressAt);
  }

  /** Spawn the child process. */
  start(): void {
    const [command, ...args] = this.bot.command;
    const child = spawn(command, args, {
      cwd: this.bot.cwd,
      env: { ...process.env, ...(this.optionsEnv()) },
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group: botd can then signal the whole tree.
      detached: true,
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => this.onStderr(chunk));
    child.stdin.on("error", () => {
      // The child may die while we are writing; the exit handler reports it.
    });
    child.on("error", (err: Error) => this.hooks.onError(this, err.message));
    child.on("exit", () => this.onExit());
    this.setState("running");
  }

  /** Forward a raw provider message to the stdin of the child. */
  send(payload: unknown): boolean {
    if (!this.isLive || !this.child) return false;
    let line: string;
    if (typeof payload === "string") {
      line = payload;
    } else {
      try {
        line = JSON.stringify(payload) ?? "null";
      } catch {
        return false;
      }
    }
    try {
      this.child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Cancel the session.
   *
   * The provider specific cancel message is sent to the child first. When the
   * child does not answer within `graceMs` it gets a SIGINT; when it still
   * does not answer `killGraceMs` later the whole process group is killed.
   *
   * A child that answers the cancel (it produces output again) ends the
   * escalation: the session leaves the cancelling state and can be used
   * again. A child that stays silent is escalated as described above.
   */
  requestCancel(
    payload: unknown,
    options: { graceMs: number; killGraceMs: number },
  ): void {
    if (!this.isLive) return;
    this.cancelling = true;
    this.cancelSatisfied = false;
    // A second cancel replaces the escalation of the first one.
    this.clearCancelTimers();
    this.send(payload ?? defaultCancelMessage(this.bot.kind, this.providerSessionId));
    this.setState("paused");

    const grace = setTimeout(() => {
      if (this.cancelSatisfied || !this.isLive) return;
      this.signalGroup("SIGINT");
      const kill = setTimeout(() => {
        if (this.cancelSatisfied || !this.isLive) return;
        this.signalGroup("SIGKILL");
      }, options.killGraceMs);
      this.cancelTimers.push(kill);
      this.addTimer(kill);
    }, options.graceMs);
    this.cancelTimers.push(grace);
    this.addTimer(grace);
  }

  /** Stop the child: SIGTERM first, SIGKILL for the group after the grace. */
  terminate(graceMs: number): void {
    if (!this.child) return;
    this.signalGroup("SIGTERM");
    this.addTimer(
      setTimeout(() => {
        if (this.isLive) this.signalGroup("SIGKILL");
      }, graceMs),
    );
  }

  /** Change the state; the hook is called only on a real change. */
  setState(state: SessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.hooks.onState(this, state);
  }

  /** Release every resource; the child is killed with its process group. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearCancelTimers();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.child) {
      this.child.stdout.removeAllListeners("data");
      this.child.stderr.removeAllListeners("data");
      this.signalGroup("SIGKILL");
      this.child = null;
    }
  }

  private optionsEnv(): Record<string, string> {
    return this.bot.env ?? {};
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const index = this.stdoutBuffer.indexOf("\n");
      if (index === -1) break;
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line.length === 0) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    this.seq += 1;
    const payload = parseOutputLine(line);
    this.ring.push(this.seq, payload);
    this.progressAt = this.now();
    this.hasOutput = true;
    this.stalled = false;
    // The child answered the cancel: it produces output again. The state is
    // cleared before the event goes out, so a client that answers the event
    // with a new message is not refused any more.
    if (this.cancelling) this.onCancelAnswered();
    this.hooks.onOutput(this, payload);
  }

  /**
   * The child answered the cancel: it produces output again.
   *
   * The escalation stops, the session is not cancelling any more and its
   * state goes back to running (the watchdog turns it into idle when the
   * child falls silent).
   */
  private onCancelAnswered(): void {
    this.cancelSatisfied = true;
    this.cancelling = false;
    this.clearCancelTimers();
    this.setState("running");
  }

  private onStderr(chunk: string): void {
    const message = chunk.trim();
    if (message.length === 0) return;
    this.hooks.onError(this, message);
  }

  private onExit(): void {
    // The child is gone: a pending cancel is over.
    this.cancelling = false;
    this.clearCancelTimers();
    // A trailing line without a newline is still an event.
    const rest = this.stdoutBuffer.trim();
    this.stdoutBuffer = "";
    if (rest.length > 0) this.handleLine(rest);
    this.setState("exited");
    this.hooks.onExit(this);
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child || child.pid === undefined) return;
    if (child.pid === process.pid) return;
    try {
      // Negative pid: the whole process group.
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // The child is already gone.
      }
    }
  }

  private addTimer(timer: NodeJS.Timeout): void {
    this.timers.add(timer);
    timer.unref?.();
  }

  /** Drop the pending escalation timers of the current cancel. */
  private clearCancelTimers(): void {
    for (const timer of this.cancelTimers) {
      clearTimeout(timer);
      this.timers.delete(timer);
    }
    this.cancelTimers = [];
  }
}
