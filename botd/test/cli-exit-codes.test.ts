// Process level tests of the exit codes of the botd entry point.
//
// The daemon is started the way an executor host starts it:
// `node botd/src/main.ts [command] [flags]`. Only the paths that end the
// process are exercised here.
//
// The cases of botd/test/cli.test.ts and botd/test/cli-flags.test.ts are not
// repeated: those files cover the frames of the `serve` path, the version
// command, the usage on stderr and the default command. This file covers
// what is left of the command line: the exact bytes of the version and of
// the usage, the flags the configuration ignores and the flags it does not
// know at all.
//
// Every child gets a throw away home inside botd/.tmp, so the session table
// of a test never lands in the home directory of the user. All the data is
// synthetic: no host name, no address, no credential.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BOTD_VERSION } from "../src/protocol.ts";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import { makeTempDir } from "./helpers.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const CONFIG = fileURLToPath(new URL("../src/config.ts", import.meta.url));

type Run = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

/** The inherited environment without BOTD_* settings (BOTD_STORE_FILE etc. would override the throw away home). */
function scrubbedEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("BOTD_")));
}

/** Run the entry point with a throw away home and collect everything it writes. */
function runCli(args: string[], home: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...scrubbedEnv(), BOTD_HOME: home, NODE_NO_WARNINGS: "1" },
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
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
    // The client is gone right away: the daemon stops on its own.
    child.stdin.end();
  });
}

/** The usage of the command line, as it is written down in cli.ts. */
function usageFromSource(): string {
  const source = readFileSync(CLI, "utf8");
  const match = /const USAGE = `([\s\S]*?)`;/.exec(source);
  if (!match) throw new Error("the usage was not found in cli.ts");
  return match[1].replace("${BOTD_VERSION}", BOTD_VERSION);
}

/** The flags the usage mentions. */
function usageFlags(usage: string): string[] {
  return [...usage.matchAll(/--([a-z-]+)=/g)].map((match) => match[1]);
}

/** Fail when an output of the daemon carries a stack trace. */
function assertNoStackTrace(run: Run): void {
  for (const [name, output] of [
    ["stdout", run.stdout],
    ["stderr", run.stderr],
  ] as const) {
    assert.ok(!output.includes("    at "), `${name} carries a stack trace:\n${output}`);
  }
}

test("--version prints the version and a newline on stdout and nothing on stderr", async () => {
  const home = makeTempDir("cli-exit-");
  const run = await runCli(["--version"], home);
  assert.equal(run.code, 0);
  assert.equal(run.stdout, `${BOTD_VERSION}\n`);
  assert.equal(run.stderr, "");
  assertNoStackTrace(run);
});

test("the version command prints the version and a newline on stdout and nothing on stderr", async () => {
  const home = makeTempDir("cli-exit-");
  const run = await runCli(["version"], home);
  assert.equal(run.code, 0);
  assert.equal(run.stdout, `${BOTD_VERSION}\n`);
  assert.equal(run.stderr, "");
  assertNoStackTrace(run);
});

test("the help command prints the usage of the command line on stdout", async () => {
  const home = makeTempDir("cli-exit-");
  const run = await runCli(["help"], home);
  assert.equal(run.code, 0);
  assert.equal(run.stdout, usageFromSource());
  assert.equal(run.stderr, "");
  assertNoStackTrace(run);
});

test("an unknown command next to a flag exits 2 and keeps stdout clean", async () => {
  const home = makeTempDir("cli-exit-");
  const run = await runCli(["bogus", "--not-a-flag"], home);
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /unknown command bogus/);
  assertNoStackTrace(run);
});

test("the version flag is answered before an unknown command is looked at", async () => {
  // The flags of the entry point are global: they are answered before the
  // command is parsed, so `botd bogus --version` prints the version and ends
  // with 0 instead of complaining about the command.
  const home = makeTempDir("cli-exit-");
  const run = await runCli(["bogus", "--version"], home);
  assert.equal(run.code, 0);
  assert.equal(run.stdout, `${BOTD_VERSION}\n`);
  assert.equal(run.stderr, "");
  assertNoStackTrace(run);
});

test("an unknown flag is ignored and the daemon starts anyway", async () => {
  const home = makeTempDir("cli-exit-");
  const run = await runCli(["serve", "--not-a-flag=1"], home);
  assert.equal(run.code, 0);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "");
  assertNoStackTrace(run);
  // The daemon ran: the session table landed in the throw away home.
  assert.equal(existsSync(path.join(home, "sessions.json")), true);
});

test("a flag without a value is ignored", async () => {
  const home = makeTempDir("cli-exit-");
  const run = await runCli(["serve", "--cancel-grace-ms"], home);
  assert.equal(run.code, 0);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "");
  assertNoStackTrace(run);
  assert.equal(existsSync(path.join(home, "sessions.json")), true);
  // The configuration keeps the default of the flag.
  const config = loadConfig(["--cancel-grace-ms"], {});
  assert.equal(config.cancelGraceMs, DEFAULT_CONFIG.cancelGraceMs);
});

test("a flag with a non numeric value is ignored", async () => {
  const home = makeTempDir("cli-exit-");
  const run = await runCli(["serve", "--cancel-grace-ms=abc"], home);
  assert.equal(run.code, 0);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "");
  assertNoStackTrace(run);
  assert.equal(existsSync(path.join(home, "sessions.json")), true);
  // The configuration keeps the default of the flag.
  const config = loadConfig(["--cancel-grace-ms=abc"], {});
  assert.equal(config.cancelGraceMs, DEFAULT_CONFIG.cancelGraceMs);
});

test("a flag with a negative value is taken as it is", async () => {
  const home = makeTempDir("cli-exit-");
  const run = await runCli(["serve", "--cancel-grace-ms=-5"], home);
  assert.equal(run.code, 0);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "");
  assertNoStackTrace(run);
  assert.equal(existsSync(path.join(home, "sessions.json")), true);
  // The configuration does not range check the numbers it reads.
  const config = loadConfig(["--cancel-grace-ms=-5"], {});
  assert.equal(config.cancelGraceMs, -5);
});

test("every flag of the usage is accepted by the configuration", () => {
  const usage = usageFromSource();
  const config = readFileSync(CONFIG, "utf8");
  const flags = usageFlags(usage);

  // Every flag of the usage is known to the configuration.
  for (const flag of flags) {
    assert.ok(
      config.includes(`flags.get("${flag}")`),
      `the flag --${flag} of the usage is not read by config.ts`,
    );
  }

  // Every flag of the usage really changes the configuration.
  const cases: Record<string, { key: string; value: string; expected: unknown }> = {
    home: { key: "home", value: "synthetic-home", expected: path.resolve("synthetic-home") },
    "store-file": {
      key: "storeFile",
      value: "synthetic-store.json",
      expected: path.resolve("synthetic-store.json"),
    },
    "lease-ttl-ms": { key: "leaseTtlMs", value: "4321", expected: 4321 },
    "ring-max-events": { key: "ringMaxEvents", value: "4321", expected: 4321 },
    "ring-max-bytes": { key: "ringMaxBytes", value: "4321", expected: 4321 },
    "idle-ms": { key: "idleAfterMs", value: "4321", expected: 4321 },
    "stall-ms": { key: "stallMs", value: "4321", expected: 4321 },
    "watchdog-ms": { key: "watchdogIntervalMs", value: "4321", expected: 4321 },
    "cancel-grace-ms": { key: "cancelGraceMs", value: "4321", expected: 4321 },
    "cancel-kill-grace-ms": { key: "cancelKillGraceMs", value: "4321", expected: 4321 },
    "terminate-grace-ms": { key: "terminateGraceMs", value: "4321", expected: 4321 },
  };
  assert.deepEqual([...flags].sort(), Object.keys(cases).sort());

  for (const [flag, testCase] of Object.entries(cases)) {
    const loaded = loadConfig([`--${flag}=${testCase.value}`], {}) as unknown as Record<
      string,
      unknown
    >;
    assert.equal(loaded[testCase.key], testCase.expected, `--${flag} was not taken over`);
  }
});

test("no path of the command line writes a stack trace", async () => {
  const home = makeTempDir("cli-exit-");
  const runs: [string[], Run][] = [];
  for (const args of [
    ["--version"],
    ["version"],
    ["help"],
    ["--help"],
    ["bogus"],
    ["bogus", "--not-a-flag"],
    ["serve", "--not-a-flag=1"],
    ["serve", "--cancel-grace-ms"],
    ["serve", "--cancel-grace-ms=abc"],
    ["serve", "--cancel-grace-ms=-5"],
  ]) {
    runs.push([args, await runCli(args, home)]);
  }

  for (const [args, run] of runs) {
    assertNoStackTrace(run);
    // The process ended on its own, it was not killed by a signal.
    assert.equal(run.signal, null, `botd ${args.join(" ")} died on a signal`);
  }
});
