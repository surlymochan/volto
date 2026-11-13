// End-to-end test: the daemon pauses the sessions when the lease expires.
//
// The client takes a lease with a short TTL and stops renewing it: the
// daemon pauses the sessions (the bot stays alive, the input is not
// forwarded any more) and a renew brings them back to life.

import test from "node:test";
import assert from "node:assert/strict";

import { FrameClient } from "./frame-client.ts";
import { FAKE_BOT, makeTempDir, skipWithoutDaemon, waitFor } from "./support.ts";

test("pauses the sessions when the lease expires and resumes them on renew", async (t) => {
  if (skipWithoutDaemon(t)) return;

  const home = makeTempDir("lease-");
  const client = FrameClient.start({ home, flags: ["--watchdog-ms=50", "--idle-ms=10000"] });
  t.after(() => client.stop());

  // A short lease: the client has to renew it before it runs out.
  const hello = await client.hello("client-a", 1500);
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
      params: { text: "hello", chunks: 1 },
    },
  });
  await client.waitForEvents("s1", 2);

  // The client stops renewing: the lease runs out and the session pauses.
  const pauseMark = client.mark();
  await waitFor(
    () =>
      client
        .framesSince(pauseMark)
        .find(
          (frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "paused",
        ),
    { timeoutMs: 8000, label: "the paused state of the session" },
  );
  await waitFor(() => client.logText().includes("lease expired"), {
    label: "the log of the expired lease",
  });

  // While the lease is gone the input is not forwarded.
  client.send({
    op: "send",
    sid: "s1",
    payload: {
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { text: "again", chunks: 1 },
    },
  });
  const error = await client.waitFor(
    (frame) => frame.op === "error" && frame.code === "lease_paused",
    { label: "the error of the expired lease" },
  );
  if (error.op !== "error") throw new Error("unreachable");
  assert.equal(error.sid, "s1");

  // A renew brings the session back to life.
  const renewMark = client.mark();
  client.send({ op: "renew", leaseId: hello.leaseId, fence: hello.fence });
  await waitFor(
    () =>
      client
        .framesSince(renewMark)
        .find(
          (frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "running",
        ),
    { timeoutMs: 8000, label: "the running state after the renew" },
  );

  const states = client.states("s1").map((frame) => frame.state);
  assert.ok(states.includes("paused"), "the session was paused while the lease was gone");
  assert.equal(states[states.length - 1], "running", "the session runs again after the renew");

  client.send({
    op: "send",
    sid: "s1",
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { text: "again", chunks: 1 },
    },
  });
  const events = await client.waitForEvents("s1", 4);
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2, 3, 4],
    "the input is forwarded again after the renew",
  );
});
