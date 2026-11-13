// Edge cases of the two pure helpers of botd/src/session.ts:
// parseOutputLine (a raw stdout line becomes an event payload) and
// defaultCancelMessage (the cancel message of a bot flavour).
//
// The basics live in session.test.ts (a json object, a plain text line and
// the cancel message of the three known kinds); what is left is covered
// here: blank lines, truncated json, json values that are not objects, a
// utf-8 byte order mark, CRLF endings, a very long line, a deeply nested
// line, an unknown event type and the corners of the cancel message.
//
// The payloads are synthetic: no host name, address or credential shows up
// in this file. The tests do no I/O, use no timer and spawn no child.
//
// Known defect (recorded as a todo below, the sources are not touched):
//   - parseOutputLine does not strip a utf-8 byte order mark, so a raw
//     stdout line that starts with one is not parsed.

import test from "node:test";
import assert from "node:assert/strict";

import { defaultCancelMessage, parseOutputLine } from "../src/session.ts";
import type { BotKind } from "../src/protocol.ts";

/** The json rpc envelope of a cancel message. */
type CancelMessage = { jsonrpc: string; method: string; params: Record<string, unknown> };

/** The cancel message of a kind, typed for the assertions. */
function cancelMessage(kind: BotKind, providerSessionId?: string): CancelMessage {
  return defaultCancelMessage(kind, providerSessionId) as CancelMessage;
}

// ---------------------------------------------------------------------------
// parseOutputLine: the lines that are not json.
// ---------------------------------------------------------------------------

test("a blank line becomes an empty payload", () => {
  assert.equal(parseOutputLine(""), "", "an empty line stays empty");
  assert.equal(parseOutputLine(" "), " ", "a line of spaces is kept as it is");
  assert.equal(parseOutputLine("\t"), "\t", "a line of tabs is kept as it is");
});

test("a line that is not json is kept as raw text", () => {
  for (const line of [
    "Error: the bot gave up",
    "NaN",
    "undefined",
    "{not json}",
    "key: value",
    "2026-11-13T09:00:00Z ready",
  ]) {
    assert.equal(parseOutputLine(line), line, `the line ${JSON.stringify(line)} is kept`);
  }
});

test("a truncated json line is kept as raw text", () => {
  const truncated = '{"jsonrpc":"2.0","method":"session/update"';
  assert.equal(parseOutputLine(truncated), truncated, "the half line is kept");
  assert.equal(parseOutputLine('{"a":1'), '{"a":1');
  assert.equal(parseOutputLine("[1,2"), "[1,2");
  assert.equal(parseOutputLine('{"a":1} trailing'), '{"a":1} trailing');
});

test("a json value that is not an object is parsed anyway", () => {
  assert.equal(parseOutputLine("42"), 42);
  assert.equal(parseOutputLine("-12.5"), -12.5);
  assert.deepEqual(parseOutputLine("[1,2,3]"), [1, 2, 3]);
  assert.equal(parseOutputLine('"a plain json string"'), "a plain json string");
  assert.equal(parseOutputLine("true"), true);
  assert.equal(parseOutputLine("false"), false);
  assert.equal(parseOutputLine("null"), null);
});

// ---------------------------------------------------------------------------
// parseOutputLine: the json lines.
// ---------------------------------------------------------------------------

test("every json type is recognised as a payload", () => {
  const values: unknown[] = [
    { jsonrpc: "2.0", id: 1, result: { ok: true } },
    [1, "two", null],
    "just a string",
    -12.5,
    false,
    null,
  ];
  for (const value of values) {
    const line = JSON.stringify(value);
    assert.deepEqual(parseOutputLine(line), value, `the line ${line} is parsed`);
  }
});

test("an event with an unknown type is passed through unchanged", () => {
  const event = { type: "totally.unknown", payload: { id: 3 } };
  assert.deepEqual(
    parseOutputLine(JSON.stringify(event)),
    event,
    "an event botd does not know is not dropped and not rewritten",
  );

  const rpc = { jsonrpc: "2.0", id: 7, method: "unknown/method", params: {} };
  assert.deepEqual(parseOutputLine(JSON.stringify(rpc)), rpc);

  // The fields botd does not know stay in the payload.
  const extra = { jsonrpc: "2.0", id: 8, method: "known/method", unknownField: [1, 2] };
  assert.deepEqual(parseOutputLine(JSON.stringify(extra)), extra);
});

test("a line with CRLF endings is parsed", () => {
  assert.deepEqual(parseOutputLine('{"a":1}\r\n'), { a: 1 }, "the carriage return is no json");
  assert.deepEqual(parseOutputLine('{"a":1}\r'), { a: 1 });
  assert.deepEqual(parseOutputLine('{"a":1}\n'), { a: 1 });
});

test("a very long line is parsed without a limit", () => {
  const text = "x".repeat(200_000);
  const line = JSON.stringify({ type: "chunk", text });
  assert.deepEqual(
    parseOutputLine(line),
    { type: "chunk", text },
    "a long json line is parsed as a whole",
  );

  const raw = text.repeat(2);
  assert.equal(parseOutputLine(raw), raw, "a long line that is not json is kept whole");
});

test("a deeply nested json line is parsed without throwing", () => {
  const depth = 5000;
  const line = "[".repeat(depth) + "]".repeat(depth);
  const parsed = parseOutputLine(line);
  assert.ok(Array.isArray(parsed), "the deep array is parsed and not kept as raw text");
  assert.equal((parsed as unknown[]).length, 1);
});

// ---------------------------------------------------------------------------
// parseOutputLine: the known defect (the sources are not touched here).
// ---------------------------------------------------------------------------

test("a line that starts with a byte order mark is parsed", {
  todo: "parseOutputLine does not strip the utf-8 byte order mark, so the line stays raw text",
}, () => {
  // The session trims every line before it calls parseOutputLine and the
  // trim removes the byte order mark, so the daemon is not affected today;
  // the exported helper takes a raw stdout line and does not.
  assert.deepEqual(parseOutputLine('\uFEFF{"a":1}'), { a: 1 });
});

// ---------------------------------------------------------------------------
// defaultCancelMessage.
// ---------------------------------------------------------------------------

test("the cancel message of every known kind carries the json rpc envelope", () => {
  for (const kind of ["acp", "codex-app-server", "pi-rpc"] as const) {
    const message = cancelMessage(kind);
    assert.equal(message.jsonrpc, "2.0", `the ${kind} message is a json rpc request`);
    assert.equal(typeof message.method, "string");
    assert.ok(message.method.length > 0, `the ${kind} message names a method`);
    assert.equal(typeof message.params, "object");
    assert.deepEqual(
      JSON.parse(JSON.stringify(message)),
      message,
      `the ${kind} message survives a json round trip`,
    );
  }
});

test("only the acp flavour carries the provider session id", () => {
  assert.deepEqual(cancelMessage("acp", "provider-42"), {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: "provider-42" },
  });

  // The other flavours do not know a provider session.
  assert.deepEqual(cancelMessage("codex-app-server", "provider-42"), {
    jsonrpc: "2.0",
    method: "turn/interrupt",
    params: {},
  });
  assert.deepEqual(cancelMessage("pi-rpc", "provider-42"), {
    jsonrpc: "2.0",
    method: "abort",
    params: {},
  });
});

test("an empty provider session id is left out of the acp cancel message", () => {
  assert.deepEqual(cancelMessage("acp", ""), {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: {},
  });
});

test("an unknown kind falls back to the plain abort message", () => {
  const kind = "not-a-bot-kind" as BotKind;
  assert.deepEqual(cancelMessage(kind), {
    jsonrpc: "2.0",
    method: "abort",
    params: {},
  });
});

test("every call returns a fresh cancel message", () => {
  const first = cancelMessage("acp");
  first.params.sessionId = "mutated";
  first.method = "mutated";

  assert.deepEqual(cancelMessage("acp"), {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: {},
  });
});
