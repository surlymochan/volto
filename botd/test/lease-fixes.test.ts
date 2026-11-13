import test from "node:test";
import assert from "node:assert/strict";
import { LeaseManager } from "../src/lease.ts";

function manager(now: { value: number }): LeaseManager {
  return new LeaseManager({ defaultTtlMs: 1000, minTtlMs: 100, now: () => now.value });
}

for (const time of [500, 501, 1000, 1500]) {
  test(`renew at ${time} rejects an expired lease without changing it`, () => {
    const now = { value: 0 };
    const lease = manager(now);
    const hello = lease.hello("client-a", 500);
    assert.ok(hello.ok);
    now.value = time;
    const result = lease.renew(hello.value.leaseId, hello.value.fence);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "lease_expired");
    assert.deepEqual(lease.current, hello.value);
    assert.equal(lease.state(), time >= 1000 ? "dead" : "paused");
  });
}

test("a different client cannot take a live lease or consume a fence", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const first = lease.hello("client-a", 500);
  assert.ok(first.ok);
  now.value = 499;
  const conflict = lease.hello("client-b", 500);
  assert.equal(conflict.ok, false);
  if (conflict.ok) return;
  assert.equal(conflict.code, "lease_conflict");
  assert.deepEqual(lease.current, first.value);
  assert.equal(lease.fence, first.value.fence);
  now.value = 500;
  const takeover = lease.hello("client-b", 500);
  assert.ok(takeover.ok);
  assert.equal(takeover.value.fence, first.value.fence + 1);
});

test("a different client can take a dead lease", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const first = lease.hello("client-a", 500);
  assert.ok(first.ok);
  now.value = 1000;
  const second = lease.hello("client-b", 500);
  assert.ok(second.ok);
  assert.equal(second.value.fence, first.value.fence + 1);
});

test("the same client reconnects with its existing fence", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const first = lease.hello("client-a", 500);
  assert.ok(first.ok);
  now.value = 100;
  const second = lease.hello("client-a", 500);
  assert.ok(second.ok);
  assert.equal(second.value.fence, first.value.fence);
  assert.equal(second.value.leaseId, first.value.leaseId);
});

test("a huge requested ttl is clamped and deadlines remain finite", () => {
  const now = { value: 1_700_000_000_000 };
  const lease = manager(now);
  const hello = lease.hello("client-a", Number.MAX_VALUE);
  assert.ok(hello.ok);
  assert.ok(hello.value.ttlMs < Number.MAX_VALUE);
  assert.ok(Number.isFinite(hello.value.pauseAt));
  assert.ok(Number.isFinite(hello.value.deadAt));
});

test("a huge default ttl is clamped too", () => {
  const lease = new LeaseManager({ defaultTtlMs: Number.MAX_VALUE, minTtlMs: 100, now: () => 0 });
  const hello = lease.hello("client-a");
  assert.ok(hello.ok);
  assert.ok(hello.value.ttlMs < Number.MAX_VALUE);
  assert.ok(Number.isFinite(hello.value.deadAt));
});
