// End-to-end test: the daemon streams the events of a turn to the client.
//
// The daemon is the real one (botd/src/main.ts), started as a child process
// over stdio; the bot behind the session is the fake ACP bot of the
// fixtures. Everything is synthetic: no host name, address or credential
// shows up in this file.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { FrameClient } from "./frame-client.ts";
import type { AcpPayload } from "./support.ts";
import {
  FAKE_BOT,
  makeTempDir,
  readFakeBotLog,
  readSessionTable,
  skipWithoutDaemon,
  waitFor,
} from "./support.ts";

test("streams the events of a turn to the client", async (t) => {
  if (skipWithoutDaemon(t)) return;

  const home = makeTempDir("stream-");
  const logFile = path.join(home, "fake-bot.log");
  const client = FrameClient.start({ home, flags: ["--idle-ms=10000"] });
  t.after(() => client.stop());

  await client.hello("client-a", 60_000);
  await client.open("s1", {
    kind: "acp",
    command: [process.execPath, FAKE_BOT],
    env: { FAKE_BOT_LOG: logFile },
  });

  // The client opens a provider session first.
  client.send({
    op: "send",
    sid: "s1",
    payload: { jsonrpc: "2.0", id: 1, method: "session/new", params: {} },
  });
  const opened = await client.waitForEvents("s1", 1);
  const answer = opened[0].payload as AcpPayload;
  assert.equal(answer.result?.sessionId, "prov-fake-1");

  // Now the turn: the bot streams three chunks and ends the turn.
  client.send({
    op: "send",
    sid: "s1",
    payload: {
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { text: "hello", chunks: 3 },
    },
  });
  const events = await client.waitForEvents("s1", 5);
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2, 3, 4, 5],
    "the events are numbered in the order the bot produced them",
  );

  const chunks = events.slice(1, 4).map((event) => {
    const payload = event.payload as AcpPayload;
    assert.equal(payload.method, "session/update");
    assert.equal(payload.params?.update?.sessionUpdate, "agent_message_chunk");
    return payload.params?.update?.content?.text;
  });
  assert.deepEqual(chunks, ["chunk 1", "chunk 2", "chunk 3"]);

  const last = events[4].payload as AcpPayload;
  assert.equal(last.result?.stopReason, "end_turn");

  // The bot really got the prompt of the client.
  const log = readFakeBotLog(logFile);
  assert.ok(
    log.some((entry) => entry.event === "recv" && entry.line?.includes("session/prompt")),
    "the prompt reached the bot",
  );

  // The client acknowledges the events; the daemon records the ack.
  client.send({ op: "ack", sid: "s1", seq: 5 });
  await waitFor(
    () => readSessionTable(home).some((row) => row.sid === "s1" && row.ackedSeq === 5),
    { label: "the acknowledgement in the session table" },
  );
});
