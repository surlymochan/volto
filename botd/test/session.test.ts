// Tests for a session: the pure helpers and the cancel lifecycle.
//
// The bot child is a tiny local script (test/fixtures/*.mjs); no host name,
// address or credential shows up in this file.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { defaultCancelMessage, parseOutputLine, Session } from "../src/session.ts";
import { EventRing } from "../src/ring.ts";
import type { SessionState } from "../src/protocol.ts";
import { ANSWERING_CHILD, FAKE_CHILD, delay, makeTempDir, readChildLog, waitFor } from "./helpers.ts";

test("knows the cancel message of every bot kind", () => {
  assert.deepEqual(defaultCancelMessage("acp"), {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: {},
  });
  assert.deepEqual(defaultCancelMessage("acp", "prov-1"), {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: "prov-1" },
  });
  assert.deepEqual(defaultCancelMessage("codex-app-server"), {
    jsonrpc: "2.0",
    method: "turn/interrupt",
    params: {},
  });
  assert.deepEqual(defaultCancelMessage("pi-rpc"), {
    jsonrpc: "2.0",
    method: "abort",
    params: {},
  });
});

test("parses a json line and keeps a plain line", () => {
  assert.deepEqual(parseOutputLine('{"jsonrpc":"2.0"}'), { jsonrpc: "2.0" });
  assert.equal(parseOutputLine("not json at all"), "not json at all");
});

/** A session with a fake child; the states and the outputs are recorded. */
function startSession(
  command: string[],
  env?: Record<string, string>,
): { session: Session; states: SessionState[]; outputs: unknown[] } {
  const states: SessionState[] = [];
  const outputs: unknown[] = [];
  const session = new Session({
    sid: "s1",
    bot: { kind: "acp", command, ...(env ? { env } : {}) },
    ring: new EventRing(100, 1 << 20),
    now: () => Date.now(),
    hooks: {
      onOutput: (_session, payload) => {
        outputs.push(payload);
      },
      onState: (_session, state) => {
        states.push(state);
      },
      onExit: () => {},
      onError: () => {},
    },
  });
  session.start();
  return { session, states, outputs };
}

test("a cancel that the child answers leaves the session usable", async (t) => {
  const home = makeTempDir("cancel-answered-");
  const logFile = path.join(home, "child.log");
  const { session, states } = startSession([process.execPath, ANSWERING_CHILD], {
    FAKE_CHILD_LOG: logFile,
  });
  t.after(() => session.dispose());

  // The child answers every message, so the session knows it is alive.
  assert.equal(session.send({ cmd: "hello" }), true);
  await waitFor(() => session.hasOutput, { label: "the first answer of the child" });

  session.requestCancel(
    { jsonrpc: "2.0", method: "session/cancel", params: {} },
    { graceMs: 5000, killGraceMs: 5000 },
  );
  assert.equal(session.state, "paused");
  assert.equal(session.cancelling, true);

  // The child answers the cancel: the session is usable again.
  await waitFor(() => !session.cancelling, { label: "the cancel to be answered" });
  assert.equal(session.state, "running");
  assert.deepEqual(
    states.filter((state) => state === "paused" || state === "running"),
    ["running", "paused", "running"],
    "the cancel pauses the session, the answer of the child resumes it",
  );

  // The escalation stopped: the child never got a SIGINT.
  await delay(300);
  assert.equal(session.isLive, true);
  assert.equal(
    readChildLog(logFile).some((entry) => entry.event === "sigint"),
    false,
    "an answered cancel must not be escalated",
  );

  // The next message reaches the child.
  const before = session.seq;
  assert.equal(session.send({ cmd: "echo", text: "after the cancel" }), true);
  await waitFor(() => session.seq > before, { label: "the answer after the cancel" });
});

test("a cancel to a silent child is escalated to a SIGINT and then a SIGKILL", async (t) => {
  const home = makeTempDir("cancel-silent-");
  const logFile = path.join(home, "child.log");
  const { session, states } = startSession([process.execPath, FAKE_CHILD], {
    FAKE_CHILD_LOG: logFile,
  });
  t.after(() => session.dispose());

  // The child ignores the SIGINT, so only the SIGKILL of the group stops it.
  assert.equal(session.send({ cmd: "ignore-sigint" }), true);
  await waitFor(() => readChildLog(logFile).some((entry) => entry.event === "ignore-sigint"), {
    label: "the child to ignore SIGINT",
  });

  session.requestCancel(
    { jsonrpc: "2.0", method: "session/cancel", params: {} },
    { graceMs: 100, killGraceMs: 100 },
  );
  assert.equal(session.state, "paused");
  assert.equal(session.cancelling, true);

  // The silent child gets a SIGINT and then a SIGKILL.
  await waitFor(() => readChildLog(logFile).some((entry) => entry.event === "sigint"), {
    label: "the SIGINT of the silent child",
  });
  await waitFor(() => session.state === "exited", { label: "the exit of the silent child" });
  assert.equal(session.cancelling, false, "a dead child is not cancelling any more");
  assert.ok(states.includes("exited"));
});
