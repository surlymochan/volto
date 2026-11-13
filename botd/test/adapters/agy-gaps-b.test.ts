import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgyAdapter } from "../../src/adapters/agy.ts";

function parser() {
  const adapter = createAgyAdapter({ protocol: "stream-json", env: {} });
  return (line: unknown) => adapter.parse(JSON.stringify(line));
}

test("stream-json maps mixed assistant blocks and streamed tool starts", () => {
  const parse = parser();
  assert.deepEqual(parse({ type: "assistant", message: { content: [
    null, "ignored", { type: "text", text: "hello" },
    { type: "tool_use", name: "", input: "x".repeat(300) },
    { type: "tool_use" }, { type: "image" },
  ] } }), [
    { kind: "text", delta: "hello" },
    { kind: "tool", name: "tool", status: "start", summary: `${"x".repeat(240)}...` },
    { kind: "tool", name: "tool", status: "start" },
  ]);
  assert.deepEqual(parse({ type: "stream_event", event: {
    type: "content_block_start", content_block: { type: "tool_use", name: "" },
  } }), [{ kind: "tool", name: "tool", status: "start" }]);
  assert.deepEqual(parse({ type: "stream_event", event: {
    type: "content_block_start", content_block: { type: "tool_use", name: "search" },
  } }), [{ kind: "tool", name: "search", status: "start" }]);
});

test("stream-json preserves unmapped or malformed events as raw", () => {
  const parse = parser();
  for (const line of [
    { type: "system", sessionId: "" },
    { type: "assistant", message: { content: [null, { type: "text", text: 1 }] } },
    { type: "stream_event", event: { type: "content_block_start", content_block: null } },
    { type: "stream_event", event: null },
    { type: "text", text: "" },
    { type: "new_event" },
  ]) assert.deepEqual(parse(line), [{ kind: "raw", payload: line }]);
  assert.deepEqual(parse({ type: "system", sessionId: "session-2" }), [
    { kind: "ready", providerSessionId: "session-2" },
  ]);
});

test("result text is emitted once per turn and state resets after completion", () => {
  const parse = parser();
  assert.deepEqual(parse({ type: "text", text: "partial" }), [{ kind: "text", delta: "partial" }]);
  assert.deepEqual(parse({ type: "result", result: "partial" }), [{ kind: "turn_end", status: "ok" }]);
  assert.deepEqual(parse({ type: "result", result: "next answer" }), [
    { kind: "text", delta: "next answer" }, { kind: "turn_end", status: "ok" },
  ]);
  assert.deepEqual(parse({ type: "stream_event", event: { delta: { text: "chunk" } } }), [
    { kind: "text", delta: "chunk" },
  ]);
  assert.deepEqual(parse({ type: "result", result: "chunk", subtype: "INTERRUPTED" }), [
    { kind: "turn_end", status: "cancelled" },
  ]);
  assert.deepEqual(parse({ type: "result", result: "after cancellation" }), [
    { kind: "text", delta: "after cancellation" }, { kind: "turn_end", status: "ok" },
  ]);
});

test("result status and usage handle alternate fields and invalid numbers", () => {
  const parse = parser();
  assert.deepEqual(parse({ type: "result", subtype: "failure", usage: {
    input_tokens: "bad", inputTokens: 0, output_tokens: null, outputTokens: 9,
  } }), [{ kind: "turn_end", status: "error", usage: { inputTokens: 0, outputTokens: 9 } }]);
  assert.deepEqual(parse({ type: "result", subtype: "cancelled", is_error: true, usage: {
    input_tokens: 4, inputTokens: 8, output_tokens: "bad",
  } }), [{ kind: "turn_end", status: "error", usage: { inputTokens: 4 } }]);
  assert.deepEqual(parse({ type: "result", subtype: "provider_error", usage: {} }), [
    { kind: "turn_end", status: "error" },
  ]);
  assert.deepEqual(parse({ type: "result", usage: "invalid" }), [{ kind: "turn_end", status: "ok" }]);
});

test("error lines map strings, messages, and structured payloads", () => {
  const parse = parser();
  assert.deepEqual(parse({ type: "error", error: "offline" }), [{ kind: "error", message: "offline" }]);
  assert.deepEqual(parse({ type: "error", error: { message: "denied" } }), [{ kind: "error", message: "denied" }]);
  assert.deepEqual(parse({ type: "error", error: { code: 429 } }), [{ kind: "error", message: '{"code":429}' }]);
  assert.deepEqual(parse({ type: "error", message: "outer" }), [{ kind: "error", message: "outer" }]);
});
