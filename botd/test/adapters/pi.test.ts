// botd/test/adapters/pi.test.ts
//
// Tests for the pi adapter (`pi --mode rpc`).
//
// `pi --mode rpc` speaks newline delimited JSON over stdio.  The client sends
// commands (`{"id":…,"type":"prompt"|"abort"|…}`) and the CLI answers with a
// `response` line or streams events (`message_update`, `message_end`,
// `tool_execution_start`, `tool_execution_end`, `agent_end`).
//
// Every line below is synthetic: no real host names, accounts, tokens or
// session files.  The pi CLI is never started by this suite -- the protocol is
// exercised with recorded-style lines only.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PiAdapter, PI_COMMAND } from "../../src/adapters/pi.ts";

/* --------------------------------------------------------------- fixtures */

const WORK_DIR = "/synthetic/work";
const SESSION_ID = "sess_synthetic_0001";
const SESSION_FILE = "/synthetic/sessions/sess_synthetic_0001.jsonl";

/** Reply to `get_state`: the session of the running CLI. */
const GET_STATE_DATA = {
  sessionId: SESSION_ID,
  sessionFile: SESSION_FILE,
  model: { provider: "synthetic-provider", id: "synthetic-model-0001" },
};

/** Streamed assistant text. */
const MESSAGE_UPDATE_DELTA = JSON.stringify({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta: "PO" },
});

const MESSAGE_UPDATE_DELTA_2 = JSON.stringify({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta: "NG" },
});

/** A thinking delta is not part of the answer. */
const MESSAGE_UPDATE_THINKING = JSON.stringify({
  type: "message_update",
  assistantMessageEvent: { type: "thinking_delta", delta: "let me think" },
});

/** The assistant message is complete; its text was already streamed. */
const MESSAGE_END = JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "PONG" }],
    usage: { input: 12, output: 3 },
  },
});

/** A tool call starts. */
const TOOL_START = JSON.stringify({
  type: "tool_execution_start",
  toolCallId: "call_synthetic_0001",
  toolName: "read_file",
  args: { path: "README.md" },
});

/** The same tool call is done. */
const TOOL_END = JSON.stringify({
  type: "tool_execution_end",
  toolCallId: "call_synthetic_0001",
  toolName: "read_file",
  result: { content: "synthetic content" },
  isError: false,
});

/** A tool call that failed. */
const TOOL_END_ERROR = JSON.stringify({
  type: "tool_execution_end",
  toolCallId: "call_synthetic_0002",
  toolName: "bash",
  error: "command failed",
  isError: true,
});

/** The agent finished the turn. */
const AGENT_END = JSON.stringify({
  type: "agent_end",
  messages: [
    { role: "user", content: [{ type: "text", text: "reply PONG" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "PONG" }],
      stopReason: "stop",
      usage: { input: 12, output: 3 },
    },
  ],
});

/** The agent was aborted. */
const AGENT_END_ABORTED = JSON.stringify({
  type: "agent_end",
  messages: [
    {
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
      stopReason: "aborted",
    },
  ],
});

/** The agent asks the client to confirm something. */
const UI_REQUEST_CONFIRM = JSON.stringify({
  type: "extension_ui_request",
  id: "ui_synthetic_0001",
  method: "confirm",
  title: "Run the command?",
});

/** The agent asks the client to pick one of several options. */
const UI_REQUEST_SELECT = JSON.stringify({
  type: "extension_ui_request",
  id: "ui_synthetic_0002",
  method: "select",
  title: "Pick a file",
  options: [{ value: "first_synthetic", label: "First" }],
});

/** A free form request is not an approval. */
const UI_REQUEST_INPUT = JSON.stringify({
  type: "extension_ui_request",
  id: "ui_synthetic_0003",
  method: "input",
  title: "Name?",
});

/** An event this adapter does not know. */
const UNKNOWN_EVENT = JSON.stringify({
  type: "future_event",
  payload: { synthetic: true },
});

/** Build the reply to a command the adapter sent. */
function reply(id: unknown, data: unknown): string {
  return JSON.stringify({ type: "response", id, success: true, data });
}

/** Run the handshake and answer the `get_state` command. */
function adapterWithSession(): PiAdapter {
  const adapter = new PiAdapter();
  const commands = adapter.handshake({ cwd: WORK_DIR }) as Record<string, unknown>[];
  const state = commands.find((command) => command.type === "get_state");
  assert.ok(state);
  adapter.parse(reply(state.id, GET_STATE_DATA));
  return adapter;
}

/* ------------------------------------------------------------------ spawn */

test("spawn() builds the pi RPC command", () => {
  const adapter = new PiAdapter();
  const spec = adapter.spawn({ cwd: WORK_DIR });

  assert.deepEqual(spec.command, ["pi", "--mode", "rpc"]);
  assert.deepEqual([...PI_COMMAND], ["pi", "--mode", "rpc"]);
  assert.equal(spec.cwd, WORK_DIR);
  assert.equal(typeof spec.env, "object");
  assert.ok(spec.env !== null);
});

test("spawn() keeps secrets out of argv", () => {
  const adapter = new PiAdapter();
  const spec = adapter.spawn({ cwd: WORK_DIR });
  for (const arg of spec.command) {
    assert.doesNotMatch(arg, /key|token|secret/i);
  }
});

test("spawn() passes a requested model to the CLI", () => {
  const adapter = new PiAdapter();
  const spec = adapter.spawn({ cwd: WORK_DIR, model: "synthetic-model-0001" });
  assert.deepEqual(spec.command, [
    "pi",
    "--mode",
    "rpc",
    "--model",
    "synthetic-model-0001",
  ]);
});

test("the adapter identifies itself as pi", () => {
  const adapter = new PiAdapter();
  assert.equal(adapter.kind, "pi");
  assert.equal(adapter.family, "other");
});

/* --------------------------------------------------------------- messages */

test("handshake() opens a session and asks for the state", () => {
  const adapter = new PiAdapter();
  const commands = adapter.handshake({ cwd: WORK_DIR }) as Record<string, unknown>[];

  assert.equal(commands.length, 2);
  const [session, state] = commands;
  assert.ok(session);
  assert.ok(state);
  assert.equal(session.type, "new_session");
  assert.equal(typeof session.id, "string");
  assert.equal(state.type, "get_state");
  assert.equal(typeof state.id, "string");
  assert.notEqual(session.id, state.id);

  for (const command of commands) {
    assert.doesNotThrow(() => JSON.stringify(command));
  }
});

test("handshake() resumes a stored session with switch_session", () => {
  const adapter = new PiAdapter();
  const commands = adapter.handshake({
    cwd: WORK_DIR,
    resumeProviderSessionId: SESSION_FILE,
  }) as Record<string, unknown>[];

  assert.equal(commands.length, 2);
  const [switchSession, state] = commands;
  assert.ok(switchSession);
  assert.ok(state);
  assert.equal(switchSession.type, "switch_session");
  const params = switchSession.sessionPath;
  assert.equal(params, SESSION_FILE);
  assert.equal(state.type, "get_state");
});

test("prompt() wraps the text in a prompt command", () => {
  const adapter = new PiAdapter();
  const command = adapter.prompt("reply PONG", {
    providerSessionId: SESSION_ID,
  }) as Record<string, unknown>;

  assert.equal(command.type, "prompt");
  assert.equal(typeof command.id, "string");
  assert.equal(command.message, "reply PONG");
  assert.doesNotThrow(() => JSON.stringify(command));
});

test("cancel() sends the provider-native abort command", () => {
  const adapter = new PiAdapter();
  const commands = adapter.cancel({ providerSessionId: SESSION_ID });

  assert.equal(commands.length, 1);
  const command = commands[0] as Record<string, unknown>;
  assert.equal(command.type, "abort");
  assert.equal(typeof command.id, "string");
});

test("command ids are unique", () => {
  const adapter = new PiAdapter();
  const first = adapter.prompt("one", {}) as Record<string, unknown>;
  const second = adapter.prompt("two", {}) as Record<string, unknown>;
  assert.notEqual(first.id, second.id);
});

/* ------------------------------------------------------------------ parse */

test("parse() announces the session as ready", () => {
  const adapter = new PiAdapter();
  const commands = adapter.handshake({ cwd: WORK_DIR }) as Record<string, unknown>[];
  const state = commands.find((command) => command.type === "get_state");
  assert.ok(state);

  // The session file is the value a later resume can be used with.
  assert.deepEqual(adapter.parse(reply(state.id, GET_STATE_DATA)), [
    { kind: "ready", providerSessionId: SESSION_FILE },
  ]);
  assert.equal(adapter.sessionId, SESSION_ID);
  assert.equal(adapter.sessionFile, SESSION_FILE);
});

test("parse() announces the session only once", () => {
  const adapter = adapterWithSession();
  const events = adapter.parse(reply("pi-unknown", GET_STATE_DATA));
  assert.deepEqual(events, [
    { kind: "raw", payload: JSON.parse(reply("pi-unknown", GET_STATE_DATA)) },
  ]);
});

test("parse() maps message_update deltas to text events", () => {
  const adapter = adapterWithSession();

  assert.deepEqual(adapter.parse(MESSAGE_UPDATE_DELTA), [
    { kind: "text", delta: "PO" },
  ]);
  assert.deepEqual(adapter.parse(MESSAGE_UPDATE_DELTA_2), [
    { kind: "text", delta: "NG" },
  ]);
});

test("parse() keeps thinking deltas raw", () => {
  const adapter = adapterWithSession();
  assert.deepEqual(adapter.parse(MESSAGE_UPDATE_THINKING), [
    { kind: "raw", payload: JSON.parse(MESSAGE_UPDATE_THINKING) },
  ]);
});

test("parse() does not repeat streamed text on message_end", () => {
  const adapter = adapterWithSession();
  adapter.parse(MESSAGE_UPDATE_DELTA);
  adapter.parse(MESSAGE_UPDATE_DELTA_2);

  assert.deepEqual(adapter.parse(MESSAGE_END), [
    { kind: "raw", payload: JSON.parse(MESSAGE_END) },
  ]);
});

test("parse() falls back to the final text of message_end", () => {
  const adapter = adapterWithSession();
  assert.deepEqual(adapter.parse(MESSAGE_END), [
    { kind: "text", delta: "PONG" },
  ]);
});

test("parse() maps tool events to tool start and end", () => {
  const adapter = adapterWithSession();

  assert.deepEqual(adapter.parse(TOOL_START), [
    { kind: "tool", name: "read_file", status: "start", summary: '{"path":"README.md"}' },
  ]);
  assert.deepEqual(adapter.parse(TOOL_END), [
    {
      kind: "tool",
      name: "read_file",
      status: "end",
      summary: '{"content":"synthetic content"}',
    },
  ]);
});

test("parse() maps a failed tool execution to a tool error", () => {
  const adapter = adapterWithSession();
  assert.deepEqual(adapter.parse(TOOL_END_ERROR), [
    { kind: "tool", name: "bash", status: "error", summary: "command failed" },
  ]);
});

test("parse() maps agent_end to turn_end", () => {
  const adapter = adapterWithSession();
  adapter.parse(MESSAGE_UPDATE_DELTA);
  adapter.parse(MESSAGE_UPDATE_DELTA_2);

  assert.deepEqual(adapter.parse(AGENT_END), [
    { kind: "turn_end", status: "ok", usage: { inputTokens: 12, outputTokens: 3 } },
  ]);
});

test("parse() maps an aborted agent_end to a cancelled turn", () => {
  const adapter = adapterWithSession();
  assert.deepEqual(adapter.parse(AGENT_END_ABORTED), [
    { kind: "text", delta: "partial" },
    { kind: "turn_end", status: "cancelled" },
  ]);
});

test("parse() maps a failed response to an error event", () => {
  const adapter = new PiAdapter();
  const command = adapter.prompt("reply PONG", {}) as Record<string, unknown>;

  assert.deepEqual(
    adapter.parse(
      JSON.stringify({ type: "response", id: command.id, success: false, error: "not logged in" }),
    ),
    [{ kind: "error", message: "not logged in" }],
  );
});

test("parse() maps a failed response with an object error to an error event", () => {
  const adapter = new PiAdapter();
  const command = adapter.prompt("reply PONG", {}) as Record<string, unknown>;

  assert.deepEqual(
    adapter.parse(
      JSON.stringify({
        type: "response",
        id: command.id,
        success: false,
        error: { message: "no provider configured" },
      }),
    ),
    [{ kind: "error", message: "no provider configured" }],
  );
});

test("parse() keeps a response without session data raw", () => {
  const adapter = new PiAdapter();
  const command = adapter.prompt("reply PONG", {}) as Record<string, unknown>;
  const line = reply(command.id, {});

  assert.deepEqual(adapter.parse(line), [
    { kind: "raw", payload: JSON.parse(line) },
  ]);
});

test("parse() maps unknown events to raw", () => {
  const adapter = adapterWithSession();
  assert.deepEqual(adapter.parse(UNKNOWN_EVENT), [
    { kind: "raw", payload: JSON.parse(UNKNOWN_EVENT) },
  ]);
});

test("parse() keeps unparsable lines as raw and ignores blank lines", () => {
  const adapter = adapterWithSession();

  assert.deepEqual(adapter.parse(""), []);
  assert.deepEqual(adapter.parse("   "), []);
  assert.deepEqual(adapter.parse("pi: something happened"), [
    { kind: "raw", payload: "pi: something happened" },
  ]);
});

test("parse() never throws", () => {
  const adapter = new PiAdapter();
  const inputs = [
    "",
    "   ",
    "not json at all",
    "{ broken json",
    "null",
    "42",
    '"a string"',
    "[1,2,3]",
    '{"type":"response"}',
    '{"type":"response","id":null,"success":false}',
    '{"type":"response","id":"pi-1","success":true,"data":null}',
    '{"type":"message_update"}',
    '{"type":"message_update","assistantMessageEvent":null}',
    '{"type":"message_update","assistantMessageEvent":{"type":"text_delta"}}',
    '{"type":"message_end"}',
    '{"type":"message_end","message":{"content":[{"type":"text"}]}}',
    '{"type":"tool_execution_start"}',
    '{"type":"tool_execution_end"}',
    '{"type":"agent_end"}',
    '{"type":"agent_end","messages":"not a list"}',
    '{"type":"extension_ui_request"}',
    '{"type":"extension_ui_request","id":"ui_1","method":"select"}',
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

/* ------------------------------------------------------------ permissions */

test("parse() reports a confirm request as a permission and answers it", () => {
  const adapter = adapterWithSession();

  const events = adapter.parse(UI_REQUEST_CONFIRM);
  assert.equal(events.length, 1);
  const permission = events[0];
  assert.equal(permission.kind, "permission");
  if (permission.kind !== "permission") return;
  assert.equal(permission.id, "ui_synthetic_0001");
  const request = permission.request as Record<string, unknown>;
  assert.equal(request.method, "confirm");

  const answer = adapter.answerPermission(permission.id, true) as Record<string, unknown>;
  assert.equal(answer.type, "extension_ui_response");
  assert.equal(answer.id, "ui_synthetic_0001");
  assert.equal(answer.confirmed, true);
});

test("answerPermission() denies with cancelled and is single shot", () => {
  const adapter = adapterWithSession();
  const permission = adapter.parse(UI_REQUEST_CONFIRM)[0];
  assert.equal(permission.kind, "permission");
  if (permission.kind !== "permission") return;

  const answer = adapter.answerPermission(permission.id, false) as Record<string, unknown>;
  assert.equal(answer.type, "extension_ui_response");
  assert.equal(answer.confirmed, false);

  // A request can only be answered once.
  assert.equal(adapter.answerPermission(permission.id, true), null);
  // Unknown ids have nothing to answer.
  assert.equal(adapter.answerPermission("does-not-exist", true), null);
});

test("answerPermission() picks the first option of a select request", () => {
  const adapter = adapterWithSession();
  const permission = adapter.parse(UI_REQUEST_SELECT)[0];
  assert.equal(permission.kind, "permission");
  if (permission.kind !== "permission") return;

  const answer = adapter.answerPermission(permission.id, true) as Record<string, unknown>;
  assert.equal(answer.type, "extension_ui_response");
  assert.equal(answer.value, "first_synthetic");
});

test("parse() keeps free form UI requests raw", () => {
  const adapter = adapterWithSession();
  assert.deepEqual(adapter.parse(UI_REQUEST_INPUT), [
    { kind: "raw", payload: JSON.parse(UI_REQUEST_INPUT) },
  ]);
});

/* ------------------------------------------------------------ full session */

test("parse() maps a full synthetic pi session", () => {
  const adapter = new PiAdapter();
  const commands = adapter.handshake({ cwd: WORK_DIR }) as Record<string, unknown>[];
  const session = commands.find((command) => command.type === "new_session");
  const state = commands.find((command) => command.type === "get_state");
  assert.ok(session);
  assert.ok(state);

  const prompt = adapter.prompt("reply PONG", {}) as Record<string, unknown>;
  const abort = adapter.cancel({})[0] as Record<string, unknown>;

  const sessionReply = reply(session.id, {});
  const promptReply = reply(prompt.id, {});
  const lines = [
    sessionReply,
    reply(state.id, GET_STATE_DATA),
    promptReply,
    MESSAGE_UPDATE_DELTA,
    TOOL_START,
    TOOL_END,
    MESSAGE_UPDATE_DELTA_2,
    MESSAGE_END,
    AGENT_END,
  ];

  const events = lines.flatMap((line) => adapter.parse(line));

  assert.deepEqual(events, [
    { kind: "raw", payload: JSON.parse(sessionReply) },
    { kind: "ready", providerSessionId: SESSION_FILE },
    { kind: "raw", payload: JSON.parse(promptReply) },
    { kind: "text", delta: "PO" },
    { kind: "tool", name: "read_file", status: "start", summary: '{"path":"README.md"}' },
    {
      kind: "tool",
      name: "read_file",
      status: "end",
      summary: '{"content":"synthetic content"}',
    },
    { kind: "text", delta: "NG" },
    { kind: "raw", payload: JSON.parse(MESSAGE_END) },
    { kind: "turn_end", status: "ok", usage: { inputTokens: 12, outputTokens: 3 } },
  ]);

  // The abort command is only sent when the caller cancels.
  assert.equal(abort.type, "abort");
});

test("parse() reports an aborted turn after a cancel", () => {
  const adapter = adapterWithSession();
  const abort = adapter.cancel({})[0] as Record<string, unknown>;
  const abortReply = JSON.stringify({ type: "response", id: abort.id, success: true });

  assert.deepEqual(adapter.parse(abortReply), [
    { kind: "raw", payload: JSON.parse(abortReply) },
  ]);
  assert.deepEqual(adapter.parse(AGENT_END_ABORTED), [
    { kind: "text", delta: "partial" },
    { kind: "turn_end", status: "cancelled" },
  ]);
});
