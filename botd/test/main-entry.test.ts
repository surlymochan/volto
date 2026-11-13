// Tests for the process entry point of the bot daemon.
//
// The launcher of scripts/install-botd.sh puts botd/src/main.ts on the
// executor host and runs it as
//
//   node --experimental-strip-types <prefix>/app/src/main.ts "$@"
//
// so main.ts is the process an operator sees: its exit code, the split
// between stdout and stderr, the shutdown of the process and the files it
// leaves behind in the botd home are what this suite pins.
//
// The command line itself is covered elsewhere: botd/test/cli-flags.test.ts
// walks the flags of botd/src/cli.ts and botd/test/cli.test.ts covers the
// handshake of the daemon.  Nothing of that is repeated here; this file
// only looks at the entry point as a child process.
//
// Every daemon of the tests gets a home of its own below ./.tmp (the
// scratch directory of the worktree) and every child is killed in the
// cleanup of its test.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BOTD_VERSION } from "../src/protocol.ts";
import { delay, waitFor } from "./helpers.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/** The scratch directory of the worktree: every home of the tests lives here. */
const TMP_ROOT = path.join(".tmp");

/** What a finished child wrote and how it ended. */
type Run = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

/** A child of the entry point and the output it produced so far. */
type Main = {
  child: ChildProcessWithoutNullStreams;
  /** Resolves when the child is gone. */
  done: Promise<Run>;
  stdout(): string;
  stderr(): string;
};

/** A fresh home for a daemon; the path is relative to the worktree. */
function makeHome(): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(path.join(TMP_ROOT, "t-"));
}

/**
 * Start the entry point with the given arguments.
 *
 * The home is passed twice: as the `--home` flag of the command and as the
 * `BOTD_HOME` of the environment, so a daemon that ignores the flag still
 * writes into the throw away home of the test and never into the home of
 * the user.
 */
function startMain(args: string[], home: string): Main {
  const child = spawn(process.execPath, [MAIN, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BOTD_HOME: path.resolve(home), NODE_NO_WARNINGS: "1" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<Run>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done, stdout: () => stdout, stderr: () => stderr };
}

/**
 * Wait for the child to be gone.
 *
 * Resolves with null when the child is still alive after the timeout: a
 * daemon that does not stop is a defect, not a hang of the suite.
 */
async function closeWithin(main: Main, timeoutMs: number): Promise<Run | null> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([main.done, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The files of a home that look like a socket, a pid file or a lock. */
function artefacts(home: string): string[] {
  return readdirSync(home).filter((name) => /(sock|pid|lock)/i.test(name));
}

test("--help prints the usage on stdout and exits 0", async (t) => {
  const home = makeHome();
  const main = startMain(["--help"], home);
  t.after(() => {
    main.child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });

  const run = await main.done;
  assert.equal(run.code, 0);
  assert.equal(run.stderr, "", "the usage goes to stdout, not to stderr");
  assert.match(run.stdout, /Usage:/);
  assert.match(run.stdout, /botd serve \[options\]/);
});

test("the version command prints the version and exits 0", async (t) => {
  const home = makeHome();
  const main = startMain(["version"], home);
  t.after(() => {
    main.child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });

  const run = await main.done;
  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  assert.equal(run.stdout, `${BOTD_VERSION}\n`);
});

test("an unknown flag is refused on stderr with a non-zero exit code", async (t) => {
  t.todo("the entry point ignores an unknown flag: it starts the daemon instead of refusing it");
  const home = makeHome();
  const main = startMain(["--nope=1"], home);
  t.after(() => {
    main.child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });

  const run = await closeWithin(main, 2000);
  assert.notEqual(run, null, "the daemon refuses the unknown flag instead of serving");
  assert.notEqual(run?.code, 0, "the refusal has a non-zero exit code");
  assert.match(main.stderr(), /--nope/, "the stderr names the unknown flag");
});

test("a clean SIGTERM shutdown exits 0 within 5 s", async (t) => {
  t.todo("the SIGTERM handler closes the daemon but never exits the process");
  const home = makeHome();
  const main = startMain(["serve", `--home=${home}`], home);
  t.after(() => {
    main.child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });

  // The daemon is up and answers a hello.
  main.child.stdin.write(`${JSON.stringify({ op: "hello", clientId: "client-a" })}\n`);
  await waitFor(() => main.stdout().includes('"op":"hello"'), {
    label: "the hello answer",
  });

  main.child.kill("SIGTERM");
  const run = await closeWithin(main, 5000);
  assert.notEqual(run, null, "the daemon is gone 5 s after the SIGTERM");
  assert.equal(run?.code, 0, "the clean shutdown exits 0");
});

test("a clean shutdown leaves no socket or pid artefact in the home", async (t) => {
  const home = makeHome();
  const main = startMain(["serve", `--home=${home}`], home);
  t.after(() => {
    main.child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });

  main.child.stdin.write(`${JSON.stringify({ op: "hello", clientId: "client-a" })}\n`);
  await waitFor(() => main.stdout().includes('"op":"hello"'), {
    label: "the hello answer",
  });

  // The client goes away: the daemon stops by itself.
  main.child.stdin.end();
  const run = await closeWithin(main, 5000);
  assert.equal(run?.code, 0, "the daemon exits 0 when the client goes away");
  assert.deepEqual(
    artefacts(home),
    [],
    "the daemon leaves no socket or pid artefact behind in the home",
  );
});

test("the session table of the daemon stays in the home it was given", async (t) => {
  const home = makeHome();
  const main = startMain(["serve", `--home=${home}`], home);
  t.after(() => {
    main.child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });

  main.child.stdin.write(`${JSON.stringify({ op: "hello", clientId: "client-a" })}\n`);
  await waitFor(() => main.stdout().includes('"op":"hello"'), {
    label: "the hello answer",
  });
  main.child.stdin.end();
  await closeWithin(main, 5000);

  const table = path.join(home, "sessions.json");
  assert.ok(existsSync(table), "the session table is written into the home of the daemon");
  assert.deepEqual(artefacts(home), [], "the home holds the session table and nothing else");
});

test("a second instance on the same home fails with a clear message instead of hanging", async (t) => {
  t.todo("the daemon has no single instance lock: the second instance serves next to the first one");
  const home = makeHome();
  const first = startMain(["serve", `--home=${home}`], home);
  const second = startMain(["serve", `--home=${home}`], home);
  t.after(() => {
    first.child.kill("SIGKILL");
    second.child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });

  // The first instance is up.
  first.child.stdin.write(`${JSON.stringify({ op: "hello", clientId: "client-a" })}\n`);
  await waitFor(() => first.stdout().includes('"op":"hello"'), {
    label: "the hello answer of the first instance",
  });

  const run = await closeWithin(second, 2000);
  assert.notEqual(run, null, "the second instance gives up instead of serving");
  assert.notEqual(run?.code, 0, "the refusal of the second instance has a non-zero exit code");
  assert.match(
    second.stderr(),
    /already running|another instance|lock/i,
    "the stderr explains that the home is taken",
  );
});
