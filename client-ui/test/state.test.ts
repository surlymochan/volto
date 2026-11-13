// Tests for the client-ui state reducers.
//
// The reducers are pure: no clocks, no randomness, no I/O, so every case
// below is fully determined by its input.

import assert from "node:assert/strict";
import test from "node:test";

import {
  formatLease,
  formatQuota,
  initialState,
  leaseRemainingMs,
  reduce,
  selectBots,
  selectHostSessions,
  selectPendingPermissions,
  selectSession,
} from "../src/state.ts";
import type { BotEvent, RemoteBot, RemoteHost } from "../src/client.ts";
import type { UiState } from "../src/state.ts";

function host(alias: string, label?: string): RemoteHost {
  return label === undefined ? { alias } : { alias, label };
}

function bot(overrides: Partial<RemoteBot> = {}): RemoteBot {
  return {
    id: "alpha-bot-1",
    host: "alpha",
    kind: "codex",
    family: "gpt",
    lane: "primary",
    status: "idle",
    leaseExpiresAt: null,
    quotaUsedPct: 12,
    sessionId: null,
    ...overrides,
  };
}

function textEvent(sessionId = "alpha-session-1", text = "hello"): BotEvent {
  return { kind: "text", sessionId, host: "alpha", botId: "alpha-bot-1", text };
}

function permissionEvent(permissionId = "perm-1"): BotEvent {
  return {
    kind: "permission",
    sessionId: "alpha-session-1",
    host: "alpha",
    botId: "alpha-bot-1",
    permissionId,
    title: "run the test suite?",
    detail: "npm test",
  };
}

function withSession(state: UiState, sessionId = "alpha-session-1"): UiState {
  return reduce(state, { type: "session/started", sessionId, host: "alpha", botId: "alpha-bot-1" });
}

test("starts empty", () => {
  const state = initialState();
  assert.deepEqual(state.hosts, []);
  assert.equal(state.selectedHost, null);
  assert.equal(state.selectedSession, null);
  assert.deepEqual(state.bots, {});
  assert.deepEqual(state.sessions, {});
  assert.equal(state.now, 0);
  assert.equal(state.error, null);
});

test("loading hosts lists them and keeps known connection status", () => {
  let state = initialState();
  state = reduce(state, { type: "host/added", host: host("alpha") });
  state = reduce(state, { type: "host/status", alias: "alpha", status: "connected" });
  state = reduce(state, { type: "hosts/loaded", hosts: [host("alpha"), host("bravo", "second")] });
  assert.deepEqual(
    state.hosts.map((entry) => entry.alias),
    ["alpha", "bravo"],
  );
  assert.equal(state.hosts[0].status, "connected");
  assert.equal(state.hosts[1].status, "disconnected");
  assert.equal(state.hosts[1].label, "second");
});

test("adding a host appends it and selects it when nothing is selected", () => {
  let state = initialState();
  state = reduce(state, { type: "host/added", host: host("alpha") });
  assert.equal(state.hosts.length, 1);
  assert.equal(state.selectedHost, "alpha");

  state = reduce(state, { type: "host/added", host: host("bravo") });
  assert.equal(state.hosts.length, 2);
  assert.equal(state.selectedHost, "alpha", "the first host stays selected");
});

test("adding a known host changes nothing", () => {
  let state = reduce(initialState(), { type: "host/added", host: host("alpha") });
  const before = state;
  state = reduce(state, { type: "host/added", host: host("alpha") });
  assert.equal(state, before);
});

test("selecting a host clears the selected session", () => {
  let state = withSession(initialState());
  state = reduce(state, { type: "host/selected", alias: "bravo" });
  assert.equal(state.selectedHost, "bravo");
  assert.equal(state.selectedSession, null);
});

test("host status carries an error message", () => {
  let state = reduce(initialState(), { type: "host/added", host: host("alpha") });
  state = reduce(state, { type: "host/status", alias: "alpha", status: "error", error: "refused" });
  const entry = state.hosts[0];
  assert.equal(entry.status, "error");
  assert.equal(entry.error, "refused");
});

test("bots are stored per host", () => {
  let state = initialState();
  state = reduce(state, { type: "bots/loaded", host: "alpha", bots: [bot()] });
  assert.equal(state.bots.alpha.length, 1);
  assert.deepEqual(selectBots(state, "alpha"), [bot()]);
  assert.deepEqual(selectBots(state, "bravo"), []);
  assert.deepEqual(selectBots(state, null), []);
});

test("a started session is recorded and selected", () => {
  const state = withSession(initialState());
  const session = selectSession(state, "alpha-session-1");
  assert.ok(session);
  assert.equal(session.host, "alpha");
  assert.equal(session.botId, "alpha-bot-1");
  assert.equal(session.status, "running");
  assert.deepEqual(session.events, []);
  assert.equal(state.selectedSession, "alpha-session-1");
});

test("starting a known session again changes nothing", () => {
  const state = withSession(initialState());
  const again = reduce(state, { type: "session/started", sessionId: "alpha-session-1", host: "alpha", botId: "alpha-bot-1" });
  assert.equal(again, state);
});

test("events land in their session", () => {
  let state = withSession(initialState());
  state = reduce(state, { type: "event/received", event: textEvent() });
  state = reduce(state, { type: "event/received", event: textEvent("alpha-session-1", "again") });
  const session = selectSession(state, "alpha-session-1");
  assert.equal(session?.events.length, 2);
  assert.deepEqual(
    session?.events.map((event) => (event.kind === "text" ? event.text : "")),
    ["hello", "again"],
  );
});

test("events of an unknown session are ignored", () => {
  const state = reduce(initialState(), { type: "event/received", event: textEvent("nope") });
  assert.deepEqual(state.sessions, {});
});

test("a permission request becomes pending", () => {
  let state = withSession(initialState());
  state = reduce(state, { type: "event/received", event: permissionEvent() });
  const pending = selectPendingPermissions(state);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, "perm-1");
  assert.equal(pending[0].title, "run the test suite?");
  assert.equal(pending[0].detail, "npm test");
});

test("answering a permission clears it", () => {
  let state = withSession(initialState());
  state = reduce(state, { type: "event/received", event: permissionEvent() });
  state = reduce(state, { type: "permission/answered", permissionId: "perm-1", allow: true });
  assert.deepEqual(selectPendingPermissions(state), []);
});

test("answering an unknown permission changes nothing", () => {
  const state = withSession(initialState());
  const after = reduce(state, { type: "permission/answered", permissionId: "perm-x", allow: false });
  assert.equal(after, state);
});

test("the end of a turn ends the session and drops pending permissions", () => {
  let state = withSession(initialState());
  state = reduce(state, { type: "event/received", event: permissionEvent() });
  state = reduce(state, {
    type: "event/received",
    event: { kind: "turn_end", sessionId: "alpha-session-1", host: "alpha", botId: "alpha-bot-1", status: "ok" },
  });
  const session = selectSession(state, "alpha-session-1");
  assert.equal(session?.status, "ended");
  assert.deepEqual(selectPendingPermissions(state), []);
});

test("a cancelled turn is recorded as cancelled", () => {
  let state = withSession(initialState());
  state = reduce(state, {
    type: "event/received",
    event: { kind: "turn_end", sessionId: "alpha-session-1", host: "alpha", botId: "alpha-bot-1", status: "cancelled" },
  });
  assert.equal(selectSession(state, "alpha-session-1")?.status, "cancelled");
});

test("cancelling a session marks it cancelled", () => {
  let state = withSession(initialState());
  state = reduce(state, { type: "session/cancelled", sessionId: "alpha-session-1" });
  assert.equal(selectSession(state, "alpha-session-1")?.status, "cancelled");
});

test("cancelling an unknown session changes nothing", () => {
  const state = initialState();
  assert.equal(reduce(state, { type: "session/cancelled", sessionId: "nope" }), state);
});

test("sessions of a host are listed, others are not", () => {
  let state = withSession(initialState());
  state = reduce(state, { type: "session/started", sessionId: "bravo-session-1", host: "bravo", botId: "bravo-bot-1" });
  assert.deepEqual(
    selectHostSessions(state, "alpha").map((session) => session.id),
    ["alpha-session-1"],
  );
  assert.deepEqual(selectHostSessions(state, null), []);
});

test("sessions are listed in creation order, including numeric ids", () => {
  let state = initialState();
  const ids = Array.from({ length: 12 }, (_, index) => String(index + 1));
  for (const id of ids) state = withSession(state, id);
  assert.deepEqual(selectHostSessions(state, "alpha").map((session) => session.id), ids);
});

test("interleaved hosts retain their own session creation order", () => {
  let state = initialState();
  for (const [sessionId, sessionHost] of [["a2", "alpha"], ["b2", "bravo"], ["a1", "alpha"], ["b1", "bravo"]]) {
    state = reduce(state, { type: "session/started", sessionId, host: sessionHost, botId: "bot" });
  }
  assert.deepEqual(selectHostSessions(state, "alpha").map((session) => session.id), ["a2", "a1"]);
  assert.deepEqual(selectHostSessions(state, "bravo").map((session) => session.id), ["b2", "b1"]);
});

test("starting a session twice keeps its first position", () => {
  let state = withSession(initialState(), "z");
  state = withSession(state, "a");
  state = withSession(state, "z");
  assert.deepEqual(selectHostSessions(state, "alpha").map((session) => session.id), ["z", "a"]);
});

test("sessions of removed or other hosts are excluded from the selected host", () => {
  let state = reduce(initialState(), { type: "hosts/loaded", hosts: [host("alpha"), host("bravo")] });
  state = reduce(state, { type: "session/started", sessionId: "bravo-1", host: "bravo", botId: "bot" });
  state = withSession(state, "alpha-1");
  state = reduce(state, { type: "hosts/loaded", hosts: [host("alpha")] });
  assert.deepEqual(selectHostSessions(state, "alpha").map((session) => session.id), ["alpha-1"]);
});

test("sessions with tied or unknown order retain their existing order", () => {
  let state = withSession(initialState(), "z");
  state = withSession(state, "a");
  state = withSession(state, "y");
  state = withSession(state, "b");
  state = { ...state, sessions: {
    z: { ...state.sessions.z, order: 0 },
    a: { ...state.sessions.a, order: 0 },
    y: { ...state.sessions.y, order: undefined },
    b: { ...state.sessions.b, order: undefined },
  } };
  assert.deepEqual(selectHostSessions(state, "alpha").map((session) => session.id), ["z", "a", "y", "b"]);
});

test("the clock is only moved by a tick", () => {
  const state = reduce(initialState(), { type: "clock/tick", now: 1000 });
  assert.equal(state.now, 1000);
});

test("an error message can be set and cleared", () => {
  let state = reduce(initialState(), { type: "error/set", message: "boom" });
  assert.equal(state.error, "boom");
  state = reduce(state, { type: "error/set", message: null });
  assert.equal(state.error, null);
});

test("the lease of a bot counts down and never goes negative", () => {
  const busy = bot({ status: "busy", leaseExpiresAt: 5000 });
  assert.equal(leaseRemainingMs(busy, 2000), 3000);
  assert.equal(leaseRemainingMs(busy, 9000), 0);
  assert.equal(leaseRemainingMs(bot(), 2000), null, "a bot without a lease has no countdown");
});

test("the lease is formatted as minutes and seconds", () => {
  const busy = bot({ status: "busy", leaseExpiresAt: 125_000 });
  assert.equal(formatLease(busy, 0), "2:05");
  assert.equal(formatLease(busy, 120_000), "0:05");
  assert.equal(formatLease(busy, 125_000), "0:00");
  assert.equal(formatLease(bot(), 0), null);
});

test("the quota is shown as a percentage", () => {
  assert.equal(formatQuota(bot({ quotaUsedPct: 42 })), "42%");
  assert.equal(formatQuota(bot({ quotaUsedPct: 42.4 })), "42%");
});

test("reducing does not modify the state it is given", () => {
  const before = withSession(initialState());
  const snapshot = JSON.stringify(before);
  reduce(before, { type: "hosts/loaded", hosts: [host("alpha")] });
  reduce(before, { type: "event/received", event: textEvent() });
  reduce(before, { type: "bots/loaded", host: "alpha", bots: [bot()] });
  assert.equal(JSON.stringify(before), snapshot);
});
