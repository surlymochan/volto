/**
 * A minimal frame client for the botd end-to-end tests.
 *
 * The client starts the real daemon (botd/src/main.ts) as a child process
 * and talks to it over stdio with the NDJSON frames of the protocol. Only
 * the frames the tests need are implemented; the client is deliberately
 * small and lives inside botd/e2e, next to the tests that use it.
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { MAIN_TS, delay } from "./support.ts";

/** The frames the daemon sends. */
export type ServerFrame =
  | { op: "hello"; botdVersion: string; leaseId: string; fence: number; leaseTtlMs: number }
  | { op: "event"; sid: string; seq: number; payload: unknown }
  | { op: "state"; sid: string; state: string; progressAt: number }
  | { op: "error"; code: string; message: string; sid?: string }
  | { op: "gap"; sid: string; fromSeq: number; toSeq: number }
  | { op: "stall"; sid: string; idleMs: number };

export type HelloFrame = Extract<ServerFrame, { op: "hello" }>;
export type EventFrame = Extract<ServerFrame, { op: "event" }>;
export type StateFrame = Extract<ServerFrame, { op: "state" }>;
export type ErrorFrame = Extract<ServerFrame, { op: "error" }>;
export type GapFrame = Extract<ServerFrame, { op: "gap" }>;

/** The bot the daemon runs for a session. */
export type BotSpec = {
  kind: "acp" | "codex-app-server" | "pi-rpc";
  command: string[];
  env?: Record<string, string>;
};

export type FrameClientOptions = {
  /** The botd home of the daemon; the session table lives there. */
  home: string;
  /** Extra flags for the daemon (`--watchdog-ms=50` for instance). */
  flags?: string[];
};

/**
 * A client of the daemon.
 *
 * The daemon is a child process: the frames go over its stdin and stdout,
 * the log of the daemon arrives on its stderr.
 */
export class FrameClient {
  /** Every frame the daemon sent so far. */
  readonly frames: ServerFrame[] = [];
  /** The log of the daemon (stderr). */
  readonly logs: string[] = [];

  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private exited = false;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.logs.push(chunk));
    // The daemon may be gone already: a broken pipe is not a test failure.
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.on("exit", () => {
      this.exited = true;
    });
  }

  /** Start the daemon and return the client that talks to it. */
  static start(options: FrameClientOptions): FrameClient {
    const args = [
      ...typeStrippingFlags(),
      MAIN_TS,
      "serve",
      `--home=${options.home}`,
      ...(options.flags ?? []),
    ];
    const child = spawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new FrameClient(child);
  }

  /** Send one frame to the daemon. */
  send(frame: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  /** Take the lease; the answer carries the id and the fence of the lease. */
  async hello(clientId = "client-e2e", leaseTtlMs?: number): Promise<HelloFrame> {
    this.send({
      op: "hello",
      clientId,
      ...(leaseTtlMs === undefined ? {} : { leaseTtlMs }),
    });
    const frame = await this.waitFor((candidate) => candidate.op === "hello", {
      label: "the hello answer",
    });
    if (frame.op !== "hello") throw new Error("unreachable");
    return frame;
  }

  /** Open a session and wait until the bot of the session runs. */
  async open(sid: string, bot: BotSpec, options: { timeoutMs?: number } = {}): Promise<void> {
    this.send({ op: "open", sid, bot });
    await this.waitFor(
      (frame) => frame.op === "state" && frame.sid === sid && frame.state === "running",
      { timeoutMs: options.timeoutMs ?? 5000, label: `the running state of ${sid}` },
    );
  }

  /** The events of a session. */
  events(sid: string): EventFrame[] {
    return this.frames.filter(
      (frame): frame is EventFrame => frame.op === "event" && frame.sid === sid,
    );
  }

  /** The states of a session. */
  states(sid: string): StateFrame[] {
    return this.frames.filter(
      (frame): frame is StateFrame => frame.op === "state" && frame.sid === sid,
    );
  }

  /** The index of the next frame; the frames after the mark are new. */
  mark(): number {
    return this.frames.length;
  }

  /** The frames that arrived after the mark. */
  framesSince(mark: number): ServerFrame[] {
    return this.frames.slice(mark);
  }

  /** Wait for a frame matching the predicate. */
  async waitFor(
    predicate: (frame: ServerFrame) => boolean,
    options: { timeoutMs?: number; label?: string } = {},
  ): Promise<ServerFrame> {
    const timeoutMs = options.timeoutMs ?? 5000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(predicate);
      if (found) return found;
      if (this.exited) {
        throw new Error(
          `the daemon exited while waiting for ${options.label ?? "a frame"}: ${this.logText()}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for ${options.label ?? "a frame"}; got ${JSON.stringify(this.frames)}`,
        );
      }
      await delay(10);
    }
  }

  /** Wait until the session produced at least `count` events. */
  async waitForEvents(
    sid: string,
    count: number,
    options: { timeoutMs?: number } = {},
  ): Promise<EventFrame[]> {
    const timeoutMs = options.timeoutMs ?? 5000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const events = this.events(sid);
      if (events.length >= count) return events;
      if (this.exited) {
        throw new Error(
          `the daemon exited while waiting for ${count} events of ${sid}: ${this.logText()}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for ${count} events of ${sid}; got ${JSON.stringify(events)}`,
        );
      }
      await delay(10);
    }
  }

  /** Kill the daemon: the transport to the host is gone. */
  async killTransport(): Promise<void> {
    this.child.kill("SIGKILL");
    await this.waitForExit();
  }

  /** Stop the daemon and wait for it. */
  async stop(): Promise<void> {
    if (this.exited) return;
    this.child.stdin.end();
    try {
      await this.waitForExit(3000);
    } catch {
      this.child.kill("SIGKILL");
      await this.waitForExit(3000);
    }
  }

  /** Wait until the daemon process is gone. */
  async waitForExit(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.exited) {
      if (Date.now() >= deadline) {
        throw new Error(`the daemon did not stop within ${timeoutMs}ms`);
      }
      await delay(10);
    }
  }

  /** The log of the daemon. */
  logText(): string {
    return this.logs.join("");
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index === -1) break;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length === 0) continue;
      this.frames.push(JSON.parse(line) as ServerFrame);
    }
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
