// botd/test/adapters/copilot.test.ts
//
// Tests for the GitHub Copilot CLI adapter.
//
// `copilot --acp` speaks the Agent Client Protocol (ACP) over stdio:
// newline delimited JSON-RPC 2.0.  The sample lines below follow the
// message shapes documented by the public ACP spec (initialize,
// session/new, session/prompt, session/update, session/cancel,
// session/request_permission).
//
// The tests never spawn the CLI: Copilot needs a paid seat, so the whole
// suite works on synthetic lines only.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COPILOT_COMMAND,
  COPILOT_ENABLED_ENV,
  CopilotAdapter,
  assertCopilotEnabled,
  copilotUnavailableReason,
  enabled,
} from "../../src/adapters/copilot.ts";

// --- synthetic ACP lines -----------------------------------------------------

const INITIALIZE_RESPONSE = JSON.stringify({
  jsonrpc: "2.0",
  id: 0,
  result: {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: true },
    },
    authMethods: [],
  },
});

const SESSION_NEW_RESPONSE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { sessionId: "sess_synthetic_0001" },
});

const AGENT_MESSAGE_CHUNK = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "sess_synthetic_0001",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "PONG" },
    },
  },
});

const AGENT_THOUGHT_CHUNK = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "sess_synthetic_0001",
    update: {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking about the answer" },
    },
  },
});

const EMPTY_MESSAGE_CHUNK = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "sess_synthetic_0001",
    update: { sessionUpdate: "agent_message_chunk" },
  },
});

const TOOL_CALL = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "sess_synthetic_0001",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "call_synthetic_0001",
      title: "List files",
      kind: "execute",
      status: "pending",
      rawInput: { command: "ls" },
    },
  },
});

const TOOL_CALL_COMPLETED = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "sess_synthetic_0001",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_synthetic_0001",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "README.md" } }],
    },
  },
});

const TOOL_CALL_FAILED = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "sess_synthetic_0001",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_synthetic_0001",
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "permission denied" } }],
    },
  },
});

const PERMISSION_REQUEST = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "session/request_permission",
  params: {
    sessionId: "sess_synthetic_0001",
    toolCall: {
      toolCallId: "call_synthetic_0003",
      title: "Run command",
      kind: "execute",
    },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  },
});

const PROMPT_RESPONSE_END = JSON.stringify({
  jsonrpc: "2.0",
  id: 3,
  result: { stopReason: "end_turn" },
});

const PROMPT_RESPONSE_CANCELLED = JSON.stringify({
  jsonrpc: "2.0",
  id: 4,
  result: { stopReason: "cancelled" },
});

const PROMPT_RESPONSE_REFUSED = JSON.stringify({
  jsonrpc: "2.0",
  id: 5,
  result: { stopReason: "refusal" },
});

const PROMPT_RESPONSE_WITH_USAGE = JSON.stringify({
  jsonrpc: "2.0",
  id: 6,
  result: { stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 3 } },
});

const ERROR_RESPONSE = JSON.stringify({
  jsonrpc: "2.0",
  id: 7,
  error: { code: -32603, message: "internal error" },
});

const UNKNOWN_NOTIFICATION = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/set_mode",
  params: { sessionId: "sess_synthetic_0001", modeId: "default" },
});

function adapterWithSession(): CopilotAdapter {
  const adapter = new CopilotAdapter();
  adapter.parse(INITIALIZE_RESPONSE);
  adapter.parse(SESSION_NEW_RESPONSE);
  return adapter;
}

// --- availability ------------------------------------------------------------

test("the adapter ships disabled", () => {
  assert.equal(enabled, false);
  assert.deepEqual([...COPILOT_COMMAND], ["copilot", "--acp"]);
});

test("the adapter refuses to run without an explicit opt-in", () => {
  const reason = copilotUnavailableReason({});
  assert.ok(reason);
  assert.match(reason, new RegExp(COPILOT_ENABLED_ENV));
  assert.throws(() => assertCopilotEnabled({}), /copilot/i);
});

test("an explicit opt-in enables the adapter", () => {
  assert.equal(copilotUnavailableReason({ [COPILOT_ENABLED_ENV]: "1" }), undefined);
  assert.doesNotThrow(() => assertCopilotEnabled({ [COPILOT_ENABLED_ENV]: "1" }));
  // Anything but "1" keeps the adapter off.
  assert.ok(copilotUnavailableReason({ [COPILOT_ENABLED_ENV]: "0" }));
  assert.ok(copilotUnavailableReason({ [COPILOT_ENABLED_ENV]: "true" }));
});

// --- prompt / cancel ---------------------------------------------------------

test("prompt() wraps the text in an ACP session/prompt request", () => {
  const adapter = new CopilotAdapter();
  const message = adapter.prompt("reply PONG", {
    providerSessionId: "sess_synthetic_0001",
  }) as Record<string, unknown>;

  assert.equal(message.jsonrpc, "2.0");
  assert.equal(message.method, "session/prompt");
  assert.equal(typeof message.id, "number");
  const params = message.params as Record<string, unknown>;
  assert.equal(params.sessionId, "sess_synthetic_0001");
  assert.deepEqual(params.prompt, [{ type: "text", text: "reply PONG" }]);
  assert.doesNotThrow(() => JSON.stringify(message));
});

test("cancel() sends the provider-native session/cancel notification", () => {
  const adapter = adapterWithSession();
  const messages = adapter.cancel({ providerSessionId: "sess_synthetic_0001" });

  assert.equal(messages.length, 1);
  const message = messages[0] as Record<string, unknown>;
  assert.equal(message.jsonrpc, "2.0");
  assert.equal(message.method, "session/cancel");
  assert.equal(message.id, undefined, "session/cancel is a notification");
  const params = message.params as Record<string, unknown>;
  assert.equal(params.sessionId, "sess_synthetic_0001");
});

test("cancel() without a session id has nothing to address", () => {
  const adapter = new CopilotAdapter();
  assert.deepEqual(adapter.cancel({}), []);
});

// --- parse -------------------------------------------------------------------

test("parse() maps the initialize and session/new replies", () => {
  const adapter = new CopilotAdapter();

  assert.deepEqual(adapter.parse(INITIALIZE_RESPONSE), [{ kind: "ready" }]);

  const ready = adapter.parse(SESSION_NEW_RESPONSE);
  assert.deepEqual(ready, [
    { kind: "ready", providerSessionId: "sess_synthetic_0001" },
  ]);
  assert.equal(adapter.sessionId, "sess_synthetic_0001");
});

test("parse() maps agent_message_chunk to text deltas", () => {
  const adapter = adapterWithSession();
  assert.deepEqual(adapter.parse(AGENT_MESSAGE_CHUNK), [
    { kind: "text", delta: "PONG" },
  ]);
});

test("parse() maps tool_call and tool_call_update to tool events", () => {
  const adapter = adapterWithSession();

  assert.deepEqual(adapter.parse(TOOL_CALL), [
    { kind: "tool", name: "List files", status: "start", summary: undefined },
  ]);
  // The update carries no title: the name of the announced call is reused.
  assert.deepEqual(adapter.parse(TOOL_CALL_COMPLETED), [
    {
      kind: "tool",
      name: "List files",
      status: "end",
      summary: "README.md",
    },
  ]);
  assert.deepEqual(adapter.parse(TOOL_CALL_FAILED), [
    {
      kind: "tool",
      name: "List files",
      status: "error",
      summary: "permission denied",
    },
  ]);
});

test("parse() maps the prompt reply to turn_end", () => {
  const adapter = adapterWithSession();

  assert.deepEqual(adapter.parse(PROMPT_RESPONSE_END), [
    { kind: "turn_end", status: "ok" },
  ]);
  assert.deepEqual(adapter.parse(PROMPT_RESPONSE_CANCELLED), [
    { kind: "turn_end", status: "cancelled" },
  ]);
  assert.deepEqual(adapter.parse(PROMPT_RESPONSE_REFUSED), [
    { kind: "turn_end", status: "error" },
  ]);
  assert.deepEqual(adapter.parse(PROMPT_RESPONSE_WITH_USAGE), [
    { kind: "turn_end", status: "ok", usage: { inputTokens: 11, outputTokens: 3 } },
  ]);
});

test("parse() maps a JSON-RPC error to an error event", () => {
  const adapter = adapterWithSession();
  assert.deepEqual(adapter.parse(ERROR_RESPONSE), [
    { kind: "error", message: "internal error" },
  ]);
});

test("parse() maps a full synthetic ACP session", () => {
  const adapter = new CopilotAdapter();
  const events = [
    INITIALIZE_RESPONSE,
    SESSION_NEW_RESPONSE,
    AGENT_MESSAGE_CHUNK,
    TOOL_CALL,
    TOOL_CALL_COMPLETED,
    PROMPT_RESPONSE_END,
  ].flatMap((line) => adapter.parse(line));

  assert.deepEqual(events, [
    { kind: "ready" },
    { kind: "ready", providerSessionId: "sess_synthetic_0001" },
    { kind: "text", delta: "PONG" },
    { kind: "tool", name: "List files", status: "start", summary: undefined },
    { kind: "tool", name: "List files", status: "end", summary: "README.md" },
    { kind: "turn_end", status: "ok" },
  ]);
});

test("parse() maps unknown messages to raw", () => {
  const adapter = adapterWithSession();

  assert.deepEqual(adapter.parse(UNKNOWN_NOTIFICATION), [
    { kind: "raw", payload: JSON.parse(UNKNOWN_NOTIFICATION) },
  ]);
  assert.deepEqual(adapter.parse(AGENT_THOUGHT_CHUNK), [
    { kind: "raw", payload: JSON.parse(AGENT_THOUGHT_CHUNK) },
  ]);
  // A chunk without content is not dropped silently.
  assert.deepEqual(adapter.parse(EMPTY_MESSAGE_CHUNK), [
    { kind: "raw", payload: JSON.parse(EMPTY_MESSAGE_CHUNK) },
  ]);
});

test("parse() keeps unparsable lines as raw", () => {
  const adapter = adapterWithSession();
  assert.deepEqual(adapter.parse("copilot: something happened"), [
    { kind: "raw", payload: "copilot: something happened" },
  ]);
});

test("parse() never throws", () => {
  const adapter = adapterWithSession();
  const inputs = [
    "",
    "   ",
    "not json at all",
    "{ broken json",
    "null",
    "42",
    '"a string"',
    "[1,2,3]",
    '{"jsonrpc":"2.0"}',
    '{"jsonrpc":"2.0","id":9,"result":null}',
    '{"jsonrpc":"2.0","method":"session/update","params":{}}',
    '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk"}}}',
    '{"jsonrpc":"2.0","method":"session/request_permission"}',
    '{"jsonrpc":"2.0","id":null,"error":null}',
  ];

  for (const input of inputs) {
    assert.doesNotThrow(() => adapter.parse(input), `parse threw for: ${input}`);
    const events = adapter.parse(input);
    assert.ok(Array.isArray(events));
    for (const event of events) {
      assert.ok(typeof event.kind === "string");
    }
  }
});

// --- permissions -------------------------------------------------------------

test("parse() reports a permission request and answers it", () => {
  const adapter = adapterWithSession();

  const events = adapter.parse(PERMISSION_REQUEST);
  assert.equal(events.length, 1);
  const permission = events[0];
  assert.equal(permission.kind, "permission");
  if (permission.kind !== "permission") return;
  assert.equal(permission.id, "2");
  const request = permission.request as Record<string, unknown>;
  assert.equal(request.sessionId, "sess_synthetic_0001");

  const allow = adapter.answerPermission(permission.id, true) as Record<string, unknown>;
  assert.equal(allow.jsonrpc, "2.0");
  assert.equal(allow.id, 2);
  const allowResult = allow.result as Record<string, unknown>;
  const allowOutcome = allowResult.outcome as Record<string, unknown>;
  assert.equal(allowOutcome.outcome, "selected");
  assert.equal(allowOutcome.optionId, "allow-once");
});

test("answerPermission() can reject and is single shot", () => {
  const adapter = adapterWithSession();
  const permission = adapter.parse(PERMISSION_REQUEST)[0];
  assert.equal(permission.kind, "permission");
  if (permission.kind !== "permission") return;

  const reject = adapter.answerPermission(permission.id, false) as Record<string, unknown>;
  const rejectResult = reject.result as Record<string, unknown>;
  const rejectOutcome = rejectResult.outcome as Record<string, unknown>;
  assert.equal(rejectOutcome.outcome, "selected");
  assert.equal(rejectOutcome.optionId, "reject-once");

  // A permission can only be answered once.
  assert.equal(adapter.answerPermission(permission.id, true), null);
  // Unknown ids have nothing to answer.
  assert.equal(adapter.answerPermission("does-not-exist", true), null);
});
