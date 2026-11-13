// Tests for the session ids of the session table on disk.
//
// The table itself is a plain load/save store (see store.test.ts and
// store-redact.test.ts).  What is checked here is the identity of the
// sessions it holds: every create gets its own id, the id keeps its shape
// from the create to the next start of the daemon, the sessions are listed
// in the order they were created, an id that was never handed out is not
// found, a deleted id is gone for good and everything is still there after
// the table is opened again.
//
// The fixtures are synthetic: the ids are random UUIDs, the command is a
// made up name and every scratch file lives in the relative .tmp directory
// of the botd package.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { SessionStore } from "../src/store.ts";
import type { SessionRecord } from "../src/store.ts";

/** The session id format the client hands out: `s-<uuid>`. */
const SID_FORMAT = /^s-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A fresh session id, in the format of src/client.ts. */
function newSid(): string {
  return `s-${randomUUID()}`;
}

/** A session record with synthetic values. */
function record(sid: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sid,
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

/** A scratch table below the relative .tmp directory of the package. */
function fixture(t: test.TestContext): { dir: string; file: string } {
  fs.mkdirSync(".tmp", { recursive: true });
  const dir = fs.mkdtempSync(path.join(".tmp", "store-ids-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, "sessions.json") };
}

/**
 * The session table as the daemon uses it: a list of sessions that is
 * written to disk after every change and read back when the daemon starts.
 */
class SessionTable {
  private readonly store: SessionStore;
  private records: SessionRecord[];

  constructor(store: SessionStore) {
    this.store = store;
    this.records = store.load();
  }

  /** Add a session and persist the table. */
  create(session: SessionRecord): SessionRecord {
    this.records.push(session);
    this.store.save(this.records);
    return session;
  }

  /** The session with the given id, or undefined when there is none. */
  get(sid: string): SessionRecord | undefined {
    return this.records.find((record) => record.sid === sid);
  }

  /** Drop the session with the given id; false when it was not there. */
  delete(sid: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((record) => record.sid !== sid);
    if (this.records.length === before) return false;
    this.store.save(this.records);
    return true;
  }

  /** Every session, in the order it was created. */
  list(): SessionRecord[] {
    return [...this.records];
  }
}

test("many creates get unique session ids", (t) => {
  const { file } = fixture(t);
  const table = new SessionTable(new SessionStore(file));

  const ids = new Set<string>();
  for (let i = 0; i < 250; i++) {
    const sid = newSid();
    ids.add(sid);
    table.create(record(sid, { createdAt: i, updatedAt: i }));
  }

  assert.equal(ids.size, 250, "every create hands out its own id");

  const stored = new SessionStore(file).load();
  assert.equal(stored.length, 250, "the table holds every session");
  assert.equal(
    new Set(stored.map((record) => record.sid)).size,
    250,
    "the table keeps the ids apart",
  );
});

test("a session id keeps its format through a save and a load", (t) => {
  const { file } = fixture(t);
  const table = new SessionTable(new SessionStore(file));
  const sid = newSid();
  table.create(record(sid));

  const loaded = new SessionStore(file).load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].sid, sid, "the id is stored as it was handed out");
  assert.match(loaded[0].sid, SID_FORMAT);
});

test("the store keeps unusual session ids verbatim", (t) => {
  const { file } = fixture(t);
  const table = new SessionTable(new SessionStore(file));
  const ids = ["S-Upper", "s-with space", "s-ünïcødé", "s-a.b_c-d", `s-${"x".repeat(64)}`];
  for (const sid of ids) table.create(record(sid));

  const loaded = new SessionStore(file).load();
  assert.deepEqual(
    loaded.map((record) => record.sid),
    ids,
    "the ids are neither trimmed, folded nor rewritten",
  );
});

test("the sessions are listed in the order they were created", (t) => {
  const { file } = fixture(t);
  const table = new SessionTable(new SessionStore(file));
  const ids = [newSid(), newSid(), newSid()];
  for (const sid of ids) table.create(record(sid));

  assert.deepEqual(
    table.list().map((record) => record.sid),
    ids,
    "the table lists the sessions in the order of the creates",
  );
  assert.deepEqual(
    new SessionStore(file).load().map((record) => record.sid),
    ids,
    "the order is the same after a load",
  );
});

test("the table on disk holds one entry per session id", (t) => {
  const { file } = fixture(t);
  const table = new SessionTable(new SessionStore(file));
  const ids = [newSid(), newSid()];
  for (const sid of ids) table.create(record(sid));

  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { sessions: { sid: string }[] };
  assert.deepEqual(
    parsed.sessions.map((session) => session.sid),
    ids,
  );
});

test("an unknown session id is not found", (t) => {
  const { file } = fixture(t);
  const table = new SessionTable(new SessionStore(file));
  const sid = newSid();
  table.create(record(sid));

  assert.equal(table.get("s-unknown"), undefined);
  assert.equal(table.get(""), undefined);
  assert.equal(
    new SessionStore(file).load().find((record) => record.sid === "s-unknown"),
    undefined,
  );
});

test("a deleted session id is not found any more", (t) => {
  const { file } = fixture(t);
  const table = new SessionTable(new SessionStore(file));
  const [first, second, third] = [newSid(), newSid(), newSid()];
  for (const sid of [first, second, third]) table.create(record(sid));

  assert.equal(table.delete(second), true);
  assert.equal(table.get(second), undefined);
  assert.ok(table.get(first));
  assert.ok(table.get(third));
  assert.deepEqual(
    table.list().map((record) => record.sid),
    [first, third],
  );
  assert.ok(
    !fs.readFileSync(file, "utf8").includes(second),
    "the deleted id is gone from the table on disk",
  );
});

test("a deleted session stays gone after the table is reopened", (t) => {
  const { file } = fixture(t);
  const table = new SessionTable(new SessionStore(file));
  const [first, second, third] = [newSid(), newSid(), newSid()];
  for (const sid of [first, second, third]) table.create(record(sid));
  table.delete(second);

  const reopened = new SessionTable(new SessionStore(file));
  assert.equal(reopened.get(second), undefined);
  assert.deepEqual(
    reopened.list().map((record) => record.sid),
    [first, third],
  );
});

test("the sessions survive a reopen of the table", (t) => {
  const { file } = fixture(t);
  const table = new SessionTable(new SessionStore(file));
  const sessions = [newSid(), newSid(), newSid()].map((sid, i) =>
    record(sid, { state: i === 1 ? "exited" : "running", lastSeq: i, ackedSeq: i }),
  );
  for (const session of sessions) table.create(session);

  const reopened = new SessionTable(new SessionStore(file));
  assert.equal(reopened.list().length, 3);
  assert.deepEqual(reopened.list(), sessions, "every field of every session is still there");
});

test("the session ids survive a reopen of the table", (t) => {
  const { file } = fixture(t);
  const table = new SessionTable(new SessionStore(file));
  const ids = [newSid(), newSid(), newSid()];
  for (const sid of ids) table.create(record(sid));

  const reopened = new SessionTable(new SessionStore(file));
  assert.deepEqual(
    reopened.list().map((record) => record.sid),
    ids,
    "the ids do not change when the table is opened again",
  );
  for (const sid of ids) assert.match(sid, SID_FORMAT);
});

test("the table is written to a directory that does not exist yet", (t) => {
  const { dir } = fixture(t);
  const home = path.join(dir, "home", "nested");
  const file = path.join(home, "sessions.json");
  const table = new SessionTable(new SessionStore(file));
  const sid = newSid();
  table.create(record(sid));

  assert.ok(fs.existsSync(home), "the missing directory is created");
  assert.deepEqual(
    new SessionStore(file).load().map((record) => record.sid),
    [sid],
  );
});
