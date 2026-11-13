// Process-level shutdown tests for the installed entry point.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { FAKE_CHILD, waitFor } from "./helpers.ts";

function start(t: TestContext, command = "serve") {
  mkdirSync(".tmp", { recursive: true });
  const home = mkdtempSync(".tmp/cli-signals-");
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["botd/src/main.ts", command, `--home=${home}`], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  t.after(() => {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });
  child.stdin.on("error", () => {});
  let stdout = "";
  let stderr = "";
  const frames: Record<string, unknown>[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) if (line) frames.push(JSON.parse(line));
  });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const send = (frame: object) => child.stdin.write(`${JSON.stringify(frame)}\n`);
  const ready = async () => {
    send({ op: "hello", clientId: "client-a" });
    await waitFor(() => frames.find((frame) => frame.op === "hello"), { label: "hello" });
  };
  return { child, home, frames, exited, send, ready, output: () => ({ stdout, stderr }) };
}

async function exitWithin(run: ReturnType<typeof start>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("daemon did not exit within 5 seconds")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function openSession(t: TestContext, run: ReturnType<typeof start>): Promise<number> {
  const pidFile = path.resolve(run.home, "child.pid");
  // The wrapper records its PID and then loads the long-running fake child in
  // the same process, preserving the process group created by the daemon.
  const script = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); import(${JSON.stringify(FAKE_CHILD)})`;
  run.send({ op: "open", sid: "session-a", bot: { kind: "acp", command: [process.execPath, "-e", script] } });
  const pid = await waitFor(() => {
    try { return Number(readFileSync(pidFile, "utf8")) || undefined; } catch { return undefined; }
  }, { label: "child PID" });
  t.after(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  });
  run.send({ op: "send", sid: "session-a", payload: { cmd: "hang" } });
  return pid;
}

function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
}

test("stdin EOF exits the main entry point cleanly", async (t) => {
  const run = start(t);
  await run.ready();
  run.child.stdin.end();
  assert.deepEqual(await exitWithin(run), { code: 0, signal: null });
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`${signal} exits the main entry point cleanly`, async (t) => {
    const run = start(t);
    await run.ready();
    run.child.kill(signal);
    // A handled signal should result in a normal exit, not a signal death.
    assert.deepEqual(await exitWithin(run), { code: 0, signal: null });
  });
}

test("shutdown kills an open session's process group", async (t) => {
  const run = start(t);
  await run.ready();
  const pid = await openSession(t, run);
  assert.equal(gone(pid), false);
  run.child.stdin.end();
  assert.deepEqual(await exitWithin(run), { code: 0, signal: null });
  await waitFor(() => gone(pid), { timeoutMs: 5000, label: "child process to disappear" });
});

test("a second SIGTERM during shutdown does not hang", async (t) => {
  const run = start(t);
  await run.ready();
  await openSession(t, run);
  run.child.kill("SIGTERM");
  run.child.kill("SIGTERM");
  assert.deepEqual(await exitWithin(run), { code: 0, signal: null });
});

test("the main entry point rejects an unknown command without stdout", async (t) => {
  const run = start(t, "unknown-command");
  assert.deepEqual(await exitWithin(run), { code: 2, signal: null });
  assert.equal(run.output().stdout, "");
  assert.match(run.output().stderr, /unknown command/);
});
