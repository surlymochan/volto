// botd/test/adapters/dsh.test.ts
//
// Tests for the DeepSeek Shell (`dsh`) adapter.
//
// `dsh --profile acp` speaks the Agent Client Protocol (ACP) over stdio:
// newline-delimited JSON-RPC 2.0.  The sample lines below follow the message
// shapes documented by ACP (initialize / session.new / session.prompt /
// session.update / session.request_permission).  When the real `dsh` binary is
// installed the last test talks to it for real; otherwise it is skipped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DshAdapter, DSH_COMMAND } from "../../src/adapters/dsh.ts";
import type { NormalizedEvent } from "../../src/adapter-types.ts";

// --- recorded-style ACP lines -------------------------------------------------

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

const TOOL_CALL_2 = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "sess_synthetic_0001",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "call_synthetic_0002",
      title: "Run command",
      kind: "execute",
      status: "pending",
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
      toolCallId: "call_synthetic_0002",
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

const PROMPT_RESPONSE_WITH_USAGE = JSON.stringify({
  jsonrpc: "2.0",
  id: 5,
  result: { stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 3 } },
});

const ERROR_RESPONSE = JSON.stringify({
  jsonrpc: "2.0",
  id: 6,
  error: { code: -32603, message: "internal error" },
});

const UNKNOWN_NOTIFICATION = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/set_mode",
  params: { sessionId: "sess_synthetic_0001", modeId: "default" },
});

function adapterWithSession(): DshAdapter {
  const adapter = new DshAdapter();
  adapter.parse(INITIALIZE_RESPONSE);
  adapter.parse(SESSION_NEW_RESPONSE);
  return adapter;
}

// --- spawn --------------------------------------------------------------------

test("spawn() builds the exact dsh command", () => {
  const adapter = new DshAdapter();
  const spec = adapter.spawn({ cwd: "/synthetic/work" });
  assert.deepEqual(spec.command, ["dsh", "--profile", "acp"]);
  assert.deepEqual([...DSH_COMMAND], ["dsh", "--profile", "acp"]);
  assert.equal(spec.cwd, "/synthetic/work");
  assert.equal(typeof spec.env, "object");
  assert.ok(spec.env !== null);
});

test("spawn() keeps secrets out of argv", () => {
  const adapter = new DshAdapter();
  const spec = adapter.spawn({ cwd: process.cwd() });
  for (const arg of spec.command) {
    assert.doesNotMatch(arg, /key|token|secret/i);
  }
});

// --- handshake / prompt / cancel ---------------------------------------------

test("handshake() sends ACP initialize and session/new requests", () => {
  const adapter = new DshAdapter();
  const messages = adapter.handshake({ cwd: "/synthetic/work" }) as Record<string, unknown>[];

  assert.equal(messages.length, 2);

  const initialize = messages[0];
  const session = messages[1];
  assert.ok(initialize);
  assert.ok(session);
  assert.equal(initialize.jsonrpc, "2.0");
  assert.equal(initialize.method, "initialize");
  assert.equal(initialize.id, 0);
  const initParams = initialize.params as Record<string, unknown>;
  assert.equal(initParams.protocolVersion, 1);
  assert.ok(initParams.clientCapabilities);

  assert.equal(session.jsonrpc, "2.0");
  assert.equal(session.method, "session/new");
  assert.equal(session.id, 1);
  const sessionParams = session.params as Record<string, unknown>;
  assert.equal(sessionParams.cwd, "/synthetic/work");
  assert.deepEqual(sessionParams.mcpServers, []);

  // Everything must be JSON-serializable.
  for (const message of messages) {
    assert.doesNotThrow(() => JSON.stringify(message));
  }
});

test("prompt() wraps the text in an ACP session/prompt request", () => {
  const adapter = new DshAdapter();
  const message = adapter.prompt("reply PONG", {
    providerSessionId: "sess_synthetic_0001",
  }) as Record<string, unknown>;

  assert.equal(message.jsonrpc, "2.0");
  assert.equal(message.method, "session/prompt");
  assert.equal(typeof message.id, "number");
  const params = message.params as Record<string, unknown>;
  assert.equal(params.sessionId, "sess_synthetic_0001");
  assert.deepEqual(params.prompt, [{ type: "text", text: "reply PONG" }]);
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
  const adapter = new DshAdapter();
  assert.deepEqual(adapter.cancel({}), []);
});

// --- parse --------------------------------------------------------------------

test("parse() maps the initialize and session/new replies", () => {
  const adapter = new DshAdapter();

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
  assert.deepEqual(adapter.parse(TOOL_CALL_2), [
    { kind: "tool", name: "Run command", status: "start", summary: undefined },
  ]);
  assert.deepEqual(adapter.parse(TOOL_CALL_FAILED), [
    {
      kind: "tool",
      name: "Run command",
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

test("parse() maps a full recorded ACP session", () => {
  const adapter = new DshAdapter();
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

test("parse() never throws", () => {
  const adapter = new DshAdapter();
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

test("parse() keeps unparsable lines as raw", () => {
  const adapter = new DshAdapter();
  assert.deepEqual(adapter.parse("dsh: something happened"), [
    { kind: "raw", payload: "dsh: something happened" },
  ]);
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

// --- live check (skipped when the binary is not installed) --------------------

function findExecutable(name: string): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

const dshBinary = findExecutable("dsh");

function hasCredentials(): boolean {
  const names = ["DEEPSEEK_API_KEY", "DSH_API_KEY", "DEEPSEEK_TOKEN"];
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) return true;
  }
  // dsh may keep its credentials in a config directory instead.
  for (const dir of [path.join(os.homedir(), ".dsh"), path.join(os.homedir(), ".config", "dsh")]) {
    try {
      if (fs.statSync(dir).isDirectory()) return true;
    } catch {
      // no config directory
    }
  }
  return false;
}

// We never try `npx -y @deepseek-ai/dsh`: that would download and install a
// package.  Without a local binary the live part is simply skipped.
const liveSkip = process.env.BOTD_LIVE !== "1"
  ? "live checks are opt-in (set BOTD_LIVE=1)"
  : dshBinary
  ? hasCredentials()
    ? false
    : "no dsh credentials available in this environment"
  : "dsh binary is not installed on this host (no npx install is attempted)";

test(
  "live: dsh --profile acp answers a trivial prompt",
  { skip: liveSkip },
  async (t) => {
    const adapter = new DshAdapter();
    const spec = adapter.spawn({ cwd: process.cwd() });
    const child = spawn(spec.command[0], spec.command.slice(1), {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderrStream = child.stderr;
    assert.ok(stdin);
    assert.ok(stdout);
    assert.ok(stderrStream);

    const events: NormalizedEvent[] = [];
    const stderr: string[] = [];
    let buffer = "";

    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`dsh did not finish within 60s; events: ${JSON.stringify(events)}`));
      }, 60_000);

      const finish = (error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };

      stderrStream.setEncoding("utf8");
      stderrStream.on("data", (chunk: string) => {
        stderr.push(chunk);
      });

      stdout.setEncoding("utf8");
      stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf("\n");
        while (index !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          for (const event of adapter.parse(line)) {
            events.push(event);
            if (event.kind === "ready" && event.providerSessionId) {
              const prompt = adapter.prompt("reply PONG", {
                providerSessionId: event.providerSessionId,
              });
              stdin.write(`${JSON.stringify(prompt)}\n`);
            }
            if (event.kind === "turn_end") {
              finish();
            }
            if (event.kind === "error") {
              if (/auth|credential|api[_ -]?key|unauthorized|token/i.test(event.message)) {
                // The agent is installed but cannot talk to the provider.
                t.skip(`dsh needs credentials: ${event.message}`);
                finish();
              } else {
                finish(new Error(`dsh reported an error: ${event.message}`));
              }
            }
          }
          index = buffer.indexOf("\n");
        }
      });

      child.on("error", (error: Error) => finish(error));
      child.on("close", (code: number | null) => {
        if (code !== 0) {
          finish(new Error(`dsh exited with code ${code}: ${stderr.join("")}`));
        } else {
          finish();
        }
      });

      for (const message of adapter.handshake({ cwd: spec.cwd })) {
        stdin.write(`${JSON.stringify(message)}\n`);
      }
    });

    try {
      await done;
    } finally {
      stdin.end();
      child.kill();
    }

    const text = events
      .filter((event): event is { kind: "text"; delta: string } => event.kind === "text")
      .map((event) => event.delta)
      .join("");
    assert.match(text.toUpperCase(), /PONG/);
  },
);
