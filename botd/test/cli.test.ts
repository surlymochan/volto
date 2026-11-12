// Tests for the command line entry point of the daemon.
//
// The daemon is started like a real executor host would start it:
// `botd serve` speaks newline-delimited JSON over stdin and stdout.
//
// The launcher of scripts/install-botd.sh runs `node --experimental-strip-types
// <prefix>/app/src/main.ts`, so main.ts is spawned the same way here.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { BOTD_VERSION } from "../src/protocol.ts";
import { delay, makeTempDir, waitFor } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/** Collect the frames the daemon writes on stdout. */
function collectFrames(child: ReturnType<typeof spawn>): Record<string, unknown>[] {
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
  return frames;
}

test("prints the version", async () => {
  const child = spawn(process.execPath, [CLI, "version"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  assert.equal(output.trim(), BOTD_VERSION);
});

test("answers a hello over stdin and stdout", async () => {
  const home = makeTempDir("cli-");
  const child = spawn(process.execPath, [CLI, "serve", `--home=${home}`], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames = collectFrames(child);

  try {
    child.stdin.write(`${JSON.stringify({ op: "hello", clientId: "client-a", leaseTtlMs: 5000 })}\n`);
    const hello = await waitFor(() => frames.find((frame) => frame.op === "hello"), {
      label: "the hello answer",
    });
    assert.equal(hello.botdVersion, BOTD_VERSION);
    assert.equal(typeof hello.leaseId, "string");
    assert.equal(typeof hello.fence, "number");
  } finally {
    child.stdin.end();
    await delay(50);
    child.kill("SIGKILL");
  }
});

test("the main entry point prints the version", async () => {
  const child = spawn(process.execPath, [MAIN, "--version"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  assert.equal(output.trim(), BOTD_VERSION);
});

test("the main entry point serves the daemon over stdin and stdout", async () => {
  const home = makeTempDir("main-");
  const child = spawn(process.execPath, [MAIN, "serve", `--home=${home}`], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames = collectFrames(child);

  try {
    child.stdin.write(`${JSON.stringify({ op: "hello", clientId: "client-a", leaseTtlMs: 5000 })}\n`);
    const hello = await waitFor(() => frames.find((frame) => frame.op === "hello"), {
      label: "the hello answer",
    });
    assert.equal(hello.botdVersion, BOTD_VERSION);
    assert.equal(typeof hello.leaseId, "string");
  } finally {
    child.stdin.end();
    await delay(50);
    child.kill("SIGKILL");
  }
});
