// Tests for the session table of the bot daemon (botd/src/store.ts).
//
// The table is a plain load/save store: the daemon writes the whole table
// after every change and reads it back when it starts again.  What is
// checked here is the contract of that table: where the botd home lives,
// that a saved table is read back unchanged, that a session id that is not
// in the table is not found, that a deleted session stays deleted and that
// a broken table is ignored instead of taking the daemon down.
//
// The fixtures are synthetic: the session ids, the provider ids, the working
// directory and the home directories are made up names, the timestamps are
// fixed numbers and every scratch file lives in the relative .tmp directory
// of the botd package.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SessionStore, defaultBotdHome } from "../src/store.ts";
import type { SessionRecord } from "../src/store.ts";

/** Everything temporary lives inside the worktree, in botd/.tmp. */
const TMP_ROOT = fileURLToPath(new URL("../.tmp/", import.meta.url));

/** The directory the botd home lives in when there is no override. */
const HOME_DIR_NAME = ".volto-botd";

/** A scratch table below the relative .tmp directory of the package. */
function fixture(t: test.TestContext): { dir: string; file: string } {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, "store-n21-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, "sessions.json") };
}

/** A session record with synthetic values. */
function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sid: "synthetic-1",
    kind: "acp",
    command: ["synthetic-bot", "--stdio"],
    cwd: "/synthetic-work",
    providerSessionId: "provider-synthetic-1",
    state: "running",
    createdAt: 1,
    updatedAt: 2,
    lastSeq: 5,
    ackedSeq: 3,
    progressAt: 4,
    ...overrides,
  };
}

/** The sessions of a table by id, the way the daemon keeps them. */
function bySid(records: SessionRecord[]): Map<string, SessionRecord> {
  return new Map(records.map((entry) => [entry.sid, entry]));
}

test("the botd home is the BOTD_HOME override", (t) => {
  const { dir } = fixture(t);
  const override = path.join(dir, "botd-home");
  const other = path.join(dir, "user-home");
  const env = { BOTD_HOME: override, HOME: other };

  assert.equal(defaultBotdHome(env), override);
  // Another override gives another home, and the home directory is not used.
  assert.notEqual(defaultBotdHome({ BOTD_HOME: other }), override);
  assert.notEqual(defaultBotdHome(env), other);
  assert.notEqual(defaultBotdHome(env), path.join(other, HOME_DIR_NAME));
});

test("a trailing separator of the override is removed", (t) => {
  const { dir } = fixture(t);
  const override = path.join(dir, "botd-home");

  assert.equal(defaultBotdHome({ BOTD_HOME: `${override}/` }), override);
  assert.notEqual(defaultBotdHome({ BOTD_HOME: `${override}/` }), `${override}/`);
});

test("an empty override falls back to the home directory", (t) => {
  const fallback = path.join(os.homedir(), HOME_DIR_NAME);

  assert.equal(defaultBotdHome({ BOTD_HOME: "" }), fallback);
  assert.equal(defaultBotdHome({ BOTD_HOME: "   " }), fallback);
  assert.equal(defaultBotdHome({}), fallback);
  // The fallback is a directory inside the home, not the home itself and
  // not the directory the other modules use.
  assert.notEqual(defaultBotdHome({ BOTD_HOME: "" }), os.homedir());
  assert.notEqual(defaultBotdHome({ BOTD_HOME: "" }), path.join(os.homedir(), ".botd"));
});

test("without an override the botd home sits in the home directory", (t) => {
  const { dir } = fixture(t);
  const home = path.join(dir, "user-home");
  // The home directory of the process is the one that is used, so it is
  // replaced for the length of this test and restored afterwards.
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  });

  assert.equal(defaultBotdHome({ HOME: home }), path.join(home, HOME_DIR_NAME));
  assert.equal(defaultBotdHome({}), path.join(home, HOME_DIR_NAME));
  assert.notEqual(defaultBotdHome({}), home);
  assert.notEqual(defaultBotdHome({}), path.join(home, ".botd"));
});

test("a saved table is read back unchanged", (t) => {
  const { file } = fixture(t);
  const store = new SessionStore(file);
  const original = record();

  store.save([original]);

  assert.equal(store.path, file);
  assert.deepEqual(store.load(), [original]);
  // The table on disk holds the very same session.
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    version: 1,
    sessions: [original],
  });
  // One changed field is enough to tell the read back table apart.
  assert.notDeepEqual(store.load(), [{ ...original, lastSeq: original.lastSeq + 1 }]);
  assert.notDeepEqual(store.load(), [{ ...original, state: "exited" }]);
});

test("every session of the table is read back unchanged", (t) => {
  const { file } = fixture(t);
  const store = new SessionStore(file);
  const first = record({ sid: "synthetic-1" });
  const second = record({ sid: "synthetic-2", state: "exited", lastSeq: 9 });

  store.save([first, second]);
  const loaded = store.load();

  assert.deepEqual(loaded, [first, second]);
  // The order of the table is kept and no session is dropped or added.
  assert.notDeepEqual(loaded, [second, first]);
  assert.notDeepEqual(loaded, [first]);
});

test("a session id that is not in the table is not found", (t) => {
  const { file } = fixture(t);
  const store = new SessionStore(file);
  store.save([record({ sid: "synthetic-1" })]);

  const loaded = store.load();
  const sessions = bySid(loaded);

  assert.equal(sessions.get("synthetic-missing"), undefined);
  assert.notEqual(sessions.get("synthetic-missing"), null);
  assert.equal(loaded.find((entry) => entry.sid === "synthetic-missing"), undefined);
  assert.deepEqual(loaded.filter((entry) => entry.sid === "synthetic-missing"), []);
  // The session that is in the table is found.
  assert.equal(sessions.get("synthetic-1")?.sid, "synthetic-1");
});

test("a deleted session is gone after the table is written again", (t) => {
  const { file } = fixture(t);
  const store = new SessionStore(file);
  const kept = record({ sid: "synthetic-keep" });
  const removed = record({ sid: "synthetic-remove" });
  store.save([kept, removed]);

  store.save(store.load().filter((entry) => entry.sid !== removed.sid));
  const after = store.load();

  assert.deepEqual(after, [kept]);
  assert.equal(bySid(after).get("synthetic-remove"), undefined);
  assert.notDeepEqual(after, [kept, removed]);
  assert.notEqual(after.length, 2);
});

test("deleting the last session leaves an empty table", (t) => {
  const { file } = fixture(t);
  const store = new SessionStore(file);
  store.save([record({ sid: "synthetic-1" })]);

  store.save(store.load().filter((entry) => entry.sid !== "synthetic-1"));

  assert.deepEqual(store.load(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, sessions: [] });
});

test("a corrupt table is ignored instead of read as a table", (t) => {
  const { file } = fixture(t);
  const store = new SessionStore(file);
  const original = record({ sid: "synthetic-1" });
  store.save([original]);

  // The table on disk is cut in half; the sessions it held are gone.
  fs.writeFileSync(file, '{"version":1,"sessions":[{"sid":"synthetic-1"');

  assert.deepEqual(store.load(), []);
  assert.notDeepEqual(store.load(), [original]);
  assert.equal(store.load().length, 0);
});

test("a corrupt table is written again by the next save", (t) => {
  const { file } = fixture(t);
  const store = new SessionStore(file);
  fs.writeFileSync(file, "{not json");

  assert.deepEqual(store.load(), []);

  const original = record({ sid: "synthetic-1" });
  store.save([original]);

  assert.deepEqual(store.load(), [original]);
  assert.notDeepEqual(store.load(), []);
});
