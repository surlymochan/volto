import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, "..", "run.mjs");

/**
 * @param {string[]} args
 */
function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner, ...args], { cwd: join(here, "..", "..") });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("the dry run lists the five probes and exits with 0", async () => {
  const result = await run(["--dry-run"]);
  assert.equal(result.code, 0, result.stderr);
  for (const id of ["codex", "claude", "dsh", "pi", "agy"]) {
    assert.ok(result.stdout.includes(id), `the dry run does not mention ${id}`);
  }
  assert.match(result.stdout, /5 probe\(s\) ready/);
});

test("an unknown bot id is rejected", async () => {
  const result = await run(["--bot", "does-not-exist"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no probe matches/);
});
