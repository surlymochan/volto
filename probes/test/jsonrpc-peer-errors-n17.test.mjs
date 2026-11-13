import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createJsonRpcPeer } from "../lib/jsonrpc.mjs";

function makePeer(options = {}) {
  const sent = [];
  const peer = createJsonRpcPeer({ send: (payload) => sent.push(payload), defaultTimeoutMs: 50, ...options });
  return { peer, sent };
}

test("request ids start at one and are unique across calls", async () => {
  const { peer, sent } = makePeer();
  const requests = [peer.request("first"), peer.request("second"), peer.request("third")];
  const ids = sent.map((payload) => JSON.parse(payload).id);
  assert.deepEqual(ids, [1, 2, 3]);
  for (const id of ids) peer.handle({ id, result: id });
  assert.deepEqual(await Promise.all(requests), ids);
});

test("error responses preserve the error code", async () => {
  const { peer, sent } = makePeer();
  const request = peer.request("example");
  peer.handle({ id: JSON.parse(sent[0]).id, error: { code: -32001, message: "synthetic error" } });
  await assert.rejects(request, { name: "Error", message: "synthetic error", code: -32001 });
});

test("error responses without a message use a fallback", async () => {
  const { peer, sent } = makePeer();
  const request = peer.request("example");
  peer.handle({ id: JSON.parse(sent[0]).id, error: { code: -32002 } });
  await assert.rejects(request, { message: "json-rpc error", code: -32002 });
});

test("unknown response ids are ignored", async () => {
  const { peer, sent } = makePeer();
  const request = peer.request("example");
  assert.doesNotThrow(() => peer.handle({ id: 999, result: "ignored" }));
  peer.handle({ id: JSON.parse(sent[0]).id, result: "accepted" });
  assert.equal(await request, "accepted");
});

test("invalid and empty messages do nothing", () => {
  const received = [];
  const { peer, sent } = makePeer({
    onServerRequest: (...args) => received.push(args),
    onNotification: (...args) => received.push(args),
  });
  for (const message of [null, "x", {}]) assert.doesNotThrow(() => peer.handle(message));
  assert.deepEqual(received, []);
  assert.deepEqual(sent, []);
});

test("server requests default missing params to an empty object", () => {
  const received = [];
  const { peer } = makePeer({ onServerRequest: (...args) => received.push(args) });
  const message = { id: 0, method: "example" };
  peer.handle(message);
  assert.deepEqual(received, [["example", {}, message]]);
});

test("notifications pass their params and original message", () => {
  const received = [];
  const { peer } = makePeer({ onNotification: (...args) => received.push(args) });
  const message = { method: "example", params: { value: 1 } };
  peer.handle(message);
  assert.deepEqual(received, [["example", { value: 1 }, message]]);
});

test("a null id routes to notifications", () => {
  const notifications = [];
  const requests = [];
  const { peer } = makePeer({
    onNotification: (...args) => notifications.push(args),
    onServerRequest: (...args) => requests.push(args),
  });
  const message = { id: null, method: "example" };
  peer.handle(message);
  assert.deepEqual(notifications, [["example", {}, message]]);
  assert.deepEqual(requests, []);
});

test("a per-request timeout overrides the default and names the method", async () => {
  const { peer, sent } = makePeer({ defaultTimeoutMs: 20 });
  const request = peer.request("slow/example", {}, { timeoutMs: 40 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  peer.handle({ id: JSON.parse(sent[0]).id, result: "in time" });
  assert.equal(await request, "in time");
  await assert.rejects(peer.request("fast/example", {}, { timeoutMs: 5 }), {
    message: "timeout waiting for response to fast/example",
  });
});

test("a late response after timeout is ignored", async () => {
  const { peer, sent } = makePeer();
  const request = peer.request("example", {}, { timeoutMs: 5 });
  const id = JSON.parse(sent[0]).id;
  await assert.rejects(request, { message: "timeout waiting for response to example" });
  assert.doesNotThrow(() => peer.handle({ id, result: "late" }));
  const next = peer.request("next");
  peer.handle({ id: JSON.parse(sent[1]).id, result: "current" });
  assert.equal(await next, "current");
});

test("respond writes a JSON-RPC result frame", () => {
  const { peer, sent } = makePeer();
  peer.respond("request-id", { value: 1 });
  assert.deepEqual(JSON.parse(sent[0]), { jsonrpc: "2.0", id: "request-id", result: { value: 1 } });
});

test("respondError writes a JSON-RPC error frame", () => {
  const { peer, sent } = makePeer();
  peer.respondError(4, -32000, "synthetic error");
  assert.deepEqual(JSON.parse(sent[0]), {
    jsonrpc: "2.0", id: 4, error: { code: -32000, message: "synthetic error" },
  });
});

test("notify writes a frame without an id", () => {
  const { peer, sent } = makePeer();
  peer.notify("example", { value: 1 });
  assert.deepEqual(JSON.parse(sent[0]), { jsonrpc: "2.0", method: "example", params: { value: 1 } });
});

// DEFECT: JsonRpcPeer documents pendingMethods, but createJsonRpcPeer does not return it.
test.todo("the documented pendingMethods property is exposed", () => {
  const source = readFileSync(new URL("../lib/jsonrpc.mjs", import.meta.url), "utf8");
  assert.match(source, /@property \{string\[\]\} pendingMethods/);
  assert.ok("pendingMethods" in makePeer().peer);
});
