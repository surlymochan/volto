// Resume of a session after a restart of the daemon.
//
// A restart of botd keeps the session table (botd/src/store.ts) but loses
// the children and the ring buffers of the live sessions (botd/src/ring.ts):
// the metadata of a session survives, its events do not. This file drives
// that transition with two daemons that share one session table and pins
// what the client sees on the other side of the restart:
//
//   - the acked sequence number and the last sequence number of a session
//     survive in the persisted record;
//   - a resume above the last sequence number gets no gap and exactly one
//     state frame;
//   - a resume at or below it gets one gap with the original numbers;
//   - the second hello of the same clientId gets a new lease id;
//   - opening an already persisted sid starts a fresh session;
//   - a closed session is gone: the resume answers unknown_session.
//
// The 'lost journal' case of replay-edge.test.ts (a daemon that lost the
// events of a session) is not repeated here: this file is about the
// restart.
//
// Known defects, pinned as TODO:
//   - the fence of the restarted daemon starts at 1 again: the fence is not
//     persisted, so the stale client of the previous daemon is not rejected;
//   - close() writes an empty session table, so a graceful restart loses the
//     metadata of every session;
//   - the fresh session of a persisted sid restarts the numbering of the
//     events at 1.
//
// The bot child is the fake child of the fixtures (test/fixtures/fake-child.mjs);
// no host name, address or credential shows up in this file.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { Botd } from "../src/daemon.ts";
import {
  FAKE_CHILD,
  isError,
  isEvent,
  isGap,
  isState,
  startHarness,
  waitFor,
} from "./helpers.ts";
import type { Harness, TestClient } from "./helpers.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const TMP_ROOT = path.join(REPO_ROOT, "botd", ".tmp", "daemon-restart-resume-test");

/** A throw away botd home inside the worktree. */
function tempHome(name: string): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TMP_ROOT, `${name}-`));
}

after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

// A daemon that is closed writes its session table one last time, sometimes
// after the hook above ran: the exit of the file removes what is left.
process.on("exit", () => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** Open a session and wait until the child runs. */
async function openSession(client: TestClient, sid: string): Promise<void> {
  client.send({
    op: "open",
    sid,
    bot: { kind: "acp", command: [process.execPath, FAKE_CHILD] },
  });
  await client.waitFor((frame) => frame.op === "state" && frame.sid === sid && frame.state === "running", {
    label: `the running state of ${sid}`,
  });
}

/** Wait until the daemon wrote its session table. */
async function waitForTable(home: string): Promise<void> {
  await waitFor(() => fs.existsSync(path.join(home, "sessions.json")), {
    label: "the session table",
  });
}

/**
 * Restart the daemon.
 *
 * The session table of the running daemon is copied into a fresh home and a
 * second daemon is started there: this is what a restart of botd looks like
 * for the client (the table survives, the children and the ring buffers do
 * not).
 */
function restart(home: string, name: string): Harness {
  const next = tempHome(name);
  const table = path.join(home, "sessions.json");
  if (fs.existsSync(table)) fs.copyFileSync(table, path.join(next, "sessions.json"));
  return startHarness({ home: next });
}

/**
 * Run a session with `count` events, acknowledge the first `acked` of them
 * and wait until the daemon knows the acknowledgement (the acknowledgement
 * writes the session table).
 */
async function runSession(
  daemon: Botd,
  client: TestClient,
  sid: string,
  options: { count: number; acked: number },
): Promise<void> {
  await openSession(client, sid);
  client.send({ op: "send", sid, payload: { cmd: "emit", count: options.count } });
  await client.waitFor(
    (frame) => frame.op === "event" && frame.sid === sid && frame.seq === options.count,
    { label: `the event ${options.count} of ${sid}` },
  );
  client.send({ op: "ack", sid, seq: options.acked });
  await waitFor(() => daemon.sessionStatus(sid)?.ackedSeq === options.acked, {
    label: `the ack of ${options.acked} of ${sid}`,
  });
}

// ---------------------------------------------------------------------------
// The records of the session table.
// ---------------------------------------------------------------------------

test("the acked seq and the lastSeq of a session survive the restart in the persisted record", async (t) => {
  const home = tempHome("records");
  const { daemon, client } = startHarness({ home });
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await runSession(daemon, client, "s1", { count: 3, acked: 2 });
  await waitForTable(home);

  // The record on disk carries the numbers of the session.
  const persisted = JSON.parse(fs.readFileSync(path.join(home, "sessions.json"), "utf8"));
  assert.equal(persisted.sessions.length, 1);
  assert.equal(persisted.sessions[0].lastSeq, 3, "the last sequence number is persisted");
  assert.equal(persisted.sessions[0].ackedSeq, 2, "the acknowledged sequence number is persisted");

  // The restarted daemon reads them back.
  const second = restart(home, "records-2");
  t.after(() => second.daemon.close());
  const records = second.daemon.table();
  assert.equal(records.length, 1);
  assert.equal(records[0].sid, "s1");
  assert.equal(records[0].lastSeq, 3, "the last sequence number survives the restart");
  assert.equal(records[0].ackedSeq, 2, "the acknowledged sequence number survives the restart");
  assert.equal(records[0].state, "exited", "a session that outlived the daemon is loaded as exited");
});

test("the record of a session that outlived the daemon is not replayed as a live session", async (t) => {
  const home = tempHome("exited");
  const { daemon, client } = startHarness({ home });
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await runSession(daemon, client, "s1", { count: 2, acked: 1 });
  await waitForTable(home);

  const second = restart(home, "exited-2");
  t.after(() => second.daemon.close());

  // The session is not live any more: it is not in the session status list.
  assert.equal(second.daemon.sessionStatus("s1"), undefined, "the session is not live any more");
  const records = second.daemon.table();
  assert.equal(records.length, 1, "the metadata of the session is still known");
  assert.equal(records[0].state, "exited");
  assert.equal(records[0].lastSeq, 2);
});

// ---------------------------------------------------------------------------
// The resume of a persisted session.
// ---------------------------------------------------------------------------

test("a resume above the lastSeq of a persisted session reports no gap and one state frame", async (t) => {
  const home = tempHome("resume-above");
  const { daemon, client } = startHarness({ home });
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await runSession(daemon, client, "s1", { count: 3, acked: 2 });
  await waitForTable(home);

  const second = restart(home, "resume-above-2");
  t.after(() => second.daemon.close());
  await second.client.hello("client-b", 60_000);

  // fromSeq is above the last sequence number of the session (3): the peer
  // is up to date, there is no hole.
  const mark = second.client.mark();
  second.client.send({ op: "resume", sid: "s1", fromSeq: 4 });
  await waitFor(
    () => second.client.sinceMark(mark).some((frame) => frame.op === "state"),
    { label: "the state after the resume" },
  );
  const frames = second.client.sinceMark(mark);
  assert.deepEqual(frames.filter(isGap), [], "an up-to-date peer gets no gap");
  assert.deepEqual(frames.filter(isEvent), [], "the events of a dead session cannot be replayed");
  const states = frames.filter(isState);
  assert.equal(states.length, 1, "the resume answers with exactly one state frame");
  assert.equal(states[0].sid, "s1");
  assert.equal(states[0].state, "exited", "the state of the persisted record is reported");
});

test("a resume at or below the lastSeq of a persisted session reports one gap with the original numbers", async (t) => {
  const home = tempHome("resume-below");
  const { daemon, client } = startHarness({ home });
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await runSession(daemon, client, "s1", { count: 5, acked: 3 });
  await waitForTable(home);

  const second = restart(home, "resume-below-2");
  t.after(() => second.daemon.close());
  await second.client.hello("client-b", 60_000);

  // The events of the session are gone: the hole runs from the sequence the
  // peer asked for to the last sequence number of the session.
  const mark = second.client.mark();
  second.client.send({ op: "resume", sid: "s1", fromSeq: 3 });
  await waitFor(
    () => second.client.sinceMark(mark).some((frame) => frame.op === "state"),
    { label: "the state after the resume" },
  );
  const frames = second.client.sinceMark(mark);
  const gaps = frames.filter(isGap);
  assert.equal(gaps.length, 1, "the lost range is reported once");
  assert.equal(gaps[0].sid, "s1");
  assert.equal(gaps[0].fromSeq, 3, "the hole starts at the sequence of the peer");
  assert.equal(gaps[0].toSeq, 5, "the hole ends at the last sequence number of the session");
  assert.deepEqual(frames.filter(isEvent), [], "nothing can be replayed");
  assert.equal(frames.filter(isState).length, 1, "the resume answers with one state frame");

  // The boundary: a resume at the head of the session is a hole of one.
  const headMark = second.client.mark();
  second.client.send({ op: "resume", sid: "s1", fromSeq: 5 });
  await waitFor(
    () => second.client.sinceMark(headMark).some((frame) => frame.op === "state"),
    { label: "the state after the resume at the head" },
  );
  const headGaps = second.client.sinceMark(headMark).filter(isGap);
  assert.equal(headGaps.length, 1);
  assert.equal(headGaps[0].fromSeq, 5);
  assert.equal(headGaps[0].toSeq, 5, "the hole is inclusive");
});

test("a resume of a persisted session does not answer unknown_session", async (t) => {
  const home = tempHome("resume-known");
  const { daemon, client } = startHarness({ home });
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await runSession(daemon, client, "s1", { count: 1, acked: 1 });
  await waitForTable(home);

  const second = restart(home, "resume-known-2");
  t.after(() => second.daemon.close());
  await second.client.hello("client-b", 60_000);

  const mark = second.client.mark();
  second.client.send({ op: "resume", sid: "s1", fromSeq: 1 });
  await waitFor(
    () => second.client.sinceMark(mark).some((frame) => frame.op === "state"),
    { label: "the state after the resume" },
  );
  const errors = second.client.sinceMark(mark).filter(isError);
  assert.deepEqual(errors, [], "a persisted session is known after the restart");
});

// ---------------------------------------------------------------------------
// The lease of the restarted daemon.
// ---------------------------------------------------------------------------

test("a second hello with the same clientId after the restart gets a new lease id and a fence of at least 1", async (t) => {
  const home = tempHome("lease");
  const { daemon, client } = startHarness({ home });
  t.after(() => daemon.close());

  const first = await client.hello("client-a", 60_000);
  assert.equal(first.fence, 1, "the first lease of a daemon has the fence 1");
  await runSession(daemon, client, "s1", { count: 1, acked: 1 });
  await waitForTable(home);

  const second = restart(home, "lease-2");
  t.after(() => second.daemon.close());
  const again = await second.client.hello("client-a", 60_000);
  assert.notEqual(again.leaseId, first.leaseId, "the restarted daemon hands out a new lease id");
  assert.ok(again.fence >= 1, `expected a fence of at least 1, got ${again.fence}`);
  assert.equal(again.leaseTtlMs, 60_000, "the ttl of the client is honoured");
});

// ---------------------------------------------------------------------------
// The open of a persisted session and the closed sessions.
// ---------------------------------------------------------------------------

test("opening an already persisted sid after the restart starts a fresh session (no session_exists)", async (t) => {
  const home = tempHome("open-persisted");
  const { daemon, client } = startHarness({ home });
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await runSession(daemon, client, "s1", { count: 3, acked: 2 });
  await waitForTable(home);

  const second = restart(home, "open-persisted-2");
  t.after(() => second.daemon.close());
  await second.client.hello("client-b", 60_000);

  // The persisted sid is not live any more: the daemon does not answer
  // session_exists, it starts a fresh session.
  const mark = second.client.mark();
  second.client.send({
    op: "open",
    sid: "s1",
    bot: { kind: "acp", command: [process.execPath, FAKE_CHILD] },
  });
  await waitFor(
    () => second.client.sinceMark(mark).some((frame) => frame.op === "state"),
    { label: "the state of the fresh session" },
  );
  const frames = second.client.sinceMark(mark);
  assert.deepEqual(
    frames.filter((frame) => isError(frame) && frame.code === "session_exists"),
    [],
    "a persisted sid is not refused with session_exists",
  );
  const states = frames.filter(isState);
  assert.ok(states.length >= 1, "the fresh session reports its state");
  assert.equal(states[0].sid, "s1");
  assert.equal(states[0].state, "starting", "the daemon starts a fresh session");

  // The fresh session shadows the persisted record.
  const records = second.daemon.table();
  assert.equal(records.length, 1);
  assert.equal(records[0].sid, "s1");
  assert.equal(records[0].lastSeq, 0, "the fresh session starts its numbering at 0");
});

test("a closed session is not in the table after the restart: the resume answers unknown_session", async (t) => {
  const home = tempHome("closed");
  const { daemon, client } = startHarness({ home });
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await runSession(daemon, client, "s1", { count: 2, acked: 2 });
  await waitForTable(home);

  // The client closes the session: it is dropped from the table.
  client.send({ op: "close", sid: "s1" });
  await waitFor(() => daemon.table().length === 0, { label: "the empty table" });

  const second = restart(home, "closed-2");
  t.after(() => second.daemon.close());
  await second.client.hello("client-b", 60_000);
  assert.deepEqual(second.daemon.table(), [], "the closed session is not in the table any more");

  const mark = second.client.mark();
  second.client.send({ op: "resume", sid: "s1", fromSeq: 1 });
  const error = await second.client.waitFor((frame) => frame.op === "error", {
    label: "the unknown_session error",
  });
  if (error.op !== "error") throw new Error("unreachable");
  assert.equal(error.code, "unknown_session");
  assert.equal(error.sid, "s1");
  assert.deepEqual(
    second.client.sinceMark(mark).filter(isState),
    [],
    "a closed session has no state to report",
  );
});

// ---------------------------------------------------------------------------
// The defects of the restart.
// ---------------------------------------------------------------------------

test(
  "the fence of the restarted daemon is higher than the fence of the previous daemon",
  {
    todo: "DEFECT: the fence counter lives in the memory of the daemon and is not persisted; after a restart it starts at 1 again, so a stale client that held fence 1 is not rejected by the new daemon",
  },
  async (t) => {
    const home = tempHome("fence");
    const { daemon, client } = startHarness({ home });
    t.after(() => daemon.close());

    const first = await client.hello("client-a", 60_000);
    await runSession(daemon, client, "s1", { count: 1, acked: 1 });
    await waitForTable(home);

    const second = restart(home, "fence-2");
    t.after(() => second.daemon.close());
    const again = await second.client.hello("client-a", 60_000);
    assert.ok(
      again.fence > first.fence,
      `expected a fence above ${first.fence}, got ${again.fence}`,
    );
  },
);

test(
  "the session table of a daemon survives its close()",
  {
    todo: "DEFECT: close() clears the sessions before the last persist, so the session table is written empty and a graceful restart loses the metadata of every session",
  },
  async (t) => {
    const home = tempHome("close-table");
    const { daemon, client } = startHarness({ home });
    t.after(() => daemon.close());

    await client.hello("client-a", 60_000);
    await runSession(daemon, client, "s1", { count: 2, acked: 1 });
    await waitForTable(home);

    daemon.close();
    const persisted = JSON.parse(fs.readFileSync(path.join(home, "sessions.json"), "utf8"));
    assert.equal(persisted.sessions.length, 1, "the record of the session survives the close");
    assert.equal(persisted.sessions[0].lastSeq, 2);
  },
);

test(
  "the fresh session of a persisted sid continues the numbering of the events",
  {
    todo: "DEFECT: the fresh session of a persisted sid restarts the sequence numbers at 1 while the persisted record says lastSeq 3, so the client cannot tell the new events from the old ones",
  },
  async (t) => {
    const home = tempHome("renumber");
    const { daemon, client } = startHarness({ home });
    t.after(() => daemon.close());

    await client.hello("client-a", 60_000);
    await runSession(daemon, client, "s1", { count: 3, acked: 2 });
    await waitForTable(home);

    const second = restart(home, "renumber-2");
    t.after(() => second.daemon.close());
    await second.client.hello("client-b", 60_000);
    second.client.send({
      op: "open",
      sid: "s1",
      bot: { kind: "acp", command: [process.execPath, FAKE_CHILD] },
    });
    await waitFor(
      () => second.client.sinceMark(0).some((frame) => frame.op === "state" && frame.state === "running"),
      { label: "the running state of the fresh session" },
    );
    second.client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 1 } });
    const event = await second.client.waitFor(
      (frame) => frame.op === "event" && frame.sid === "s1",
      { label: "the first event of the fresh session" },
    );
    if (event.op !== "event") throw new Error("unreachable");
    assert.equal(event.seq, 4, "the numbering of the persisted session continues");
  },
);
