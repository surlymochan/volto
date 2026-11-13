import { test } from "node:test";
import assert from "node:assert/strict";

import { CodexAdapter } from "../../src/adapters/codex.ts";

function completed(turn: Record<string, unknown>): string {
  return JSON.stringify({ method: "turn/completed", params: { turn } });
}

function usage(turnId: string, last: Record<string, unknown>): string {
  return JSON.stringify({ method: "thread/tokenUsage/updated", params: { turnId, tokenUsage: { last } } });
}

test("an unknown turn status ends in error", () => {
  assert.deepEqual(new CodexAdapter().parse(completed({ id: "turn-a", status: "pending" })), [
    { kind: "turn_end", status: "error", usage: undefined },
  ]);
});

test("a missing turn status ends in error", () => {
  assert.deepEqual(new CodexAdapter().parse(completed({ id: "turn-a" })), [
    { kind: "turn_end", status: "error", usage: undefined },
  ]);
});

test("a failed turn without an error message only ends the turn", () => {
  assert.deepEqual(new CodexAdapter().parse(completed({ id: "turn-a", status: "failed", error: {} })), [
    { kind: "turn_end", status: "error", usage: undefined },
  ]);
});

test("an empty failed-turn message does not emit an error event", () => {
  assert.deepEqual(new CodexAdapter().parse(completed({ id: "turn-a", status: "failed", error: { message: "" } })), [
    { kind: "turn_end", status: "error", usage: undefined },
  ]);
});

test("turn usage is consumed after completion", () => {
  const adapter = new CodexAdapter();
  adapter.parse(usage("turn-a", { inputTokens: 8, outputTokens: 2 }));
  const line = completed({ id: "turn-a", status: "completed" });
  assert.deepEqual(adapter.parse(line), [
    { kind: "turn_end", status: "ok", usage: { inputTokens: 8, outputTokens: 2 } },
  ]);
  assert.deepEqual(adapter.parse(line), [{ kind: "turn_end", status: "ok", usage: undefined }]);
});

test("input-only usage does not add outputTokens", () => {
  const adapter = new CodexAdapter();
  adapter.parse(usage("turn-a", { inputTokens: 8 }));
  assert.deepEqual(adapter.parse(completed({ id: "turn-a", status: "completed" })), [
    { kind: "turn_end", status: "ok", usage: { inputTokens: 8 } },
  ]);
});

test("non-finite usage numbers are dropped", () => {
  const adapter = new CodexAdapter();
  adapter.parse('{"method":"thread/tokenUsage/updated","params":{"turnId":"turn-a","tokenUsage":{"last":{"inputTokens":1e400,"outputTokens":-1e400}}}}');
  assert.deepEqual(adapter.parse(completed({ id: "turn-a", status: "completed" })), [
    { kind: "turn_end", status: "ok", usage: {} },
  ]);
});

test("usage remains isolated by turn id", () => {
  const adapter = new CodexAdapter();
  adapter.parse(usage("turn-a", { inputTokens: 8 }));
  adapter.parse(usage("turn-b", { outputTokens: 2 }));
  assert.deepEqual(adapter.parse(completed({ id: "turn-b", status: "completed" })), [
    { kind: "turn_end", status: "ok", usage: { outputTokens: 2 } },
  ]);
  assert.deepEqual(adapter.parse(completed({ id: "turn-a", status: "completed" })), [
    { kind: "turn_end", status: "ok", usage: { inputTokens: 8 } },
  ]);
});

test("an error notification without a message uses the fallback", () => {
  assert.deepEqual(new CodexAdapter().parse('{"method":"error","params":{"error":{}}}'), [
    { kind: "error", message: "codex error" },
  ]);
});

test("an error notification with a non-string message uses the fallback", () => {
  assert.deepEqual(new CodexAdapter().parse('{"method":"error","params":{"error":{"message":7}}}'), [
    { kind: "error", message: "codex error" },
  ]);
});

test("an error response with a non-string message uses the fallback", () => {
  assert.deepEqual(new CodexAdapter().parse('{"id":1,"error":{"message":7}}'), [
    { kind: "error", message: "codex request failed" },
  ]);
});

test("unparseable input is returned as trimmed text", () => {
  assert.deepEqual(new CodexAdapter().parse("  synthetic text \n"), [
    { kind: "raw", payload: "synthetic text" },
  ]);
});

test("JSON arrays are returned as raw parsed values", () => {
  assert.deepEqual(new CodexAdapter().parse('[1,"synthetic"]'), [
    { kind: "raw", payload: [1, "synthetic"] },
  ]);
});

test("JSON numbers are returned as raw parsed values", () => {
  assert.deepEqual(new CodexAdapter().parse("42"), [{ kind: "raw", payload: 42 }]);
});
