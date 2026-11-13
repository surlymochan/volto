import test from "node:test";
import assert from "node:assert/strict";

import { LeaseManager } from "../src/lease.ts";

function setup() {
  const clock = { value: 1000 };
  const manager = new LeaseManager({ defaultTtlMs: 500, minTtlMs: 100, now: () => clock.value });
  const first = manager.hello("client-a", 500);
  assert.ok(first.ok);
  return { clock, manager, first: first.value };
}

test("renew succeeds one millisecond before expiry", () => {
  const { clock, manager, first } = setup();
  clock.value = 1499;
  const renewed = manager.renew(first.leaseId, first.fence);
  assert.ok(renewed.ok);
  assert.equal(renewed.value.pauseAt, 1999);
});

test("renew fails exactly at expiry without changing the lease", () => {
  const { clock, manager, first } = setup();
  clock.value = 1500;
  const renewed = manager.renew(first.leaseId, first.fence);
  assert.equal(renewed.ok, false);
  if (renewed.ok) return;
  assert.equal(renewed.code, "lease_expired");
  assert.deepEqual(manager.current, first);
});

test("renew fails one millisecond after expiry", () => {
  const { clock, manager, first } = setup();
  clock.value = 1501;
  const renewed = manager.renew(first.leaseId, first.fence);
  assert.equal(renewed.ok, false);
  if (renewed.ok) return;
  assert.equal(renewed.code, "lease_expired");
});

test("renewal deadlines are measured from the current time", () => {
  const { clock, manager, first } = setup();
  clock.value = 1200;
  const renewed = manager.renew(first.leaseId, first.fence);
  assert.ok(renewed.ok);
  assert.equal(renewed.value.renewedAt, 1200);
  assert.equal(renewed.value.pauseAt, 1700);
  assert.equal(renewed.value.deadAt, 2200);
  assert.equal(renewed.value.leaseId, first.leaseId);
  assert.equal(renewed.value.fence, first.fence);
});

test("a second client is rejected just before expiry without altering the lease", () => {
  const { clock, manager, first } = setup();
  clock.value = 1499;
  const second = manager.hello("client-b", 500);
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.code, "lease_conflict");
  assert.deepEqual(manager.current, first);
});

test("a second client can take over one millisecond after expiry", () => {
  const { clock, manager, first } = setup();
  clock.value = 1501;
  const second = manager.hello("client-b", 500);
  assert.ok(second.ok);
  assert.equal(second.value.clientId, "client-b");
  assert.equal(second.value.fence, first.fence + 1);
  assert.equal(second.value.pauseAt, 2001);
});

test("zero requested ttl is clamped to the minimum", () => {
  const { clock, manager } = setup();
  clock.value = 1100;
  const result = manager.hello("client-a", 0);
  assert.ok(result.ok);
  assert.equal(result.value.ttlMs, 100);
  assert.equal(result.value.pauseAt, 1200);
  assert.equal(result.value.deadAt, 1300);
});

test("negative requested ttl is clamped to the minimum", () => {
  const { clock, manager } = setup();
  clock.value = 1100;
  const result = manager.hello("client-a", -50);
  assert.ok(result.ok);
  assert.equal(result.value.ttlMs, 100);
  assert.equal(result.value.pauseAt, 1200);
  assert.equal(manager.state(1199), "ok");
  assert.equal(manager.state(1200), "paused");
});

test("a renewed lease blocks takeover until its new expiry", () => {
  const { clock, manager, first } = setup();
  clock.value = 1400;
  assert.ok(manager.renew(first.leaseId, first.fence).ok);
  clock.value = 1501;
  const second = manager.hello("client-b", 500);
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.code, "lease_conflict");
  clock.value = 1900;
  assert.ok(manager.hello("client-b", 500).ok);
});
