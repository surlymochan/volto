// Tests for the session table on disk.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { SessionStore, defaultBotdHome } from "../src/store.ts";
import type { SessionRecord } from "../src/store.ts";
import { makeTempDir } from "./helpers.ts";

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sid: "s1",
    kind: "acp",
    command: ["bot", "--stdio"],
    cwd: "/work",
    providerSessionId: "prov-1",
    state: "running",
    createdAt: 1,
    updatedAt: 2,
    lastSeq: 5,
    ackedSeq: 3,
    progressAt: 4,
    ...overrides,
  };
}

test("saves and loads the session table", () => {
  const dir = makeTempDir("store-");
  const file = path.join(dir, "sessions.json");
  const store = new SessionStore(file);
  store.save([record(), record({ sid: "s2", state: "exited" })]);
  const loaded = new SessionStore(file).load();
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].sid, "s1");
  assert.equal(loaded[0].lastSeq, 5);
  assert.equal(loaded[0].ackedSeq, 3);
  assert.equal(loaded[0].providerSessionId, "prov-1");
  assert.equal(loaded[1].state, "exited");
});

test("a missing table yields no session", () => {
  const dir = makeTempDir("store-");
  const store = new SessionStore(path.join(dir, "missing.json"));
  assert.deepEqual(store.load(), []);
});

test("a broken table yields no session", () => {
  const dir = makeTempDir("store-");
  const file = path.join(dir, "sessions.json");
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(new SessionStore(file).load(), []);
});

test("the table is written atomically", () => {
  const dir = makeTempDir("store-");
  const file = path.join(dir, "sessions.json");
  const store = new SessionStore(file);
  store.save([record()]);
  store.save([record({ lastSeq: 9 })]);
  // No temporary file is left behind and the table is complete.
  assert.deepEqual(fs.readdirSync(dir), ["sessions.json"]);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.sessions[0].lastSeq, 9);
});

test("the botd home defaults to the volto directory", () => {
  assert.equal(defaultBotdHome({ BOTD_HOME: "/somewhere/else" }), "/somewhere/else");
  assert.match(defaultBotdHome({}), /\.volto-botd$/);
});
