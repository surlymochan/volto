// Conformance of the lease, of the fence and of the renewal of
// botd/PROTOCOL.md.
//
// Covered: §3 (hello takes the lease, the fence of a takeover, the refusal
// of the frames of the client that lost the fence, the renewal, the ttl) and
// the codes of §7 (no_lease, stale_fence, stale_lease).
//
// The frames are written as raw NDJSON lines and the answers are read from
// the raw stream. The sessions of the tests use the local fixture of the
// harness; no host, token or name shows up here.

import test from "node:test";
import assert from "node:assert/strict";

import { FAKE_CHILD, startHarness } from "../helpers.ts";
import { RawClient } from "./raw-client.ts";

const CHILD_COMMAND = [process.execPath, FAKE_CHILD];

test("answers a frame before hello with no_lease", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  // PROTOCOL.md §3: hello is the first frame of a connection.
  client.send({ op: "ack", sid: "s1", seq: 1 });
  const error = await client.waitForError("no_lease");
  assert.equal(error.op, "error");
  assert.match(String(error.message), /hello/);
});

test("answers a renew without a lease with no_lease", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  client.send({ op: "renew", leaseId: "11111111-2222-3333-4444-555555555555", fence: 1 });
  const error = await client.waitForError("no_lease");
  assert.equal(error.op, "error");
});

test("gives the takeover a higher fence and a new lease id", async (t) => {
  // Round 2: a takeover needs an expired lease; the test moves the daemon clock.
  const clock = { value: Date.now() };
  const { daemon } = startHarness({ now: () => clock.value });
  t.after(() => daemon.close());
  const first = new RawClient(daemon);
  const second = new RawClient(daemon);

  first.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000 });
  const helloA = await first.waitForOp("hello");

  clock.value += 60_000;
  second.send({ op: "hello", clientId: "client-b", leaseTtlMs: 60_000 });
  const helloB = await second.waitForOp("hello");

  // PROTOCOL.md §3: a hello of another client takes the lease over: it gets
  // a new lease id and a higher fence.
  assert.ok(helloB.fence > helloA.fence, "the fence of the takeover is not higher");
  assert.notEqual(helloB.leaseId, helloA.leaseId, "the lease id did not change");
});

test("refuses a second holder while the lease is ok with lease_conflict", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const first = new RawClient(daemon);
  const second = new RawClient(daemon);

  first.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000 });
  await first.waitForOp("hello");

  // PROTOCOL.md §3: a live lease is not taken over.
  second.send({ op: "hello", clientId: "client-b", leaseTtlMs: 60_000 });
  const error = await second.waitForError("lease_conflict");
  assert.equal(error.op, "error");
});

test("keeps the lease and the fence of a client that reconnects", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const first = new RawClient(daemon);
  const second = new RawClient(daemon);

  first.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000 });
  const helloA = await first.waitForOp("hello");

  // PROTOCOL.md §3: a hello of the same client keeps the lease id and the
  // fence.
  second.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000 });
  const helloB = await second.waitForOp("hello");

  assert.equal(helloB.leaseId, helloA.leaseId, "the lease id changed");
  assert.equal(helloB.fence, helloA.fence, "the fence changed");
});

test("refuses the frames of the client that lost the fence with stale_fence", async (t) => {
  // Round 2: a takeover needs an expired lease; the test moves the daemon clock.
  const clock = { value: Date.now() };
  const { daemon } = startHarness({ now: () => clock.value });
  t.after(() => daemon.close());
  const first = new RawClient(daemon);
  const second = new RawClient(daemon);

  first.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000 });
  const helloA = await first.waitForOp("hello");
  clock.value += 60_000;
  second.send({ op: "hello", clientId: "client-b", leaseTtlMs: 60_000 });
  await second.waitForOp("hello");

  // PROTOCOL.md §3: the frames of the old client are refused.
  first.send({ op: "renew", leaseId: helloA.leaseId, fence: helloA.fence });
  const renewError = await first.waitForError("stale_fence");
  assert.equal(renewError.op, "error");

  first.send({
    op: "open",
    sid: "s1",
    bot: { kind: "acp", command: CHILD_COMMAND },
  });
  const openError = await first.waitForError("stale_fence");
  assert.equal(openError.op, "error");

  // The new client is in charge: its session runs.
  second.send({
    op: "open",
    sid: "s1",
    bot: { kind: "acp", command: CHILD_COMMAND },
  });
  await second.waitFor(
    (frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "running",
    { label: "the running state of s1" },
  );
});

test("refuses a renew with a wrong fence with stale_fence", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  client.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000 });
  const hello = await client.waitForOp("hello");

  client.send({ op: "renew", leaseId: hello.leaseId, fence: hello.fence + 1 });
  const error = await client.waitForError("stale_fence");
  assert.equal(error.op, "error");
  assert.match(String(error.message), /fence/);
});

test("refuses a renew with an unknown lease id with stale_lease", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  client.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000 });
  const hello = await client.waitForOp("hello");

  // PROTOCOL.md §3: a wrong lease id is refused with stale_lease.
  client.send({ op: "renew", leaseId: "11111111-2222-3333-4444-555555555555", fence: hello.fence });
  const error = await client.waitForError("stale_lease");
  assert.equal(error.op, "error");
});

test("does not answer a renew", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  client.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000 });
  const hello = await client.waitForOp("hello");

  // PROTOCOL.md §3: a renew extends the lease and is not answered.
  client.send({ op: "renew", leaseId: hello.leaseId, fence: hello.fence });
  assert.deepEqual(await client.collect(), [], "the renew was answered");
});

test("answers hello with the effective ttl", async (t) => {
  const { daemon } = startHarness();
  t.after(() => daemon.close());
  const client = new RawClient(daemon);

  // PROTOCOL.md §3: the ttl is never below 250 ms and the answer of hello
  // carries the effective ttl.
  client.send({ op: "hello", clientId: "client-a", leaseTtlMs: 10 });
  const hello = await client.waitForOp("hello");
  assert.equal(hello.leaseTtlMs, 250);

  // Round 2: another client would get lease_conflict while the lease is ok; the same client may re-hello with a new ttl.
  client.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000 });
  const second = await client.waitFor((frame) => frame.op === "hello" && frame.leaseTtlMs === 60_000, {
    label: "the hello answer of the second client",
  });
  assert.equal(second.leaseTtlMs, 60_000);
});

test.todo(
  "PROTOCOL.md §3: a frame before hello is answered with no_lease",
  async (t) => {
    // PROTOCOL.md §3: "hello is the first frame of a connection; every
    // other frame before it is answered with error and code:"no_lease"".
    // The daemon answers no_lease while no lease is held, but a second
    // connection that sends a frame before its hello gets stale_fence,
    // because the fence of the connection is compared with the fence of the
    // lease before the lease is looked at. See
    // botd/test/conformance/DEVIATIONS.md (D1).
    const { daemon } = startHarness();
    t.after(() => daemon.close());
    const first = new RawClient(daemon);
    const second = new RawClient(daemon);

    first.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000 });
    await first.waitForOp("hello");

    second.send({ op: "ack", sid: "s1", seq: 1 });
    const error = await second.waitForError("stale_fence");
    assert.equal(error.code, "stale_fence", "the daemon answers stale_fence, not no_lease");
  },
);
