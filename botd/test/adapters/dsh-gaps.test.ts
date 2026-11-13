import assert from "node:assert/strict";
import { test } from "node:test";
import { DshAdapter } from "../../src/adapters/dsh.ts";

function parse(adapter: DshAdapter, message: unknown) {
  return adapter.parse(JSON.stringify(message));
}

test("initialize and session/new errors do not set a session", () => {
  const adapter = new DshAdapter();
  const requests = adapter.handshake({ cwd: "/synthetic/work" }) as { id: number }[];
  assert.deepEqual(parse(adapter, { id: requests[0].id, error: { message: "init failed" } }), [{ kind: "error", message: "init failed" }]);
  assert.deepEqual(parse(adapter, { id: requests[1].id, error: "session failed" }), [{ kind: "error", message: "session failed" }]);
  assert.equal(adapter.sessionId, undefined);
});

test("empty results use the pending handshake or prompt method", () => {
  const adapter = new DshAdapter();
  const requests = adapter.handshake({ cwd: "/synthetic/work" }) as { id: number }[];
  for (const request of requests) {
    assert.deepEqual(parse(adapter, { id: request.id, result: {} }), [{ kind: "ready" }]);
  }
  const prompt = adapter.prompt("hello", {}) as { id: number };
  assert.deepEqual(parse(adapter, { id: prompt.id, result: {} }), [{ kind: "turn_end", status: "ok" }]);
  const unknown = { id: 999, result: {} };
  assert.deepEqual(parse(adapter, unknown), [{ kind: "raw", payload: unknown }]);
});

test("unknown updates remain raw and incomplete tool updates use fallbacks", () => {
  const adapter = new DshAdapter();
  const unknown = { method: "session/update", params: { update: { sessionUpdate: "future_update", data: 1 } } };
  assert.deepEqual(parse(adapter, unknown), [{ kind: "raw", payload: unknown }]);
  const update = { method: "session/update", params: { update: {
    sessionUpdate: "tool_call_update", status: "in_progress", content: { type: "image" },
  } } };
  assert.deepEqual(parse(adapter, update), [{ kind: "tool", name: "tool", status: "start", summary: undefined }]);
});

test("permission mapping retains string ids and selects fallback options", () => {
  const adapter = new DshAdapter();
  const params = { options: [null, { kind: "allow_always", optionId: "always" }, { kind: "allow_once", optionId: 42 }] };
  assert.deepEqual(parse(adapter, { method: "session/request_permission", id: "rpc-1", params }), [{ kind: "permission", id: "rpc-1", request: params }]);
  assert.deepEqual(adapter.answerPermission("rpc-1", true), {
    jsonrpc: "2.0", id: "rpc-1", result: { outcome: { outcome: "selected", optionId: "always" } },
  });
  parse(adapter, { method: "session/request_permission", id: 7, params: { options: [{ kind: "reject_always", optionId: "deny" }] } });
  assert.deepEqual(adapter.answerPermission("7", false), {
    jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "selected", optionId: "deny" } },
  });
});

test("permission without a matching option is cancelled and missing ids stay raw", () => {
  const adapter = new DshAdapter();
  const missingId = { method: "session/request_permission", params: {} };
  assert.deepEqual(parse(adapter, missingId), [{ kind: "raw", payload: missingId }]);
  parse(adapter, { method: "session/request_permission", id: 8, params: { options: [{ kind: "reject_once", optionId: "no" }] } });
  assert.deepEqual(adapter.answerPermission("8", true), {
    jsonrpc: "2.0", id: 8, result: { outcome: { outcome: "cancelled" } },
  });
  assert.equal(adapter.answerPermission("8", false), null);
});

test("prompt stop reasons and partial or invalid usage map consistently", () => {
  const adapter = new DshAdapter();
  for (const reason of ["end_turn", "max_tokens", "max_turn_requests", "refusal"]) {
    assert.deepEqual(parse(adapter, { result: { stopReason: reason, usage: { input_tokens: 5, output_tokens: "invalid" } } }), [
      { kind: "turn_end", status: "ok", usage: { inputTokens: 5, outputTokens: undefined } },
    ]);
  }
  assert.deepEqual(parse(adapter, { result: { stopReason: "cancelled", usage: { inputTokens: "bad" } } }), [
    { kind: "turn_end", status: "cancelled" },
  ]);
});
