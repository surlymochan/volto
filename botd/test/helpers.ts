/**
 * Helpers shared by the botd tests.
 *
 * Fixtures are synthetic: the fake child is a tiny local script, the botd
 * home directories live inside the worktree (botd/.tmp) and no host name,
 * address or credential ever shows up here.
 */
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import { Botd } from "../src/daemon.ts";
import type { BotdConfig } from "../src/config.ts";
import type { ClientFrame, ServerFrame } from "../src/protocol.ts";

/** Everything temporary lives inside the worktree, in botd/.tmp. */
const TMP_ROOT = fileURLToPath(new URL("../.tmp/", import.meta.url));

export function makeTempDir(prefix = "botd-"): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(path.join(TMP_ROOT, prefix));
}

/** Absolute path of the fake child fixture. */
export const FAKE_CHILD = fileURLToPath(new URL("./fixtures/fake-child.mjs", import.meta.url));

/** Absolute path of the fake child that answers every message. */
export const ANSWERING_CHILD = fileURLToPath(
  new URL("./fixtures/answering-child.mjs", import.meta.url),
);

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` returns a truthy value, or fail after the timeout. */
export async function waitFor<T>(
  predicate: () => T | undefined | null | false,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${options.label ?? "condition"}`);
    }
    await delay(intervalMs);
  }
}

export type EventFrame = Extract<ServerFrame, { op: "event" }>;
export type StateFrame = Extract<ServerFrame, { op: "state" }>;
export type ErrorFrame = Extract<ServerFrame, { op: "error" }>;
export type GapFrame = Extract<ServerFrame, { op: "gap" }>;
export type HelloFrame = Extract<ServerFrame, { op: "hello" }>;

/** Type guard for event frames. */
export function isEvent(frame: ServerFrame): frame is EventFrame {
  return frame.op === "event";
}

/** Type guard for state frames. */
export function isState(frame: ServerFrame): frame is StateFrame {
  return frame.op === "state";
}

/** Type guard for error frames. */
export function isError(frame: ServerFrame): frame is ErrorFrame {
  return frame.op === "error";
}

/** Type guard for gap frames. */
export function isGap(frame: ServerFrame): frame is GapFrame {
  return frame.op === "gap";
}

/** A client that talks to a daemon over an in-memory NDJSON stream. */
export class TestClient {
  /** Every frame received so far. */
  readonly frames: ServerFrame[] = [];
  private readonly input = new PassThrough();
  private readonly output = new PassThrough();
  private buffer = "";

  constructor(daemon: Botd) {
    daemon.connect(this.input, this.output);
    this.output.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      for (;;) {
        const index = this.buffer.indexOf("\n");
        if (index === -1) break;
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line.length === 0) continue;
        this.frames.push(JSON.parse(line) as ServerFrame);
      }
    });
  }

  /** Send a frame to the daemon. */
  send(frame: ClientFrame | Record<string, unknown>): void {
    this.input.write(`${JSON.stringify(frame)}\n`);
  }

  /** Index of the next frame; frames received after the mark are new. */
  mark(): number {
    return this.frames.length;
  }

  /** Frames received after the given mark. */
  sinceMark(mark: number): ServerFrame[] {
    return this.frames.slice(mark);
  }

  /** Event frames of a session. */
  events(sid: string): EventFrame[] {
    return this.frames.filter((frame) => frame.op === "event" && frame.sid === sid);
  }

  /** State frames of a session. */
  states(sid: string): StateFrame[] {
    return this.frames.filter((frame) => frame.op === "state" && frame.sid === sid);
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
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for ${options.label ?? "frame"}; got ${JSON.stringify(this.frames)}`,
        );
      }
      await delay(10);
    }
  }

  /** Wait for a frame with the given op. */
  async waitForOp(op: ServerFrame["op"], timeoutMs = 5000): Promise<ServerFrame> {
    return this.waitFor((frame) => frame.op === op, { timeoutMs, label: `a ${op} frame` });
  }

  /** Say hello and return the answer of the daemon. */
  async hello(clientId = "client-a", leaseTtlMs?: number): Promise<HelloFrame> {
    this.send({ op: "hello", clientId, ...(leaseTtlMs === undefined ? {} : { leaseTtlMs }) });
    const frame = await this.waitFor((candidate) => candidate.op === "hello", {
      label: "the hello answer",
    });
    assert.equal(frame.op, "hello");
    if (frame.op !== "hello") throw new Error("unreachable");
    return frame;
  }
}

/** Read the lines the fake child logged. */
export function readChildLog(file: string): { event: string; line?: string }[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { event: string; line?: string });
}

/** A daemon plus a connected client. */
export type Harness = {
  daemon: Botd;
  client: TestClient;
  home: string;
  storeFile: string;
};

/** Start a daemon with a client attached and a throw away botd home. */
export function startHarness(config: Partial<BotdConfig> = {}): Harness {
  const home = config.home ?? makeTempDir();
  const storeFile = config.storeFile ?? path.join(home, "sessions.json");
  const daemon = new Botd({ ...config, home, storeFile }, { onFrame: () => {} });
  const client = new TestClient(daemon);
  return { daemon, client, home, storeFile };
}
