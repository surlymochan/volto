// Tests for the lease and its fence.

import test from "node:test";
import assert from "node:assert/strict";

import { LeaseManager } from "../src/lease.ts";

function manager(now: { value: number }): LeaseManager {
  return new LeaseManager({
    defaultTtlMs: 1000,
    minTtlMs: 100,
    now: () => now.value,
  });
}

test("a hello creates the first lease", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const result = lease.hello("client-a", 500);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.fence, 1);
  assert.equal(result.value.clientId, "client-a");
  assert.equal(result.value.ttlMs, 500);
  assert.equal(lease.state(0), "ok");
});

test("the same client keeps its fence", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const first = lease.hello("client-a", 500);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = lease.hello("client-a", 500);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.value.fence, first.value.fence);
  assert.equal(second.value.leaseId, first.value.leaseId);
});

test("another client takes the lease over and bumps the fence", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const first = lease.hello("client-a", 500);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  // Round 2: a takeover is only possible once the first lease expired; while it is ok the second holder gets lease_conflict.
  now.value = 500;
  const second = lease.hello("client-b", 500);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.value.fence, first.value.fence + 1);
  assert.notEqual(second.value.leaseId, first.value.leaseId);
});

test("a renew with a stale fence is rejected", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const first = lease.hello("client-a", 500);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  // Round 2: the takeover needs an expired first lease (otherwise lease_conflict).
  now.value = 500;
  lease.hello("client-b", 500);
  const renew = lease.renew(first.value.leaseId, first.value.fence);
  assert.equal(renew.ok, false);
  if (renew.ok) return;
  assert.equal(renew.code, "stale_fence");
});

test("a renew with an unknown lease id is rejected", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;
  const renew = lease.renew("not-a-lease", hello.value.fence);
  assert.equal(renew.ok, false);
  if (renew.ok) return;
  assert.equal(renew.code, "stale_lease");
});

test("a renew extends the lease", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;
  now.value = 400;
  const renew = lease.renew(hello.value.leaseId, hello.value.fence);
  assert.equal(renew.ok, true);
  assert.equal(lease.state(800), "ok");
  assert.equal(lease.state(950), "paused");
});

test("the lease pauses after one ttl and dies after two", () => {
  const now = { value: 0 };
  const lease = manager(now);
  lease.hello("client-a", 500);
  assert.equal(lease.state(499), "ok");
  assert.equal(lease.state(500), "paused");
  assert.equal(lease.state(999), "paused");
  assert.equal(lease.state(1000), "dead");
});

test("there is no lease before the first hello", () => {
  const now = { value: 0 };
  const lease = manager(now);
  assert.equal(lease.state(0), "none");
  const renew = lease.renew("lease", 1);
  assert.equal(renew.ok, false);
  if (renew.ok) return;
  assert.equal(renew.code, "no_lease");
});

test("a client supplied ttl is bounded from below", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", 1);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;
  assert.equal(hello.value.ttlMs, 100);
});
