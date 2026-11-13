import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAdapter } from "../../src/adapters/claude.ts";

function assistant(content: unknown): string {
  return JSON.stringify({ type: "assistant", message: { content } });
}

function result(content: unknown): string {
  return JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "unknown", content }] },
  });
}

test("tool input longer than 240 characters is truncated", () => {
  const input = "x".repeat(241);
  assert.deepEqual(new ClaudeAdapter().parse(assistant([{ type: "tool_use", name: "sample", input }])), [
    { kind: "tool", name: "sample", status: "start", summary: `${"x".repeat(240)}…` },
  ]);
});

test("tool input of exactly 240 characters is unchanged", () => {
  const input = "x".repeat(240);
  assert.deepEqual(new ClaudeAdapter().parse(assistant([{ type: "tool_use", name: "sample", input }])), [
    { kind: "tool", name: "sample", status: "start", summary: input },
  ]);
});

test("missing tool input has no summary", () => {
  assert.deepEqual(new ClaudeAdapter().parse(assistant([{ type: "tool_use", name: "sample" }])), [
    { kind: "tool", name: "sample", status: "start" },
  ]);
});

test("null tool input has no summary", () => {
  assert.deepEqual(new ClaudeAdapter().parse(assistant([{ type: "tool_use", name: "sample", input: null }])), [
    { kind: "tool", name: "sample", status: "start" },
  ]);
});

test("circular tool input has no summary", () => {
  const input: Record<string, unknown> = {};
  input.self = input;
  const adapter = new ClaudeAdapter() as unknown as {
    assistantEvents(payload: unknown): unknown;
  };
  assert.deepEqual(adapter.assistantEvents({ message: { content: [
    { type: "tool_use", name: "sample", input },
  ] } }), [{ kind: "tool", name: "sample", status: "start" }]);
});

test("tool result combines text blocks and strings, ignoring non-text blocks", () => {
  const content = [{ type: "text", text: "first" }, " middle ", { type: "image" }, { type: "text", text: "last" }];
  assert.deepEqual(new ClaudeAdapter().parse(result(content)), [
    { kind: "tool", name: "tool", status: "end", summary: "first middle last" },
  ]);
});

test("tool result serializes object content", () => {
  assert.deepEqual(new ClaudeAdapter().parse(result({ value: 42 })), [
    { kind: "tool", name: "tool", status: "end", summary: '{"value":42}' },
  ]);
});

test("empty tool result has no summary", () => {
  assert.deepEqual(new ClaudeAdapter().parse(result("")), [
    { kind: "tool", name: "tool", status: "end" },
  ]);
});

test("assistant string content produces a text event", () => {
  assert.deepEqual(new ClaudeAdapter().parse(assistant("hello")), [{ kind: "text", delta: "hello" }]);
});

test("empty assistant string content falls back to raw", () => {
  const payload = { type: "assistant", message: { content: "" } };
  assert.deepEqual(new ClaudeAdapter().parse(JSON.stringify(payload)), [{ kind: "raw", payload }]);
});

test("non-text stream deltas fall back to raw", () => {
  const payload = { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } } };
  assert.deepEqual(new ClaudeAdapter().parse(JSON.stringify(payload)), [{ kind: "raw", payload }]);
});

test("assistant text blocks retain their order", () => {
  assert.deepEqual(new ClaudeAdapter().parse(assistant([
    { type: "text", text: "first" }, { type: "text", text: "second" },
  ])), [{ kind: "text", delta: "first" }, { kind: "text", delta: "second" }]);
});
