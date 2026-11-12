// Tests for the pieces of a session that do not need a child process.

import test from "node:test";
import assert from "node:assert/strict";

import { defaultCancelMessage, parseOutputLine } from "../src/session.ts";

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
