import assert from "node:assert/strict";
import test from "node:test";

import { findHost, formatLease, formatQuota, initialState, selectHostSessions, selectPendingPermissions, selectSession } from "../src/state.ts";
import type { RemoteBot } from "../src/client.ts";
import type { SessionState } from "../src/state.ts";

function bot(overrides: Partial<RemoteBot> = {}): RemoteBot {
  return {
    id: "bot-a", host: "host-a", kind: "codex", family: "gpt", lane: "primary",
    status: "idle", leaseExpiresAt: null, quotaUsedPct: 0, sessionId: null,
    ...overrides,
  };
}

function session(id: string, host: string, order: number): SessionState {
  return { id, host, order, botId: "bot-a", status: "running", events: [], pendingPermissions: [] };
}

test("lease rounds one remaining millisecond up to one second", () => {
  assert.equal(formatLease(bot({ leaseExpiresAt: 1001 }), 1000), "0:01");
});

test("lease formats exactly one minute", () => {
  assert.equal(formatLease(bot({ leaseExpiresAt: 60_000 }), 0), "1:00");
});

test("lease rounds up across a minute boundary and pads seconds", () => {
  assert.equal(formatLease(bot({ leaseExpiresAt: 61_001 }), 0), "1:02");
});

test("lease minutes can exceed 59", () => {
  assert.equal(formatLease(bot({ leaseExpiresAt: 3_601_000 }), 0), "60:01");
});

test("quota rounds a half percentage upward", () => {
  assert.equal(formatQuota(bot({ quotaUsedPct: 49.5 })), "50%");
});

test("quota rounds a fraction below one half down", () => {
  assert.equal(formatQuota(bot({ quotaUsedPct: 0.4 })), "0%");
});

test("initial states do not share mutable collections", () => {
  const first = initialState();
  first.hosts.push({ alias: "host-a", label: "", status: "disconnected", error: null });
  first.bots["host-a"] = [bot()];
  first.sessions["session-a"] = session("session-a", "host-a", 0);
  const second = initialState();
  assert.deepEqual(second.hosts, []);
  assert.deepEqual(second.bots, {});
  assert.deepEqual(second.sessions, {});
});

test("findHost finds an exact alias and returns null for an unknown alias", () => {
  const state = initialState();
  const host = { alias: "host-a", label: "", status: "disconnected" as const, error: null };
  state.hosts.push(host);
  assert.equal(findHost(state, "host-a"), host);
  assert.equal(findHost(state, "host-b"), null);
});

test("selectSession returns null for an unknown id", () => {
  assert.equal(selectSession(initialState(), "session-missing"), null);
});

test("pending permissions concatenate in session object order", () => {
  const state = initialState();
  const first = session("session-b", "host-a", 1);
  const second = session("session-a", "host-b", 0);
  const permission = (id: string, sessionId: string) => ({ id, sessionId, title: id, detail: null });
  first.pendingPermissions = [permission("permission-b1", first.id), permission("permission-b2", first.id)];
  second.pendingPermissions = [permission("permission-a1", second.id)];
  state.sessions = { [first.id]: first, [second.id]: second };
  assert.deepEqual(selectPendingPermissions(state).map((entry) => entry.id), ["permission-b1", "permission-b2", "permission-a1"]);
});

// DEFECT: selectHostSessions sorts by creation order instead of ascending session id.
test.todo("host sessions sort by id ascending for the requested host", () => {
  const state = initialState();
  state.sessions = {
    "session-b": session("session-b", "host-a", 0),
    "session-a": session("session-a", "host-a", 1),
    "session-c": session("session-c", "host-b", 2),
  };
  assert.deepEqual(selectHostSessions(state, "host-a").map((entry) => entry.id), ["session-a", "session-b"]);
});
