// In-process tests for bridge startup paths that do not require a socket or ssh.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { startBridge } from "../botd-stdio-bridge.mjs";

test("rejects an existing non-socket path without changing it", async (t) => {
  mkdirSync(".tmp", { recursive: true });
  const directory = mkdtempSync(join(".tmp", "stdio-bridge-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "existing-file");
  writeFileSync(socketPath, "synthetic data");

  await assert.rejects(
    startBridge({ host: "host-a", socketPath }),
    { message: `${socketPath} exists and is not a socket` },
  );
  assert.equal(readFileSync(socketPath, "utf8"), "synthetic data");
});
