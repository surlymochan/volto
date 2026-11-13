// Tests for the bot daemon: sequencing, resume, lease, fence, cancel and the
// session table.
//
// The bot child is a tiny local script (test/fixtures/fake-child.mjs); no
// host name, address or credential shows up in this file.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { Botd } from "../src/daemon.ts";
import {
  ANSWERING_CHILD,
  FAKE_CHILD,
  TestClient,
  delay,
  isEvent,
  makeTempDir,
  readChildLog,
  startHarness,
  waitFor,
} from "./helpers.ts";

const CHILD_COMMAND = [process.execPath, FAKE_CHILD];

/** Open a session and wait until the child runs. */
async function openSession(
  client: TestClient,
  sid: string,
  env?: Record<string, string>,
): Promise<void> {
  client.send({
    op: "open",
    sid,
    bot: { kind: "acp", command: CHILD_COMMAND, ...(env ? { env } : {}) },
  });
  await client.waitFor((frame) => frame.op === "state" && frame.sid === sid && frame.state === "running", {
    label: `the running state of ${sid}`,
  });
}

test("numbers the events of a session and replays them on resume", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");

  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 3 } });
  await client.waitFor((frame) => frame.op === "event" && frame.sid === "s1" && frame.seq === 3, {
    label: "the third event",
  });

  const events = client.events("s1");
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);

  client.send({ op: "ack", sid: "s1", seq: 2 });
  await waitFor(() => daemon.sessionStatus("s1")?.ackedSeq === 2, { label: "the ack" });

  const mark = client.mark();
  client.send({ op: "resume", sid: "s1", fromSeq: 2 });
  const replayed = await waitFor(() => {
    const events = client.sinceMark(mark).filter(isEvent);
    return events.length >= 2 ? events : undefined;
  }, { label: "the replay" });
  assert.deepEqual(replayed.map((event) => event.seq), [2, 3]);
});

test("reports a gap when the ring buffer overflows", async (t) => {
  const { daemon, client } = startHarness({ ringMaxEvents: 2 });
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");

  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 5 } });
  await client.waitFor((frame) => frame.op === "event" && frame.sid === "s1" && frame.seq === 5, {
    label: "the fifth event",
  });

  const mark = client.mark();
  client.send({ op: "resume", sid: "s1", fromSeq: 1 });
  const gap = await client.waitFor((frame) => frame.op === "gap" && frame.sid === "s1", {
    label: "the gap frame",
  });
  assert.equal(gap.fromSeq, 1);
  assert.equal(gap.toSeq, 3);

  const replayed = client.sinceMark(mark).filter(isEvent);
  assert.deepEqual(replayed.map((event) => event.seq), [4, 5]);
});

test("pauses the sessions when the lease expires and resumes them on hello", async (t) => {
  const { daemon, client } = startHarness({ leaseTtlMs: 600, watchdogIntervalMs: 50 });
  t.after(() => daemon.close());

  const hello = await client.hello("client-a", 600);
  await openSession(client, "s1");

  await client.waitFor((frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "paused", {
    timeoutMs: 4000,
    label: "the paused state",
  });

  // While the lease is gone the input is not forwarded.
  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 1 } });
  const error = await client.waitFor((frame) => frame.op === "error" && frame.code === "lease_paused", {
    label: "the lease error",
  });
  assert.equal(error.sid, "s1");
  // The child is still alive.
  assert.equal(daemon.sessionStatus("s1")?.live, true);

  // Round 2: a renew of an expired lease is refused (lease_expired); the
  // client brings the session back to life with a new hello (same clientId
  // keeps the lease id and the fence).
  client.send({ op: "renew", leaseId: hello.leaseId, fence: hello.fence });
  await client.waitFor((frame) => frame.op === "error" && frame.code === "lease_expired", {
    label: "the lease_expired error of the late renew",
  });
  const again = await client.hello("client-a", 600);
  assert.equal(again.leaseId, hello.leaseId);
  assert.equal(again.fence, hello.fence);
  await client.waitFor((frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "running", {
    timeoutMs: 4000,
    label: "the running state after the renew",
  });
  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 1 } });
  await client.waitFor((frame) => frame.op === "event" && frame.sid === "s1" && frame.seq === 1, {
    label: "the event after the renew",
  });
});

test("terminates the children when the lease expires twice", async (t) => {
  const { daemon, client } = startHarness({ leaseTtlMs: 300, watchdogIntervalMs: 50 });
  t.after(() => daemon.close());

  await client.hello("client-a", 300);
  await openSession(client, "s1");
  client.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 1 } });
  await client.waitFor((frame) => frame.op === "event" && frame.sid === "s1" && frame.seq === 1, {
    label: "the first event",
  });

  await client.waitFor((frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "exited", {
    timeoutMs: 8000,
    label: "the exited state",
  });
  assert.equal(daemon.sessionStatus("s1")?.live, false);

  // The metadata of the session is kept, so the client can resume it: the
  // events that are still buffered are replayed.
  assert.equal(daemon.table()[0].state, "exited");
  const mark = client.mark();
  client.send({ op: "resume", sid: "s1", fromSeq: 1 });
  const replayed = await waitFor(() => {
    const events = client.sinceMark(mark).filter(isEvent);
    return events.length >= 1 ? events : undefined;
  }, { label: "the replay of the killed session" });
  assert.deepEqual(replayed.map((event) => event.seq), [1]);
});

test("rejects the frames of a client that lost the fence", async (t) => {
  // Round 2: a second holder only takes over an expired lease (otherwise
  // lease_conflict), so the test drives the clock of the daemon past the ttl.
  const clock = { value: Date.now() };
  const daemon = new Botd(
    { leaseTtlMs: 60_000, watchdogIntervalMs: 50, now: () => clock.value },
    { onFrame: () => {} },
  );
  t.after(() => daemon.close());
  const first = new TestClient(daemon);
  const second = new TestClient(daemon);

  const helloA = await first.hello("client-a", 60_000);
  clock.value += 60_000;
  const helloB = await second.hello("client-b", 60_000);
  assert.ok(helloB.fence > helloA.fence, "the fence of the new client has to be higher");

  // The old client cannot renew the lease any more.
  first.send({ op: "renew", leaseId: helloA.leaseId, fence: helloA.fence });
  await first.waitFor((frame) => frame.op === "error" && frame.code === "stale_fence", {
    label: "the stale fence error",
  });

  // And it cannot drive the sessions either.
  const mark = first.mark();
  first.send({ op: "send", sid: "s1", payload: { cmd: "emit" } });
  await first.waitFor((frame) => frame.op === "error" && frame.code === "stale_fence", {
    label: "the second stale fence error",
  });
  assert.ok(first.sinceMark(mark).length >= 1);

  // The new client is in charge.
  await openSession(second, "s1");
  second.send({ op: "send", sid: "s1", payload: { cmd: "emit", count: 1 } });
  await second.waitFor((frame) => frame.op === "event" && frame.sid === "s1" && frame.seq === 1, {
    label: "the event of the new client",
  });
});

test("escalates a cancel to a SIGKILL of the process group", async (t) => {
  const home = makeTempDir("cancel-");
  const logFile = path.join(home, "child.log");
  const { daemon, client } = startHarness({ home });
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1", { FAKE_CHILD_LOG: logFile });

  // The child ignores SIGINT and stays silent: only a SIGKILL stops it.
  client.send({ op: "send", sid: "s1", payload: { cmd: "ignore-sigint" } });
  await waitFor(
    () => readChildLog(logFile).some((entry) => entry.event === "ignore-sigint"),
    { label: "the child to ignore SIGINT" },
  );

  const mark = client.mark();
  const started = Date.now();
  client.send({
    op: "cancel",
    sid: "s1",
    payload: { jsonrpc: "2.0", method: "session/cancel", params: {} },
  });

  // The provider message reaches the child.
  await waitFor(
    () => readChildLog(logFile).some((entry) => entry.line?.includes("session/cancel")),
    { label: "the cancel message at the child" },
  );

  // The state of the session is reported.
  await client.waitFor((frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "paused", {
    label: "the paused state of the cancelled session",
  });

  // The child gets a SIGINT after 3s and a SIGKILL after 6s.
  await client.waitFor((frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "exited", {
    timeoutMs: 12_000,
    label: "the exited state of the cancelled session",
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 5000, `expected the kill after ~6s, got ${elapsed}ms`);
  assert.ok(elapsed <= 10_000, `expected the kill after ~6s, got ${elapsed}ms`);
  assert.ok(client.sinceMark(mark).length >= 2);
});

test("forwards the input again after the child answered a cancel", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  client.send({
    op: "open",
    sid: "s1",
    bot: { kind: "acp", command: [process.execPath, ANSWERING_CHILD] },
  });
  await client.waitFor((frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "running", {
    label: "the running state",
  });

  const mark = client.mark();
  client.send({
    op: "cancel",
    sid: "s1",
    payload: { jsonrpc: "2.0", method: "session/cancel", params: {} },
  });
  await client.waitFor((frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "paused", {
    label: "the paused state of the cancelled session",
  });

  // The child answers the cancel: the session is not cancelling any more.
  await waitFor(() => daemon.sessionStatus("s1")?.cancelling === false, {
    label: "the cancel to be answered",
  });
  await waitFor(
    () =>
      client
        .sinceMark(mark)
        .some((frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "running"),
    { label: "the running state after the cancel" },
  );

  // The next message is forwarded to the child and answered.
  const sendMark = client.mark();
  client.send({ op: "send", sid: "s1", payload: { cmd: "echo", text: "after the cancel" } });
  await waitFor(
    () =>
      client
        .sinceMark(sendMark)
        .some(
          (frame) =>
            frame.op === "event" &&
            JSON.stringify(frame.payload).includes("after the cancel"),
        ),
    { label: "the answer of the child" },
  );
  const errors = client
    .sinceMark(sendMark)
    .filter((frame) => frame.op === "error" && frame.code === "session_cancelling");
  assert.deepEqual(errors, [], "the input must not be refused after an answered cancel");
});

test("reports a stalled session", async (t) => {
  const { daemon, client } = startHarness({
    stallMs: 300,
    idleAfterMs: 200,
    watchdogIntervalMs: 50,
  });
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");

  const stall = await client.waitFor((frame) => frame.op === "stall" && frame.sid === "s1", {
    timeoutMs: 4000,
    label: "the stall frame",
  });
  assert.ok(stall.idleMs >= 300);
  const states = client.states("s1");
  assert.ok(states.some((state) => state.state === "idle"));
  assert.ok(states.every((state) => typeof state.progressAt === "number"));
});

test("persists the session table and reads it back", async (t) => {
  const home = makeTempDir("persist-");
  const storeFile = path.join(home, "sessions.json");
  const { daemon, client } = startHarness({ home, storeFile });
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  await openSession(client, "s1");
  await waitFor(() => fs.existsSync(storeFile), { label: "the session table" });

  const parsed = JSON.parse(fs.readFileSync(storeFile, "utf8"));
  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.sessions[0].sid, "s1");
  assert.equal(parsed.sessions[0].kind, "acp");
  assert.deepEqual(parsed.sessions[0].command, CHILD_COMMAND);
  assert.equal(parsed.sessions[0].state, "running");

  // The table is written atomically: no temporary file is left behind.
  assert.deepEqual(fs.readdirSync(home), ["sessions.json"]);

  // A fresh daemon picks the metadata of the session up.
  const restarted = new Botd({ home, storeFile }, { onFrame: () => {} });
  const table = restarted.table();
  assert.equal(table.length, 1);
  assert.equal(table[0].sid, "s1");
  assert.equal(table[0].state, "exited");
  restarted.close();
});

test("keeps the provider session id of a resumed session", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());

  await client.hello("client-a", 60_000);
  client.send({
    op: "open",
    sid: "s1",
    bot: { kind: "codex-app-server", command: CHILD_COMMAND },
    resume: { providerSessionId: "prov-42" },
  });
  await client.waitFor((frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "running", {
    label: "the running state",
  });
  assert.equal(daemon.sessionStatus("s1")?.providerSessionId, "prov-42");
  await delay(50);
  assert.equal(daemon.table()[0].providerSessionId, "prov-42");
});
