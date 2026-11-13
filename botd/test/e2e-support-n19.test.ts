import assert from "node:assert/strict";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { hasDaemon, makeTempDir, readSessionTable, waitFor } from "../e2e/support.ts";

test("makeTempDir creates distinct directories with the requested prefix", (t) => {
  const first = makeTempDir("support-n19-");
  t.after(() => rmSync(first, { recursive: true, force: true }));
  const second = makeTempDir("support-n19-");
  t.after(() => rmSync(second, { recursive: true, force: true }));

  assert.notEqual(first, second);
  for (const dir of [first, second]) {
    assert.ok(path.basename(dir).startsWith("support-n19-"));
    assert.ok(existsSync(dir));
    assert.ok(statSync(dir).isDirectory());
  }
});

test("waitFor returns the first truthy predicate value", async () => {
  let calls = 0;
  const value = { result: "ready" };
  const result = await waitFor(() => ++calls === 3 ? value : false, {
    intervalMs: 1,
    timeoutMs: 1000,
  });
  assert.strictEqual(result, value);
  assert.equal(calls, 3);
});

test("waitFor rejects when its timeout expires", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const result = waitFor(() => false, { timeoutMs: 10, intervalMs: 10, label: "synthetic condition" });
  const rejection = assert.rejects(result, /timed out after 10ms waiting for synthetic condition/);
  t.mock.timers.tick(10);
  await rejection;
});

test("readSessionTable reads rows and returns an empty array for a missing file", (t) => {
  const home = makeTempDir("support-n19-home-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(readSessionTable(home), []);

  const rows = [{ sid: "s1", state: "running", lastSeq: 2, ackedSeq: 1 }];
  writeFileSync(path.join(home, "sessions.json"), JSON.stringify({ sessions: rows }));
  assert.deepEqual(readSessionTable(home), rows);
});

test("hasDaemon returns a boolean", () => {
  assert.equal(typeof hasDaemon(), "boolean");
});
