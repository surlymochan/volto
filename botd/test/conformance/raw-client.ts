/**
 * A raw NDJSON client for the conformance tests.
 *
 * The conformance tests drive the daemon with the bytes of the wire: the
 * frames are written as they travel (blank lines, broken JSON, a line above
 * the size limit) and the frames that come back are parsed as they arrive.
 * The daemon itself comes from the shared harness (botd/test/helpers.ts).
 *
 * The client never rewrites a line: what the test writes is what the daemon
 * reads.
 */
import { PassThrough } from "node:stream";

import type { Botd } from "../../src/daemon.ts";
import type { ServerFrame } from "../../src/protocol.ts";
import { delay } from "../helpers.ts";

/** A frame of the daemon; the unknown fields are kept. */
export type RawFrame = ServerFrame & Record<string, unknown>;

/** Options of the wait helpers. */
export type WaitOptions = { timeoutMs?: number; label?: string };

export class RawClient {
  /** Every frame the daemon sent so far. */
  readonly frames: RawFrame[] = [];
  /** The raw lines the daemon sent, before the JSON parse. */
  readonly lines: string[] = [];

  private readonly input = new PassThrough();
  private readonly output = new PassThrough();
  private buffer = "";

  constructor(daemon: Botd) {
    daemon.connect(this.input, this.output);
    this.output.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  /** Write raw bytes to the daemon. */
  writeRaw(text: string): void {
    this.input.write(text);
  }

  /** Write one raw line; the newline is added. */
  writeLine(line: string): void {
    this.input.write(`${line}\n`);
  }

  /** Write a frame as one NDJSON line. */
  send(frame: Record<string, unknown>): void {
    this.writeLine(JSON.stringify(frame));
  }

  /** Index of the next frame; the frames after the mark are new. */
  mark(): number {
    return this.frames.length;
  }

  /** The frames that arrived after the mark. */
  sinceMark(mark: number): RawFrame[] {
    return this.frames.slice(mark);
  }

  /** The frames with the given op. */
  withOp(op: string): RawFrame[] {
    return this.frames.filter((frame) => frame.op === op);
  }

  /** The error frames with the given code. */
  errors(code: string): RawFrame[] {
    return this.frames.filter((frame) => frame.op === "error" && frame.code === code);
  }

  /** Wait for a frame matching the predicate. */
  async waitFor(
    predicate: (frame: RawFrame) => boolean,
    options: WaitOptions = {},
  ): Promise<RawFrame> {
    const timeoutMs = options.timeoutMs ?? 5000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(predicate);
      if (found) return found;
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for ${options.label ?? "a frame"}; got ${JSON.stringify(this.frames)}`,
        );
      }
      await delay(10);
    }
  }

  /** Wait for a frame with the given op. */
  async waitForOp(op: string, options: WaitOptions = {}): Promise<RawFrame> {
    return this.waitFor((frame) => frame.op === op, {
      ...options,
      label: options.label ?? `a ${op} frame`,
    });
  }

  /** Wait for an error frame with the given code. */
  async waitForError(code: string, options: WaitOptions = {}): Promise<RawFrame> {
    return this.waitFor((frame) => frame.op === "error" && frame.code === code, {
      ...options,
      label: options.label ?? `the error ${code}`,
    });
  }

  /** Wait a moment and return the frames that arrived meanwhile. */
  async collect(ms = 100): Promise<RawFrame[]> {
    const mark = this.mark();
    await delay(ms);
    return this.sinceMark(mark);
  }

  /** Close the connection. */
  close(): void {
    this.input.end();
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index === -1) break;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length === 0) continue;
      this.lines.push(line);
      this.frames.push(JSON.parse(line) as RawFrame);
    }
  }
}
