// botd/test/adapters/copilot-gaps.test.ts
//
// Gap tests for the ACP handling of the GitHub Copilot CLI adapter.
//
// botd/test/adapters/copilot.test.ts walks the happy path of the adapter
// (initialize, session/new, a text chunk, a tool call, a prompt reply, an
// error reply and a permission request with the standard option kinds) and
// botd/test/adapters/acp-cancel-permission.test.ts covers the cancel of a
// pending permission.  The branches those two files leave open are covered
// here:
//
//   * the ACP methods we do not serve (fs/*, terminal/*, ...) stay raw and
//     are never answered,
//   * the permission requests with unusual shapes (a string id, options that
//     are not objects, options without an id) and the option kinds the agent
//     does not use ("Yes, allow the command" instead of "allow_once"),
//   * the session/update variants (a list of content blocks, a content block
//     without text, a tool call without a title, a tool call with a raw
//     output),
//   * the error replies that carry no message and the one that cannot be
//     turned into a string at all,
//   * the replies to our own requests that carry no payload,
//   * the prompt and the cancel of a session we learned from the agent.
//
// The Copilot CLI is never started: the adapter ships disabled (it needs a
// paid Copilot seat) and every line below is synthetic, so the suite runs
// offline.  The enable flag of the adapter (COPILOT_ENABLED) belongs to
// another card: this suite neither reads nor writes process.env, so the
// argv of the CLI (the model and the effort) is left to that card.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CopilotAdapter } from "../../src/adapters/copilot.ts";

/* ---------------------------------------------------------------- fixtures */

/** The session id the synthetic agent announces. */
const SESSION_ID = "sess_synthetic_0001";

/** A JSON-RPC message as it arrives on stdout (one line). */
function wire(message: unknown): string {
  return JSON.stringify(message);
}

/** The reply of the agent to our `initialize` request. */
const INITIALIZE_RESULT = wire({
  jsonrpc: "2.0",
  id: 0,
  result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
});

/** The reply of the agent to our `session/new` request. */
const SESSION_NEW_RESULT = wire({
  jsonrpc: "2.0",
  id: 1,
  result: { sessionId: SESSION_ID },
});

/** An adapter that already knows the session of the agent. */
function adapterWithSession(): CopilotAdapter {
  const adapter = new CopilotAdapter();
  adapter.parse(INITIALIZE_RESULT);
  adapter.parse(SESSION_NEW_RESULT);
  return adapter;
}

/** The outcome of an answer of the adapter. */
function outcomeOf(answer: unknown): { outcome: string; optionId?: string } {
  assert.ok(answer !== null && typeof answer === "object", "the answer is not an object");
  const frame = answer as { result?: { outcome?: { outcome?: unknown; optionId?: unknown } } };
  const outcome = frame.result?.outcome;
  assert.ok(outcome !== undefined, "the answer has no outcome");
  const result: { outcome: string; optionId?: string } = { outcome: String(outcome.outcome) };
  // The cancelled outcome of ACP carries no option id at all.
  if (typeof outcome.optionId === "string") result.optionId = outcome.optionId;
  return result;
}

/* --------------------------------------------------- the methods we ignore */

test("an ACP request we do not serve stays raw and is never answered", () => {
  const adapter = adapterWithSession();

  const requests = [
    // The agent asks us to read a file: we serve no fs request.
    wire({
      jsonrpc: "2.0",
      id: 21,
      method: "fs/read_text_file",
      params: { path: "/etc/hosts", sessionId: SESSION_ID },
    }),
    // The agent asks us for a terminal: we serve no terminal request.
    wire({
      jsonrpc: "2.0",
      id: 22,
      method: "terminal/create",
      params: { command: "ls", cwd: "/tmp/synthetic" },
    }),
    // The agent cancels a session on its own: it is not our notification.
    wire({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: SESSION_ID },
    }),
  ];

  for (const request of requests) {
    const events = adapter.parse(request);
    assert.deepEqual(events, [{ kind: "raw", payload: JSON.parse(request) }]);
    // Nothing is answered: the request is not ours and it never becomes a
    // permission, a text delta or a turn end.
    for (const event of events) {
      assert.equal(event.kind, "raw");
    }
  }
});

/* ------------------------------------------------ the permission requests */

test("a permission request with a string id is answered with that id", () => {
  const adapter = adapterWithSession();
  const request = wire({
    jsonrpc: "2.0",
    id: "perm-0001",
    method: "session/request_permission",
    params: {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: "call-0001", title: "Run command", kind: "execute" },
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
    },
  });

  const events = adapter.parse(request);
  assert.equal(events.length, 1);
  const permission = events[0];
  assert.equal(permission.kind, "permission");
  if (permission.kind !== "permission") return;
  assert.equal(permission.id, "perm-0001");

  const answer = adapter.answerPermission("perm-0001", true);
  assert.ok(answer !== null, "the permission was not answered");
  assert.equal((answer as { id?: unknown }).id, "perm-0001");
  assert.deepEqual(outcomeOf(answer), { outcome: "selected", optionId: "allow-once" });
});

test("permission options that cannot be used are dropped", () => {
  const adapter = adapterWithSession();
  const request = wire({
    jsonrpc: "2.0",
    id: 23,
    method: "session/request_permission",
    params: {
      sessionId: SESSION_ID,
      options: [
        "allow-once", // not an object
        null, // not an object
        { name: "Allow once", kind: "allow_once" }, // no option id
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      ],
    },
  });

  const events = adapter.parse(request);
  assert.equal(events.length, 1);
  const permission = events[0];
  assert.equal(permission.kind, "permission");
  if (permission.kind !== "permission") return;

  // The option without an id cannot be selected, the one with an id can.
  const answer = adapter.answerPermission("23", true);
  assert.deepEqual(outcomeOf(answer), { outcome: "selected", optionId: "allow-once" });
});

test("a permission the agent offered no usable option for is cancelled", () => {
  const adapter = adapterWithSession();
  const request = wire({
    jsonrpc: "2.0",
    id: 24,
    method: "session/request_permission",
    params: {
      sessionId: SESSION_ID,
      // The option has a name and a kind but no id: it cannot be answered.
      options: [{ name: "Allow once", kind: "allow_once" }],
    },
  });

  const events = adapter.parse(request);
  assert.equal(events.length, 1);
  const permission = events[0];
  assert.equal(permission.kind, "permission");
  if (permission.kind !== "permission") return;

  const answer = adapter.answerPermission("24", true);
  assert.ok(answer !== null, "the permission was not answered");
  assert.equal((answer as { id?: unknown }).id, 24);
  // The agent offered no option the policy could pick: the request is
  // answered with the cancelled outcome of ACP, never with an allow.
  assert.deepEqual(outcomeOf(answer), { outcome: "cancelled" });
});

test("an option with a custom kind is matched by its wording", () => {
  // The agent does not use the kinds of the ACP spec, it only names its
  // options: the wording decides.
  const allowing = adapterWithSession();
  allowing.parse(
    wire({
      jsonrpc: "2.0",
      id: 25,
      method: "session/request_permission",
      params: {
        sessionId: SESSION_ID,
        options: [{ optionId: "opt-yes", name: "Yes, allow the command", kind: "custom" }],
      },
    }),
  );
  const allow = allowing.answerPermission("25", true);
  assert.deepEqual(outcomeOf(allow), { outcome: "selected", optionId: "opt-yes" });

  const rejecting = adapterWithSession();
  rejecting.parse(
    wire({
      jsonrpc: "2.0",
      id: 26,
      method: "session/request_permission",
      params: {
        sessionId: SESSION_ID,
        options: [{ optionId: "opt-no", name: "No, do not run it", kind: "custom" }],
      },
    }),
  );
  const reject = rejecting.answerPermission("26", false);
  assert.deepEqual(outcomeOf(reject), { outcome: "selected", optionId: "opt-no" });
});

/* ----------------------------------------------------- the update variants */

test("a chunk with a list of content blocks is joined", () => {
  const adapter = adapterWithSession();
  const line = wire({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    },
  });

  assert.deepEqual(adapter.parse(line), [{ kind: "text", delta: "first\nsecond" }]);
});

test("a chunk with a content block without text stays raw", () => {
  const adapter = adapterWithSession();
  const line = wire({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: "agent_message_chunk",
        // An image block carries no text: nothing is answered, but the line
        // is not dropped either.
        content: { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      },
    },
  });

  assert.deepEqual(adapter.parse(line), [{ kind: "raw", payload: JSON.parse(line) }]);
});

test("a tool call without a title falls back to its kind", () => {
  const adapter = adapterWithSession();
  const line = wire({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-0002",
        kind: "edit",
        status: "in_progress",
      },
    },
  });

  assert.deepEqual(adapter.parse(line), [
    { kind: "tool", name: "edit", status: "start", summary: undefined },
  ]);
});

test("a tool call without a title, a kind and an id is called tool", () => {
  const adapter = adapterWithSession();
  const line = wire({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: SESSION_ID,
      update: { sessionUpdate: "tool_call", status: "pending" },
    },
  });

  assert.deepEqual(adapter.parse(line), [
    { kind: "tool", name: "tool", status: "start", summary: undefined },
  ]);
});

test("a tool call update without a title keeps the id of the call", () => {
  const adapter = adapterWithSession();
  const line = wire({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-0003",
        status: "completed",
        rawOutput: { output: "done" },
      },
    },
  });

  assert.deepEqual(adapter.parse(line), [
    { kind: "tool", name: "call-0003", status: "end", summary: "done" },
  ]);
});

/* --------------------------------------------------------- the error replies */

test("an error reply without a message is reported with its text", () => {
  const adapter = adapterWithSession();

  assert.deepEqual(adapter.parse(wire({ jsonrpc: "2.0", id: 30, error: "the agent crashed" })), [
    { kind: "error", message: "the agent crashed" },
  ]);
  assert.deepEqual(adapter.parse(wire({ jsonrpc: "2.0", id: 31, error: { code: -32603 } })), [
    { kind: "error", message: "[object Object]" },
  ]);
  assert.deepEqual(adapter.parse(wire({ jsonrpc: "2.0", id: 32, error: 42 })), [
    { kind: "error", message: "42" },
  ]);
});

test("an error reply that cannot be turned into a string stays raw", () => {
  const adapter = adapterWithSession();
  // The error object has no usable toString: the adapter may not throw, so
  // the line is kept verbatim instead of being answered.
  const line = wire({ jsonrpc: "2.0", id: 33, error: { toString: {} } });

  const events = adapter.parse(line);
  assert.deepEqual(events, [{ kind: "raw", payload: line }]);
});

/* -------------------------------------------------- the replies to our own */

test("a reply to our session/new without a session id still reports the agent as ready", () => {
  const adapter = new CopilotAdapter();
  const handshake = adapter.handshake({ cwd: "/tmp/synthetic" });
  assert.equal(handshake.length, 2);
  const session = handshake[1] as Record<string, unknown>;
  assert.equal(session.method, "session/new");

  const events = adapter.parse(wire({ jsonrpc: "2.0", id: session.id, result: {} }));
  assert.deepEqual(events, [{ kind: "ready" }]);
  // The agent announced no session id: none is invented.
  assert.equal(adapter.sessionId, undefined);
});

test("a reply to our initialize without a protocol version reports the agent", () => {
  const adapter = new CopilotAdapter();
  const handshake = adapter.handshake({ cwd: "/tmp/synthetic" });
  const initialize = handshake[0] as Record<string, unknown>;
  assert.equal(initialize.method, "initialize");

  const events = adapter.parse(wire({ jsonrpc: "2.0", id: initialize.id, result: {} }));
  assert.deepEqual(events, [{ kind: "ready" }]);
});

test("a reply to our prompt without a stop reason ends the turn", () => {
  const adapter = adapterWithSession();
  const prompt = adapter.prompt("hello", { providerSessionId: SESSION_ID }) as Record<string, unknown>;

  const events = adapter.parse(wire({ jsonrpc: "2.0", id: prompt.id, result: {} }));
  assert.deepEqual(events, [{ kind: "turn_end", status: "ok" }]);
});

test("a prompt reply with a usage that carries no token count ends the turn", () => {
  const adapter = adapterWithSession();
  const line = wire({
    jsonrpc: "2.0",
    id: 40,
    result: { stopReason: "end_turn", usage: { inputTokens: "11", outputTokens: null } },
  });

  // The usage of the agent carries no number: the turn ends without usage.
  assert.deepEqual(adapter.parse(line), [{ kind: "turn_end", status: "ok" }]);
});

test("a prompt reply keeps the tokens it has", () => {
  const adapter = adapterWithSession();
  const line = wire({
    jsonrpc: "2.0",
    id: 41,
    result: { stopReason: "end_turn", usage: { outputTokens: 3 } },
  });

  assert.deepEqual(adapter.parse(line), [
    { kind: "turn_end", status: "ok", usage: { inputTokens: undefined, outputTokens: 3 } },
  ]);
});

test("a prompt reply also reads the snake case usage of the agent", () => {
  const adapter = adapterWithSession();
  const line = wire({
    jsonrpc: "2.0",
    id: 42,
    result: { stopReason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } },
  });

  assert.deepEqual(adapter.parse(line), [
    { kind: "turn_end", status: "ok", usage: { inputTokens: 5, outputTokens: 2 } },
  ]);
});

/* ------------------------------------------------ the session of the agent */

test("the prompt addresses the session the agent announced", () => {
  const adapter = adapterWithSession();
  const message = adapter.prompt("hello", {}) as Record<string, unknown>;

  const params = message.params as Record<string, unknown>;
  assert.equal(params.sessionId, SESSION_ID);
});

test("the cancel addresses the session the agent announced", () => {
  const adapter = adapterWithSession();
  const frames = adapter.cancel({});

  assert.deepEqual(frames, [
    {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: SESSION_ID },
    },
  ]);
});
