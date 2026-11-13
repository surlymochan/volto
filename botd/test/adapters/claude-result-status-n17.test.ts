// botd adapter tests: the claude `result` line (turn status + usage) and the
// `system`/`init` line (session announcement).
//
// The claude CLI closes a turn with a `{"type":"result",...}` line.  The
// adapter maps such a line to exactly one `turn_end` event whose status is
// `ok`, `error` or `cancelled`, and whose usage carries the token counts of
// the turn.  A `system` line with the subtype `init` announces the session.
//
// All values are synthetic: no real hosts, accounts, tokens or paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAdapter } from "../../src/adapters/claude.ts";
import type { NormalizedEvent } from "../../src/adapter-types.ts";

const adapter = new ClaudeAdapter();

/** One `result` line with the given members. */
function resultLine(members: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "result", ...members });
}

/** One `system` line with the given members. */
function systemLine(members: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "system", ...members });
}

/** The single `turn_end` event of a provider line. */
function turnEnd(line: string): Extract<NormalizedEvent, { kind: "turn_end" }> {
  const events = adapter.parse(line);
  assert.equal(events.length, 1, `expected exactly one event for ${line}`);
  const event = events[0];
  assert.equal(event?.kind, "turn_end", `expected a turn_end event for ${line}`);
  if (!event || event.kind !== "turn_end") throw new Error("expected a turn_end event");
  return event;
}

/* ------------------------------------------------------------ result: status */

test("a result line without a status member ends the turn as ok", () => {
  assert.deepEqual(turnEnd(resultLine()), { kind: "turn_end", status: "ok" });
});

test("a result line with is_error true ends the turn as error", () => {
  const event = turnEnd(resultLine({ subtype: "success", is_error: true }));
  assert.equal(event.status, "error");
});

test("a result subtype that starts with error ends the turn as error", () => {
  assert.equal(turnEnd(resultLine({ subtype: "error_max_turns" })).status, "error");
  assert.equal(turnEnd(resultLine({ subtype: "error_during_execution" })).status, "error");
});

test("the result subtype cancelled ends the turn as cancelled", () => {
  assert.equal(turnEnd(resultLine({ subtype: "cancelled" })).status, "cancelled");
});

test("the result subtype interrupted ends the turn as cancelled", () => {
  assert.equal(turnEnd(resultLine({ subtype: "interrupted" })).status, "cancelled");
});

test("a result line with the status cancelled ends the turn as cancelled", () => {
  assert.equal(turnEnd(resultLine({ subtype: "success", status: "cancelled" })).status, "cancelled");
});

test("a result line with interrupted true ends the turn as cancelled", () => {
  assert.equal(turnEnd(resultLine({ subtype: "success", interrupted: true })).status, "cancelled");
});

test("an error result wins over a cancelled one", () => {
  // is_error plus a cancelled subtype
  assert.equal(
    turnEnd(resultLine({ subtype: "cancelled", is_error: true })).status,
    "error",
  );
  // an error subtype plus a cancelled status and flag
  assert.equal(
    turnEnd(resultLine({ subtype: "error_max_turns", status: "cancelled", interrupted: true }))
      .status,
    "error",
  );
});

/* ------------------------------------------------------------- result: usage */

test("the usage of a result becomes inputTokens and outputTokens", () => {
  const event = turnEnd(resultLine({ usage: { input_tokens: 20, output_tokens: 8 } }));
  assert.deepEqual(event, {
    kind: "turn_end",
    status: "ok",
    usage: { inputTokens: 20, outputTokens: 8 },
  });
});

test("a usage with only input_tokens keeps the output key absent", () => {
  const event = turnEnd(resultLine({ usage: { input_tokens: 20 } }));
  assert.deepEqual(event, {
    kind: "turn_end",
    status: "ok",
    usage: { inputTokens: 20 },
  });
  assert.equal("outputTokens" in (event.usage ?? {}), false);
});

test("a usage with only output_tokens keeps the input key absent", () => {
  const event = turnEnd(resultLine({ usage: { output_tokens: 8 } }));
  assert.deepEqual(event, {
    kind: "turn_end",
    status: "ok",
    usage: { outputTokens: 8 },
  });
  assert.equal("inputTokens" in (event.usage ?? {}), false);
});

test("a usage with a non finite token count is dropped", () => {
  // JSON has no NaN/Infinity literal: an overflowing number literal is the
  // wire shape of a non finite count.
  const line = '{"type":"result","usage":{"input_tokens":1e999,"output_tokens":1e999}}';
  const event = turnEnd(line);
  assert.deepEqual(event, { kind: "turn_end", status: "ok" });
  assert.equal("usage" in event, false);
});

test("a usage with a string token count is dropped", () => {
  const event = turnEnd(resultLine({ usage: { input_tokens: "20", output_tokens: "8" } }));
  assert.deepEqual(event, { kind: "turn_end", status: "ok" });
  assert.equal("usage" in event, false);
});

test("a usage with one invalid count drops the invalid one and keeps the valid one", () => {
  const event = turnEnd(resultLine({ usage: { input_tokens: "20", output_tokens: 8 } }));
  assert.deepEqual(event, {
    kind: "turn_end",
    status: "ok",
    usage: { outputTokens: 8 },
  });
});

test("a usage that is not an object is ignored", () => {
  for (const usage of ["20", 20, true, null, [1, 2]]) {
    const event = turnEnd(resultLine({ usage }));
    assert.deepEqual(event, { kind: "turn_end", status: "ok" }, `usage ${JSON.stringify(usage)}`);
    assert.equal("usage" in event, false);
  }
});

/* ---------------------------------------------------------------- system/init */

test("a system init line with a session id announces the session", () => {
  assert.deepEqual(adapter.parse(systemLine({ subtype: "init", session_id: "session-n17-0001" })), [
    { kind: "ready", providerSessionId: "session-n17-0001" },
  ]);
});

test("a system init line without a session id announces a plain ready", () => {
  assert.deepEqual(adapter.parse(systemLine({ subtype: "init" })), [{ kind: "ready" }]);
  assert.deepEqual(adapter.parse(systemLine({ subtype: "init", session_id: "" })), [
    { kind: "ready" },
  ]);
});

test("a system line with another subtype stays raw", () => {
  const payload = { type: "system", subtype: "compact_boundary" };
  const events = adapter.parse(JSON.stringify(payload));
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event?.kind, "raw");
  if (!event || event.kind !== "raw") throw new Error("expected a raw event");
  assert.deepEqual(event.payload, payload);
});
