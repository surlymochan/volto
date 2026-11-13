import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { SpawnSpec } from "./adapter-types.ts";

export type SupervisorOptions = {
  spec: SpawnSpec;
  spawn?: (spec: SpawnSpec) => ChildProcess;
  baseMs?: number;
  maxMs?: number;
  /** Fractional jitter: 0 disables it, 1 permits delays from zero to twice the base. */
  jitter?: number;
  random?: () => number;
  maxRestarts?: number;
  windowMs?: number;
  healthyMs?: number;
  graceMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

/** Supervises one adapter. All exits are unexpected unless stop() was requested. */
export class Supervisor extends EventEmitter {
  child: ChildProcess | null = null;
  private options: SupervisorOptions;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private restarts: number[] = [];
  private attempts = 0;

  constructor(options: SupervisorOptions) {
    super();
    this.options = options;
  }

  start(): void {
    if (!this.stopped || this.child) return;
    this.stopped = false;
    this.restarts = [];
    this.attempts = 0;
    this.launch();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clear(this.timer);
    this.timer = null;
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    // An injected child may emit exit synchronously from kill().
    if (this.child !== child) return;
    this.killTimer = this.schedule(() => {
      this.killTimer = null;
      if (this.child === child) child.kill("SIGKILL");
    }, this.options.graceMs ?? 5000);
  }

  private launch(): void {
    if (this.stopped) return;
    let child: ChildProcess;
    try {
      child = (this.options.spawn ?? ((spec) => {
        const [command, ...args] = spec.command;
        return spawn(command, args, { cwd: spec.cwd, env: { ...process.env, ...spec.env } });
      }))(this.options.spec);
    } catch (error) {
      this.onGone(null, null, error);
      return;
    }
    this.child = child;
    const startedAt = (this.options.now ?? Date.now)();
    let gone = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: unknown) => {
      if (gone) return;
      gone = true;
      if (this.child === child) this.child = null;
      this.onGone(code, signal, error, startedAt);
    };
    child.once("error", (error) => finish(null, null, error));
    child.once("exit", (code, signal) => finish(code, signal));
    this.emit("started", child);
  }

  private onGone(code: number | null, signal: NodeJS.Signals | null, error?: unknown, startedAt?: number): void {
    this.clear(this.killTimer);
    this.killTimer = null;
    this.emit("exited", { code, signal, error });
    if (this.stopped) return;
    const now = (this.options.now ?? Date.now)();
    if (startedAt !== undefined && now - startedAt >= (this.options.healthyMs ?? this.options.windowMs ?? 60000)) {
      this.attempts = 0;
    }
    this.restarts = this.restarts.filter((time) => now - time < (this.options.windowMs ?? 60000));
    if (this.restarts.length >= (this.options.maxRestarts ?? 5)) {
      this.stopped = true;
      this.emit("failed", error ?? new Error("restart limit exceeded"));
      return;
    }
    this.restarts.push(now);
    const base = Math.min(this.options.maxMs ?? 30000, (this.options.baseMs ?? 1000) * 2 ** this.attempts++);
    const jitter = this.options.jitter ?? 0;
    const delay = Math.max(0, Math.min(this.options.maxMs ?? 30000, base * (1 + jitter * (2 * (this.options.random ?? Math.random)() - 1))));
    this.emit("restarting", { delay, attempt: this.attempts });
    if (this.stopped) return;
    this.timer = this.schedule(() => { this.timer = null; this.launch(); }, delay);
  }

  private schedule(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    return (this.options.setTimer ?? setTimeout)(fn, ms);
  }

  private clear(timer: ReturnType<typeof setTimeout> | null): void {
    if (timer !== null) (this.options.clearTimer ?? clearTimeout)(timer);
  }
}
