// Edge-case tests for the volto-botd lease store.
//
// botd/test/lease-store.test.ts covers the happy path of the store.  This
// file walks the edges: the resource helpers, the exact millisecond a lease
// dies, the TTL values that are not a sane TTL, the fences over many owners
// and what two stores on the same state file do to each other.
//
// The rules come from botd/src/lease-store.ts itself:
//
//   hostResource()      the resource of a host lease
//   sessionResource()   the resource of a session lease
//   parentResource()    the host resource a session resource lives under
//   LeaseStore          the store itself, with an injectable clock
//
// Every test drives an injected clock, so no test waits for a lease to run
// out in wall clock time.  The hosts, owners and sessions are synthetic.
//
// The tests marked "todo" pin a defect of the store: they describe the
// behaviour the module should have and fail today.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  hostResource,
  sessionResource,
  parentResource,
  LeaseStore,
  LeaseStoreError,
} from "../src/lease-store.ts";
import { MAX_TTL_MS } from "../src/lease.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// Scratch space lives inside the work tree (never in a shared temp dir).
const tmpRoot = path.join(here, "..", "..", ".tmp", "lease-store-edge");

// Leave no scratch files behind.
after(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

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

/** A clock that jumps forward on every read. */
class SteppingClock {
  #now: number;
  #step: number;

  constructor(start = 1_700_000_000_000, step = 600) {
    this.#now = start;
    this.#step = step;
  }

  now = (): number => {
    const value = this.#now;
    this.#now += this.#step;
    return value;
  };
}

/** Create an empty home directory for one test. */
async function makeHome(label: string): Promise<string> {
  await mkdir(tmpRoot, { recursive: true });
  return mkdtemp(path.join(tmpRoot, `${label}-`));
}

/** Remove a home directory again. */
async function dropHome(home: string): Promise<void> {
  await rm(home, { recursive: true, force: true });
}

/** Read the persisted state file. */
async function readState(home: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(home, "leases.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

/** True when the state file is there. */
async function stateFileExists(home: string): Promise<boolean> {
  return stat(path.join(home, "leases.json"))
    .then(() => true)
    .catch(() => false);
}

/** The fence counters of the persisted state. */
function fencesOf(state: Record<string, unknown>): Record<string, number> {
  return state["fences"] as Record<string, number>;
}

test("the resource helpers round trip a host and its session", async (t) => {
  const home = await makeHome("helpers");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  assert.equal(hostResource("site-a"), "host/site-a");
  assert.equal(sessionResource("site-a", "s1"), "session/site-a/s1");
  // The parent of a session resource is the host resource of the same host.
  assert.equal(parentResource(sessionResource("site-a", "s1")), hostResource("site-a"));
  // A host resource has no parent.
  assert.equal(parentResource(hostResource("site-a")), undefined);

  const host = await store.acquire(hostResource("site-a"), "controller-1", 10_000);
  const session = await store.acquire(sessionResource("site-a", "s1"), "controller-1", 10_000);

  // The session lease remembers the host lease it lives under.
  const leases = (await readState(home))["leases"] as Record<
    string,
    { parentResource?: string; parentLeaseId?: string }
  >;
  const stored = Object.values(leases).find((lease) => lease.parentResource !== undefined);
  assert.ok(stored, "the session lease is persisted with its parent");
  assert.equal(stored.parentResource, hostResource("site-a"));
  assert.equal(stored.parentLeaseId, host.leaseId);
  assert.equal(session.resource, sessionResource("site-a", "s1"));
});

test("the resource helpers keep empty and odd ids verbatim", async (t) => {
  const home = await makeHome("helpers-odd");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  // Empty ids are not special: they are put into the resource as they are.
  assert.equal(hostResource(""), "host/");
  assert.equal(sessionResource("site-a", ""), "session/site-a/");
  // An empty host id still names a host resource.
  assert.equal(parentResource("session/site-a/"), "host/site-a");
  // A resource that names no host has no parent.
  assert.equal(parentResource("session/"), undefined);
  assert.equal(parentResource(""), undefined);
  assert.equal(parentResource("host/"), undefined);
  // Odd characters survive the round trip.
  assert.equal(hostResource("héllo wörld"), "host/héllo wörld");
  assert.equal(parentResource(sessionResource("a b", "s/1")), "host/a b");

  // The store accepts such a resource and persists it unchanged.
  const lease = await store.acquire(hostResource("héllo wörld"), "controller-1", 10_000);
  assert.equal(lease.resource, "host/héllo wörld");
  const leases = (await readState(home))["leases"] as Record<string, { resource: string }>;
  assert.equal(Object.values(leases)[0].resource, "host/héllo wörld");
});

test(
  "a host id with a slash keeps the session lease under its host",
  {
    todo: "DEFECT: the resource helpers do not escape the id, so a host id with a slash breaks the link to its session: parentResource(sessionResource('a/b', 's1')) is 'host/a' and the session lease is refused with 'no-host-lease' although the host lease is alive",
  },
  async (t) => {
    const home = await makeHome("helpers-slash");
    t.after(() => dropHome(home));

    const clock = new TestClock();
    const store = new LeaseStore({ home, clock: clock.now });

    // The parent of the session resource has to be the host resource.
    assert.equal(parentResource(sessionResource("a/b", "s1")), hostResource("a/b"));

    const host = await store.acquire(hostResource("a/b"), "controller-1", 10_000);
    assert.equal(await store.isValid(host.leaseId, host.fence), true);

    // The session lease finds the host lease it belongs to.
    const session = await store.acquire(sessionResource("a/b", "s1"), "controller-1", 10_000);
    assert.equal(await store.isValid(session.leaseId, session.fence), true);
  },
);

test(
  "a session lease with an empty host id needs a host lease",
  {
    todo: "DEFECT: parentResource() of 'session//s1' is undefined, so a session lease with an empty host id is granted without a host lease and the 'no-host-lease' guard does not fire",
  },
  async (t) => {
    const home = await makeHome("helpers-empty-host");
    t.after(() => dropHome(home));

    const clock = new TestClock();
    const store = new LeaseStore({ home, clock: clock.now });

    // The session resource still names its host.
    assert.equal(parentResource(sessionResource("", "s1")), hostResource(""));

    // Without a host lease there is no session lease.
    await assert.rejects(
      () => store.acquire(sessionResource("", "s1"), "controller-1", 10_000),
      (error: unknown) => error instanceof LeaseStoreError && error.code === "no-host-lease",
    );
  },
);

test(
  "a resource named like an Object.prototype member gets a fence",
  {
    todo: "DEFECT: the fence counters live in a plain object, so a resource named '__proto__' or 'constructor' reads Object.prototype instead of a number: the fence becomes NaN, the lease is invalid right away and the state file stores 'fence: null'",
  },
  async (t) => {
    const home = await makeHome("proto-resource");
    t.after(() => dropHome(home));

    const clock = new TestClock();
    const store = new LeaseStore({ home, clock: clock.now });

    const lease = await store.acquire("__proto__", "controller-1", 10_000);

    // The fence is a number that grows.
    assert.ok(Number.isFinite(lease.fence), `the fence must be a number, got ${lease.fence}`);
    assert.ok(lease.fence > 0);
    // And the lease it hands out is a usable one.
    assert.equal(await store.isValid(lease.leaseId, lease.fence), true);
  },
);

test("a session lease is granted under the host lease of another owner", async (t) => {
  const home = await makeHome("foreign-host");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  const host = await store.acquire(hostResource("site-a"), "controller-1", 10_000);
  // The store checks that the host lease is alive, but not who holds it.
  const session = await store.acquire(sessionResource("site-a", "s1"), "controller-2", 10_000);

  assert.equal(session.owner, "controller-2");
  assert.equal(await store.isValid(session.leaseId, session.fence), true);

  // The session still lives and dies with the host lease of the other owner.
  assert.equal(await store.release(host.leaseId), true);
  assert.equal(await store.isValid(session.leaseId, session.fence), false);
});

test("a session lease dies when its host lease is replaced", async (t) => {
  const home = await makeHome("host-replaced");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  const host = await store.acquire(hostResource("site-a"), "controller-1", 10_000);
  const session = await store.acquire(sessionResource("site-a", "s1"), "controller-1", 10_000);
  assert.equal(await store.isValid(session.leaseId, session.fence), true);

  // The same owner takes the host lease again: a new lease with a new fence.
  const second = await store.acquire(hostResource("site-a"), "controller-1", 10_000);
  assert.ok(second.fence > host.fence);

  // The session lease hung on the old host lease and dies with it.
  assert.equal(await store.isValid(session.leaseId, session.fence), false);
  assert.equal(await store.renew(session.leaseId, session.fence), null);
});

test("an expired host lease does not admit a session lease", async (t) => {
  const home = await makeHome("host-expired");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  await store.acquire(hostResource("site-a"), "controller-1", 1000);
  clock.advance(1000);

  await assert.rejects(
    () => store.acquire(sessionResource("site-a", "s1"), "controller-1", 1000),
    (error: unknown) => error instanceof LeaseStoreError && error.code === "no-host-lease",
  );
});

test("releasing an unknown lease changes nothing", async (t) => {
  const home = await makeHome("release-unknown");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  const lease = await store.acquire(hostResource("site-a"), "controller-1", 1000);

  // An unknown lease is not an error, it is simply not released.
  assert.equal(await store.release("lease-does-not-exist"), false);
  assert.equal(await store.release("lease-does-not-exist", lease.fence), false);
  assert.equal(await store.release(""), false);

  // The lease of the store is untouched.
  assert.equal(await store.isValid(lease.leaseId, lease.fence), true);

  // A refused release does not consume a fence.
  assert.equal(await store.release(lease.leaseId), true);
  assert.equal(fencesOf(await readState(home))[hostResource("site-a")], 1);
  const next = await store.acquire(hostResource("site-a"), "controller-2", 1000);
  assert.equal(next.fence, 2);
});

test("a lease cannot be renewed at its expiry millisecond", async (t) => {
  const home = await makeHome("renew-boundary");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  const lease = await store.acquire(hostResource("site-a"), "controller-1", 1000);

  // One millisecond before the end the lease is still alive.
  clock.advance(999);
  const renewed = await store.renew(lease.leaseId, lease.fence);
  assert.ok(renewed);
  assert.equal(renewed.expiresAt, clock.now() + 1000);

  // At its expiry millisecond the lease is gone: expiresAt <= now means expired.
  clock.advance(1000);
  assert.equal(await store.renew(lease.leaseId, lease.fence), null);
  assert.equal(await store.isValid(lease.leaseId, lease.fence), false);
});

test("renewing an expired lease returns null and leaves the lease dead", async (t) => {
  const home = await makeHome("renew-expired");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  const lease = await store.acquire(hostResource("site-a"), "controller-1", 1000);
  clock.advance(1000);

  // The store answers with null, it does not throw.
  assert.equal(await store.renew(lease.leaseId, lease.fence), null);
  // The expiry is not extended: the lease stays dead.
  assert.equal(await store.isValid(lease.leaseId, lease.fence), false);
  // A broken ttl is only reported for a lease that is alive.
  assert.equal(await store.renew(lease.leaseId, lease.fence, 0), null);
  assert.equal(await store.renew("lease-does-not-exist", lease.fence, 0), null);
});

test(
  "renewing an expired lease reports an error code",
  {
    todo: "DEFECT: renewing a lease that ran out returns null instead of a LeaseStoreError with a stable code, so a caller cannot tell 'the lease is gone' from 'the fence is stale'",
  },
  async (t) => {
    const home = await makeHome("renew-expired-code");
    t.after(() => dropHome(home));

    const clock = new TestClock();
    const store = new LeaseStore({ home, clock: clock.now });

    const lease = await store.acquire(hostResource("site-a"), "controller-1", 1000);
    clock.advance(1000);

    await assert.rejects(
      () => store.renew(lease.leaseId, lease.fence),
      (error: unknown) => error instanceof LeaseStoreError && error.code === "lease-expired",
    );
  },
);

test("a live lease is not renewed with a broken ttl", async (t) => {
  const home = await makeHome("renew-ttl");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  const lease = await store.acquire(hostResource("site-a"), "controller-1", 1000);

  for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => store.renew(lease.leaseId, lease.fence, ttl),
      (error: unknown) => error instanceof LeaseStoreError && error.code === "invalid-ttl",
    );
  }

  // The lease is unchanged: the refused renewals did not touch it.
  assert.equal(await store.isValid(lease.leaseId, lease.fence), true);
  const leases = (await readState(home))["leases"] as Record<string, { expiresAt: number }>;
  assert.equal(Object.values(leases)[0].expiresAt, lease.expiresAt);
});

test("a lease can be taken over exactly at its expiry millisecond", async (t) => {
  const home = await makeHome("acquire-boundary");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  const first = await store.acquire(hostResource("site-a"), "controller-1", 1000);

  // One millisecond before the end the lease is still held.
  clock.advance(999);
  await assert.rejects(
    () => store.acquire(hostResource("site-a"), "controller-2", 1000),
    (error: unknown) => error instanceof LeaseStoreError && error.code === "conflict",
  );

  // At its expiry millisecond the lease is over and the resource is free.
  clock.advance(1);
  const second = await store.acquire(hostResource("site-a"), "controller-2", 1000);

  assert.equal(second.fence, first.fence + 1);
  assert.equal(await store.isValid(first.leaseId, first.fence), false);
  assert.equal(await store.isValid(second.leaseId, second.fence), true);
});

test("a ttl of zero, a negative ttl, NaN and Infinity are refused", async (t) => {
  const home = await makeHome("ttl-invalid");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  for (const ttl of [0, -1, -1000, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => store.acquire(hostResource("site-a"), "controller-1", ttl),
      (error: unknown) => error instanceof LeaseStoreError && error.code === "invalid-ttl",
    );
  }

  // A refused acquire writes nothing and consumes no fence.
  assert.equal(await stateFileExists(home), false);
  const lease = await store.acquire(hostResource("site-a"), "controller-1", 1000);
  assert.equal(lease.fence, 1);
});

test(
  "a huge ttl is clamped to the maximum ttl",
  {
    todo: "DEFECT: the store does not clamp the ttl (botd/src/lease.ts clamps it to MAX_TTL_MS, one year), so a caller can hand out a host lease that never runs out",
  },
  async (t) => {
    const home = await makeHome("ttl-huge");
    t.after(() => dropHome(home));

    const clock = new TestClock();
    const store = new LeaseStore({ home, clock: clock.now });

    const lease = await store.acquire(hostResource("site-a"), "controller-1", 10 ** 15);

    assert.ok(
      lease.expiresAt - clock.now() <= MAX_TTL_MS,
      `the lease may not live longer than ${MAX_TTL_MS} ms`,
    );
  },
);

test("the fence grows strictly over many owners", async (t) => {
  const home = await makeHome("fence-many-owners");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  const seen: number[] = [];
  for (let round = 0; round < 25; round++) {
    const lease = await store.acquire(hostResource("site-a"), `controller-${round}`, 1000);
    seen.push(lease.fence);
    assert.equal(await store.release(lease.leaseId), true);
  }

  // Every owner gets its own fence: no fence is handed out twice.
  assert.deepEqual(
    seen,
    Array.from({ length: 25 }, (_, index) => index + 1),
  );
  assert.equal(new Set(seen).size, seen.length);

  // The counter survives the releases and a restart.
  assert.equal(fencesOf(await readState(home))[hostResource("site-a")], 25);
  const restarted = new LeaseStore({ home, clock: clock.now });
  const next = await restarted.acquire(hostResource("site-a"), "controller-x", 1000);
  assert.equal(next.fence, 26);
});

test("two stores on the same file share the leases and the fences", async (t) => {
  const home = await makeHome("two-stores");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const first = new LeaseStore({ home, clock: clock.now });
  const second = new LeaseStore({ home, clock: clock.now });

  const lease = await first.acquire(hostResource("site-a"), "controller-1", 10_000);

  // The second store reads the same state file and sees the lease.
  assert.equal(await second.isValid(lease.leaseId, lease.fence), true);
  await assert.rejects(
    () => second.acquire(hostResource("site-a"), "controller-2", 10_000),
    (error: unknown) => error instanceof LeaseStoreError && error.code === "conflict",
  );

  // After the release the second store takes over, with the next fence.
  assert.equal(await first.release(lease.leaseId), true);
  const next = await second.acquire(hostResource("site-a"), "controller-2", 10_000);
  assert.equal(next.fence, 2);
  assert.equal(await first.isValid(next.leaseId, next.fence), true);
});

test("a damaged state file is recovered from the backup", async (t) => {
  const home = await makeHome("damaged-state");
  t.after(() => dropHome(home));

  const margin = 100;
  const clock = new TestClock();
  const first = new LeaseStore({ home, clock: clock.now, fenceSafetyMargin: margin });

  const lease = await first.acquire(hostResource("site-a"), "controller-1", 10_000);
  assert.equal(lease.fence, 1);

  // The state file is damaged, the backup is still good.
  await writeFile(path.join(home, "leases.json"), "{ this is not json", "utf8");

  // The next store recovers from the backup: no error, the fences are bumped.
  const second = new LeaseStore({ home, clock: clock.now, fenceSafetyMargin: margin });
  const next = await second.acquire(hostResource("site-a"), "controller-2", 10_000);
  assert.equal(next.fence, lease.fence + margin + 1);

  // The lease of the lost generation is dropped: everybody acquires again.
  assert.equal(await second.isValid(lease.leaseId, lease.fence), false);
  // The store works and writes a readable state file again.
  assert.equal((await readState(home))["version"], 1);
});

test("a damaged state file and a damaged backup start over with an empty store", async (t) => {
  const home = await makeHome("damaged-both");
  t.after(() => dropHome(home));

  const margin = 250;
  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now, fenceSafetyMargin: margin });
  await store.acquire(hostResource("site-a"), "controller-1", 10_000);

  await writeFile(path.join(home, "leases.json"), "broken", "utf8");
  await writeFile(path.join(home, "leases.json.bak"), "broken too", "utf8");

  // Nothing is left to recover from: the store starts over without an error.
  const recovered = new LeaseStore({ home, clock: clock.now, fenceSafetyMargin: margin });
  const lease = await recovered.acquire(hostResource("site-a"), "controller-2", 10_000);

  // The store is empty, but it never hands out a low fence.
  assert.equal(lease.fence, margin + 1);
  assert.equal((await readState(home))["version"], 1);
});

test("a vanished state file is recovered from the backup", async (t) => {
  const home = await makeHome("vanished-state");
  t.after(() => dropHome(home));

  const margin = 100;
  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now, fenceSafetyMargin: margin });

  const lease = await store.acquire(hostResource("site-a"), "controller-1", 10_000);

  // The state file is gone, the backup is still good.
  await rm(path.join(home, "leases.json"));

  const recovered = new LeaseStore({ home, clock: clock.now, fenceSafetyMargin: margin });
  const next = await recovered.acquire(hostResource("site-b"), "controller-2", 10_000);

  // The fences are bumped, so no fence of the lost generation comes back.
  assert.ok(next.fence >= margin);
  assert.equal(await recovered.isValid(lease.leaseId, lease.fence), false);
});

test("a state file with an unknown version is treated as a damaged one", async (t) => {
  const home = await makeHome("state-version");
  t.after(() => dropHome(home));

  const margin = 100;
  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now, fenceSafetyMargin: margin });

  const lease = await store.acquire(hostResource("site-a"), "controller-1", 10_000);

  await writeFile(
    path.join(home, "leases.json"),
    JSON.stringify({ version: 2, floor: 0, fences: {}, leases: {} }),
    "utf8",
  );

  // The unknown version is refused, the backup takes over.
  const recovered = new LeaseStore({ home, clock: clock.now, fenceSafetyMargin: margin });
  const next = await recovered.acquire(hostResource("site-a"), "controller-2", 10_000);
  assert.equal(next.fence, lease.fence + margin + 1);
});

test("a damaged lease entry is dropped but its fence is kept", async (t) => {
  const home = await makeHome("damaged-entry");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  const lease = await store.acquire(hostResource("site-a"), "controller-1", 10_000);

  // One lease entry of the state file is damaged.
  const state = JSON.parse(await readFile(path.join(home, "leases.json"), "utf8")) as {
    leases: Record<string, { fence: number | string }>;
  };
  state.leases[lease.leaseId].fence = "not a number";
  await writeFile(path.join(home, "leases.json"), JSON.stringify(state), "utf8");

  const recovered = new LeaseStore({ home, clock: clock.now });
  const next = await recovered.acquire(hostResource("site-a"), "controller-2", 10_000);

  // The broken entry is gone, but its fence is not handed out again.
  assert.equal(next.fence, lease.fence + 1);
  assert.equal(await recovered.isValid(lease.leaseId, lease.fence), false);
});

test("the wait deadline uses the real clock, the expiry the injected one", async (t) => {
  const home = await makeHome("wait-clock");
  t.after(() => dropHome(home));

  // The clock jumps forward on every read: the lease runs out in virtual time.
  const clock = new SteppingClock(1_700_000_000_000, 600);
  const store = new LeaseStore({ home, clock: clock.now, pollIntervalMs: 1 });

  const first = await store.acquire(hostResource("site-a"), "controller-1", 1000);

  const started = Date.now();
  const second = await store.acquire(hostResource("site-a"), "controller-2", 1000, {
    waitMs: 60_000,
  });
  const elapsed = Date.now() - started;

  // The takeover happened because the injected clock passed the expiry, not
  // because the real deadline of the wait was reached.
  assert.ok(second.fence > first.fence);
  assert.ok(elapsed < 1000, `the takeover took ${elapsed} ms of real time`);
});
