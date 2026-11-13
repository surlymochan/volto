// Concurrency tests for the bot daemon: many sessions on one connection.
//
// One daemon and one client drive five sessions at the same time.  Every
// session numbers its own events, the stream of a session never carries the
// events of another one, and closing, cancelling, acknowledging or resuming
// a session leaves the other sessions untouched.
//
// The child of every session is the fake child of the fixtures
// (test/fixtures/fake-child.mjs): it answers `emit count` with count lines
// and it carries the id of the payload back, so every event can be traced
// back to the session that produced it.  No host name, address or credential
// shows up in this file.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  FAKE_CHILD,
  TestClient,
  isError,
  isEvent,
  makeTempDir,
  startHarness,
  waitFor,
} from "./helpers.ts";

/** The command of the fake child of the fixtures. */
const CHILD_COMMAND = [process.execPath, FAKE_CHILD];

/** The sessions of the scenario. */
const SIDS = ["s1", "s2", "s3", "s4", "s5"];

/** The answer of the fake child: the id of the request and its own counter. */
type ChildPayload = { id?: string; result?: { seq?: number } };

/**
 * Open a session and wait until its child runs.
 *
 * Returns the mark of the frames that follow the open, so that a caller can
 * look at the frames of this session only.
 */
async function openSession(client: TestClient, sid: string): Promise<number> {
  const mark = client.mark();
  client.send({ op: "open", sid, bot: { kind: "acp", command: CHILD_COMMAND } });
  await waitFor(
    () =>
      client
        .sinceMark(mark)
        .some((frame) => frame.op === "state" && frame.sid === sid && frame.state === "running"),
    { label: `the running state of ${sid}` },
  );
  return mark;
}

/** Open the five sessions of the scenario, one after the other. */
async function openFive(client: TestClient): Promise<void> {
  for (const sid of SIDS) await openSession(client, sid);
}

/**
 * Send `emit count` to a session.
 *
 * The id of the payload is the sid of the session: the child carries it back
 * in every answer, so an event that leaks into the stream of another session
 * is visible right away.
 */
function emit(client: TestClient, sid: string, count: number): void {
  client.send({ op: "send", sid, payload: { cmd: "emit", count, id: sid } });
}

/** The sequence numbers of the events of a session. */
function seqs(client: TestClient, sid: string): number[] {
  return client.events(sid).map((event) => event.seq);
}

/** The payload of an event. */
function payloadOf(event: { payload: unknown }): ChildPayload {
  return event.payload as ChildPayload;
}

/** The sessions of the persisted session table. */
function persistedSessions(storeFile: string): { sid: string; ackedSeq: number }[] {
  if (!fs.existsSync(storeFile)) return [];
  const parsed = JSON.parse(fs.readFileSync(storeFile, "utf8")) as {
    sessions?: { sid: string; ackedSeq: number }[];
  };
  return parsed.sessions ?? [];
}

test("numbers the events of five concurrent sessions on their own", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openFive(client);

  // The five sends are not awaited: the daemon multiplexes them.
  for (const sid of SIDS) emit(client, sid, 3);

  await waitFor(() => SIDS.every((sid) => client.events(sid).length >= 3), {
    label: "three events per session",
  });

  for (const sid of SIDS) {
    const numbers = seqs(client, sid);
    assert.deepEqual(numbers, [1, 2, 3], `${sid} has to be numbered from 1 without gaps`);
    for (let index = 1; index < numbers.length; index += 1) {
      assert.ok(
        numbers[index] > numbers[index - 1],
        `${sid} has to be numbered strictly increasingly`,
      );
    }
    // The child of the session counted its own answers.
    const own = client.events(sid).map((event) => payloadOf(event).result?.seq);
    assert.deepEqual(own, [0, 1, 2], `${sid} must only carry the answers of its own child`);
  }
});

test("keeps the events of a session out of the stream of the other sessions", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openFive(client);

  // The sends are interleaved: four rounds of one event per session.
  for (let round = 0; round < 4; round += 1) {
    for (const sid of SIDS) emit(client, sid, 1);
  }

  await waitFor(() => SIDS.every((sid) => client.events(sid).length >= 4), {
    label: "four events per session",
  });

  const events = client.frames.filter(isEvent);
  assert.equal(events.length, 20, "every session answers exactly four times");
  for (const event of events) {
    assert.equal(
      payloadOf(event).id,
      event.sid,
      `the event ${event.seq} of ${event.sid} was produced by another session`,
    );
  }
  for (const sid of SIDS) {
    assert.deepEqual(seqs(client, sid), [1, 2, 3, 4], `${sid} numbers its own events`);
    const own = client.events(sid).map((event) => payloadOf(event).result?.seq);
    assert.deepEqual(own, [0, 1, 2, 3], `${sid} must only carry the answers of its own child`);
  }
});

test("closes one session without touching the other ones", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openFive(client);

  for (const sid of SIDS) emit(client, sid, 1);
  await waitFor(() => SIDS.every((sid) => client.events(sid).length >= 1), {
    label: "the first event of every session",
  });

  client.send({ op: "close", sid: "s3" });
  await waitFor(() => daemon.sessionStatus("s3") === undefined, {
    label: "s3 to be gone",
  });

  // The other sessions still answer, with the next sequence number.
  const others = ["s1", "s2", "s4", "s5"];
  for (const sid of others) emit(client, sid, 1);
  await waitFor(() => others.every((sid) => client.events(sid).length >= 2), {
    label: "the answers of the remaining sessions",
  });

  for (const sid of others) {
    assert.deepEqual(seqs(client, sid), [1, 2], `${sid} keeps on counting`);
    assert.equal(daemon.sessionStatus(sid)?.live, true);
    // The watchdog reports the session as running once it saw its output.
    await waitFor(() => daemon.sessionStatus(sid)?.state === "running", {
      label: `the running state of ${sid}`,
    });
  }
  assert.equal(daemon.sessionStatus("s3"), undefined, "the closed session is gone");
  assert.ok(
    !daemon.table().some((record) => record.sid === "s3"),
    "the closed session is not in the session table any more",
  );
});

test("cancels one session without touching the other ones", async (t) => {
  const { daemon, client } = startHarness({ cancelGraceMs: 400, cancelKillGraceMs: 400 });
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openFive(client);

  for (const sid of SIDS) emit(client, sid, 1);
  await waitFor(() => SIDS.every((sid) => client.events(sid).length >= 1), {
    label: "the first event of every session",
  });

  // The fake child ignores the cancel message, so the escalation kills it.
  client.send({
    op: "cancel",
    sid: "s2",
    payload: { jsonrpc: "2.0", method: "session/cancel", params: {} },
  });
  await waitFor(() => daemon.sessionStatus("s2")?.cancelling === true, {
    label: "s2 to be cancelling",
  });

  // The other sessions keep on answering while s2 is cancelled.
  const others = ["s1", "s3", "s4", "s5"];
  for (const sid of others) emit(client, sid, 1);
  await waitFor(() => others.every((sid) => client.events(sid).length >= 2), {
    label: "the answers of the other sessions",
  });

  await waitFor(() => daemon.sessionStatus("s2")?.state === "exited", {
    timeoutMs: 5000,
    label: "the child of s2 to be gone",
  });

  // And they keep on answering after the escalation.
  for (const sid of others) emit(client, sid, 1);
  await waitFor(() => others.every((sid) => client.events(sid).length >= 3), {
    label: "the answers after the cancel",
  });

  for (const sid of others) {
    assert.deepEqual(seqs(client, sid), [1, 2, 3], `${sid} keeps on counting`);
    assert.equal(daemon.sessionStatus(sid)?.live, true);
    assert.equal(daemon.sessionStatus(sid)?.cancelling, false);
  }
  assert.equal(daemon.sessionStatus("s2")?.cancelling, false);
  assert.equal(daemon.sessionStatus("s2")?.live, false);
  const errors = client.frames.filter(isError);
  assert.deepEqual(
    errors.filter((frame) => frame.sid !== "s2"),
    [],
    "the cancel of s2 must not report an error for another session",
  );
});

test("keeps the ack of a session out of the other sessions", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openFive(client);

  for (const sid of SIDS) emit(client, sid, 2);
  await waitFor(() => SIDS.every((sid) => client.events(sid).length >= 2), {
    label: "two events per session",
  });

  client.send({ op: "ack", sid: "s1", seq: 2 });
  await waitFor(() => daemon.sessionStatus("s1")?.ackedSeq === 2, {
    label: "the ack of s1",
  });

  assert.equal(daemon.sessionStatus("s1")?.ackedSeq, 2);
  for (const sid of ["s2", "s3", "s4", "s5"]) {
    assert.equal(daemon.sessionStatus(sid)?.ackedSeq, 0, `${sid} must not be acknowledged`);
    const record = daemon.table().find((entry) => entry.sid === sid);
    assert.equal(record?.ackedSeq, 0, `${sid} must not be acknowledged in the table`);
  }
  assert.equal(daemon.table().find((entry) => entry.sid === "s1")?.ackedSeq, 2);
});

test("replays the events of one session on resume", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openFive(client);

  for (const sid of SIDS) emit(client, sid, 2);
  await waitFor(() => SIDS.every((sid) => client.events(sid).length >= 2), {
    label: "two events per session",
  });

  const mark = client.mark();
  client.send({ op: "resume", sid: "s4", fromSeq: 1 });
  // The state frame comes after the replayed events.
  await waitFor(
    () => client.sinceMark(mark).some((frame) => frame.op === "state" && frame.sid === "s4"),
    { label: "the state after the replay" },
  );

  const replayed = client.sinceMark(mark).filter(isEvent);
  assert.deepEqual(
    replayed.map((event) => event.sid),
    ["s4", "s4"],
    "the replay carries the events of s4 only",
  );
  assert.deepEqual(
    replayed.map((event) => event.seq),
    [1, 2],
    "the replay repeats the events of s4 in order",
  );
  assert.deepEqual(
    replayed.map((event) => payloadOf(event).id),
    ["s4", "s4"],
    "the replayed events come from the child of s4",
  );
});

test("leaves no stale session after twenty open and close cycles", async (t) => {
  const home = makeTempDir("multi-cycle-");
  const storeFile = path.join(home, "sessions.json");
  const { daemon, client } = startHarness({ home, storeFile });
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);

  for (let round = 0; round < 20; round += 1) {
    await openSession(client, "cycle");
    assert.ok(daemon.sessionStatus("cycle"), `the session of round ${round} exists`);
    client.send({ op: "close", sid: "cycle" });
    await waitFor(() => daemon.sessionStatus("cycle") === undefined, {
      label: `the close of round ${round}`,
    });
    assert.ok(
      !daemon.table().some((record) => record.sid === "cycle"),
      `the session of round ${round} is not in the table any more`,
    );
  }

  assert.equal(daemon.sessionStatus("cycle"), undefined, "no stale session is left behind");

  // One live session next to it: the table lists exactly this one.
  await openSession(client, "live");
  emit(client, "live", 1);
  await waitFor(() => client.events("live").length >= 1, { label: "the event of the live session" });

  await waitFor(() => persistedSessions(storeFile).length === 1, {
    label: "the persisted table to hold one session",
  });
  const persisted = persistedSessions(storeFile);
  assert.deepEqual(
    persisted.map((record) => record.sid),
    ["live"],
    "the persisted table lists the live sessions only",
  );
  assert.deepEqual(
    daemon.table().map((record) => record.sid),
    ["live"],
    "the session table lists the live sessions only",
  );
});
