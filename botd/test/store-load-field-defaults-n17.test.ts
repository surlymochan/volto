// Tests for the field defaults of the session table on disk.
//
// The table is written by the daemon and read back when it starts again.
// A table that was written by another version, that was cut in half or that
// was edited by hand can hold entries the daemon does not understand.  What
// is checked here is what the loader does with such a table: which shape it
// accepts, which entries it drops and which value every field of a session
// gets when the table does not carry it.
//
// The fixtures are synthetic: the session ids, the provider ids and the
// working directory are made up names and every scratch file lives in the
// relative .tmp directory of the botd package.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionStore, defaultBotdHome } from "../src/store.ts";
import type { SessionRecord } from "../src/store.ts";

/** A scratch table below the relative .tmp directory of the package. */
function fixture(t: test.TestContext): { dir: string; file: string; store: SessionStore } {
  fs.mkdirSync(".tmp", { recursive: true });
  const dir = fs.mkdtempSync(path.join(".tmp", "store-load-defaults-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "sessions.json");
  return { dir, file, store: new SessionStore(file) };
}

/** A session record with synthetic values. */
function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sid: "synthetic-1",
    kind: "acp",
    command: ["bot", "--stdio"],
    cwd: "/synthetic-work",
    providerSessionId: "prov-synthetic",
    state: "running",
    createdAt: 1,
    updatedAt: 2,
    lastSeq: 5,
    ackedSeq: 3,
    progressAt: 4,
    ...overrides,
  };
}

/** Write a table with the given content and read it back. */
function write(t: test.TestContext, content: unknown): SessionRecord[] {
  const { file, store } = fixture(t);
  fs.writeFileSync(file, JSON.stringify(content));
  return store.load();
}

test("a bare array of sessions is loaded", (t) => {
  const loaded = write(t, [{ sid: "synthetic-1", kind: "pi-rpc", state: "idle" }]);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].sid, "synthetic-1");
  assert.equal(loaded[0].kind, "pi-rpc");
  assert.equal(loaded[0].state, "idle");
});

test("a bare array and a sessions object load the same sessions", (t) => {
  const sessions = [{ sid: "synthetic-1", kind: "codex-app-server", state: "paused", lastSeq: 4 }];
  const fromArray = write(t, sessions);
  const fromObject = write(t, { version: 1, sessions });
  assert.deepEqual(fromArray, fromObject);
  assert.equal(fromObject.length, 1);
  assert.equal(fromObject[0].kind, "codex-app-server");
  assert.equal(fromObject[0].lastSeq, 4);
});

test("an entry without a usable session id is skipped", (t) => {
  const loaded = write(t, {
    sessions: [{}, { sid: "" }, { sid: 42 }, { sid: null }, { sid: "synthetic-1" }],
  });
  assert.deepEqual(loaded.map((entry) => entry.sid), ["synthetic-1"]);
});

test("an entry that is not an object is skipped", (t) => {
  const loaded = write(t, {
    sessions: [null, 42, "synthetic-text", true, [], { sid: "synthetic-1" }],
  });
  assert.deepEqual(loaded.map((entry) => entry.sid), ["synthetic-1"]);
});

test("a session without fields gets the default values", (t) => {
  const loaded = write(t, { sessions: [{ sid: "synthetic-1" }] });
  assert.deepEqual(loaded, [{
    sid: "synthetic-1", kind: "acp", command: [], cwd: undefined,
    providerSessionId: undefined, state: "exited", createdAt: 0, updatedAt: 0,
    lastSeq: 0, ackedSeq: 0, progressAt: 0,
  }]);
});

test("only the missing fields of a partial session get a default", (t) => {
  const loaded = write(t, {
    sessions: [{
      sid: "synthetic-1", kind: "codex-app-server", state: "paused", lastSeq: 7,
    }],
  });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].kind, "codex-app-server");
  assert.equal(loaded[0].state, "paused");
  assert.equal(loaded[0].lastSeq, 7);
  assert.equal(loaded[0].ackedSeq, 0);
  assert.equal(loaded[0].createdAt, 0);
  assert.equal(loaded[0].updatedAt, 0);
  assert.equal(loaded[0].progressAt, 0);
  assert.deepEqual(loaded[0].command, []);
  assert.equal(loaded[0].cwd, undefined);
  assert.equal(loaded[0].providerSessionId, undefined);
});

test("the command of a session is a list of strings", (t) => {
  const loaded = write(t, {
    sessions: [{ sid: "synthetic-1", command: ["bot", 42, true, null] }],
  });
  assert.deepEqual(loaded[0].command, ["bot", "42", "true", "null"]);
});

test("a command that is not a list becomes an empty list", (t) => {
  const loaded = write(t, {
    sessions: [
      { sid: "synthetic-1", command: "bot --stdio" },
      { sid: "synthetic-2", command: { 0: "bot" } },
    ],
  });
  assert.deepEqual(loaded.map((entry) => entry.command), [[], []]);
});

test("a working directory that is not a string is dropped", (t) => {
  const loaded = write(t, {
    sessions: [
      { sid: "synthetic-1", cwd: 42 },
      { sid: "synthetic-2", cwd: null },
      { sid: "synthetic-3", cwd: "/synthetic-work" },
    ],
  });
  assert.equal(loaded[0].cwd, undefined);
  assert.equal(loaded[1].cwd, undefined);
  assert.equal(loaded[2].cwd, "/synthetic-work");
});

test("a provider session id that is not a string is dropped", (t) => {
  const loaded = write(t, {
    sessions: [
      { sid: "synthetic-1", providerSessionId: 42 },
      { sid: "synthetic-2", providerSessionId: "prov-synthetic" },
    ],
  });
  assert.equal(loaded[0].providerSessionId, undefined);
  assert.equal(loaded[1].providerSessionId, "prov-synthetic");
});

test("a table that is not a session list loads as no session", (t) => {
  for (const value of [null, 42, {}]) {
    const loaded = write(t, value);
    assert.deepEqual(loaded, [], `a table of ${JSON.stringify(value)} holds no session`);
  }
});

test("a missing table loads as no session", (t) => {
  const { file } = fixture(t);
  assert.deepEqual(new SessionStore(file).load(), []);
});

test("a save writes the version and the sessions with a trailing newline", (t) => {
  const { file, store } = fixture(t);
  store.save([record()]);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.endsWith("\n"), "the table ends with a newline");
  const parsed = JSON.parse(text) as { version: number; sessions: unknown[] };
  assert.equal(parsed.version, 1);
  assert.equal(parsed.sessions.length, 1);
});

test("a save creates the directories of the table", (t) => {
  const { dir } = fixture(t);
  const file = path.join(dir, "nested", "home", "sessions.json");
  new SessionStore(file).save([record()]);
  assert.ok(fs.existsSync(path.dirname(file)), "the missing directory is created");
  assert.equal(new SessionStore(file).load().length, 1);
});

test("a save leaves no temporary file behind", (t) => {
  const { dir, store } = fixture(t);
  store.save([record()]);
  const names = fs.readdirSync(dir);
  assert.deepEqual(names, ["sessions.json"]);
  assert.ok(!names.some((name) => name.includes(".tmp-")), "no temporary file is left over");
});

test("a saved table loads back unchanged", (t) => {
  const { store } = fixture(t);
  const original = record();
  store.save([original]);
  assert.deepEqual(store.load(), [original]);
});

test("the botd home falls back to the home directory when the override is blank", () => {
  assert.equal(defaultBotdHome({ BOTD_HOME: "  " }), path.join(os.homedir(), ".volto-botd"));
});

test("a relative botd home is resolved against the working directory", () => {
  assert.equal(
    defaultBotdHome({ BOTD_HOME: ".tmp/store-home-n17" }),
    path.resolve(".tmp/store-home-n17"),
  );
});
