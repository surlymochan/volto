import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgyAdapter } from "../../src/adapters/agy.ts";

function update(fields: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "tool_call_update", ...fields } },
  });
}

for (const [reason, status] of [
  ["max_tokens", "ok"],
  ["max_turn_requests", "error"],
  ["refusal", "error"],
  ["unrecognized_reason", "ok"],
] as const) {
  test(`parse: stop reason ${reason} maps to ${status}`, () => {
    const adapter = createAgyAdapter({ protocol: "acp" });
    const line = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: reason } });
    assert.deepEqual(adapter.parse(line), [{ kind: "turn_end", status }]);
  });
}

for (const [input, status] of [
  ["cancelled", "end"],
  ["pending", "start"],
  ["in_progress", "start"],
  ["unrecognized_status", "start"],
] as const) {
  test(`parse: tool update status ${input} maps to ${status}`, () => {
    const adapter = createAgyAdapter({ protocol: "acp" });
    assert.deepEqual(adapter.parse(update({ title: "Synthetic tool", status: input })), [
      { kind: "tool", name: "Synthetic tool", status },
    ]);
  });
}

test("parse: tool update without status starts the tool", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });
  assert.deepEqual(adapter.parse(update({ title: "Synthetic tool" })), [
    { kind: "tool", name: "Synthetic tool", status: "start" },
  ]);
});

test("parse: an update title takes precedence over the remembered title", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });
  adapter.parse(JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "tool_call", toolCallId: "call-a", title: "First" } },
  }));
  assert.deepEqual(adapter.parse(update({ toolCallId: "call-a", title: "Second", status: "pending" })), [
    { kind: "tool", name: "Second", status: "start" },
  ]);
});

test("parse: an empty update title falls back to the matching remembered title", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });
  for (const [id, title] of [["call-a", "First"], ["call-b", "Second"]]) {
    adapter.parse(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "tool_call", toolCallId: id, title } },
    }));
  }
  assert.deepEqual(adapter.parse(update({ toolCallId: "call-a", title: "", status: "pending" })), [
    { kind: "tool", name: "First", status: "start" },
  ]);
});

test("parse: an unknown tool id and empty title use the default name", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });
  assert.deepEqual(adapter.parse(update({ toolCallId: "unknown", title: "", status: "pending" })), [
    { kind: "tool", name: "tool", status: "start" },
  ]);
});
