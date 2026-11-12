// botd/test/adapters/copilot.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// botd/src/adapters/copilot.ts
var enabled = false;
var COPILOT_COMMAND = ["copilot", "--acp"];
var COPILOT_ENABLED_ENV = "COPILOT_ENABLED";
var ACP_PROTOCOL_VERSION = 1;
function copilotUnavailableReason(env = process.env) {
  if (env[COPILOT_ENABLED_ENV] === "1")
    return;
  return `the copilot adapter is disabled: set ${COPILOT_ENABLED_ENV}=1 to ` + "enable the GitHub Copilot CLI adapter (it requires a paid Copilot seat)";
}
function assertCopilotEnabled(env = process.env) {
  const reason = copilotUnavailableReason(env);
  if (reason)
    throw new Error(reason);
}

class CopilotAdapter {
  kind = "copilot";
  family = "other";
  #nextId = 0;
  #sessionId;
  #pending = new Map;
  #permissions = new Map;
  #toolNames = new Map;
  get sessionId() {
    return this.#sessionId;
  }
  spawn(opts) {
    assertCopilotEnabled();
    const command = [...COPILOT_COMMAND];
    if (opts.model)
      command.push("--model", opts.model);
    if (opts.effort)
      command.push("--reasoning-effort", opts.effort);
    return {
      command,
      env: inheritedEnv(),
      cwd: opts.cwd
    };
  }
  handshake(opts) {
    const initialize = this.#request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      }
    });
    const session = opts.resumeProviderSessionId ? this.#request("session/load", {
      sessionId: opts.resumeProviderSessionId,
      cwd: opts.cwd,
      mcpServers: []
    }) : this.#request("session/new", {
      cwd: opts.cwd,
      mcpServers: []
    });
    const messages = [initialize, session];
    if (opts.systemPrompt) {
      const params = session.params;
      const meta = asRecord(params._meta) ?? {};
      meta.systemPrompt = opts.systemPrompt;
      params._meta = meta;
    }
    return messages;
  }
  prompt(text, ctx) {
    const sessionId = ctx.providerSessionId ?? this.#sessionId ?? "";
    return this.#request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }]
    });
  }
  cancel(ctx) {
    const sessionId = ctx.providerSessionId ?? this.#sessionId;
    if (!sessionId)
      return [];
    return [
      {
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId }
      }
    ];
  }
  answerPermission(id, allow) {
    const request = this.#permissions.get(id);
    if (!request)
      return null;
    this.#permissions.delete(id);
    const optionId = pickOption(request.options, allow);
    if (!optionId) {
      return {
        jsonrpc: "2.0",
        id: request.rpcId,
        result: { outcome: { outcome: "cancelled" } }
      };
    }
    return {
      jsonrpc: "2.0",
      id: request.rpcId,
      result: { outcome: { outcome: "selected", optionId } }
    };
  }
  parse(line) {
    try {
      const trimmed = line.trim();
      if (!trimmed)
        return [];
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return [{ kind: "raw", payload: line }];
      }
      const record = asRecord(message);
      if (!record)
        return [{ kind: "raw", payload: message }];
      return this.#mapMessage(record);
    } catch {
      return [{ kind: "raw", payload: line }];
    }
  }
  #request(method, params) {
    const id = this.#nextId++;
    this.#pending.set(String(id), method);
    return { jsonrpc: "2.0", id, method, params };
  }
  #mapMessage(message) {
    const method = message.method;
    if (typeof method === "string") {
      if (method === "session/update")
        return this.#mapUpdate(message);
      if (method === "session/request_permission")
        return this.#mapPermission(message);
      return [{ kind: "raw", payload: message }];
    }
    if (message.error !== undefined)
      return this.#mapError(message.error);
    if (message.result !== undefined)
      return this.#mapResult(message);
    return [{ kind: "raw", payload: message }];
  }
  #mapResult(message) {
    const result = asRecord(message.result) ?? {};
    const id = message.id;
    const method = typeof id === "number" || typeof id === "string" ? this.#pending.get(String(id)) : undefined;
    if (typeof result.sessionId === "string") {
      this.#sessionId = result.sessionId;
      return [{ kind: "ready", providerSessionId: result.sessionId }];
    }
    if (result.stopReason !== undefined) {
      return [turnEnd(result.stopReason, usageOf(result))];
    }
    if (result.protocolVersion !== undefined) {
      return [{ kind: "ready" }];
    }
    if (method === "session/prompt")
      return [{ kind: "turn_end", status: "ok" }];
    if (method === "session/new" || method === "session/load" || method === "initialize") {
      return [{ kind: "ready" }];
    }
    return [{ kind: "raw", payload: message }];
  }
  #mapError(error) {
    const record = asRecord(error);
    if (record && typeof record.message === "string" && record.message) {
      return [{ kind: "error", message: record.message }];
    }
    if (error === null || error === undefined) {
      return [{ kind: "error", message: "unknown error" }];
    }
    return [{ kind: "error", message: String(error) }];
  }
  #mapUpdate(message) {
    const params = asRecord(message.params);
    const update = params ? asRecord(params.update) : undefined;
    if (!update)
      return [{ kind: "raw", payload: message }];
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk") {
      const delta = textOf(update.content);
      if (!delta)
        return [{ kind: "raw", payload: message }];
      return [{ kind: "text", delta }];
    }
    if (kind === "tool_call") {
      return [
        {
          kind: "tool",
          name: this.#toolName(update),
          status: toolStatus(update.status),
          summary: toolSummary(update)
        }
      ];
    }
    if (kind === "tool_call_update") {
      return [
        {
          kind: "tool",
          name: this.#toolName(update),
          status: toolStatus(update.status),
          summary: toolSummary(update)
        }
      ];
    }
    return [{ kind: "raw", payload: message }];
  }
  #toolName(update) {
    const callId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
    let name;
    if (typeof update.title === "string" && update.title)
      name = update.title;
    else if (callId)
      name = this.#toolNames.get(callId);
    if (!name && typeof update.kind === "string" && update.kind)
      name = update.kind;
    if (!name && callId)
      name = callId;
    if (!name)
      name = "tool";
    if (callId)
      this.#toolNames.set(callId, name);
    return name;
  }
  #mapPermission(message) {
    const id = message.id;
    if (typeof id !== "number" && typeof id !== "string") {
      return [{ kind: "raw", payload: message }];
    }
    const params = asRecord(message.params) ?? {};
    const rawOptions = Array.isArray(params.options) ? params.options : [];
    const options = [];
    for (const raw of rawOptions) {
      const option = asRecord(raw);
      if (!option)
        continue;
      options.push({
        optionId: typeof option.optionId === "string" ? option.optionId : undefined,
        name: typeof option.name === "string" ? option.name : undefined,
        kind: typeof option.kind === "string" ? option.kind : undefined
      });
    }
    this.#permissions.set(String(id), { rpcId: id, options });
    return [{ kind: "permission", id: String(id), request: params }];
  }
}
function inheritedEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string")
      env[key] = value;
  }
  return env;
}
function asRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return;
}
function textOf(content) {
  if (Array.isArray(content)) {
    return content.map((entry) => textOf(entry)).filter((text) => text.length > 0).join(`
`);
  }
  const block = asRecord(content);
  if (!block)
    return "";
  if (typeof block.text === "string")
    return block.text;
  const inner = asRecord(block.content);
  if (inner && typeof inner.text === "string")
    return inner.text;
  return "";
}
function toolSummary(update) {
  const text = textOf(update.content);
  if (text)
    return text;
  const output = asRecord(update.rawOutput);
  if (output && typeof output.output === "string")
    return output.output;
  return;
}
function toolStatus(status) {
  if (status === "completed")
    return "end";
  if (status === "failed")
    return "error";
  return "start";
}
function turnEnd(stopReason, usage) {
  let status = "ok";
  if (stopReason === "cancelled")
    status = "cancelled";
  else if (stopReason === "refusal")
    status = "error";
  return usage ? { kind: "turn_end", status, usage } : { kind: "turn_end", status };
}
function usageOf(result) {
  const usage = asRecord(result.usage);
  if (!usage)
    return;
  const inputTokens = firstNumber(usage.inputTokens, usage.input_tokens);
  const outputTokens = firstNumber(usage.outputTokens, usage.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined)
    return;
  return { inputTokens, outputTokens };
}
function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value))
      return value;
  }
  return;
}
function pickOption(options, allow) {
  const kinds = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of kinds) {
    for (const option of options) {
      if (option.kind === kind && typeof option.optionId === "string") {
        return option.optionId;
      }
    }
  }
  const words = allow ? ["allow", "approve", "yes"] : ["reject", "deny", "no"];
  for (const word of words) {
    for (const option of options) {
      const name = (option.name ?? "").toLowerCase();
      if (name.includes(word) && typeof option.optionId === "string") {
        return option.optionId;
      }
    }
  }
  return;
}
var copilotAdapter = new CopilotAdapter;

// botd/test/adapters/copilot.test.ts
var INITIALIZE_RESPONSE = JSON.stringify({
  jsonrpc: "2.0",
  id: 0,
  result: {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: true }
    },
    authMethods: []
  }
});
var SESSION_NEW_RESPONSE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { sessionId: "sess_synthetic_0001" }
});
var AGENT_MESSAGE_CHUNK = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "sess_synthetic_0001",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "PONG" }
    }
  }
});
var AGENT_THOUGHT_CHUNK = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "sess_synthetic_0001",
    update: {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking about the answer" }
    }
  }
});
var EMPTY_MESSAGE_CHUNK = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "sess_synthetic_0001",
    update: { sessionUpdate: "agent_message_chunk" }
  }
});
var TOOL_CALL = JSON.stringify({
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
      rawInput: { command: "ls" }
    }
  }
});
var TOOL_CALL_COMPLETED = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "sess_synthetic_0001",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_synthetic_0001",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "README.md" } }]
    }
  }
});
var TOOL_CALL_FAILED = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "sess_synthetic_0001",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_synthetic_0001",
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "permission denied" } }]
    }
  }
});
var PERMISSION_REQUEST = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "session/request_permission",
  params: {
    sessionId: "sess_synthetic_0001",
    toolCall: {
      toolCallId: "call_synthetic_0003",
      title: "Run command",
      kind: "execute"
    },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" }
    ]
  }
});
var PROMPT_RESPONSE_END = JSON.stringify({
  jsonrpc: "2.0",
  id: 3,
  result: { stopReason: "end_turn" }
});
var PROMPT_RESPONSE_CANCELLED = JSON.stringify({
  jsonrpc: "2.0",
  id: 4,
  result: { stopReason: "cancelled" }
});
var PROMPT_RESPONSE_REFUSED = JSON.stringify({
  jsonrpc: "2.0",
  id: 5,
  result: { stopReason: "refusal" }
});
var PROMPT_RESPONSE_WITH_USAGE = JSON.stringify({
  jsonrpc: "2.0",
  id: 6,
  result: { stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 3 } }
});
var ERROR_RESPONSE = JSON.stringify({
  jsonrpc: "2.0",
  id: 7,
  error: { code: -32603, message: "internal error" }
});
var UNKNOWN_NOTIFICATION = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/set_mode",
  params: { sessionId: "sess_synthetic_0001", modeId: "default" }
});
function adapterWithSession() {
  const adapter = new CopilotAdapter;
  adapter.parse(INITIALIZE_RESPONSE);
  adapter.parse(SESSION_NEW_RESPONSE);
  return adapter;
}
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
  assert.ok(copilotUnavailableReason({ [COPILOT_ENABLED_ENV]: "0" }));
  assert.ok(copilotUnavailableReason({ [COPILOT_ENABLED_ENV]: "true" }));
});
test("prompt() wraps the text in an ACP session/prompt request", () => {
  const adapter = new CopilotAdapter;
  const message = adapter.prompt("reply PONG", {
    providerSessionId: "sess_synthetic_0001"
  });
  assert.equal(message.jsonrpc, "2.0");
  assert.equal(message.method, "session/prompt");
  assert.equal(typeof message.id, "number");
  const params = message.params;
  assert.equal(params.sessionId, "sess_synthetic_0001");
  assert.deepEqual(params.prompt, [{ type: "text", text: "reply PONG" }]);
  assert.doesNotThrow(() => JSON.stringify(message));
});
test("cancel() sends the provider-native session/cancel notification", () => {
  const adapter = adapterWithSession();
  const messages = adapter.cancel({ providerSessionId: "sess_synthetic_0001" });
  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(message.jsonrpc, "2.0");
  assert.equal(message.method, "session/cancel");
  assert.equal(message.id, undefined, "session/cancel is a notification");
  const params = message.params;
  assert.equal(params.sessionId, "sess_synthetic_0001");
});
test("cancel() without a session id has nothing to address", () => {
  const adapter = new CopilotAdapter;
  assert.deepEqual(adapter.cancel({}), []);
});
test("parse() maps the initialize and session/new replies", () => {
  const adapter = new CopilotAdapter;
  assert.deepEqual(adapter.parse(INITIALIZE_RESPONSE), [{ kind: "ready" }]);
  const ready = adapter.parse(SESSION_NEW_RESPONSE);
  assert.deepEqual(ready, [
    { kind: "ready", providerSessionId: "sess_synthetic_0001" }
  ]);
  assert.equal(adapter.sessionId, "sess_synthetic_0001");
});
test("parse() maps agent_message_chunk to text deltas", () => {
  const adapter = adapterWithSession();
  assert.deepEqual(adapter.parse(AGENT_MESSAGE_CHUNK), [
    { kind: "text", delta: "PONG" }
  ]);
});
test("parse() maps tool_call and tool_call_update to tool events", () => {
  const adapter = adapterWithSession();
  assert.deepEqual(adapter.parse(TOOL_CALL), [
    { kind: "tool", name: "List files", status: "start", summary: undefined }
  ]);
  assert.deepEqual(adapter.parse(TOOL_CALL_COMPLETED), [
    {
      kind: "tool",
      name: "List files",
      status: "end",
      summary: "README.md"
    }
  ]);
  assert.deepEqual(adapter.parse(TOOL_CALL_FAILED), [
    {
      kind: "tool",
      name: "List files",
      status: "error",
      summary: "permission denied"
    }
  ]);
});
test("parse() maps the prompt reply to turn_end", () => {
  const adapter = adapterWithSession();
  assert.deepEqual(adapter.parse(PROMPT_RESPONSE_END), [
    { kind: "turn_end", status: "ok" }
  ]);
  assert.deepEqual(adapter.parse(PROMPT_RESPONSE_CANCELLED), [
    { kind: "turn_end", status: "cancelled" }
  ]);
  assert.deepEqual(adapter.parse(PROMPT_RESPONSE_REFUSED), [
    { kind: "turn_end", status: "error" }
  ]);
  assert.deepEqual(adapter.parse(PROMPT_RESPONSE_WITH_USAGE), [
    { kind: "turn_end", status: "ok", usage: { inputTokens: 11, outputTokens: 3 } }
  ]);
});
test("parse() maps a JSON-RPC error to an error event", () => {
  const adapter = adapterWithSession();
  assert.deepEqual(adapter.parse(ERROR_RESPONSE), [
    { kind: "error", message: "internal error" }
  ]);
});
test("parse() maps a full synthetic ACP session", () => {
  const adapter = new CopilotAdapter;
  const events = [
    INITIALIZE_RESPONSE,
    SESSION_NEW_RESPONSE,
    AGENT_MESSAGE_CHUNK,
    TOOL_CALL,
    TOOL_CALL_COMPLETED,
    PROMPT_RESPONSE_END
  ].flatMap((line) => adapter.parse(line));
  assert.deepEqual(events, [
    { kind: "ready" },
    { kind: "ready", providerSessionId: "sess_synthetic_0001" },
    { kind: "text", delta: "PONG" },
    { kind: "tool", name: "List files", status: "start", summary: undefined },
    { kind: "tool", name: "List files", status: "end", summary: "README.md" },
    { kind: "turn_end", status: "ok" }
  ]);
});
test("parse() maps unknown messages to raw", () => {
  const adapter = adapterWithSession();
  assert.deepEqual(adapter.parse(UNKNOWN_NOTIFICATION), [
    { kind: "raw", payload: JSON.parse(UNKNOWN_NOTIFICATION) }
  ]);
  assert.deepEqual(adapter.parse(AGENT_THOUGHT_CHUNK), [
    { kind: "raw", payload: JSON.parse(AGENT_THOUGHT_CHUNK) }
  ]);
  assert.deepEqual(adapter.parse(EMPTY_MESSAGE_CHUNK), [
    { kind: "raw", payload: JSON.parse(EMPTY_MESSAGE_CHUNK) }
  ]);
});
test("parse() keeps unparsable lines as raw", () => {
  const adapter = adapterWithSession();
  assert.deepEqual(adapter.parse("copilot: something happened"), [
    { kind: "raw", payload: "copilot: something happened" }
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
    '{"jsonrpc":"2.0","id":null,"error":null}'
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
test("parse() reports a permission request and answers it", () => {
  const adapter = adapterWithSession();
  const events = adapter.parse(PERMISSION_REQUEST);
  assert.equal(events.length, 1);
  const permission = events[0];
  assert.equal(permission.kind, "permission");
  if (permission.kind !== "permission")
    return;
  assert.equal(permission.id, "2");
  const request = permission.request;
  assert.equal(request.sessionId, "sess_synthetic_0001");
  const allow = adapter.answerPermission(permission.id, true);
  assert.equal(allow.jsonrpc, "2.0");
  assert.equal(allow.id, 2);
  const allowResult = allow.result;
  const allowOutcome = allowResult.outcome;
  assert.equal(allowOutcome.outcome, "selected");
  assert.equal(allowOutcome.optionId, "allow-once");
});
test("answerPermission() can reject and is single shot", () => {
  const adapter = adapterWithSession();
  const permission = adapter.parse(PERMISSION_REQUEST)[0];
  assert.equal(permission.kind, "permission");
  if (permission.kind !== "permission")
    return;
  const reject = adapter.answerPermission(permission.id, false);
  const rejectResult = reject.result;
  const rejectOutcome = rejectResult.outcome;
  assert.equal(rejectOutcome.outcome, "selected");
  assert.equal(rejectOutcome.optionId, "reject-once");
  assert.equal(adapter.answerPermission(permission.id, true), null);
  assert.equal(adapter.answerPermission("does-not-exist", true), null);
});
