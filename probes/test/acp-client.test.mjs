// probes/test/acp-client.test.mjs
//
// Tests for the ACP client (probes/lib/acp.mjs). The client is exercised
// against a tiny fake ACP agent: a real child process that speaks newline
// delimited JSON-RPC 2.0 on stdio, the same transport the probes use.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { createAcpClient } from "../lib/acp.mjs";
import { createLineSplitter } from "../lib/jsonl.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const tmpRoot = join(here, "..", ".tmp", "acp-client");
const fakeAgentPath = join(tmpRoot, "fake-acp-agent.mjs");

// The fake agent answers the handful of calls the client makes. The prompt
// text picks the behaviour so that every scenario stays independent.
const FAKE_AGENT_SOURCE = `// A tiny fake ACP agent, written by probes/test/acp-client.test.mjs.
// It speaks newline delimited JSON-RPC 2.0 on stdio, like a real ACP agent.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

/** request ids that are still unanswered */
const held = new Map();
/** the prompt that waits for a permission answer */
let pendingPromptId = null;

for await (const line of createInterface({ input: process.stdin })) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }

  const method = message.method;
  const text = method === "session/prompt" ? message.params.prompt[0].text : "";

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [],
      },
    });
  } else if (method === "authenticate") {
    send({ jsonrpc: "2.0", id: message.id, result: { authenticated: true } });
  } else if (method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-fake-1" } });
  } else if (method === "session/load") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: message.params.sessionId } });
  } else if (method === "session/cancel") {
    send({ jsonrpc: "2.0", method: "session/cancelled", params: { sessionId: message.params.sessionId } });
  } else if (method === "session/prompt" && text === "hang") {
    // never answer, the client has to give up on its own
  } else if (method === "session/prompt" && text === "error") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: "model backend refused the request" },
    });
  } else if (method === "session/prompt" && text === "exit") {
    process.exit(3);
  } else if (method === "session/prompt" && text === "slow") {
    held.set("slow", message.id);
  } else if (method === "session/prompt" && text === "fast") {
    held.set("fast", message.id);
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn", text: text } });
    const slowId = held.get("slow");
    if (slowId !== undefined) {
      held.delete("slow");
      setTimeout(() => {
        send({ jsonrpc: "2.0", id: slowId, result: { stopReason: "end_turn", text: "slow" } });
      }, 50);
    }
  } else if (method === "session/prompt" && text === "notify") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "ping" },
        },
      },
    });
    send({ jsonrpc: "2.0", method: "vendor/telemetry", params: { count: 1 } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn", text: text } });
  } else if (method === "session/prompt" && text === "permission") {
    pendingPromptId = message.id;
    send({
      jsonrpc: "2.0",
      id: "permission-1",
      method: "session/request_permission",
      params: {
        sessionId: message.params.sessionId,
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "deny-once", name: "Deny once", kind: "reject_once" },
        ],
      },
    });
  } else if (method === "session/prompt") {
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn", text: text } });
  } else if (message.id !== undefined && message.result !== undefined) {
    // the client answered our permission request
    send({ jsonrpc: "2.0", method: "vendor/permission_answered", params: message.result });
    if (pendingPromptId !== null) {
      send({ jsonrpc: "2.0", id: pendingPromptId, result: { stopReason: "end_turn", text: "permission" } });
      pendingPromptId = null;
    }
  }
}
`;

/**
 * Start the fake ACP agent and wire a client to its stdio.
 *
 * @param {import("node:test").TestContext} t
 * @param {{
 *   defaultTimeoutMs?: number,
 *   onUpdate?: (params: any) => void,
 *   onNotification?: (method: string, params: any) => void,
 *   onPermission?: (method: string, params: any, message: any) => void,
 * }} [options]
 */
function startFakeAgent(t, options = {}) {
  const child = spawn(process.execPath, [fakeAgentPath], { stdio: ["pipe", "pipe", "pipe"] });
  // The agent may die while a request is in flight; the broken pipe must not
  // take the test runner down with it.
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");

  /** @type {string[]} */
  const sent = [];

  const client = createAcpClient({
    send: (payload) => {
      sent.push(payload);
      child.stdin.write(payload + "\n");
    },
    onUpdate: options.onUpdate,
    onNotification: options.onNotification,
    onPermission: options.onPermission,
    defaultTimeoutMs: options.defaultTimeoutMs,
  });

  const splitter = createLineSplitter((line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    client.peer.handle(message);
  });
  child.stdout.on("data", (chunk) => splitter.push(chunk));

  const exited = new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  });

  return { child, client, sent, exited };
}

before(() => {
  mkdirSync(tmpRoot, { recursive: true });
  writeFileSync(fakeAgentPath, FAKE_AGENT_SOURCE);
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

test("initialize performs the ACP handshake", async (t) => {
  const { client, sent } = startFakeAgent(t);

  const result = await client.initialize("/tmp/probe-cwd");

  assert.equal(result.protocolVersion, 1);
  assert.deepEqual(result.agentCapabilities, { loadSession: true });
  assert.equal(sent.length, 1);
  const request = JSON.parse(sent[0]);
  assert.equal(request.jsonrpc, "2.0");
  assert.equal(request.method, "initialize");
  assert.equal(request.params.protocolVersion, 1);
  assert.equal(request.params.cwd, "/tmp/probe-cwd");
  assert.deepEqual(request.params.clientCapabilities, {
    fs: { readTextFile: false, writeTextFile: false },
  });
});

test("correlates concurrent requests when the replies arrive out of order", async (t) => {
  const { client } = startFakeAgent(t);
  const session = await client.newSession("/tmp/probe-cwd");
  assert.equal(session.sessionId, "session-fake-1");

  /** @type {string[]} */
  const order = [];
  const slow = client.prompt(session.sessionId, "slow").then((result) => {
    order.push("slow");
    return result;
  });
  const fast = client.prompt(session.sessionId, "fast").then((result) => {
    order.push("fast");
    return result;
  });

  const [slowResult, fastResult] = await Promise.all([slow, fast]);

  assert.deepEqual(order, ["fast", "slow"], "the later request answered first");
  assert.equal(slowResult.text, "slow");
  assert.equal(fastResult.text, "fast");
});

test("delivers agent notifications to the update handler", async (t) => {
  /** @type {any[]} */
  const updates = [];
  /** @type {any[]} */
  const notifications = [];
  const { client } = startFakeAgent(t, {
    onUpdate: (params) => updates.push(params),
    onNotification: (method, params) => notifications.push({ method, params }),
  });
  const session = await client.newSession("/tmp/probe-cwd");

  await client.prompt(session.sessionId, "notify");

  assert.equal(updates.length, 1);
  assert.equal(updates[0].sessionId, "session-fake-1");
  assert.equal(updates[0].update.sessionUpdate, "agent_message_chunk");
  assert.deepEqual(
    notifications.map((notification) => notification.method),
    ["vendor/telemetry"],
  );
  assert.deepEqual(notifications[0].params, { count: 1 });
});

test("rejects the call when the agent answers with an error", async (t) => {
  const { client } = startFakeAgent(t);
  const session = await client.newSession("/tmp/probe-cwd");

  await assert.rejects(
    () => client.prompt(session.sessionId, "error"),
    (error) => {
      assert.match(error.message, /model backend refused the request/);
      assert.equal(error.code, -32000);
      return true;
    },
  );
});

test("times out when the agent never answers", async (t) => {
  const { client } = startFakeAgent(t, { defaultTimeoutMs: 250 });
  const session = await client.newSession("/tmp/probe-cwd");

  await assert.rejects(
    () => client.prompt(session.sessionId, "hang"),
    /timeout waiting for response to session\/prompt/,
  );
});

test("declines a permission request instead of granting it", async (t) => {
  /** @type {any[]} */
  const permissions = [];
  /** @type {any[]} */
  const notifications = [];
  const { client } = startFakeAgent(t, {
    onPermission: (method, params) => permissions.push({ method, params }),
    onNotification: (method, params) => notifications.push({ method, params }),
  });
  const session = await client.newSession("/tmp/probe-cwd");

  const result = await client.prompt(session.sessionId, "permission");

  assert.equal(permissions.length, 1);
  assert.equal(permissions[0].method, "session/request_permission");
  assert.equal(permissions[0].params.sessionId, "session-fake-1");
  const answered = notifications.find((notification) => notification.method === "vendor/permission_answered");
  assert.ok(answered, "the client did not answer the permission request");
  assert.equal(answered.params.outcome.optionId, "deny-once");
  assert.equal(result.stopReason, "end_turn");
});

test(
  "a child that exits mid-request rejects the pending call",
  { todo: "the client cannot observe the agent exit, so the pending call only times out" },
  async (t) => {
    const { client, exited } = startFakeAgent(t, { defaultTimeoutMs: 2_000 });
    const session = await client.newSession("/tmp/probe-cwd");

    const pending = client.prompt(session.sessionId, "exit");
    const closed = await exited;
    assert.equal(closed.code, 3, "the fake agent should have exited");

    await assert.rejects(() => pending, /exit/i);
  },
);
