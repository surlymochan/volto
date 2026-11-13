import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Session } from "../src/session.ts";
import { EventRing } from "../src/ring.ts";

function makeSession() {
  const events: string[] = [];
  const input = new PassThrough();
  let written = "";
  input.on("data", (chunk) => { written += chunk.toString(); });
  const session = new Session({
    sid: "s1", bot: { kind: "acp", command: [] },
    ring: new EventRing(100, 1024), now: () => 10,
    hooks: {
      onState: (_s, state) => events.push(`state:${state}`),
      onOutput: (_s, payload) => events.push(`output:${payload}`),
      onExit: () => events.push("exit"),
      onError: (_s, message) => events.push(`error:${message}`),
    },
  });
  const child = { stdin: input, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null };
  const attach = () => { session.child = child as unknown as ChildProcessWithoutNullStreams; };
  const internals = session as unknown as { onStdout: (chunk: string) => void; onExit: () => void };
  return { session, events, child, attach, internals, written: () => written };
}

const cancelOptions = { graceMs: 10000, killGraceMs: 10000 };

test("idle can transition through running to exited", () => {
  const { session, events } = makeSession();
  session.setState("idle");
  session.setState("running");
  session.setState("exited");
  assert.deepEqual(events, ["state:idle", "state:running", "state:exited"]);
});

test("cancel without a live child leaves idle unchanged", () => {
  const { session, events } = makeSession();
  session.setState("idle");
  session.requestCancel(null, cancelOptions);
  assert.equal(session.state, "idle");
  assert.equal(session.cancelling, false);
  assert.deepEqual(events, ["state:idle"]);
});

test("cancel while idle pauses a live session", () => {
  const { session, attach, written } = makeSession();
  attach();
  session.setState("idle");
  session.requestCancel("cancel", cancelOptions);
  assert.equal(session.state, "paused");
  assert.equal(written(), "cancel\n");
  session.dispose();
});

test("a second cancel sends again without repeating the paused state", () => {
  const { session, attach, events, written } = makeSession();
  attach();
  session.setState("running");
  session.requestCancel("one", cancelOptions);
  session.requestCancel("two", cancelOptions);
  assert.equal(written(), "one\ntwo\n");
  assert.deepEqual(events, ["state:running", "state:paused"]);
  session.dispose();
});

test("send after the child exits is rejected", () => {
  const { session, attach, child, written, internals } = makeSession();
  attach();
  child.exitCode = 0 as unknown as null;
  internals.onExit();
  assert.equal(session.send("late"), false);
  assert.equal(written(), "");
  assert.equal(session.state, "exited");
  session.dispose();
});

test("cancel answer publishes running before output", () => {
  const { session, attach, events, internals } = makeSession();
  attach();
  session.setState("running");
  session.requestCancel("cancel", cancelOptions);
  internals.onStdout('"answer"\n');
  assert.deepEqual(events, ["state:running", "state:paused", "state:running", "output:answer"]);
  assert.equal(session.cancelling, false);
  session.dispose();
});

test("trailing output is delivered before exit state and exit hook", () => {
  const { session, events, internals } = makeSession();
  internals.onStdout("last");
  internals.onExit();
  assert.deepEqual(events, ["output:last", "state:exited", "exit"]);
});

// DEFECT: setState permits an exited session to return to running.
test.todo("exited is a sticky terminal state", () => {
  const { session } = makeSession();
  session.setState("exited");
  session.setState("running");
  assert.equal(session.state, "exited");
});
