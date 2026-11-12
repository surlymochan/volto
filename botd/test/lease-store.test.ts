// Tests for the volto-botd lease store.
//
// The store keeps two levels of leases (a host lease per host and a session
// lease per bot session underneath it) and hands out a strictly increasing
// fence per resource, so a holder that lost its lease can always be told
// apart from the current one.
//
// All fixtures are synthetic: hosts, owners and sessions are made-up names,
// never real hosts, addresses or credentials.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  hostResource,
  sessionResource,
  LeaseStore,
  LeaseStoreError,
} from "../src/lease-store.ts";
import type { Lease } from "../src/lease-store.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// Scratch space lives inside the work tree (never in a shared temp dir).
const tmpRoot = path.join(here, "..", "..", ".tmp", "lease-store");

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

test("acquire grants a lease and persists it under BOTD_HOME", async (t) => {
  const home = await makeHome("basic");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  const lease = await store.acquire(hostResource("site-a"), "controller-1", 30_000);

  assert.equal(typeof lease.leaseId, "string");
  assert.ok(lease.leaseId.length > 0);
  assert.equal(lease.fence, 1);
  assert.equal(lease.resource, hostResource("site-a"));
  assert.equal(lease.owner, "controller-1");
  assert.equal(lease.expiresAt, clock.now() + 30_000);
  assert.equal(await store.isValid(lease.leaseId, lease.fence), true);

  const state = await readState(home);
  const leases = state["leases"] as Record<string, { fence: number; resource: string }>;
  assert.equal(Object.keys(leases).length, 1);
  assert.equal(Object.values(leases)[0].fence, 1);
  assert.equal(Object.values(leases)[0].resource, hostResource("site-a"));

  // The state file and its backup are written next to each other.
  const files = await readdir(home);
  assert.ok(files.includes("leases.json"));
  assert.ok(files.includes("leases.json.bak"));
  // No temporary files are left behind.
  assert.deepEqual(files.filter((file) => file.includes(".tmp-")), []);
});

test("BOTD_HOME is used when no home is given", async (t) => {
  const home = await makeHome("env");
  t.after(() => dropHome(home));

  const previous = process.env["BOTD_HOME"];
  process.env["BOTD_HOME"] = home;
  t.after(() => {
    if (previous === undefined) delete process.env["BOTD_HOME"];
    else process.env["BOTD_HOME"] = previous;
  });

  const store = new LeaseStore();
  assert.equal(store.home, home);

  const lease = await store.acquire(hostResource("site-a"), "controller-1", 1000);
  assert.equal(lease.fence, 1);
  assert.ok((await readdir(home)).includes("leases.json"));
});

test("fences increase strictly for every acquisition of a resource", async (t) => {
  const home = await makeHome("fences");
  t.after(() => dropHome(home));

  const store = new LeaseStore({ home, clock: new TestClock().now });

  const first = await store.acquire(hostResource("site-a"), "controller-1", 1000);
  assert.equal(first.fence, 1);
  await store.release(first.leaseId);

  const second = await store.acquire(hostResource("site-a"), "controller-1", 1000);
  assert.equal(second.fence, 2);
  await store.release(second.leaseId);

  const third = await store.acquire(hostResource("site-a"), "controller-2", 1000);
  assert.equal(third.fence, 3);

  // Another resource counts on its own.
  const other = await store.acquire(hostResource("site-b"), "controller-1", 1000);
  assert.equal(other.fence, 1);
});

test("a resource can only be held by one owner at a time", async (t) => {
  const home = await makeHome("conflict");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  const lease = await store.acquire(hostResource("site-a"), "controller-1", 1000);

  await assert.rejects(
    () => store.acquire(hostResource("site-a"), "controller-2", 1000),
    (error: unknown) => {
      assert.ok(error instanceof LeaseStoreError);
      assert.equal(error.code, "conflict");
      return true;
    },
  );

  // The holder keeps its lease.
  assert.equal(await store.isValid(lease.leaseId, lease.fence), true);
});

test("a waiting acquire takes over once the lease expired", async (t) => {
  const home = await makeHome("wait");
  t.after(() => dropHome(home));

  const store = new LeaseStore({ home });

  const first = await store.acquire(hostResource("site-a"), "controller-1", 50);
  const started = Date.now();
  const second = await store.acquire(hostResource("site-a"), "controller-2", 1000, {
    waitMs: 5000,
  });

  assert.ok(second.fence > first.fence);
  assert.ok(Date.now() - started >= 40, "the second acquire waited for the lease to expire");
  assert.equal(await store.isValid(first.leaseId, first.fence), false);
  assert.equal(await store.isValid(second.leaseId, second.fence), true);
});

test("two owners racing for one resource: exactly one wins", async (t) => {
  const home = await makeHome("race");
  t.after(() => dropHome(home));

  // Two stores on the same home stand in for two botd processes.
  const first = new LeaseStore({ home });
  const second = new LeaseStore({ home });

  const results = await Promise.allSettled([
    first.acquire(hostResource("site-a"), "controller-1", 10_000),
    second.acquire(hostResource("site-a"), "controller-2", 10_000),
  ]);

  const granted = results.filter((result) => result.status === "fulfilled");
  const refused = results.filter((result) => result.status === "rejected");
  assert.equal(granted.length, 1);
  assert.equal(refused.length, 1);
  const failure = (refused[0] as PromiseRejectedResult).reason as LeaseStoreError;
  assert.ok(failure instanceof LeaseStoreError);
  assert.equal(failure.code, "conflict");
});

test("renew extends a lease and rejects a stale fence", async (t) => {
  const home = await makeHome("renew");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  const lease = await store.acquire(hostResource("site-a"), "controller-1", 1000);
  clock.advance(500);

  const renewed = await store.renew(lease.leaseId, lease.fence);
  assert.ok(renewed);
  assert.equal(renewed.leaseId, lease.leaseId);
  assert.equal(renewed.fence, lease.fence);
  assert.equal(renewed.expiresAt, clock.now() + 1000);
  assert.equal(await store.isValid(lease.leaseId, lease.fence), true);

  // A wrong fence never renews.
  assert.equal(await store.renew(lease.leaseId, lease.fence + 1), null);
  assert.equal(await store.renew("lease-does-not-exist", lease.fence), null);
});

test("a stale fence cannot renew a lease that was taken over", async (t) => {
  const home = await makeHome("stale");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  const first = await store.acquire(hostResource("site-a"), "controller-1", 1000);
  clock.advance(2000);
  const second = await store.acquire(hostResource("site-a"), "controller-2", 1000);

  assert.ok(second.fence > first.fence);
  // The old holder may neither renew nor claim validity any more.
  assert.equal(await store.renew(first.leaseId, first.fence), null);
  assert.equal(await store.isValid(first.leaseId, first.fence), false);
  assert.equal(await store.isValid(second.leaseId, second.fence), true);
  assert.equal(await store.renew(second.leaseId, first.fence), null);
});

test("expire reports the leases that ran out and drops them", async (t) => {
  const home = await makeHome("expire");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  const short = await store.acquire(hostResource("site-a"), "controller-1", 1000);
  const long = await store.acquire(hostResource("site-b"), "controller-2", 100_000);

  clock.advance(1500);
  const expired = await store.expire();

  assert.equal(expired.length, 1);
  assert.equal(expired[0].leaseId, short.leaseId);
  assert.equal(expired[0].fence, short.fence);
  assert.equal(expired[0].resource, hostResource("site-a"));

  assert.equal(await store.isValid(short.leaseId, short.fence), false);
  assert.equal(await store.isValid(long.leaseId, long.fence), true);

  // A second sweep finds nothing.
  assert.deepEqual(await store.expire(), []);
});

test("an expired lease frees the resource for the next owner", async (t) => {
  const home = await makeHome("expired-free");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  const first = await store.acquire(hostResource("site-a"), "controller-1", 1000);
  clock.advance(2000);
  const second = await store.acquire(hostResource("site-a"), "controller-2", 1000);

  assert.ok(second.fence > first.fence);
  assert.equal(await store.isValid(second.leaseId, second.fence), true);
});

test("releasing a host lease invalidates its session leases", async (t) => {
  const home = await makeHome("cascade");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now });

  const host = await store.acquire(hostResource("site-a"), "controller-1", 10_000);
  const session = await store.acquire(
    sessionResource("site-a", "session-1"),
    "controller-1",
    10_000,
  );

  assert.equal(await store.isValid(session.leaseId, session.fence), true);
  assert.ok(session.fence > 0);

  assert.equal(await store.release(host.leaseId), true);

  // The session lease dies with its host lease.
  assert.equal(await store.isValid(session.leaseId, session.fence), false);
  assert.equal(await store.renew(session.leaseId, session.fence), null);
  // The host lease is gone as well.
  assert.equal(await store.isValid(host.leaseId, host.fence), false);
});

test("a session lease needs a live host lease", async (t) => {
  const home = await makeHome("no-host");
  t.after(() => dropHome(home));

  const store = new LeaseStore({ home });

  await assert.rejects(
    () => store.acquire(sessionResource("site-a", "session-1"), "controller-1", 1000),
    (error: unknown) => {
      assert.ok(error instanceof LeaseStoreError);
      assert.equal(error.code, "no-host-lease");
      return true;
    },
  );

  const host = await store.acquire(hostResource("site-a"), "controller-1", 10_000);
  const session = await store.acquire(
    sessionResource("site-a", "session-1"),
    "controller-1",
    10_000,
  );
  assert.equal(await store.isValid(session.leaseId, session.fence), true);

  // A second session may run under the same host.
  const other = await store.acquire(
    sessionResource("site-a", "session-2"),
    "controller-1",
    10_000,
  );
  assert.equal(await store.isValid(other.leaseId, other.fence), true);

  await store.release(host.leaseId);
  assert.equal(await store.isValid(session.leaseId, session.fence), false);
  assert.equal(await store.isValid(other.leaseId, other.fence), false);
});

test("fences never go backwards across a restart", async (t) => {
  const home = await makeHome("restart");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const first = new LeaseStore({ home, clock: clock.now });
  const lease = await first.acquire(hostResource("site-a"), "controller-1", 1000);

  // The lease runs out, but its fence stays used up.
  clock.advance(2000);
  await first.expire();

  // Restart: a fresh store reads the persisted state back.
  const second = new LeaseStore({ home, clock: clock.now });
  const afterRestart = await second.acquire(hostResource("site-a"), "controller-2", 1000);

  assert.ok(afterRestart.fence > lease.fence, "the fence must not be reused after a restart");
  assert.equal(await second.isValid(lease.leaseId, lease.fence), false);
});

test("an expired lease never frees its fence for reuse", async (t) => {
  const home = await makeHome("fence-expired");
  t.after(() => dropHome(home));

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
    assert.ok(seen[index] > seen[index - 1], "fences must strictly increase");
  }
});

test("a damaged state file falls back to the backup and bumps the fences", async (t) => {
  const home = await makeHome("corrupt");
  t.after(() => dropHome(home));

  const margin = 100;
  const clock = new TestClock();
  const store = new LeaseStore({ home, clock: clock.now, fenceSafetyMargin: margin });

  const lease = await store.acquire(hostResource("site-a"), "controller-1", 10_000);
  assert.equal(lease.fence, 1);

  // The state file is damaged, the backup is still good.
  await writeFile(path.join(home, "leases.json"), "{ this is not json", "utf8");

  const recovered = new LeaseStore({ home, clock: clock.now, fenceSafetyMargin: margin });
  const next = await recovered.acquire(hostResource("site-a"), "controller-2", 10_000);

  assert.ok(
    next.fence >= lease.fence + margin,
    `expected a fence of at least ${lease.fence + margin}, got ${next.fence}`,
  );

  // The recovered store works and writes a readable state file again.
  const state = await readState(home);
  assert.ok(state["leases"]);
});

test("a damaged state file and a damaged backup start over with a safety margin", async (t) => {
  const home = await makeHome("corrupt-both");
  t.after(() => dropHome(home));

  const margin = 250;
  const store = new LeaseStore({ home, fenceSafetyMargin: margin });
  await store.acquire(hostResource("site-a"), "controller-1", 10_000);

  await writeFile(path.join(home, "leases.json"), "broken", "utf8");
  await writeFile(path.join(home, "leases.json.bak"), "broken too", "utf8");

  const recovered = new LeaseStore({ home, fenceSafetyMargin: margin });
  const lease = await recovered.acquire(hostResource("site-a"), "controller-2", 10_000);
  assert.ok(lease.fence > margin);
});

test("the store validates its arguments", async (t) => {
  const home = await makeHome("invalid");
  t.after(() => dropHome(home));

  const store = new LeaseStore({ home });

  await assert.rejects(
    () => store.acquire("", "controller-1", 1000),
    (error: unknown) => error instanceof LeaseStoreError && error.code === "invalid-resource",
  );
  await assert.rejects(
    () => store.acquire(hostResource("site-a"), "", 1000),
    (error: unknown) => error instanceof LeaseStoreError && error.code === "invalid-owner",
  );
  await assert.rejects(
    () => store.acquire(hostResource("site-a"), "controller-1", 0),
    (error: unknown) => error instanceof LeaseStoreError && error.code === "invalid-ttl",
  );
});

test("the state survives a restart with its leases intact", async (t) => {
  const home = await makeHome("restart-keeps");
  t.after(() => dropHome(home));

  const clock = new TestClock();
  const first = new LeaseStore({ home, clock: clock.now });
  const host = await first.acquire(hostResource("site-a"), "controller-1", 10_000);
  const session = await first.acquire(
    sessionResource("site-a", "session-1"),
    "controller-1",
    10_000,
  );

  // A fresh store reads the same state back.
  const second = new LeaseStore({ home, clock: clock.now });
  assert.equal(await second.isValid(host.leaseId, host.fence), true);
  assert.equal(await second.isValid(session.leaseId, session.fence), true);

  // The next acquisition continues the fence sequence.
  const next = await second.acquire(hostResource("site-b"), "controller-2", 10_000);
  assert.equal(next.fence, 1);
});

test("the same owner may take its own resource again", async (t) => {
  const home = await makeHome("reacquire");
  t.after(() => dropHome(home));

  const store = new LeaseStore({ home, clock: new TestClock().now });

  const first = await store.acquire(hostResource("site-a"), "controller-1", 1000);
  const second = await store.acquire(hostResource("site-a"), "controller-1", 1000);

  // A new lease replaces the old one, so the old fence is dead.
  assert.ok(second.fence > first.fence);
  assert.equal(await store.isValid(first.leaseId, first.fence), false);
  assert.equal(await store.isValid(second.leaseId, second.fence), true);
});

test("releasing with a stale fence is refused", async (t) => {
  const home = await makeHome("release-fence");
  t.after(() => dropHome(home));

  const store = new LeaseStore({ home, clock: new TestClock().now });

  const lease: Lease = await store.acquire(hostResource("site-a"), "controller-1", 1000);

  assert.equal(await store.release(lease.leaseId, lease.fence + 1), false);
  assert.equal(await store.isValid(lease.leaseId, lease.fence), true);

  assert.equal(await store.release(lease.leaseId, lease.fence), true);
  assert.equal(await store.isValid(lease.leaseId, lease.fence), false);
  assert.equal(await store.release(lease.leaseId), false);
});
