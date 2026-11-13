import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { FALLBACK_DIRS, resolveBinary } from "../lib/binary.mjs";
import { runCommand, spawnChild } from "../lib/process.mjs";

function fixture(t) {
  mkdirSync(".tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), ".tmp", "binary-process-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;

function executable(path, body = "#!/bin/sh\nexit 0\n") {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

test("executable override wins over PATH", (t) => {
  const dir = fixture(t);
  const override = executable(join(dir, "override"));
  executable(join(dir, "bot"));
  assert.deepEqual(resolveBinary("bot", { env: { PATH: dir, VOLTO_PROBE_BOT_BIN: override }, extraDirs: [] }),
    { path: override, source: "env:VOLTO_PROBE_BOT_BIN", searched: [override] });
});

test("missing override is authoritative", (t) => {
  const dir = fixture(t);
  executable(join(dir, "bot"));
  const missing = join(dir, "missing");
  assert.deepEqual(resolveBinary("bot", { env: { PATH: dir, VOLTO_PROBE_BOT_BIN: missing }, extraDirs: [] }),
    { path: null, source: "missing", searched: [missing] });
});

test("non-executable override is authoritative", (t) => {
  const dir = fixture(t);
  executable(join(dir, "bot"));
  const override = join(dir, "override");
  writeFileSync(override, "no", { mode: 0o644 });
  assert.deepEqual(resolveBinary("bot", { env: { PATH: dir, VOLTO_PROBE_BOT_BIN: override }, extraDirs: [] }),
    { path: null, source: "missing", searched: [override] });
});

test("override key normalizes punctuation and case", (t) => {
  const dir = fixture(t);
  const override = executable(join(dir, "override"));
  assert.equal(resolveBinary("my-bot.cli", { env: { VOLTO_PROBE_MY_BOT_CLI_BIN: override } }).source, "env:VOLTO_PROBE_MY_BOT_CLI_BIN");
});

test("PATH searches directories in order and stops at the first executable", (t) => {
  const dir = fixture(t);
  const first = join(dir, "first");
  const second = join(dir, "second");
  mkdirSync(first); mkdirSync(second);
  executable(join(first, "bot")); executable(join(second, "bot"));
  assert.deepEqual(resolveBinary("bot", { env: { PATH: `${first}:${second}` }, extraDirs: [] }),
    { path: join(first, "bot"), source: "path", searched: [join(first, "bot")] });
});

test("empty PATH entries are ignored and extra directories follow PATH", (t) => {
  const dir = fixture(t);
  const pathDir = join(dir, "path");
  const extra = join(dir, "extra");
  mkdirSync(pathDir); mkdirSync(extra);
  executable(join(extra, "bot"));
  assert.deepEqual(resolveBinary("bot", { env: { PATH: `:${pathDir}::` }, extraDirs: [extra] }),
    { path: join(extra, "bot"), source: "path", searched: [join(pathDir, "bot"), join(extra, "bot")] });
});

test("non-executable candidates are skipped and all attempts are recorded", (t) => {
  const dir = fixture(t);
  const first = join(dir, "first");
  const second = join(dir, "second");
  mkdirSync(first); mkdirSync(second);
  writeFileSync(join(first, "bot"), "no", { mode: 0o644 });
  assert.deepEqual(resolveBinary("bot", { env: { PATH: first }, extraDirs: [second] }),
    { path: null, source: "missing", searched: [join(first, "bot"), join(second, "bot")] });
});

test("default fallback directories are searched after PATH", () => {
  const name = `volto-missing-${process.pid}`;
  assert.deepEqual(resolveBinary(name, { env: { PATH: "" } }).searched, FALLBACK_DIRS.map((dir) => join(dir, name)));
});

test("spawnChild splits both streams and flushes partial lines on close", async (t) => {
  const dir = fixture(t);
  const script = executable(join(dir, "lines"), "#!/bin/sh\nprintf out; printf err >&2; sleep 0.03; printf ' one\\nout tail'; printf ' one\\nerr tail' >&2\n");
  const stdout = []; const stderr = [];
  const child = spawnChild({ command: script, env: childEnv, onStdoutLine: (line) => stdout.push(line), onStderrLine: (line) => stderr.push(line) });
  t.after(() => child.kill());
  assert.deepEqual(await child.exited, { code: 0, signal: null, timedOut: false });
  assert.deepEqual(stdout, ["out one", "out tail"]);
  assert.deepEqual(stderr, ["err one", "err tail"]);
});

test("spawnChild reports exit codes and permits killing an exited child", async (t) => {
  const dir = fixture(t);
  const child = spawnChild({ command: executable(join(dir, "exit"), "#!/bin/sh\nexit 7\n") });
  assert.deepEqual(await child.exited, { code: 7, signal: null, timedOut: false });
  assert.doesNotThrow(() => child.kill());
});

test("kill terminates the process group including a grandchild", { timeout: 2000 }, async (t) => {
  const dir = fixture(t);
  const script = executable(join(dir, "group"), "#!/bin/sh\nsleep 30 &\npid=$!\ntrap 'wait $pid; exit 0' TERM\nprintf '%s\\n' \"$pid\"\nwait $pid\n");
  let resolvePid;
  const pid = new Promise((resolve) => { resolvePid = resolve; });
  const child = spawnChild({ command: script, env: childEnv, onStdoutLine: (line) => resolvePid(Number(line)) });
  t.after(() => child.kill("SIGKILL"));
  const grandchild = await Promise.race([pid, child.exited.then(() => { throw new Error("child exited before reporting its grandchild"); })]);
  t.after(() => { try { process.kill(grandchild, "SIGKILL"); } catch {} });
  child.kill();
  assert.deepEqual(await child.exited, { code: 0, signal: null, timedOut: false });
  assert.throws(() => process.kill(grandchild, 0), { code: "ESRCH" });
});

test("spawnChild reports a terminating signal", async (t) => {
  const dir = fixture(t);
  const child = spawnChild({ command: executable(join(dir, "signal"), "#!/bin/sh\nkill -TERM $$\n") });
  t.after(() => child.kill());
  assert.deepEqual(await child.exited, { code: null, signal: "SIGTERM", timedOut: false });
});

test("runCommand captures output and exit code", async (t) => {
  const dir = fixture(t);
  const result = await runCommand({ command: executable(join(dir, "short"), "#!/bin/sh\nprintf out; printf err >&2; exit 4\n") });
  assert.deepEqual(result, { code: 4, signal: null, stdout: "out", stderr: "err", timedOut: false });
});

test("runCommand reports a timeout and captures output", async (t) => {
  const dir = fixture(t);
  const script = executable(join(dir, "timeout"), "#!/bin/sh\nprintf out; printf err >&2; exec sleep 30\n");
  const result = await runCommand({ command: script, env: childEnv, timeoutMs: 300 });
  assert.deepEqual(result, { code: null, signal: "SIGKILL", stdout: "out", stderr: "err", timedOut: true });
});
