// Tests for the TTL, the state boundaries and the error precedence of the
// lease manager (botd/src/lease.ts).
//
// The lease manager hands the lease of a session to a client, guards it with
// a fence and lets it expire when the client stops renewing.  The tests
// drive an injected clock, so no test waits for the wall clock time; every
// client id and lease id is synthetic.
//
// The rules come from botd/PROTOCOL.md §3 (lease, fence and renewal) and
// §7 (the error codes):
//
//   * a hello of the same client keeps the lease id and the fence and pushes
//     the deadlines of the lease away,
//   * a hello of another client takes an expired lease over: the fence grows
//     by one and the lease id is new,
//   * the TTL of a client is clamped to [minTtlMs, MAX_TTL_MS]; a TTL that is
//     not a finite number falls back to the default TTL,
//   * the lease is "ok" until renewedAt + ttl, "paused" from there on and
//     "dead" from renewedAt + 2 * ttl on,
//   * a renew is refused with no_lease, then stale_fence, then stale_lease;
//     the fence is checked before the lease id.

import test from "node:test";
import assert from "node:assert/strict";

import { LeaseManager } from "../src/lease.ts";

/** The default TTL of the lease manager used in the tests. */
const DEFAULT_TTL_MS = 1000;
/** The lower bound for a client supplied TTL (PROTOCOL.md §3). */
const MIN_TTL_MS = 250;

/**
 * A lease manager driven by a clock the test controls.
 */
function manager(
  now: { value: number },
  options: { defaultTtlMs?: number; minTtlMs?: number } = {},
): LeaseManager {
  return new LeaseManager({
    defaultTtlMs: options.defaultTtlMs ?? DEFAULT_TTL_MS,
    minTtlMs: options.minTtlMs ?? MIN_TTL_MS,
    now: () => now.value,
  });
}

// ---------------------------------------------------------------------------
// The hello: the TTL of the lease
// ---------------------------------------------------------------------------

test("a hello of the same client extends the lease and keeps the lease id and the fence", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const first = lease.hello("client-a", 500);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.value.renewedAt, 0);
  assert.equal(first.value.pauseAt, 500);
  assert.equal(first.value.deadAt, 1000);

  now.value = 200;
  const again = lease.hello("client-a", 500);
  assert.equal(again.ok, true);
  if (!again.ok) return;

  // The lease id and the fence survive the reconnect, the deadlines move.
  assert.equal(again.value.leaseId, first.value.leaseId);
  assert.equal(again.value.fence, first.value.fence);
  assert.equal(again.value.renewedAt, 200);
  assert.equal(again.value.pauseAt, 700);
  assert.equal(again.value.deadAt, 1200);

  assert.equal(lease.state(699), "ok");
  assert.equal(lease.state(700), "paused");
});

test("a takeover bumps the fence by exactly one and mints a new lease id", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const first = lease.hello("client-a", 500);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  // The first lease died at 1000: another client may take it over.
  now.value = 1000;
  const second = lease.hello("client-b", 500);
  assert.equal(second.ok, true);
  if (!second.ok) return;

  assert.equal(second.value.fence, first.value.fence + 1);
  assert.notEqual(second.value.leaseId, first.value.leaseId);
  assert.equal(second.value.clientId, "client-b");

  // The deadlines of the new lease start at the takeover.
  assert.equal(second.value.renewedAt, 1000);
  assert.equal(second.value.pauseAt, 1500);
  assert.equal(second.value.deadAt, 2000);
  assert.equal(lease.state(1000), "ok");
  assert.equal(lease.state(1500), "paused");
  assert.equal(lease.state(2000), "dead");
});

test("a ttl below the minimum is clamped up and the deadlines follow", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", MIN_TTL_MS - 1);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;

  assert.equal(hello.value.ttlMs, MIN_TTL_MS);
  assert.equal(hello.value.pauseAt, MIN_TTL_MS);
  assert.equal(hello.value.deadAt, 2 * MIN_TTL_MS);

  // The state follows the clamped ttl, not the requested one.
  assert.equal(lease.state(MIN_TTL_MS - 1), "ok");
  assert.equal(lease.state(MIN_TTL_MS), "paused");
  assert.equal(lease.state(2 * MIN_TTL_MS), "dead");
});

test("a NaN ttl on a reconnect falls back to the default and keeps the lease id", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const first = lease.hello("client-a", 500);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  now.value = 100;
  const again = lease.hello("client-a", Number.NaN);
  assert.equal(again.ok, true);
  if (!again.ok) return;

  assert.equal(again.value.ttlMs, DEFAULT_TTL_MS);
  assert.equal(again.value.pauseAt, 100 + DEFAULT_TTL_MS);
  assert.equal(again.value.leaseId, first.value.leaseId);
  assert.equal(again.value.fence, first.value.fence);
});

test("a negative infinite ttl falls back to the default", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", Number.NEGATIVE_INFINITY);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;

  assert.equal(hello.value.ttlMs, DEFAULT_TTL_MS);
  assert.equal(hello.value.pauseAt, DEFAULT_TTL_MS);
  assert.equal(hello.value.deadAt, 2 * DEFAULT_TTL_MS);
});

test("a hello without a ttl on a reconnect falls back to the default", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const first = lease.hello("client-a", 500);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  now.value = 100;
  const again = lease.hello("client-a");
  assert.equal(again.ok, true);
  if (!again.ok) return;

  assert.equal(again.value.ttlMs, DEFAULT_TTL_MS);
  assert.equal(again.value.pauseAt, 100 + DEFAULT_TTL_MS);
  assert.equal(again.value.leaseId, first.value.leaseId);
  assert.equal(again.value.fence, first.value.fence);
});

test("a default ttl below the minimum is clamped up to the minimum", () => {
  const now = { value: 0 };
  const lease = manager(now, { defaultTtlMs: 50, minTtlMs: MIN_TTL_MS });
  const hello = lease.hello("client-a");
  assert.equal(hello.ok, true);
  if (!hello.ok) return;

  // The default is clamped like a client supplied ttl.
  assert.equal(hello.value.ttlMs, MIN_TTL_MS);
  assert.equal(hello.value.pauseAt, MIN_TTL_MS);
  assert.equal(hello.value.deadAt, 2 * MIN_TTL_MS);
});

// ---------------------------------------------------------------------------
// The state of the lease at a point in time
// ---------------------------------------------------------------------------

test("the state of a renewed lease follows the renewed deadlines", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;

  now.value = 400;
  const renew = lease.renew(hello.value.leaseId, hello.value.fence);
  assert.equal(renew.ok, true);
  if (!renew.ok) return;
  assert.equal(renew.value.pauseAt, 900);
  assert.equal(renew.value.deadAt, 1400);

  // Just below the pause deadline the lease is ok, at the deadline it is
  // paused and at the dead deadline it is dead.
  assert.equal(lease.state(899), "ok");
  assert.equal(lease.state(900), "paused");
  assert.equal(lease.state(1399), "paused");
  assert.equal(lease.state(1400), "dead");
});

test("the state after a takeover follows the deadlines of the new lease", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const first = lease.hello("client-a", 500);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  now.value = 1000;
  const second = lease.hello("client-b", 2000);
  assert.equal(second.ok, true);
  if (!second.ok) return;

  // The deadlines of the old lease are gone: the lease of the new holder is
  // still ok at the old pause deadline.
  assert.equal(lease.state(500), "ok");
  assert.equal(lease.state(1000), "ok");
  assert.equal(lease.state(2999), "ok");
  assert.equal(lease.state(3000), "paused");
  assert.equal(lease.state(5000), "dead");
});

test("the state is none as long as there is no lease", () => {
  const now = { value: 0 };
  const lease = manager(now);

  assert.equal(lease.state(0), "none");
  assert.equal(lease.state(1_000), "none");
  assert.equal(lease.state(), "none");
});

// ---------------------------------------------------------------------------
// The renew: the order of the checks and the messages
// ---------------------------------------------------------------------------

test("a renew without a lease is refused with no_lease", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const renew = lease.renew("11111111-2222-3333-4444-555555555555", 1);
  assert.equal(renew.ok, false);
  if (renew.ok) return;

  assert.equal(renew.code, "no_lease");
  assert.equal(renew.message, "send hello before renewing");
});

test("a wrong fence is refused with stale_fence, also when the lease id is wrong", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;

  // Both the fence and the lease id are wrong: the fence is checked first.
  const renew = lease.renew("not-a-lease", hello.value.fence + 1);
  assert.equal(renew.ok, false);
  if (renew.ok) return;

  assert.equal(renew.code, "stale_fence");
  assert.equal(
    renew.message,
    `fence ${hello.value.fence + 1} is stale, the current fence is ${hello.value.fence}`,
  );
});

test("a wrong lease id with the current fence is refused with stale_lease", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;

  const renew = lease.renew("not-a-lease", hello.value.fence);
  assert.equal(renew.ok, false);
  if (renew.ok) return;

  assert.equal(renew.code, "stale_lease");
  assert.equal(renew.message, "unknown lease not-a-lease");
});

test("the fence is checked before the expiry of the lease", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;

  // The lease is dead at 1000, but the stale fence is reported first.
  now.value = 1000;
  const renew = lease.renew(hello.value.leaseId, hello.value.fence + 1);
  assert.equal(renew.ok, false);
  if (renew.ok) return;
  assert.equal(renew.code, "stale_fence");
});

test("the lease id is checked before the expiry of the lease", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;

  // The lease is dead at 1000, but the unknown lease id is reported first.
  now.value = 1000;
  const renew = lease.renew("not-a-lease", hello.value.fence);
  assert.equal(renew.ok, false);
  if (renew.ok) return;
  assert.equal(renew.code, "stale_lease");
});

// ---------------------------------------------------------------------------
// The renew: the TTL of the lease
// ---------------------------------------------------------------------------

test("a renew keeps the ttl of the lease", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;

  now.value = 200;
  const renew = lease.renew(hello.value.leaseId, hello.value.fence);
  assert.equal(renew.ok, true);
  if (!renew.ok) return;

  // The renew extends the lease by its own ttl, it does not fall back to the
  // default ttl.
  assert.equal(renew.value.ttlMs, 500);
  assert.equal(renew.value.renewedAt, 200);
  assert.equal(renew.value.pauseAt, 700);
  assert.equal(renew.value.deadAt, 1200);
});

test("a renew keeps the ttl that a hello asked for", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const first = lease.hello("client-a", 500);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  // The client asks for another ttl with its next hello.
  now.value = 100;
  const again = lease.hello("client-a", 900);
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.value.ttlMs, 900);

  // PROTOCOL.md §3: the renew extends the lease by the ttl of the lease, it
  // never changes the ttl itself.
  now.value = 200;
  const renew = lease.renew(first.value.leaseId, first.value.fence);
  assert.equal(renew.ok, true);
  if (!renew.ok) return;

  assert.equal(renew.value.ttlMs, 900);
  assert.equal(renew.value.renewedAt, 200);
  assert.equal(renew.value.pauseAt, 1100);
  assert.equal(renew.value.deadAt, 2000);
});

// ---------------------------------------------------------------------------
// The fence
// ---------------------------------------------------------------------------

test("isCurrentFence accepts only the fence of the current lease", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;

  assert.equal(lease.isCurrentFence(null), false);
  assert.equal(lease.isCurrentFence(undefined), false);
  assert.equal(lease.isCurrentFence(hello.value.fence - 1), false);
  assert.equal(lease.isCurrentFence(hello.value.fence), true);
  assert.equal(lease.isCurrentFence(hello.value.fence + 1), false);
});

test("isCurrentFence stays true for a dead lease until a takeover", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;

  // The lease dies, but the fence is only invalid after a takeover.
  now.value = 1000;
  assert.equal(lease.state(1000), "dead");
  assert.equal(lease.isCurrentFence(hello.value.fence), true);

  const takeover = lease.hello("client-b", 500);
  assert.equal(takeover.ok, true);
  if (!takeover.ok) return;
  assert.equal(lease.isCurrentFence(hello.value.fence), false);
  assert.equal(lease.isCurrentFence(takeover.value.fence), true);
});

test("the fence getter is 0 without a lease and follows the holder", () => {
  const now = { value: 0 };
  const lease = manager(now);
  assert.equal(lease.fence, 0);
  assert.equal(lease.current, null);

  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;
  assert.equal(lease.fence, hello.value.fence);
  assert.equal(lease.fence, 1);

  now.value = 1000;
  const takeover = lease.hello("client-b", 500);
  assert.equal(takeover.ok, true);
  if (!takeover.ok) return;
  assert.equal(lease.fence, takeover.value.fence);
  assert.equal(lease.fence, hello.value.fence + 1);
});
