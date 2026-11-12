import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { probe as claude } from "../bots/claude.mjs";
import { probe as codex } from "../bots/codex.mjs";
import { probe as dsh } from "../bots/dsh.mjs";
import { probe as pi } from "../bots/pi.mjs";
import { probe as agy } from "../bots/agy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const tmpRoot = join(here, "..", ".tmp", "tests");

/**
 * @param {string} id
 */
function ctxFor(id) {
  const tmpDir = join(tmpRoot, id);
  mkdirSync(tmpDir, { recursive: true });
  return {
    tmpDir,
    outDir: tmpDir,
    timeoutMs: 10_000,
    transcript: { record() {}, note() {} },
    redactor: { text: (s) => s, value: (v) => v },
  };
}

test("the five probes are registered with a stable id", () => {
  const ids = [codex, claude, dsh, pi, agy].map((probe) => probe.id);
  assert.deepEqual(ids, ["codex", "claude", "dsh", "pi", "agy"]);
});

test("a missing binary skips the probe cleanly", async (t) => {
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));
  const previous = process.env.VOLTO_PROBE_CLAUDE_BIN;
  process.env.VOLTO_PROBE_CLAUDE_BIN = join(tmpRoot, "does-not-exist");
  t.after(() => {
    if (previous === undefined) delete process.env.VOLTO_PROBE_CLAUDE_BIN;
    else process.env.VOLTO_PROBE_CLAUDE_BIN = previous;
  });

  const result = await claude.run(ctxFor("claude"));
  assert.equal(result.status, "skipped");
  assert.match(result.reason ?? "", /binary not found/);
  assert.equal(result.protocol.sessionCreate.supported, null);
  assert.ok(result.protocol.cancel.method.includes("interrupt"));
  assert.equal(result.auth.state, "unknown");
});
