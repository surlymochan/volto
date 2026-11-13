// End-to-end test: the client resumes a session after a transport break.
//
// Two breaks are covered: the transport to the bot dies (the daemon keeps
// the journal of the session and replays the events the client missed) and
// the transport to the daemon dies (the journal is gone, the daemon reports
// the gap so that the client can restart the task).

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { FrameClient } from "./frame-client.ts";
import type { EventFrame } from "./frame-client.ts";
import {
  FAKE_BOT,
  makeTempDir,
  readSessionTable,
  skipWithoutDaemon,
  waitFor,
} from "./support.ts";

test("replays the events the client missed after the bot transport died", async (t) => {
  if (skipWithoutDaemon(t)) return;

  const home = makeTempDir("resume-");
  const logFile = path.join(home, "fake-bot.log");
  const client = FrameClient.start({ home, flags: ["--idle-ms=10000"] });
  t.after(() => client.stop());

  await client.hello("client-a", 60_000);
  await client.open("s1", {
    kind: "acp",
    command: [process.execPath, FAKE_BOT],
    env: { FAKE_BOT_LOG: logFile },
  });

  client.send({
    op: "send",
    sid: "s1",
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: { text: "hello", chunks: 2 },
    },
  });
  const events = await client.waitForEvents("s1", 3);
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2, 3],
  );
  // The client processed the first event and acknowledged it.
  client.send({ op: "ack", sid: "s1", seq: 1 });

  // The transport to the bot dies: the bot leaves.
  client.send({
    op: "send",
    sid: "s1",
    payload: { jsonrpc: "2.0", id: 2, method: "bot/exit", params: { code: 0 } },
  });
  await client.waitFor(
    (frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "exited",
    { label: "the exited state of the session" },
  );

  // The client resumes the session: the events it missed are replayed.
  const mark = client.mark();
  client.send({ op: "resume", sid: "s1", fromSeq: 2 });
  const replayed = await waitFor(
    () => {
      const frames = client
        .framesSince(mark)
        .filter((frame): frame is EventFrame => frame.op === "event");
      return frames.length >= 2 ? frames : undefined;
    },
    { label: "the replay of the missed events" },
  );
  assert.deepEqual(
    replayed.map((frame) => frame.seq),
    [2, 3],
    "the replay keeps the sequence numbers of the original events",
  );
});

test("reports the gap of a session whose daemon went away with the transport", async (t) => {
  if (skipWithoutDaemon(t)) return;

  const home = makeTempDir("gap-");
  const client = FrameClient.start({ home, flags: ["--idle-ms=10000"] });
  t.after(() => client.stop());

  await client.hello("client-a", 60_000);
  await client.open("s1", {
    kind: "acp",
    command: [process.execPath, FAKE_BOT],
  });

  client.send({
    op: "send",
    sid: "s1",
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: { text: "hello", chunks: 2 },
    },
  });
  await client.waitForEvents("s1", 3);
  client.send({ op: "ack", sid: "s1", seq: 1 });
  // The daemon has to write the table before the host goes away.
  await waitFor(
    () => readSessionTable(home).some((row) => row.sid === "s1" && row.ackedSeq === 1),
    { label: "the acknowledgement in the session table" },
  );

  // The transport breaks: the daemon (the host) is gone.
  await client.killTransport();

  // A new transport: a fresh daemon with the same home reads the table.
  const second = FrameClient.start({ home, flags: ["--idle-ms=10000"] });
  t.after(() => second.stop());
  await second.hello("client-b", 60_000);

  second.send({ op: "resume", sid: "s1", fromSeq: 2 });
  const gap = await second.waitFor((frame) => frame.op === "gap" && frame.sid === "s1", {
    label: "the gap frame",
  });
  if (gap.op !== "gap") throw new Error("unreachable");
  assert.equal(gap.fromSeq, 2);
  assert.equal(gap.toSeq, 3, "the events of the session are lost");

  const state = await second.waitFor((frame) => frame.op === "state" && frame.sid === "s1", {
    label: "the state of the session",
  });
  if (state.op !== "state") throw new Error("unreachable");
  assert.equal(state.state, "exited", "the session cannot be resumed, it has to be restarted");
});
