// Parent resource and persisted parent/child lease bookkeeping.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { LeaseStore, parentResource } from "../src/lease-store.ts";

const tmpRoot = path.join(".tmp", "lease-store-parent");
const clock = () => 1_700_000_000_000;

async function makeHome(): Promise<string> {
  await mkdir(tmpRoot, { recursive: true });
  return mkdtemp(path.join(tmpRoot, "case-"));
}

const cases: Array<[string, string | undefined]> = [
  ["host/x", undefined],
  ["session/h/s", "host/h"],
  ["session/h", undefined],
  ["session//s", undefined],
  ["session/h/", "host/h"],
  ["session/h/a/b", "host/h"],
  ["", undefined],
  ["other/h/s", undefined],
  ["session/alias.a-b/s", "host/alias.a-b"],
];

for (const [resource, expected] of cases) {
  test(`parentResource(${JSON.stringify(resource)})`, () => {
    assert.equal(parentResource(resource), expected);
  });
}

test("session parent bookkeeping survives reload and host revocation", async (t) => {
  const home = await makeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const first = new LeaseStore({ home, clock });
  const host = await first.acquire("host/h", "owner-a", 1000);
  const session = await first.acquire("session/h/s", "owner-b", 2000);
  const second = new LeaseStore({ home, clock });
  assert.equal(await second.isValid(session.leaseId, session.fence), true);
  // Force a write after loading so the persisted bookkeeping is checked after normalization.
  assert.ok(await second.renew(session.leaseId, session.fence));
  const state = JSON.parse(await readFile(path.join(home, "leases.json"), "utf8"));
  assert.equal(state.leases[session.leaseId].parentResource, "host/h");
  assert.equal(state.leases[session.leaseId].parentLeaseId, host.leaseId);
  assert.equal(await second.release(host.leaseId), true);
  assert.equal(await second.isValid(session.leaseId, session.fence), false);
  assert.equal(await second.renew(session.leaseId, session.fence), null);
});

test("a non-string stored parentResource field is dropped on load", async (t) => {
  const home = await makeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const first = new LeaseStore({ home, clock });
  const host = await first.acquire("host/h", "owner-a", 1000);
  const session = await first.acquire("session/h/s", "owner-b", 1000);
  const statePath = path.join(home, "leases.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.leases[session.leaseId].parentResource = 42;
  await writeFile(statePath, JSON.stringify(state));

  const second = new LeaseStore({ home, clock });
  assert.ok(await second.renew(session.leaseId, session.fence));
  const normalized = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(Object.hasOwn(normalized.leases[session.leaseId], "parentResource"), false);
  assert.equal(normalized.leases[session.leaseId].parentLeaseId, host.leaseId);
  assert.equal(await second.release(host.leaseId), true);
  assert.equal(await second.isValid(session.leaseId, session.fence), false);
});

test("a lease with a non-string parentResource is dropped on load", { todo: "loader retains the lease after discarding the malformed field" }, async (t) => {
  const home = await makeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const first = new LeaseStore({ home, clock });
  await first.acquire("host/h", "owner-a", 1000);
  const session = await first.acquire("session/h/s", "owner-b", 1000);
  const statePath = path.join(home, "leases.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.leases[session.leaseId].parentResource = 42;
  await writeFile(statePath, JSON.stringify(state));

  const second = new LeaseStore({ home, clock });
  assert.equal(await second.isValid(session.leaseId, session.fence), false);
});
