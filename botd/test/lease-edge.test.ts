// Edge-case tests for the lease and its fence.
//
// The lease is the handshake between a control plane and the daemon: it
// carries a TTL that has to be renewed in time and a fence that grows on
// every takeover, so that the frames of a client that lost the lease are
// rejected instead of interleaved with the frames of the new holder.
//
// The rules come from botd/PROTOCOL.md §6 (TTL, renewal and fencing) and
// from the two modules that enforce them:
//
//   botd/src/lease.ts       the lease of a session: fence, TTL and state
//   botd/src/lease-store.ts the lease of a host and of its sessions
//
// Every test drives an injected clock, so no test waits for wall clock time.
// The hosts, owners, sessions and clients are synthetic.
//
// PROTOCOL.md names the fencing conditions "stale_epoch", "lease_expired"
// and "lease_conflict".  The lease manager reports the same conditions with
// its own codes ("stale_fence", "stale_lease"), which the daemon puts on
// the wire unchanged; PROTOCOL_CODE maps one onto the other.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LeaseManager, MAX_TTL_MS } from "../src/lease.ts";
import {
  hostResource,
  sessionResource,
  LeaseStore,
  LeaseStoreError,
} from "../src/lease-store.ts";

/** The default TTL of the lease manager used in the tests. */
const DEFAULT_TTL_MS = 1000;
/** The lower bound for a client supplied TTL. */
const MIN_TTL_MS = 100;

/**
 * The codes of PROTOCOL.md §6 that the lease manager reports under its own
 * names.
 */
const PROTOCOL_CODE: Record<string, string> = {
  stale_fence: "stale_epoch",
  stale_lease: "stale_epoch",
  lease_expired: "lease_expired",
  lease_conflict: "lease_conflict",
};

/** A lease manager driven by a clock the test controls. */
function manager(now: { value: number }): LeaseManager {
  return new LeaseManager({
    defaultTtlMs: DEFAULT_TTL_MS,
    minTtlMs: MIN_TTL_MS,
    now: () => now.value,
  });
}

/** A clock the tests control. */
class TestClock {
  #now: number;

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now = (): number => this.#now;

  advance(ms: number): void {
    this.#now += ms;
  }
}

// Scratch space lives inside the work tree (never in a shared temp dir).
const tmpRoot = fileURLToPath(new URL("../.tmp/lease-edge/", import.meta.url));

after(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

/** Create an empty home directory for one test. */
async function makeHome(label: string): Promise<string> {
  await mkdir(tmpRoot, { recursive: true });
  return mkdtemp(path.join(tmpRoot, `${label}-`));
}

// ---------------------------------------------------------------------------
// The lease of a session (botd/src/lease.ts)
// ---------------------------------------------------------------------------

test("a renew just before the ttl boundary is still accepted", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;

  // The lease runs out at renewedAt + ttl = 500 (state() is "paused" from there).
  now.value = 499;
  const renew = lease.renew(hello.value.leaseId, hello.value.fence);
  assert.equal(renew.ok, true, "a renew before the boundary is not too late");
  if (!renew.ok) return;

  // The lease lives on for another ttl.
  assert.equal(renew.value.renewedAt, 499);
  assert.equal(renew.value.pauseAt, 999);
  assert.equal(renew.value.deadAt, 1499);
  assert.equal(lease.state(499), "ok");
  assert.equal(lease.state(999), "paused");
});

// Round 2: renew now checks the expiry, so the boundary itself (state "paused") is too late.
test("a renew exactly at the ttl boundary is rejected with lease_expired", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;
  now.value = 500;
  const renew = lease.renew(hello.value.leaseId, hello.value.fence);
  assert.equal(renew.ok, false);
  if (renew.ok) return;
  assert.equal(PROTOCOL_CODE[renew.code], "lease_expired");
});

test("a renew one millisecond after the ttl boundary is rejected with lease_expired", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;

  now.value = 501;
  const renew = lease.renew(hello.value.leaseId, hello.value.fence);
  assert.equal(renew.ok, false, "a renew after the ttl is too late");
  if (renew.ok) return;
  assert.equal(PROTOCOL_CODE[renew.code], "lease_expired");
});

test("a renew does not resurrect a lease that is already dead", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;

  // The lease died at renewedAt + 2 * ttl = 1000.
  now.value = 1000;
  assert.equal(lease.state(1000), "dead");
  const renew = lease.renew(hello.value.leaseId, hello.value.fence);
  assert.equal(renew.ok, false, "a dead lease cannot be renewed");
  if (renew.ok) return;
  assert.equal(PROTOCOL_CODE[renew.code], "lease_expired");
});

test("a renew with a stale fence is rejected as a stale epoch", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const first = lease.hello("client-a", 500);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  // Another client takes the lease over (round 2: only possible once the
  // first lease expired): the fence of the first client is stale from now on.
  now.value = 500;
  const second = lease.hello("client-b", 500);
  assert.equal(second.ok, true);
  if (!second.ok) return;

  const renew = lease.renew(first.value.leaseId, first.value.fence);
  assert.equal(renew.ok, false);
  if (renew.ok) return;
  assert.equal(PROTOCOL_CODE[renew.code], "stale_epoch");
  // The daemon puts the code of the manager on the wire unchanged.
  assert.equal(renew.code, "stale_fence");

  // The current holder may still renew.
  const current = lease.renew(second.value.leaseId, second.value.fence);
  assert.equal(current.ok, true);
});

test("a renew with the current fence but a foreign lease id is rejected", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const first = lease.hello("client-a", 500);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  now.value = 500; // round 2: a takeover needs an expired lease
  const second = lease.hello("client-b", 500);
  assert.equal(second.ok, true);
  if (!second.ok) return;

  // The fence is current, the lease id belongs to the old holder.
  const renew = lease.renew(first.value.leaseId, second.value.fence);
  assert.equal(renew.ok, false);
  if (renew.ok) return;
  assert.equal(PROTOCOL_CODE[renew.code], "stale_epoch");
  assert.equal(renew.code, "stale_lease");
});

test("a hello by a second holder while the first lease is still ok is a lease conflict", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const first = lease.hello("client-a", 500);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(lease.state(0), "ok");

  const second = lease.hello("client-b", 500);
  assert.equal(second.ok, false, "the session is already leased to client-a");
  if (second.ok) return;
  assert.equal(PROTOCOL_CODE[second.code], "lease_conflict");

  // The first holder keeps its lease.
  assert.equal(lease.current?.leaseId, first.value.leaseId);
});

test("a takeover after the expiry bumps the fence strictly monotonically", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const first = lease.hello("client-a", 500);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  // The lease runs out: it is paused after one ttl and dead after two.
  now.value = 1000;
  assert.equal(lease.state(1000), "dead");

  const second = lease.hello("client-b", 500);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.ok(second.value.fence > first.value.fence, "the fence grew");
  assert.notEqual(second.value.leaseId, first.value.leaseId);

  now.value = 2000;
  const third = lease.hello("client-c", 500);
  assert.equal(third.ok, true);
  if (!third.ok) return;
  assert.ok(third.value.fence > second.value.fence, "the fence grew again");
});

test("the fence never decreases when the clients come and go", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const seen: number[] = [];

  for (let round = 0; round < 5; round++) {
    const hello = lease.hello(`client-${round}`, 500);
    assert.equal(hello.ok, true);
    if (!hello.ok) return;
    seen.push(hello.value.fence);
    now.value += 1000;
  }

  for (let index = 1; index < seen.length; index++) {
    const previous = seen[index - 1] as number;
    const current = seen[index] as number;
    assert.ok(current > previous, "the fences must strictly increase");
  }
});

test("the state goes from none to ok to paused to dead", () => {
  const now = { value: 0 };
  const lease = manager(now);

  assert.equal(lease.state(0), "none");
  assert.equal(lease.state(1000), "none");

  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;

  assert.equal(lease.state(0), "ok");
  assert.equal(lease.state(499), "ok");
  assert.equal(lease.state(500), "paused");
  assert.equal(lease.state(999), "paused");
  assert.equal(lease.state(1000), "dead");
  assert.equal(lease.state(100_000), "dead");
});

// Round 2: renew no longer resurrects a paused lease; the holder has to send hello again.
test("a hello of the same client brings a paused lease back to ok", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;

  now.value = 600;
  assert.equal(lease.state(600), "paused");

  const renew = lease.renew(hello.value.leaseId, hello.value.fence);
  assert.equal(renew.ok, false);
  const again = lease.hello("client-a", 500);
  assert.equal(again.ok, true);
  if (!again.ok) return;

  assert.equal(lease.state(600), "ok");
  assert.equal(lease.state(1100), "paused");
  assert.equal(lease.state(1600), "dead");
});

test("state without an argument uses the injected clock", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;

  assert.equal(lease.state(), "ok");
  now.value = 500;
  assert.equal(lease.state(), "paused");
  now.value = 1000;
  assert.equal(lease.state(), "dead");
});

test("a ttl of zero is clamped to the minimum", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", 0);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;
  assert.equal(hello.value.ttlMs, MIN_TTL_MS);
  assert.equal(hello.value.pauseAt, MIN_TTL_MS);
  assert.equal(hello.value.deadAt, 2 * MIN_TTL_MS);
});

test("a negative ttl is clamped to the minimum", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", -5);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;
  assert.equal(hello.value.ttlMs, MIN_TTL_MS);
  assert.equal(hello.value.pauseAt, MIN_TTL_MS);
});

test("a NaN ttl falls back to the default", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", Number.NaN);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;
  assert.equal(hello.value.ttlMs, DEFAULT_TTL_MS);
});

test("an infinite ttl falls back to the default", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", Number.POSITIVE_INFINITY);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;
  assert.equal(hello.value.ttlMs, DEFAULT_TTL_MS);
});

test("a missing ttl falls back to the default", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a");
  assert.equal(hello.ok, true);
  if (!hello.ok) return;
  assert.equal(hello.value.ttlMs, DEFAULT_TTL_MS);
});

test("an absurdly large ttl keeps the deadlines finite", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", Number.MAX_SAFE_INTEGER);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;
  // Round 2: the ttl is capped at MAX_TTL_MS (one year).
  assert.equal(hello.value.ttlMs, MAX_TTL_MS);
  assert.ok(Number.isFinite(hello.value.pauseAt));
  assert.ok(Number.isFinite(hello.value.deadAt));
});

test("an absurdly large ttl does not overflow the deadlines into infinity", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", Number.MAX_VALUE);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;
  assert.ok(Number.isFinite(hello.value.pauseAt), "the lease has to pause at some point");
  assert.ok(Number.isFinite(hello.value.deadAt), "the lease has to die at some point");
});

test("isCurrentFence rejects null and undefined", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;

  assert.equal(lease.isCurrentFence(null), false);
  assert.equal(lease.isCurrentFence(undefined), false);
  assert.equal(lease.isCurrentFence(hello.value.fence), true);
  assert.equal(lease.isCurrentFence(hello.value.fence + 1), false);
});

test("isCurrentFence is false without a lease", () => {
  const now = { value: 0 };
  const lease = manager(now);
  assert.equal(lease.isCurrentFence(null), false);
  assert.equal(lease.isCurrentFence(undefined), false);
  assert.equal(lease.isCurrentFence(1), false);
  assert.equal(lease.isCurrentFence(0), false);
});

test("isCurrentFence follows the fence of the current holder", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const first = lease.hello("client-a", 500);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  now.value = 500; // round 2: a takeover needs an expired lease
  const second = lease.hello("client-b", 500);
  assert.equal(second.ok, true);
  if (!second.ok) return;

  assert.equal(lease.isCurrentFence(first.value.fence), false);
  assert.equal(lease.isCurrentFence(second.value.fence), true);
});

test("the fence of the manager is zero without a lease", () => {
  const now = { value: 0 };
  const lease = manager(now);
  assert.equal(lease.fence, 0);
  assert.equal(lease.current, null);

  const hello = lease.hello("client-a", 500);
  assert.equal(hello.ok, true);
  if (!hello.ok) return;
  assert.equal(lease.fence, hello.value.fence);
});

test("the same client keeps its fence over a reconnect", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const first = lease.hello("client-a", 500);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  now.value = 400;
  const again = lease.hello("client-a", 500);
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.value.fence, first.value.fence);
  assert.equal(again.value.leaseId, first.value.leaseId);
  assert.equal(again.value.renewedAt, 400);
});

test("a client that comes back after a takeover gets a new fence", () => {
  const now = { value: 0 };
  const lease = manager(now);
  const first = lease.hello("client-a", 500);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  now.value = 500; // round 2: a takeover needs an expired lease
  const second = lease.hello("client-b", 500);
  assert.equal(second.ok, true);
  if (!second.ok) return;

  // The first client comes back after the second lease expired too: it is no longer the holder.
  now.value = 1000;
  const back = lease.hello("client-a", 500);
  assert.equal(back.ok, true);
  if (!back.ok) return;
  assert.ok(back.value.fence > second.value.fence, "the fence grew");
  assert.equal(lease.isCurrentFence(second.value.fence), false);
});

// ---------------------------------------------------------------------------
// The lease store (botd/src/lease-store.ts)
// ---------------------------------------------------------------------------

test("the fence of a resource never decreases when the store is reopened", async (t) => {
  const home = await makeHome("reopen");
  t.after(() => rm(home, { recursive: true, force: true }));

  const clock = new TestClock();
  const first = new LeaseStore({ home, clock: clock.now });
  const lease = await first.acquire(hostResource("site-a"), "controller-1", 10_000);
  assert.equal(lease.fence, 1);

  // The daemon restarts: a fresh store reads the state back.  The lease of
  // the first controller is still alive, so the same owner takes it again.
  const second = new LeaseStore({ home, clock: clock.now });
  const again = await second.acquire(hostResource("site-a"), "controller-1", 10_000);
  assert.ok(again.fence > lease.fence, "the fence must not be reused after a restart");
});

test("the fence sequence survives a restart when every lease expired", async (t) => {
  const home = await makeHome("restart-expired");
  t.after(() => rm(home, { recursive: true, force: true }));

  const clock = new TestClock();
  const first = new LeaseStore({ home, clock: clock.now });
  const lease = await first.acquire(hostResource("site-a"), "controller-1", 1000);

  clock.advance(2000);
  await first.expire();

  const second = new LeaseStore({ home, clock: clock.now });
  const next = await second.acquire(hostResource("site-a"), "controller-2", 1000);
  assert.ok(next.fence > lease.fence, "an expired lease never frees its fence");
});

test("a holder that lost the lease cannot renew it after the store was reopened", async (t) => {
  const home = await makeHome("reopen-stale");
  t.after(() => rm(home, { recursive: true, force: true }));

  const clock = new TestClock();
  const first = new LeaseStore({ home, clock: clock.now });
  const lease = await first.acquire(hostResource("site-a"), "controller-1", 1000);

  clock.advance(2000);
  const second = new LeaseStore({ home, clock: clock.now });
  const takeover = await second.acquire(hostResource("site-a"), "controller-2", 1000);
  assert.ok(takeover.fence > lease.fence);

  // The old holder may neither renew nor claim validity any more.
  assert.equal(await second.renew(lease.leaseId, lease.fence), null);
  assert.equal(await second.isValid(lease.leaseId, lease.fence), false);
  assert.equal(await second.isValid(takeover.leaseId, takeover.fence), true);
});

test("the store treats a lease as expired exactly at its expiry", async (t) => {
  const home = await makeHome("expiry-boundary");
  t.after(() => rm(home, { recursive: true, force: true }));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });
  const lease = await store.acquire(hostResource("site-a"), "controller-1", 1000);
  assert.equal(lease.expiresAt, clock.now() + 1000);

  // One millisecond before the expiry the lease is still alive.
  clock.advance(999);
  assert.equal(await store.isValid(lease.leaseId, lease.fence), true);
  const renewed = await store.renew(lease.leaseId, lease.fence);
  assert.ok(renewed);

  // The renew pushed the expiry away, the lease lives on.
  assert.equal(renewed.expiresAt, clock.now() + 1000);
  clock.advance(1000);
  assert.equal(await store.isValid(lease.leaseId, lease.fence), false);
  assert.equal(await store.renew(lease.leaseId, lease.fence), null);
});

test("the fences of two resources count on their own", async (t) => {
  const home = await makeHome("resources");
  t.after(() => rm(home, { recursive: true, force: true }));

  const store = new LeaseStore({ home, clock: new TestClock().now });

  const a = await store.acquire(hostResource("site-a"), "controller-1", 1000);
  const b = await store.acquire(hostResource("site-b"), "controller-1", 1000);
  assert.equal(a.fence, 1);
  assert.equal(b.fence, 1);

  const again = await store.acquire(hostResource("site-a"), "controller-1", 1000);
  assert.equal(again.fence, 2);
});

test("a session lease needs a live host lease", async (t) => {
  const home = await makeHome("host-expired");
  t.after(() => rm(home, { recursive: true, force: true }));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });
  await store.acquire(hostResource("site-a"), "controller-1", 1000);

  // The host lease is gone, so the session lease cannot be granted.
  clock.advance(1000);
  await assert.rejects(
    () => store.acquire(sessionResource("site-a", "session-1"), "controller-1", 1000),
    (error: unknown) => {
      assert.ok(error instanceof LeaseStoreError);
      assert.equal(error.code, "no-host-lease");
      return true;
    },
  );
});

test("releasing a host lease invalidates the session leases under it", async (t) => {
  const home = await makeHome("release-host");
  t.after(() => rm(home, { recursive: true, force: true }));

  const store = new LeaseStore({ home, clock: new TestClock().now });
  const host = await store.acquire(hostResource("site-a"), "controller-1", 10_000);
  const session = await store.acquire(
    sessionResource("site-a", "session-1"),
    "controller-1",
    10_000,
  );
  assert.equal(await store.isValid(session.leaseId, session.fence), true);

  assert.equal(await store.release(host.leaseId), true);
  assert.equal(await store.isValid(session.leaseId, session.fence), false);
  assert.equal(await store.renew(session.leaseId, session.fence), null);

  // The fence of the host is not reused by the next owner.
  const next = await store.acquire(hostResource("site-a"), "controller-2", 1000);
  assert.ok(next.fence > host.fence);
});

test("an expired lease never frees its fence for reuse", async (t) => {
  const home = await makeHome("fence-expired");
  t.after(() => rm(home, { recursive: true, force: true }));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  const seen: number[] = [];
  for (let round = 0; round < 4; round++) {
    const lease = await store.acquire(hostResource("site-a"), `controller-${round}`, 100);
    seen.push(lease.fence);
    clock.advance(200);
    await store.expire();
  }

  for (let index = 1; index < seen.length; index++) {
    const previous = seen[index - 1] as number;
    const current = seen[index] as number;
    assert.ok(current > previous, "the fences must strictly increase");
  }
});

test("the fences of a recovered store stay above the old ones", async (t) => {
  const home = await makeHome("recovered");
  t.after(() => rm(home, { recursive: true, force: true }));

  const margin = 100;
  const clock = new TestClock();
  const first = new LeaseStore({ home, clock: clock.now, fenceSafetyMargin: margin });
  const lease = await first.acquire(hostResource("site-a"), "controller-1", 10_000);
  assert.equal(lease.fence, 1);

  // The state file is gone, the store recovers from its backup and pushes the
  // fences up by the safety margin.
  await rm(path.join(home, "leases.json"));
  const second = new LeaseStore({ home, clock: clock.now, fenceSafetyMargin: margin });
  const next = await second.acquire(hostResource("site-a"), "controller-2", 10_000);
  assert.ok(
    next.fence >= lease.fence + margin,
    `expected a fence of at least ${lease.fence + margin}, got ${next.fence}`,
  );
});

test("the store rejects an absurd ttl", async (t) => {
  const home = await makeHome("ttl");
  t.after(() => rm(home, { recursive: true, force: true }));

  const store = new LeaseStore({ home, clock: new TestClock().now });

  for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => store.acquire(hostResource("site-a"), "controller-1", ttl),
      (error: unknown) => {
        assert.ok(error instanceof LeaseStoreError);
        assert.equal(error.code, "invalid-ttl");
        return true;
      },
    );
  }

  const lease = await store.acquire(hostResource("site-a"), "controller-1", 1000);
  await assert.rejects(
    () => store.renew(lease.leaseId, lease.fence, 0),
    (error: unknown) => {
      assert.ok(error instanceof LeaseStoreError);
      assert.equal(error.code, "invalid-ttl");
      return true;
    },
  );

  // The lease survived the rejected renews.
  assert.equal(await store.isValid(lease.leaseId, lease.fence), true);
});
