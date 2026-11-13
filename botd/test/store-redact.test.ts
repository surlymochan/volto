import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SessionStore } from "../src/store.ts";
import type { SessionRecord } from "../src/store.ts";

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sid: "s1", kind: "acp", command: ["bot", "--stdio"], cwd: "/work",
    providerSessionId: "provider-1", state: "running", createdAt: 1, updatedAt: 2,
    lastSeq: 5, ackedSeq: 3, progressAt: 4, ...overrides,
  };
}

function fixture(t: test.TestContext) {
  fs.mkdirSync(".tmp", { recursive: true });
  const dir = fs.mkdtempSync(path.join(".tmp", "store-redact-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "sessions.json");
  return { file, store: new SessionStore(file) };
}

const bearer = "Authorization: Bearer abcdef0123456789abcdef";
const token = "token=sk-test-0123456789abcdef0123456789";

test("redacts a stderr field before writing", (t) => {
  const { file, store } = fixture(t);
  const withStderr = { ...record(), stderr: bearer };
  store.save([withStderr]);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes(bearer));
  assert.match(text, /Authorization: Bearer <redacted>/);
});

test("redacts command arguments on disk and load", (t) => {
  const { file, store } = fixture(t);
  store.save([record({ command: ["bot", token, bearer] })]);
  assert.ok(!fs.readFileSync(file, "utf8").includes(token));
  assert.deepEqual(store.load()[0].command, ["bot", "token=<redacted>", "Authorization: Bearer <redacted>"]);
});

test("redacts cwd on disk and load", (t) => {
  const { store } = fixture(t);
  store.save([record({ cwd: `/work/${token}` })]);
  assert.equal(store.load()[0].cwd, "/work/token=<redacted>");
});

test("preserves identifiers and sequence numbers exactly", (t) => {
  const { store } = fixture(t);
  const original = record({ sid: token, providerSessionId: bearer, lastSeq: 123, ackedSeq: 99 });
  store.save([original]);
  const loaded = store.load()[0];
  assert.equal(loaded.sid, original.sid);
  assert.equal(loaded.providerSessionId, original.providerSessionId);
  assert.equal(loaded.lastSeq, original.lastSeq);
  assert.equal(loaded.ackedSeq, original.ackedSeq);
});

test("keeps a record without secrets byte identical", (t) => {
  const { file, store } = fixture(t);
  const original = record();
  store.save([original]);
  assert.equal(fs.readFileSync(file, "utf8"), `${JSON.stringify({ version: 1, sessions: [original] }, null, 2)}\n`);
});

test("save-load-save is idempotent", (t) => {
  const { file, store } = fixture(t);
  store.save([record({ command: [token, bearer] })]);
  const first = fs.readFileSync(file, "utf8");
  store.save(store.load());
  assert.equal(fs.readFileSync(file, "utf8"), first);
});

test("corrupt table loads empty", (t) => {
  const { file, store } = fixture(t);
  fs.writeFileSync(file, "{broken");
  assert.deepEqual(store.load(), []);
});

test("empty table loads empty", (t) => {
  const { file, store } = fixture(t);
  fs.writeFileSync(file, "");
  assert.deepEqual(store.load(), []);
});
