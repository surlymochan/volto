// End-to-end test: the daemon escalates a cancel.
//
// The client cancels a turn of a bot that stopped answering. The daemon
// sends the provider cancel first, then it signals the process group of the
// bot (SIGINT) and finally it kills it (SIGKILL); the fake bot ignores
// SIGINT, so the whole escalation is visible.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { FrameClient } from "./frame-client.ts";
import { FAKE_BOT, makeTempDir, readFakeBotLog, skipWithoutDaemon, waitFor } from "./support.ts";

test("escalates a cancel to the kill of the process group of the bot", async (t) => {
  if (skipWithoutDaemon(t)) return;

  const home = makeTempDir("cancel-");
  const logFile = path.join(home, "fake-bot.log");
  const client = FrameClient.start({
    home,
    flags: [
      "--watchdog-ms=50",
      "--idle-ms=10000",
      "--cancel-grace-ms=300",
      "--cancel-kill-grace-ms=300",
    ],
  });
  t.after(() => client.stop());

  await client.hello("client-a", 60_000);
  await client.open("s1", {
    kind: "acp",
    command: [process.execPath, FAKE_BOT],
    env: { FAKE_BOT_LOG: logFile },
  });

  // The bot stops answering.
  client.send({
    op: "send",
    sid: "s1",
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: { mode: "hang" },
    },
  });
  await waitFor(() => readFakeBotLog(logFile).some((entry) => entry.event === "hang"), {
    label: "the bot to hang",
  });

  // The client cancels the turn.
  const cancelMark = client.mark();
  client.send({
    op: "cancel",
    sid: "s1",
    payload: {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "prov-fake-1" },
    },
  });

  // The first step of the escalation is the provider cancel.
  await waitFor(
    () =>
      readFakeBotLog(logFile).some(
        (entry) => entry.event === "recv" && entry.line?.includes("session/cancel"),
      ),
    { label: "the provider cancel at the bot" },
  );

  // The session is paused while the cancel is running.
  await waitFor(
    () =>
      client
        .framesSince(cancelMark)
        .find(
          (frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "paused",
        ),
    { label: "the paused state of the cancelled session" },
  );

  // The bot ignores SIGINT: the daemon has to kill the process group.
  await waitFor(() => readFakeBotLog(logFile).some((entry) => entry.event === "sigint"), {
    timeoutMs: 8000,
    label: "the SIGINT at the bot",
  });

  // The kill ends the session.
  await client.waitFor(
    (frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "exited",
    { timeoutMs: 8000, label: "the exited state of the cancelled session" },
  );

  // After the kill the bot is gone: it never answered the cancel.
  const log = readFakeBotLog(logFile);
  assert.equal(
    log.filter((entry) => entry.event === "sigterm").length,
    0,
    "the daemon kills the group, it does not ask the bot to leave",
  );
});
