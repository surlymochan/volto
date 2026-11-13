import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SessionStore, defaultBotdHome } from "../src/store.ts";
import type { SessionRecord } from "../src/store.ts";

function fixture(t: test.TestContext) {
  fs.mkdirSync(".tmp", { recursive: true });
  const dir = fs.mkdtempSync(path.join(".tmp", "store-corrupt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "sessions.json");
  return { dir, file, store: new SessionStore(file) };
}

function record(sid: string): SessionRecord {
  return {
    sid, kind: "acp", command: ["bot"], state: "running",
    createdAt: 1, updatedAt: 2, lastSeq: 3, ackedSeq: 1, progressAt: 2,
  };
}

test("save creates a missing nested home directory", (t) => {
  const { dir } = fixture(t);
  const store = new SessionStore(path.join(dir, "new", "home", "sessions.json"));
  store.save([record("synthetic-1")]);
  assert.deepEqual(store.load().map((entry) => entry.sid), ["synthetic-1"]);
});

test("a truncated JSON table loads empty", (t) => {
  const { file, store } = fixture(t);
  fs.writeFileSync(file, '{"version":1,"sessions":[{"sid":"synthetic-1"}');
  assert.deepEqual(store.load(), []);
});

test("JSON with the wrong table shape loads empty", (t) => {
  const { file, store } = fixture(t);
  for (const value of [null, 42, "table", {}, { sessions: {} }]) {
    fs.writeFileSync(file, JSON.stringify(value));
    assert.deepEqual(store.load(), []);
  }
});

test("invalid entries are ignored and partial records receive defaults", (t) => {
  const { file, store } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ sessions: [null, 4, {}, { sid: "" }, { sid: "synthetic-1" }] }));
  assert.deepEqual(store.load(), [{
    sid: "synthetic-1", kind: "acp", command: [], cwd: undefined,
    providerSessionId: undefined, state: "exited", createdAt: 0, updatedAt: 0,
    lastSeq: 0, ackedSeq: 0, progressAt: 0,
  }]);
});

test("extra record fields are saved but dropped when loaded", (t) => {
  const { file, store } = fixture(t);
  store.save([{ ...record("synthetic-1"), extra: "synthetic-value" }]);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).sessions[0].extra, "synthetic-value");
  assert.deepEqual(store.load(), [{ ...record("synthetic-1"), cwd: undefined, providerSessionId: undefined }]);
});

test("a failed partial write leaves the previous table intact", (t) => {
  const { file, store } = fixture(t);
  store.save([record("synthetic-old")]);
  const before = fs.readFileSync(file, "utf8");
  const originalWrite = fs.writeFileSync;
  const write = t.mock.method(fs, "writeFileSync", (fd, data, options) => {
    originalWrite(fd, String(data).slice(0, 10), options);
    throw new Error("simulated write failure");
  });
  assert.throws(() => store.save([record("synthetic-new")]), /simulated write failure/);
  write.mock.restore();
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(new SessionStore(file).load().map((entry) => entry.sid), ["synthetic-old"]);
});

test("two stores on the same path use the last saved table", (t) => {
  const { file, store } = fixture(t);
  const other = new SessionStore(file);
  store.save([record("synthetic-1")]);
  const stale = other.load();
  store.save([record("synthetic-2")]);
  other.save(stale);
  assert.deepEqual(store.load().map((entry) => entry.sid), ["synthetic-1"]);
});

test("a relative BOTD_HOME override resolves from the working directory", () => {
  assert.equal(defaultBotdHome({ BOTD_HOME: ".tmp/synthetic-home" }), path.resolve(".tmp/synthetic-home"));
});
