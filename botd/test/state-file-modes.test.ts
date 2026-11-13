import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SessionStore } from "../src/store.ts";
import { LeaseStore, hostResource } from "../src/lease-store.ts";
import type { SessionRecord } from "../src/store.ts";

const skip = process.platform === "win32" ? "posix permissions only" : false;

function scratch(t: test.TestContext): string {
  fs.mkdirSync(".tmp", { recursive: true });
  const dir = fs.mkdtempSync(path.join(".tmp", "state-modes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const mode = (file: string) => fs.statSync(file).mode & 0o777;

test("session table is written 0600 into a 0700 home", { skip }, (t) => {
  const home = path.join(scratch(t), "home");
  const file = path.join(home, "sessions.json");
  const record: SessionRecord = {
    sid: "synthetic-1", kind: "acp", command: ["bot"], state: "running",
    createdAt: 1, updatedAt: 2, lastSeq: 3, ackedSeq: 1, progressAt: 2,
  };
  new SessionStore(file).save([record]);
  assert.equal(mode(file), 0o600);
  assert.equal(mode(home), 0o700);
});

test("lease state and its backup are written 0600 into a 0700 home", { skip }, async (t) => {
  const home = path.join(scratch(t), "home");
  const store = new LeaseStore({ home });
  await store.acquire(hostResource("site-a"), "controller-1", 30_000);
  assert.equal(mode(home), 0o700);
  const files = fs.readdirSync(home).filter((name) => name.endsWith(".json"));
  assert.ok(files.length >= 1);
  for (const name of files) assert.equal(mode(path.join(home, name)), 0o600, name);
});
