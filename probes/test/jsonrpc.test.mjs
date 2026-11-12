import assert from "node:assert/strict";
import test from "node:test";

import { createJsonRpcPeer } from "../lib/jsonrpc.mjs";

test("correlates responses with requests", async () => {
  /** @type {string[]} */
  const sent = [];
  const peer = createJsonRpcPeer({
    send: (payload) => {
      sent.push(payload);
      const message = JSON.parse(payload);
      // Echo the answer back the way a server would.
      peer.handle({ jsonrpc: "2.0", id: message.id, result: { echo: message.params } });
    },
  });

  const result = await peer.request("initialize", { clientInfo: { name: "probe" } });
  assert.deepEqual(result, { echo: { clientInfo: { name: "probe" } } });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /"method":"initialize"/);
});

test("rejects with the json-rpc error message", async () => {
  const peer = createJsonRpcPeer({
    send: (payload) => {
      const message = JSON.parse(payload);
      peer.handle({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown variant" } });
    },
  });
  await assert.rejects(() => peer.request("thread/start", {}), /unknown variant/);
});

test("routes server requests to the handler", async () => {
  /** @type {string[]} */
  const sent = [];
  /** @type {string[]} */
  const received = [];
  const peer = createJsonRpcPeer({
    send: (payload) => sent.push(payload),
    onServerRequest: (method, params, message) => {
      received.push(method);
      peer.respond(message.id, { decision: "decline" });
    },
  });

  peer.handle({ jsonrpc: "2.0", id: 7, method: "item/commandExecution/requestApproval", params: { command: "ls" } });
  assert.deepEqual(received, ["item/commandExecution/requestApproval"]);
  assert.match(sent[0], /"decision":"decline"/);
});

test("routes notifications to the handler", () => {
  /** @type {string[]} */
  const received = [];
  const peer = createJsonRpcPeer({ send: () => {}, onNotification: (method) => received.push(method) });
  peer.handle({ jsonrpc: "2.0", method: "thread/started", params: {} });
  assert.deepEqual(received, ["thread/started"]);
});

test("times out when no answer arrives", async () => {
  const peer = createJsonRpcPeer({ send: () => {} });
  await assert.rejects(() => peer.request("initialize", {}, { timeoutMs: 50 }), /timeout/);
});
