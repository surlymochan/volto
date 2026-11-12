// probes/lib/process.mjs
//
// Small helpers to spawn bot CLIs with a hard timeout and to capture the
// output of short-lived commands (version / login checks).

import { spawn } from "node:child_process";
import { createLineSplitter } from "./jsonl.mjs";

/**
 * @typedef {Object} Spawned
 * @property {import("node:child_process").ChildProcess} child
 * @property {(signal?: NodeJS.Signals) => void} kill
 * @property {Promise<{ code: number|null, signal: string|null, timedOut: boolean }>} exited
 */

/**
 * Spawn a long-lived child process. The whole process group is killed when
 * `kill()` is called so that helper processes do not survive the probe.
 *
 * @param {{
 *   command: string,
 *   args?: string[],
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   onStdoutLine?: (line: string) => void,
 *   onStderrLine?: (line: string) => void,
 * }} options
 * @returns {Spawned}
 */
export function spawnChild(options) {
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  const outSplitter = createLineSplitter((line) => options.onStdoutLine?.(line));
  const errSplitter = createLineSplitter((line) => options.onStderrLine?.(line));

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => outSplitter.push(chunk));
  child.stderr.on("data", (chunk) => errSplitter.push(chunk));

  const exited = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      outSplitter.flush();
      errSplitter.flush();
      resolve({ code, signal, timedOut: false });
    });
  });

  return {
    child,
    exited,
    kill(signal = "SIGTERM") {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    },
  };
}

/**
 * Run a short command and capture its output.
 *
 * @param {{
 *   command: string,
 *   args?: string[],
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 * }} options
 */
export function runCommand(options) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  return new Promise((resolve) => {
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr: stderr + String(error), timedOut });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}
