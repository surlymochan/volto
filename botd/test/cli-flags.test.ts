// Tests for the command line of the daemon entry point.
//
// The daemon is started as a child process, the way an executor host
// starts it: `node botd/src/cli.ts [command] [flags]`. Every child gets a
// throw away BOTD_HOME, so the session table of a test never lands in the
// home directory of the user.
//
// The cases of botd/test/cli.test.ts are not repeated here: that file
// covers the `version` command, the `serve` command with an explicit
// `--home` and the main entry point. This file covers the flags and the
// commands around them.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BOTD_VERSION } from "../src/protocol.ts";
import { makeTempDir, waitFor } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const CONFIG = fileURLToPath(new URL("../src/config.ts", import.meta.url));

type Run = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

/** Run the CLI with a throw away home and collect everything it writes. */
function runCli(args: string[], home: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, BOTD_HOME: home, NODE_NO_WARNINGS: "1" },
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
    child.stdin.end();
  });
}

test("--version prints the version", async () => {
  const home = makeTempDir("cli-flags-");
  const run = await runCli(["--version"], home);
  assert.equal(run.code, 0);
  assert.equal(run.stdout.trim(), BOTD_VERSION);
  assert.equal(run.stderr, "");
});

test("--version next to serve prints the version", async () => {
  const home = makeTempDir("cli-flags-");
  const run = await runCli(["serve", "--version"], home);
  assert.equal(run.code, 0);
  assert.equal(run.stdout.trim(), BOTD_VERSION);
  assert.equal(run.stderr, "");
  // The daemon did not start: no session table was written.
  assert.equal(existsSync(path.join(home, "sessions.json")), false);
});

test("help prints the usage and exits 0", async () => {
  const home = makeTempDir("cli-flags-");
  const run = await runCli(["help"], home);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /Usage:/);
  assert.match(run.stdout, /botd serve \[options\]/);
  assert.match(run.stdout, /botd version/);
  assert.match(run.stdout, /botd help/);
  assert.equal(run.stderr, "");
});

test("--help prints the same usage as help", async () => {
  const home = makeTempDir("cli-flags-");
  const run = await runCli(["--help"], home);
  const help = await runCli(["help"], home);
  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  assert.match(run.stdout, /Usage:/);
  assert.equal(run.stdout, help.stdout);
});

test("an unknown command prints the usage on stderr and exits 2", async () => {
  const home = makeTempDir("cli-flags-");
  const run = await runCli(["bogus"], home);
  const help = await runCli(["help"], home);
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /unknown command bogus/);
  assert.match(run.stderr, /Usage:/);
  // The usage on stderr is the usage of the help command.
  assert.ok(
    run.stderr.includes(help.stdout),
    "the usage on stderr differs from the usage of the help command",
  );
});

test("the default command is serve", async () => {
  const home = makeTempDir("cli-flags-");
  const child = spawn(process.execPath, [CLI], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BOTD_HOME: home, NODE_NO_WARNINGS: "1" },
  });
  const frames: Record<string, unknown>[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) frames.push(JSON.parse(line));
    }
  });
  const closed = new Promise<number | null>((resolve) => {
    child.on("close", (code) => {
      resolve(code);
    });
  });

  child.stdin.write(`${JSON.stringify({ op: "hello", clientId: "client-a" })}\n`);
  const hello = await waitFor(() => frames.find((frame) => frame.op === "hello"), {
    label: "the hello answer",
  });
  assert.equal(hello.botdVersion, BOTD_VERSION);
  assert.equal(typeof hello.leaseId, "string");

  // The client goes away: the daemon stops and the exit code stays 0.
  child.stdin.end();
  assert.equal(await closed, 0);
  // The session table was written into the throw away home.
  assert.ok(existsSync(path.join(home, "sessions.json")));
});

test("the usage lists every flag and every environment variable of the configuration", () => {
  const cli = readFileSync(CLI, "utf8");
  const config = readFileSync(CONFIG, "utf8");

  const usageFlags = new Set([...cli.matchAll(/--([a-z-]+)=/g)].map((match) => match[1]));
  const configFlags = new Set(
    [...config.matchAll(/flags\.get\("([a-z-]+)"\)/g)].map((match) => match[1]),
  );
  assert.deepEqual([...usageFlags].sort(), [...configFlags].sort());

  const usageEnv = new Set([...cli.matchAll(/\[(BOTD_[A-Z_]+)\]/g)].map((match) => match[1]));
  const configEnv = new Set(
    [...config.matchAll(/env\.(BOTD_[A-Z_]+)/g)].map((match) => match[1]),
  );
  assert.deepEqual([...usageEnv].sort(), [...configEnv].sort());
});
