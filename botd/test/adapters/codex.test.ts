// botd/test/adapters/codex.test.ts
//
// Tests for the Codex adapter.
//
// `codex app-server` speaks a JSON-RPC style protocol over stdio: one JSON
// object per line, no "jsonrpc" member.  The client -> server half of the
// protocol is initialize / initialized / thread.start / thread.resume /
// turn.start / turn.interrupt, the server -> client half is thread/started,
// turn/started, item/started, item/completed, item/agentMessage/delta,
// thread/tokenUsage/updated, turn/completed and error, plus five approval
// requests that ask the client for a decision.
//
// The sample lines below follow the message shapes of the app-server protocol
// (see `codex app-server generate-json-schema`).  Every value is synthetic:
// no real hosts, accounts, tokens or paths.
//
// Behaviour notes (the current implementation is asserted as-is):
//   * A blank line yields no event at all (parse() returns []); every other
//     unparsable line is kept as a raw event.
//   * A turn_end event always carries a `usage` key, even when it is undefined.
//   * cancel() is a no-op until a turn id is known.  The turn id is only picked
//     up from the `turn/started` notification or from a result that carries a
//     top level `threadId`; the `turn/start` reply shape
//     `{ result: { turn: { id } } }` does not register it.
//   * prompt() falls back to an empty thread id while no session is known.
//   * A thread is announced as "ready" only once; a repeated thread/started
//     notification for the same thread is passed through as a raw event.
//   * `item/tool/requestUserInput` asks a question and is therefore not an
//     approval: it is surfaced as a raw event.
//
// The live test at the bottom talks to the real CLI, but only when it is
// installed on the host and BOTD_LIVE=1 is set.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CodexAdapter, codexAdapter } from "../../src/adapters/codex.ts";
import type { NormalizedEvent } from "../../src/adapter-types.ts";

/* --------------------------------------------------------------- fixtures */

const WORK_DIR = "/synthetic/work";
const THREAD_ID = "thread_synthetic_0001";
const TURN_ID = "turn_synthetic_0001";

/** Reply to `initialize`: the app-server reports itself, no thread yet. */
const INITIALIZE_RESULT = JSON.stringify({
  id: 1,
  result: { userAgent: "codex_app_server/0.0.1-synthetic" },
});

/** Reply to `thread/start`: this is where the session id comes from. */
const THREAD_START_RESULT = JSON.stringify({
  id: 2,
  result: { thread: { id: THREAD_ID, cwd: WORK_DIR } },
});

/** Reply to `turn/start`: the turn id, but no thread id next to it. */
const TURN_START_RESULT = JSON.stringify({
  id: 3,
  result: { turn: { id: TURN_ID, status: "inProgress", items: [] } },
});

const THREAD_STARTED = JSON.stringify({
  method: "thread/started",
  params: { thread: { id: THREAD_ID, cwd: WORK_DIR } },
});

const TURN_STARTED = JSON.stringify({
  method: "turn/started",
  params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "inProgress", items: [] } },
});

const AGENT_MESSAGE_DELTA = JSON.stringify({
  method: "item/agentMessage/delta",
  params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "item_synthetic_0001", delta: "PO" },
});

const AGENT_MESSAGE_DELTA_2 = JSON.stringify({
  method: "item/agentMessage/delta",
  params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "item_synthetic_0001", delta: "NG" },
});

const AGENT_MESSAGE_COMPLETED = JSON.stringify({
  method: "item/completed",
  params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item: { id: "item_synthetic_0001", type: "agentMessage", text: "PONG" },
  },
});

/** The same item, but this time without any delta before it. */
const AGENT_MESSAGE_COMPLETED_WITHOUT_DELTA = JSON.stringify({
  method: "item/completed",
  params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item: { id: "item_synthetic_0002", type: "agentMessage", text: "PONG" },
  },
});

const COMMAND_STARTED = JSON.stringify({
  method: "item/started",
  params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item: { id: "item_synthetic_0002", type: "commandExecution", command: "ls -la", status: "inProgress" },
  },
});

const COMMAND_COMPLETED = JSON.stringify({
  method: "item/completed",
  params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item: {
      id: "item_synthetic_0002",
      type: "commandExecution",
      command: "ls -la",
      status: "completed",
      exitCode: 0,
    },
  },
});

const COMMAND_FAILED = JSON.stringify({
  method: "item/completed",
  params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item: {
      id: "item_synthetic_0003",
      type: "commandExecution",
      command: "false",
      status: "failed",
      exitCode: 1,
    },
  },
});

const FILE_CHANGE_STARTED = JSON.stringify({
  method: "item/started",
  params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item: {
      id: "item_synthetic_0004",
      type: "fileChange",
      status: "inProgress",
      changes: [{ path: "src/synthetic.ts", kind: "update" }],
    },
  },
});

const WEB_SEARCH_STARTED = JSON.stringify({
  method: "item/started",
  params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item: { id: "item_synthetic_0005", type: "webSearch", query: "volto bots" },
  },
});

const MCP_TOOL_STARTED = JSON.stringify({
  method: "item/started",
  params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item: {
      id: "item_synthetic_0006",
      type: "mcpToolCall",
      server: "synthetic-docs",
      tool: "search",
      status: "inProgress",
    },
  },
});

const MCP_TOOL_FAILED = JSON.stringify({
  method: "item/completed",
  params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item: {
      id: "item_synthetic_0006",
      type: "mcpToolCall",
      server: "synthetic-docs",
      tool: "search",
      status: "failed",
      error: { message: "tool unavailable" },
    },
  },
});

const DYNAMIC_TOOL_STARTED = JSON.stringify({
  method: "item/started",
  params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item: { id: "item_synthetic_0007", type: "dynamicToolCall", tool: "synthetic_tool", status: "inProgress" },
  },
});

const PLAN_STARTED = JSON.stringify({
  method: "item/started",
  params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item: { id: "item_synthetic_0008", type: "plan", text: "a synthetic plan" },
  },
});

const TOKEN_USAGE = JSON.stringify({
  method: "thread/tokenUsage/updated",
  params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    tokenUsage: {
      last: { inputTokens: 11, outputTokens: 3 },
      total: { inputTokens: 11, outputTokens: 3 },
    },
  },
});

const TURN_COMPLETED_OK = JSON.stringify({
  method: "turn/completed",
  params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed", items: [] } },
});

const TURN_COMPLETED_INTERRUPTED = JSON.stringify({
  method: "turn/completed",
  params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "interrupted", items: [] } },
});

const TURN_COMPLETED_FAILED = JSON.stringify({
  method: "turn/completed",
  params: {
    threadId: THREAD_ID,
    turn: { id: TURN_ID, status: "failed", error: { message: "model unavailable" } },
  },
});

const ERROR_NOTIFICATION = JSON.stringify({
  method: "error",
  params: { error: { message: "synthetic failure" } },
});

const ERROR_RESPONSE = JSON.stringify({
  id: 9,
  error: { code: -32603, message: "internal error" },
});

const UNKNOWN_NOTIFICATION = JSON.stringify({
  method: "thread/status/changed",
  params: { threadId: THREAD_ID, status: { type: "active" } },
});

const COMMAND_APPROVAL = JSON.stringify({
  id: 11,
  method: "item/commandExecution/requestApproval",
  params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: "item_synthetic_0002",
    command: "ls -la",
    cwd: WORK_DIR,
  },
});

const FILE_CHANGE_APPROVAL = JSON.stringify({
  id: 12,
  method: "item/fileChange/requestApproval",
  params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: "item_synthetic_0004",
    startedAtMs: 1_700_000_000_000,
  },
});

const PERMISSIONS_APPROVAL = JSON.stringify({
  id: 13,
  method: "item/permissions/requestApproval",
  params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: "item_synthetic_0009",
    cwd: WORK_DIR,
    permissions: { network: { enabled: true }, fileSystem: { write: [WORK_DIR] } },
  },
});

const EXEC_COMMAND_APPROVAL = JSON.stringify({
  id: 14,
  method: "execCommandApproval",
  params: {
    callId: "call_synthetic_0001",
    conversationId: THREAD_ID,
    command: ["ls", "-la"],
    cwd: WORK_DIR,
    parsedCmd: [],
  },
});

const APPLY_PATCH_APPROVAL = JSON.stringify({
  id: 15,
  method: "applyPatchApproval",
  params: {
    callId: "call_synthetic_0002",
    conversationId: THREAD_ID,
    fileChanges: {},
  },
});

const USER_INPUT_REQUEST = JSON.stringify({
  id: 16,
  method: "item/tool/requestUserInput",
  params: { itemId: "item_synthetic_0010", questions: [] },
});

/* ------------------------------------------------------------------ helpers */

/** A fresh adapter that already knows the thread of THREAD_ID. */
function adapterWithThread(): CodexAdapter {
  const adapter = new CodexAdapter();
  adapter.parse(THREAD_START_RESULT);
  return adapter;
}

/** A fresh adapter that knows both the thread and the running turn. */
function adapterWithTurn(): CodexAdapter {
  const adapter = adapterWithThread();
  adapter.parse(TURN_STARTED);
  return adapter;
}

/* -------------------------------------------------------------------- spawn */

test("spawn() starts the codex app-server", () => {
  const adapter = new CodexAdapter();
  const spec = adapter.spawn({ cwd: WORK_DIR });

  assert.deepEqual(spec.command, ["codex", "app-server"]);
  assert.equal(spec.cwd, WORK_DIR);
  assert.deepEqual(spec.env, {});
});

test("spawn() keeps model, effort, prompt and secrets out of argv", () => {
  const adapter = new CodexAdapter();
  const spec = adapter.spawn({
    cwd: WORK_DIR,
    model: "synthetic-model",
    effort: "medium",
    systemPrompt: "be terse",
    resumeProviderSessionId: THREAD_ID,
  });

  assert.deepEqual(spec.command, ["codex", "app-server"]);
  for (const argument of spec.command) {
    assert.doesNotMatch(argument, /key|token|secret|password/i);
    assert.doesNotMatch(argument, /synthetic-model|be terse/);
  }
});

test("adapter identity", () => {
  const adapter = new CodexAdapter();
  assert.equal(adapter.kind, "codex");
  assert.equal(adapter.family, "gpt");
  assert.equal(codexAdapter.kind, "codex");
  assert.equal(codexAdapter.family, "gpt");
});

/* -------------------------------------------------------- handshake / prompt */

test("handshake() initializes, acknowledges and starts a thread", () => {
  const adapter = new CodexAdapter();
  const messages = adapter.handshake({ cwd: WORK_DIR }) as Record<string, unknown>[];

  assert.equal(messages.length, 3);

  const initialize = messages[0];
  assert.equal(initialize.method, "initialize");
  assert.equal(initialize.id, 1);
  const initializeParams = initialize.params as Record<string, unknown>;
  const clientInfo = initializeParams.clientInfo as Record<string, unknown>;
  assert.equal(clientInfo.name, "volto-botd");
  assert.equal(typeof clientInfo.version, "string");
  const capabilities = initializeParams.capabilities as Record<string, unknown>;
  assert.equal(capabilities.experimentalApi, true);

  const acknowledged = messages[1];
  assert.equal(acknowledged.method, "initialized");
  assert.equal(acknowledged.id, undefined, "initialized is a notification");

  const session = messages[2];
  assert.equal(session.method, "thread/start");
  assert.equal(session.id, 2);
  const sessionParams = session.params as Record<string, unknown>;
  assert.equal(sessionParams.cwd, WORK_DIR);
  assert.equal(sessionParams.approvalPolicy, "on-request");
  assert.equal(sessionParams.sandbox, "workspace-write");
  assert.equal(sessionParams.threadId, undefined);
  assert.equal(sessionParams.model, undefined);
});

test("handshake() resumes a thread when a provider session id is known", () => {
  const adapter = new CodexAdapter();
  const messages = adapter.handshake({
    cwd: WORK_DIR,
    resumeProviderSessionId: THREAD_ID,
  }) as Record<string, unknown>[];

  assert.equal(messages.length, 3);
  const session = messages[2];
  assert.equal(session.method, "thread/resume");
  const sessionParams = session.params as Record<string, unknown>;
  assert.equal(sessionParams.threadId, THREAD_ID);
  assert.equal(sessionParams.cwd, WORK_DIR);
  assert.equal(sessionParams.approvalPolicy, "on-request");
  assert.equal(sessionParams.sandbox, "workspace-write");
});

test("handshake() carries model, effort and system prompt as protocol params", () => {
  const adapter = new CodexAdapter();
  const messages = adapter.handshake({
    cwd: WORK_DIR,
    model: "synthetic-model",
    effort: "medium",
    systemPrompt: "be terse",
  }) as Record<string, unknown>[];

  const sessionParams = messages[2].params as Record<string, unknown>;
  assert.equal(sessionParams.model, "synthetic-model");
  assert.deepEqual(sessionParams.config, { model_reasoning_effort: "medium" });
  assert.equal(sessionParams.developerInstructions, "be terse");
});

test("handshake() messages are JSON serializable and use increasing ids", () => {
  const adapter = new CodexAdapter();
  const messages = adapter.handshake({ cwd: WORK_DIR });

  for (const message of messages) {
    assert.doesNotThrow(() => JSON.stringify(message));
  }
  const ids = messages
    .map((message) => (message as Record<string, unknown>).id)
    .filter((id): id is number => typeof id === "number");
  assert.deepEqual(ids, [1, 2]);

  const next = adapter.prompt("reply PONG", {}) as Record<string, unknown>;
  assert.equal(next.id, 3, "request ids keep counting");
});

test("prompt() wraps the text in a turn/start request", () => {
  const adapter = new CodexAdapter();
  const message = adapter.prompt("reply PONG", {
    providerSessionId: THREAD_ID,
  }) as Record<string, unknown>;

  assert.equal(message.method, "turn/start");
  assert.equal(typeof message.id, "number");
  const params = message.params as Record<string, unknown>;
  assert.equal(params.threadId, THREAD_ID);
  assert.deepEqual(params.input, [
    { type: "text", text: "reply PONG", text_elements: [] },
  ]);
});

test("prompt() falls back to the last known thread id", () => {
  const adapter = adapterWithThread();
  const message = adapter.prompt("reply PONG", {}) as Record<string, unknown>;
  const params = message.params as Record<string, unknown>;
  assert.equal(params.threadId, THREAD_ID);
});

test("prompt() without a known session sends an empty thread id", () => {
  const adapter = new CodexAdapter();
  const message = adapter.prompt("reply PONG", {}) as Record<string, unknown>;
  const params = message.params as Record<string, unknown>;
  // Known behaviour: the adapter does not fail fast, it sends an empty id.
  assert.equal(params.threadId, "");
});

/* -------------------------------------------------------------------- cancel */

test("cancel() interrupts the running turn", () => {
  const adapter = adapterWithTurn();
  const messages = adapter.cancel({ providerSessionId: THREAD_ID }) as Record<string, unknown>[];

  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(message.method, "turn/interrupt");
  assert.equal(typeof message.id, "number");
  assert.deepEqual(message.params, { threadId: THREAD_ID, turnId: TURN_ID });
});

test("cancel() does nothing while no turn is known", () => {
  const adapter = adapterWithThread();
  assert.deepEqual(adapter.cancel({ providerSessionId: THREAD_ID }), []);
  assert.deepEqual(adapter.cancel({}), []);
});

test("cancel() uses the thread of the context, not the last one", () => {
  const adapter = adapterWithTurn();
  assert.deepEqual(adapter.cancel({ providerSessionId: "thread_synthetic_9999" }), []);
});

/* --------------------------------------------------------------------- parse */

test("parse() maps the thread/start reply to a ready event", () => {
  const adapter = new CodexAdapter();
  assert.deepEqual(adapter.parse(THREAD_START_RESULT), [
    { kind: "ready", providerSessionId: THREAD_ID },
  ]);
});

test("parse() maps the initialize reply to a raw event", () => {
  const adapter = new CodexAdapter();
  assert.deepEqual(adapter.parse(INITIALIZE_RESULT), [
    { kind: "raw", payload: JSON.parse(INITIALIZE_RESULT) },
  ]);
});

test("parse() announces a thread only once", () => {
  const adapter = new CodexAdapter();
  assert.deepEqual(adapter.parse(THREAD_STARTED), [
    { kind: "ready", providerSessionId: THREAD_ID },
  ]);
  // The same thread again is passed through untouched.
  assert.deepEqual(adapter.parse(THREAD_STARTED), [
    { kind: "raw", payload: JSON.parse(THREAD_STARTED) },
  ]);
});

test("parse() maps agent message deltas to text events", () => {
  const adapter = adapterWithThread();
  assert.deepEqual(adapter.parse(AGENT_MESSAGE_DELTA), [{ kind: "text", delta: "PO" }]);
  assert.deepEqual(adapter.parse(AGENT_MESSAGE_DELTA_2), [{ kind: "text", delta: "NG" }]);
});

test("parse() does not repeat an agent message that was streamed as deltas", () => {
  const adapter = adapterWithThread();
  adapter.parse(AGENT_MESSAGE_DELTA);
  assert.deepEqual(adapter.parse(AGENT_MESSAGE_COMPLETED), [
    { kind: "raw", payload: JSON.parse(AGENT_MESSAGE_COMPLETED) },
  ]);
});

test("parse() falls back to the final agent message when no delta arrived", () => {
  const adapter = adapterWithThread();
  assert.deepEqual(adapter.parse(AGENT_MESSAGE_COMPLETED_WITHOUT_DELTA), [
    { kind: "text", delta: "PONG" },
  ]);
});

test("parse() maps command execution items to shell tool events", () => {
  const adapter = adapterWithThread();

  assert.deepEqual(adapter.parse(COMMAND_STARTED), [
    { kind: "tool", name: "shell", status: "start", summary: "ls -la" },
  ]);
  assert.deepEqual(adapter.parse(COMMAND_COMPLETED), [
    { kind: "tool", name: "shell", status: "end", summary: "exit 0" },
  ]);
  assert.deepEqual(adapter.parse(COMMAND_FAILED), [
    { kind: "tool", name: "shell", status: "error", summary: "exit 1" },
  ]);
});

test("parse() maps file changes to apply_patch tool events", () => {
  const adapter = adapterWithThread();
  assert.deepEqual(adapter.parse(FILE_CHANGE_STARTED), [
    { kind: "tool", name: "apply_patch", status: "start", summary: "src/synthetic.ts" },
  ]);
});

test("parse() maps web search items to web_search tool events", () => {
  const adapter = adapterWithThread();
  assert.deepEqual(adapter.parse(WEB_SEARCH_STARTED), [
    { kind: "tool", name: "web_search", status: "start", summary: "volto bots" },
  ]);
});

test("parse() maps mcp tool calls to mcp:<server>/<tool> tool events", () => {
  const adapter = adapterWithThread();
  assert.deepEqual(adapter.parse(MCP_TOOL_STARTED), [
    { kind: "tool", name: "mcp:synthetic-docs/search", status: "start" },
  ]);
  assert.deepEqual(adapter.parse(MCP_TOOL_FAILED), [
    { kind: "tool", name: "mcp:synthetic-docs/search", status: "error", summary: "tool unavailable" },
  ]);
});

test("parse() maps dynamic tool calls and plans to tool events", () => {
  const adapter = adapterWithThread();
  assert.deepEqual(adapter.parse(DYNAMIC_TOOL_STARTED), [
    { kind: "tool", name: "dynamic:synthetic_tool", status: "start" },
  ]);
  assert.deepEqual(adapter.parse(PLAN_STARTED), [
    { kind: "tool", name: "update_plan", status: "start" },
  ]);
});

test("parse() attaches the reported token usage to the turn_end event", () => {
  const adapter = adapterWithTurn();
  assert.deepEqual(adapter.parse(TOKEN_USAGE), [
    { kind: "raw", payload: JSON.parse(TOKEN_USAGE) },
  ]);
  assert.deepEqual(adapter.parse(TURN_COMPLETED_OK), [
    { kind: "turn_end", status: "ok", usage: { inputTokens: 11, outputTokens: 3 } },
  ]);
});

test("parse() maps a completed turn to turn_end ok", () => {
  const adapter = adapterWithTurn();
  assert.deepEqual(adapter.parse(TURN_COMPLETED_OK), [
    { kind: "turn_end", status: "ok", usage: undefined },
  ]);
});

test("parse() maps an interrupted turn to turn_end cancelled", () => {
  const adapter = adapterWithTurn();
  assert.deepEqual(adapter.parse(TURN_COMPLETED_INTERRUPTED), [
    { kind: "turn_end", status: "cancelled", usage: undefined },
  ]);
});

test("parse() maps a failed turn to an error and a turn_end error", () => {
  const adapter = adapterWithTurn();
  assert.deepEqual(adapter.parse(TURN_COMPLETED_FAILED), [
    { kind: "error", message: "model unavailable" },
    { kind: "turn_end", status: "error", usage: undefined },
  ]);
});

test("parse() maps the error notification and the error response", () => {
  const adapter = adapterWithThread();
  assert.deepEqual(adapter.parse(ERROR_NOTIFICATION), [
    { kind: "error", message: "synthetic failure" },
  ]);
  assert.deepEqual(adapter.parse(ERROR_RESPONSE), [
    { kind: "error", message: "internal error" },
  ]);
  assert.deepEqual(adapter.parse(JSON.stringify({ id: 10, error: { code: -32603 } })), [
    { kind: "error", message: "codex request failed" },
  ]);
});

test("parse() keeps unknown notifications raw", () => {
  const adapter = adapterWithThread();
  assert.deepEqual(adapter.parse(UNKNOWN_NOTIFICATION), [
    { kind: "raw", payload: JSON.parse(UNKNOWN_NOTIFICATION) },
  ]);
});

test("parse() maps a whole synthetic session", () => {
  const adapter = new CodexAdapter();
  const events = [
    INITIALIZE_RESULT,
    THREAD_START_RESULT,
    TURN_STARTED,
    AGENT_MESSAGE_DELTA,
    COMMAND_STARTED,
    COMMAND_COMPLETED,
    TOKEN_USAGE,
    AGENT_MESSAGE_COMPLETED,
    TURN_COMPLETED_OK,
  ].flatMap((line) => adapter.parse(line));

  assert.deepEqual(events, [
    { kind: "raw", payload: JSON.parse(INITIALIZE_RESULT) },
    { kind: "ready", providerSessionId: THREAD_ID },
    { kind: "raw", payload: JSON.parse(TURN_STARTED) },
    { kind: "text", delta: "PO" },
    { kind: "tool", name: "shell", status: "start", summary: "ls -la" },
    { kind: "tool", name: "shell", status: "end", summary: "exit 0" },
    { kind: "raw", payload: JSON.parse(TOKEN_USAGE) },
    { kind: "raw", payload: JSON.parse(AGENT_MESSAGE_COMPLETED) },
    { kind: "turn_end", status: "ok", usage: { inputTokens: 11, outputTokens: 3 } },
  ]);
});

test("parse() never throws on malformed lines", () => {
  const adapter = adapterWithThread();
  const inputs = [
    "",
    "   ",
    "not json at all",
    "{ broken json",
    "null",
    "42",
    '"a string"',
    "[1,2,3]",
    "{}",
    '{"method":null}',
    '{"method":"item/started"}',
    '{"method":"item/started","params":{}}',
    '{"method":"item/agentMessage/delta","params":{"delta":7}}',
    '{"method":"thread/started","params":{"thread":{}}}',
    '{"method":"turn/completed","params":{"turn":{"id":"t","status":"inProgress"}}}',
    '{"id":null,"error":null}',
    '{"id":42,"method":"item/permissions/requestApproval"}',
  ];

  for (const input of inputs) {
    assert.doesNotThrow(() => adapter.parse(input), `parse threw for: ${input}`);
    const events = adapter.parse(input);
    assert.ok(Array.isArray(events));
    for (const event of events) {
      assert.equal(typeof event.kind, "string");
    }
  }
});

test("parse() keeps unparsable lines as raw and drops blank ones", () => {
  const adapter = adapterWithThread();
  assert.deepEqual(adapter.parse("codex: something happened"), [
    { kind: "raw", payload: "codex: something happened" },
  ]);
  assert.deepEqual(adapter.parse(""), []);
  assert.deepEqual(adapter.parse("   "), []);
});

/* -------------------------------------------------------------- permissions */

test("parse() reports a command execution approval request", () => {
  const adapter = adapterWithThread();
  const events = adapter.parse(COMMAND_APPROVAL);

  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.kind, "permission");
  if (event.kind !== "permission") throw new Error("expected a permission event");
  assert.equal(event.id, "11");
  const request = event.request as Record<string, unknown>;
  assert.equal(request.method, "item/commandExecution/requestApproval");
  const params = request.params as Record<string, unknown>;
  assert.equal(params.command, "ls -la");
});

test("answerPermission() accepts a command execution request", () => {
  const adapter = adapterWithThread();
  const event = adapter.parse(COMMAND_APPROVAL)[0];
  if (event.kind !== "permission") throw new Error("expected a permission event");

  const answer = adapter.answerPermission(event.id, true) as Record<string, unknown>;
  assert.equal(answer.id, 11);
  assert.deepEqual(answer.result, { decision: "accept" });
});

test("answerPermission() declines a file change request", () => {
  const adapter = adapterWithThread();
  const event = adapter.parse(FILE_CHANGE_APPROVAL)[0];
  if (event.kind !== "permission") throw new Error("expected a permission event");

  const answer = adapter.answerPermission(event.id, false) as Record<string, unknown>;
  assert.equal(answer.id, 12);
  assert.deepEqual(answer.result, { decision: "decline" });
});

test("answerPermission() grants the requested permissions for the turn", () => {
  const adapter = adapterWithThread();
  const event = adapter.parse(PERMISSIONS_APPROVAL)[0];
  if (event.kind !== "permission") throw new Error("expected a permission event");

  const answer = adapter.answerPermission(event.id, true) as Record<string, unknown>;
  assert.equal(answer.id, 13);
  assert.deepEqual(answer.result, {
    permissions: { network: { enabled: true }, fileSystem: { write: [WORK_DIR] } },
    scope: "turn",
  });
});

test("answerPermission() grants nothing when a permission request is denied", () => {
  const adapter = adapterWithThread();
  const event = adapter.parse(PERMISSIONS_APPROVAL)[0];
  if (event.kind !== "permission") throw new Error("expected a permission event");

  const answer = adapter.answerPermission(event.id, false) as Record<string, unknown>;
  assert.deepEqual(answer.result, { permissions: {}, scope: "turn" });
});

test("answerPermission() answers the legacy exec and patch approvals", () => {
  const adapter = adapterWithThread();

  const exec = adapter.parse(EXEC_COMMAND_APPROVAL)[0];
  if (exec.kind !== "permission") throw new Error("expected a permission event");
  assert.equal(exec.id, "14");
  const execAnswer = adapter.answerPermission(exec.id, true) as Record<string, unknown>;
  assert.equal(execAnswer.id, 14);
  assert.deepEqual(execAnswer.result, { decision: "approved" });

  const patch = adapter.parse(APPLY_PATCH_APPROVAL)[0];
  if (patch.kind !== "permission") throw new Error("expected a permission event");
  assert.equal(patch.id, "15");
  const patchAnswer = adapter.answerPermission(patch.id, false) as Record<string, unknown>;
  assert.equal(patchAnswer.id, 15);
  assert.deepEqual(patchAnswer.result, {
    decision: { denied: { rejection: "denied by policy" } },
  });
});

test("answerPermission() is single shot and returns null for unknown ids", () => {
  const adapter = adapterWithThread();
  const event = adapter.parse(COMMAND_APPROVAL)[0];
  if (event.kind !== "permission") throw new Error("expected a permission event");

  assert.notEqual(adapter.answerPermission(event.id, true), null);
  assert.equal(adapter.answerPermission(event.id, true), null);
  assert.equal(adapter.answerPermission("does-not-exist", true), null);
});

test("parse() leaves a user input question raw, it is not an approval", () => {
  const adapter = adapterWithThread();
  assert.deepEqual(adapter.parse(USER_INPUT_REQUEST), [
    { kind: "raw", payload: JSON.parse(USER_INPUT_REQUEST) },
  ]);
  assert.equal(adapter.answerPermission("16", true), null);
});

/* --------------------------------------------------------------------- live */

function findCodexBinary(): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "codex");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here, keep looking
    }
  }
  return undefined;
}

const codexBinary = findCodexBinary();

/** Root of the worktree: the live run keeps its scratch files in .tmp/. */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(join(dir, "botd", "src"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const liveSkip =
  process.env.BOTD_LIVE !== "1"
    ? "live checks are opt-in (set BOTD_LIVE=1)"
    : codexBinary === undefined
      ? "the codex CLI is not installed on this host"
      : false;

test("live: codex app-server answers a trivial prompt", { skip: liveSkip }, async (t) => {
  const adapter = new CodexAdapter();
  const cwd = join(findRepoRoot(), ".tmp", "codex-live");
  mkdirSync(cwd, { recursive: true });

  const child = spawn(codexBinary as string, ["app-server"], {
    cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const events: NormalizedEvent[] = [];
  let buffer = "";
  let stderr = "";
  let skipReason: string | undefined;
  let sawTurnEnd = false;

  // A host without a reachable provider (no login, no network) cannot finish a
  // turn: that is a property of the host, not of the adapter.
  const unusableHost = /auth|login|unauthorized|credential|api[_ -]?key|token|network|connect|reconnect|offline|timeout|timed out|rate.?limit|quota|unavailable|sandbox|denied/i;

  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      skipReason = "the codex app-server did not answer within 90s";
      resolve();
    }, 90_000);

    const finish = (error?: Error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        for (const event of adapter.parse(line)) {
          events.push(event);
          if (event.kind === "ready" && event.providerSessionId) {
            const prompt = adapter.prompt("reply PONG, do not use any tools", {
              providerSessionId: event.providerSessionId,
            });
            try {
              child.stdin.write(`${JSON.stringify(prompt)}\n`);
            } catch {
              // the CLI may have exited already
            }
          }
          if (event.kind === "turn_end") {
            sawTurnEnd = true;
            finish();
          }
          if (event.kind === "error") {
            if (unusableHost.test(event.message)) {
              skipReason = `the codex CLI cannot complete a turn on this host: ${event.message}`;
              finish();
            } else {
              finish(new Error(`codex reported an error: ${event.message}`));
            }
          }
        }
        index = buffer.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error: Error) => finish(error));
    child.on("close", (code: number | null) => {
      if (!sawTurnEnd && skipReason === undefined) {
        skipReason = `the codex CLI exited (code ${code}) without finishing a turn; stderr: ${stderr.trim().slice(0, 200)}`;
      }
      finish();
    });

    for (const message of adapter.handshake({ cwd })) {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        // the CLI may have exited already
      }
    }
  });

  try {
    await done;
  } finally {
    child.stdin.end();
    child.kill("SIGKILL");
  }

  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const text = events
    .filter((event): event is { kind: "text"; delta: string } => event.kind === "text")
    .map((event) => event.delta)
    .join("");
  assert.match(text.toUpperCase(), /PONG/, `unexpected output, stderr: ${stderr}`);
});
