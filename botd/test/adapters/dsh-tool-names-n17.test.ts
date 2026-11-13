import assert from "node:assert/strict";
import { test } from "node:test";
import { DshAdapter } from "../../src/adapters/dsh.ts";

function update(adapter: DshAdapter, value: Record<string, unknown>) {
  return adapter.parse(JSON.stringify({ method: "session/update", params: { update: value } }));
}

function tool(name: string, status = "start", summary?: string) {
  return [{ kind: "tool", name, status, summary }];
}

test("a new title overrides a remembered name and kind", () => {
  const adapter = new DshAdapter();
  update(adapter, { sessionUpdate: "tool_call", toolCallId: "id-a", title: "first" });
  assert.deepEqual(update(adapter, { sessionUpdate: "tool_call", toolCallId: "id-a", title: "second", kind: "other" }), tool("second"));
  assert.deepEqual(update(adapter, { sessionUpdate: "tool_call_update", toolCallId: "id-a" }), tool("second"));
});

test("remembered names take precedence over a later kind", () => {
  const adapter = new DshAdapter();
  update(adapter, { sessionUpdate: "tool_call", toolCallId: "id-a", title: "named" });
  assert.deepEqual(update(adapter, { sessionUpdate: "tool_call_update", toolCallId: "id-a", kind: "other" }), tool("named"));
});

test("kind is remembered when there is no title", () => {
  const adapter = new DshAdapter();
  assert.deepEqual(update(adapter, { sessionUpdate: "tool_call", toolCallId: "id-a", kind: "inspect" }), tool("inspect"));
  assert.deepEqual(update(adapter, { sessionUpdate: "tool_call_update", toolCallId: "id-a" }), tool("inspect"));
});

test("the call id is a remembered fallback", () => {
  const adapter = new DshAdapter();
  assert.deepEqual(update(adapter, { sessionUpdate: "tool_call", toolCallId: "id-a" }), tool("id-a"));
  assert.deepEqual(update(adapter, { sessionUpdate: "tool_call_update", toolCallId: "id-a", kind: "other" }), tool("id-a"));
});

test("empty name fields fall back to tool", () => {
  assert.deepEqual(update(new DshAdapter(), { sessionUpdate: "tool_call", toolCallId: "", title: "", kind: "" }), tool("tool"));
});

test("names are isolated by call id", () => {
  const adapter = new DshAdapter();
  update(adapter, { sessionUpdate: "tool_call", toolCallId: "id-a", title: "alpha" });
  update(adapter, { sessionUpdate: "tool_call", toolCallId: "id-b", title: "beta" });
  assert.deepEqual(update(adapter, { sessionUpdate: "tool_call_update", toolCallId: "id-a" }), tool("alpha"));
  assert.deepEqual(update(adapter, { sessionUpdate: "tool_call_update", toolCallId: "id-b" }), tool("beta"));
});

test("tool calls start even when their supplied status is terminal", () => {
  const adapter = new DshAdapter();
  for (const status of ["completed", "failed", "cancelled"]) {
    assert.deepEqual(update(adapter, { sessionUpdate: "tool_call", title: "action", status }), tool("action"));
  }
});

for (const status of ["pending", "cancelled", "unknown"]) {
  test(`tool update status ${status} maps to start`, () => {
    assert.deepEqual(update(new DshAdapter(), { sessionUpdate: "tool_call_update", title: "action", status }), tool("action"));
  });
}

test("tool summaries join nested text blocks and prefer content over raw output", () => {
  assert.deepEqual(update(new DshAdapter(), {
    sessionUpdate: "tool_call", title: "action",
    content: [{ text: "one" }, { content: { text: "two" } }, { text: "" }],
    rawOutput: { output: "fallback" },
  }), tool("action", "start", "one\ntwo"));
});

test("tool summaries use raw output when content has no text", () => {
  assert.deepEqual(update(new DshAdapter(), {
    sessionUpdate: "tool_call", title: "action", content: [{ text: "" }], rawOutput: { output: "fallback" },
  }), tool("action", "start", "fallback"));
});

test("empty text chunks remain raw", () => {
  const message = { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "" } } } };
  assert.deepEqual(new DshAdapter().parse(JSON.stringify(message)), [{ kind: "raw", payload: message }]);
});

test("session updates without an update remain raw", () => {
  const message = { method: "session/update", params: {} };
  assert.deepEqual(new DshAdapter().parse(JSON.stringify(message)), [{ kind: "raw", payload: message }]);
});
