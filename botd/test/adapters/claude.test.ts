// botd adapter tests: Claude Code (headless stream-json protocol).
//
// The recorded sample lines below mirror the shapes the `claude` CLI emits with
//   claude -p --input-format stream-json --output-format stream-json --verbose
// (system/init, assistant, user, result and control_request lines). All values are
// synthetic: no real hosts, accounts, tokens or paths.
//
// The live section at the bottom exercises the real binary when it is installed on
// the host; it is skipped cleanly when the CLI is not available.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { ClaudeAdapter } from "../../src/adapters/claude.ts";

const adapter = new ClaudeAdapter();

/* ------------------------------------------------------------------ samples */

const INIT_LINE = JSON.stringify({
  type: "system",
  subtype: "init",
  cwd: "/workspace/demo",
  session_id: "session-0000-1111",
  tools: ["Bash", "Read"],
  mcp_servers: [],
  model: "claude-sonnet-4",
  permissionMode: "default",
  slash_commands: [],
  apiKeySource: "none",
  output_style: "default",
});

const ASSISTANT_TEXT_LINE = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg_0001",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4",
    content: [{ type: "text", text: "PONG" }],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 4 },
  },
  parent_tool_use_id: null,
  session_id: "session-0000-1111",
});

const ASSISTANT_TOOL_USE_LINE = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg_0002",
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text: "checking" },
      { type: "tool_use", id: "toolu_0001", name: "Bash", input: { command: "ls" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 20, output_tokens: 8 },
  },
  parent_tool_use_id: null,
  session_id: "session-0000-1111",
});

const USER_TOOL_RESULT_LINE = JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_0001", content: "file-a\nfile-b", is_error: false },
    ],
  },
  parent_tool_use_id: null,
  session_id: "session-0000-1111",
});

const USER_TOOL_ERROR_LINE = JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_0001", content: "command failed", is_error: true },
    ],
  },
  parent_tool_use_id: null,
  session_id: "session-0000-1111",
});

const RESULT_OK_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 1234,
  num_turns: 2,
  result: "PONG",
  session_id: "session-0000-1111",
  total_cost_usd: 0.01,
  usage: {
    input_tokens: 20,
    output_tokens: 8,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
});

const RESULT_ERROR_LINE = JSON.stringify({
  type: "result",
  subtype: "error_max_turns",
  is_error: true,
  duration_ms: 99,
  num_turns: 9,
  result: "",
  session_id: "session-0000-1111",
  usage: { input_tokens: 5, output_tokens: 1 },
});

const PERMISSION_REQUEST_LINE = JSON.stringify({
  type: "control_request",
  request_id: "req-0001",
  request: {
    subtype: "can_use_tool",
    tool_name: "Bash",
    input: { command: "ls" },
    permission_suggestions: null,
    blocked_path: null,
  },
});

const PARTIAL_TEXT_LINE = JSON.stringify({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text: "PO" } },
  parent_tool_use_id: null,
  session_id: "session-0000-1111",
});

/* -------------------------------------------------------------------- spawn */

test("spawn builds the documented claude stream-json command", () => {
  const spec = adapter.spawn({ cwd: "/workspace/demo" });
  assert.deepEqual(spec.command, [
    "claude",
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
  assert.equal(spec.cwd, "/workspace/demo");
  assert.deepEqual(spec.env, {});
});

test("spawn passes model, resume and system prompt as provider flags", () => {
  const spec = adapter.spawn({
    cwd: "/workspace/demo",
    model: "claude-sonnet-4",
    resumeProviderSessionId: "session-0000-1111",
    systemPrompt: "be terse",
  });
  assert.equal(spec.command[0], "claude");
  assert.ok(spec.command.includes("--model"));
  assert.ok(spec.command.includes("claude-sonnet-4"));
  assert.ok(spec.command.includes("--resume"));
  assert.ok(spec.command.includes("session-0000-1111"));
  assert.ok(spec.command.includes("--append-system-prompt"));
  assert.ok(spec.command.includes("be terse"));
  // protocol flags stay in place and in order
  assert.deepEqual(spec.command.slice(1, 7), [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
});

test("adapter identity", () => {
  assert.equal(adapter.kind, "claude");
  assert.equal(adapter.family, "claude");
});

/* -------------------------------------------------- handshake / prompt / io */

test("handshake needs no init message", () => {
  assert.deepEqual(adapter.handshake({ cwd: "/workspace/demo" }), []);
});

test("prompt is a provider-native user message", () => {
  const message = adapter.prompt("reply PONG", {}) as Record<string, unknown>;
  assert.equal(message.type, "user");
  const body = message.message as Record<string, unknown>;
  assert.equal(body.role, "user");
  assert.equal(body.content, "reply PONG");
  assert.doesNotThrow(() => JSON.stringify(message));
});

test("prompt carries the provider session id when resuming", () => {
  const message = adapter.prompt("reply PONG", {
    providerSessionId: "session-0000-1111",
  }) as Record<string, unknown>;
  assert.equal(message.session_id, "session-0000-1111");
});

test("cancel sends a provider-native interrupt control request", () => {
  const messages = adapter.cancel({}) as Record<string, unknown>[];
  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(message.type, "control_request");
  assert.equal(typeof message.request_id, "string");
  assert.ok((message.request_id as string).length > 0);
  const request = message.request as Record<string, unknown>;
  assert.equal(request.subtype, "interrupt");
});

test("answerPermission returns a control response for allow and deny", () => {
  const allow = adapter.answerPermission("req-0001", true) as Record<string, unknown>;
  assert.equal(allow.type, "control_response");
  const allowResponse = allow.response as Record<string, unknown>;
  assert.equal(allowResponse.subtype, "success");
  assert.equal(allowResponse.request_id, "req-0001");
  const allowBody = allowResponse.response as Record<string, unknown>;
  assert.equal(allowBody.behavior, "allow");

  const deny = adapter.answerPermission("req-0002", false) as Record<string, unknown>;
  const denyResponse = deny.response as Record<string, unknown>;
  assert.equal(denyResponse.request_id, "req-0002");
  const denyBody = denyResponse.response as Record<string, unknown>;
  assert.equal(denyBody.behavior, "deny");
  assert.equal(typeof denyBody.message, "string");
});

test("answerPermission echoes the tool input recorded from the permission request", () => {
  adapter.parse(PERMISSION_REQUEST_LINE);
  const allow = adapter.answerPermission("req-0001", true) as Record<string, unknown>;
  const response = allow.response as Record<string, unknown>;
  const body = response.response as Record<string, unknown>;
  assert.deepEqual(body.updatedInput, { command: "ls" });
});

/* -------------------------------------------------------------------- parse */

test("parse maps the system/init line to a ready event", () => {
  assert.deepEqual(adapter.parse(INIT_LINE), [
    { kind: "ready", providerSessionId: "session-0000-1111" },
  ]);
});

test("parse maps assistant text to a text event", () => {
  assert.deepEqual(adapter.parse(ASSISTANT_TEXT_LINE), [{ kind: "text", delta: "PONG" }]);
});

test("parse maps assistant tool_use blocks to tool start events", () => {
  const events = adapter.parse(ASSISTANT_TOOL_USE_LINE);
  assert.deepEqual(events, [
    { kind: "text", delta: "checking" },
    { kind: "tool", name: "Bash", status: "start", summary: '{"command":"ls"}' },
  ]);
});

test("parse maps user tool_result blocks to tool end and error events", () => {
  const events = adapter.parse(USER_TOOL_RESULT_LINE);
  assert.deepEqual(events, [
    { kind: "tool", name: "Bash", status: "end", summary: "file-a\nfile-b" },
  ]);

  const errorEvents = adapter.parse(USER_TOOL_ERROR_LINE);
  assert.deepEqual(errorEvents, [
    { kind: "tool", name: "Bash", status: "error", summary: "command failed" },
  ]);
});

test("parse maps the result line to a turn_end event with usage", () => {
  assert.deepEqual(adapter.parse(RESULT_OK_LINE), [
    { kind: "turn_end", status: "ok", usage: { inputTokens: 20, outputTokens: 8 } },
  ]);
});

test("parse maps a failed result line to an error turn_end", () => {
  assert.deepEqual(adapter.parse(RESULT_ERROR_LINE), [
    { kind: "turn_end", status: "error", usage: { inputTokens: 5, outputTokens: 1 } },
  ]);
});

test("parse maps a can_use_tool control request to a permission event", () => {
  const events = adapter.parse(PERMISSION_REQUEST_LINE);
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.kind, "permission");
  if (event.kind !== "permission") throw new Error("expected a permission event");
  assert.equal(event.id, "req-0001");
  const request = event.request as Record<string, unknown>;
  assert.equal(request.subtype, "can_use_tool");
  assert.equal(request.tool_name, "Bash");
});

test("parse maps partial stream text to text events", () => {
  assert.deepEqual(adapter.parse(PARTIAL_TEXT_LINE), [{ kind: "text", delta: "PO" }]);
});

test("parse never throws and falls back to raw for unknown lines", () => {
  const garbage = ["", "not json", "{", "[]", "null", "42", '"a string"'];
  for (const line of garbage) {
    const events = adapter.parse(line);
    assert.ok(Array.isArray(events));
    assert.ok(events.length > 0, `expected an event for ${JSON.stringify(line)}`);
    for (const event of events) assert.equal(typeof event.kind, "string");
  }

  assert.deepEqual(adapter.parse("not json"), [{ kind: "raw", payload: "not json" }]);

  const unknownEvents = adapter.parse(JSON.stringify({ type: "totally_new", payload: 1 }));
  assert.equal(unknownEvents.length, 1);
  const unknownEvent = unknownEvents[0];
  assert.equal(unknownEvent.kind, "raw");
  if (unknownEvent.kind !== "raw") throw new Error("expected a raw event");
  assert.deepEqual(unknownEvent.payload, { type: "totally_new", payload: 1 });
});

test("parse handles every recorded sample line without throwing", () => {
  const lines = [
    INIT_LINE,
    ASSISTANT_TEXT_LINE,
    ASSISTANT_TOOL_USE_LINE,
    USER_TOOL_RESULT_LINE,
    RESULT_OK_LINE,
    PERMISSION_REQUEST_LINE,
  ];
  for (const line of lines) {
    const events = adapter.parse(line);
    assert.ok(events.length > 0, `expected events for ${line}`);
    for (const event of events) assert.ok(["ready", "text", "tool", "permission", "turn_end", "raw"].includes(event.kind));
  }
});

/* --------------------------------------------------------------------- live */

function findClaudeBinary(): string | null {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "claude");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here, keep looking
    }
  }
  return null;
}

test("live: claude answers a trivial prompt over the stream-json protocol", async (t) => {
  const binary = findClaudeBinary();
  if (!binary || process.env.BOTD_LIVE !== "1") {
    t.skip("claude live check is opt-in (BOTD_LIVE=1) and needs the CLI installed");
    return;
  }

  const spec = adapter.spawn({ cwd: process.cwd() });
  const child = spawn(spec.command[0], spec.command.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lines: string[] = [];
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) lines.push(line);
      index = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const finished = new Promise<number>((resolve) => {
    child.on("close", (code) => {
      const last = buffer.trim();
      if (last) lines.push(last);
      buffer = "";
      resolve(code ?? -1);
    });
  });

  const prompt = adapter.prompt("reply PONG, do not use any tools", {}) as Record<string, unknown>;
  child.stdin.on("error", () => {
    // the CLI may exit before reading stdin; that surfaces via the exit code
  });
  child.stdin.write(`${JSON.stringify(prompt)}\n`);
  child.stdin.end();

  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const code = await finished;
  clearTimeout(timer);

  // A host without credentials cannot answer; that is not an adapter failure.
  if (code !== 0 && /not (logged in|authenticated)|invalid api key|oauth|please run .claude login/i.test(stderr)) {
    t.skip(`claude CLI is installed but not usable on this host: ${stderr.trim().slice(0, 200)}`);
    return;
  }

  assert.ok(lines.length > 0, `expected stream-json output, stderr: ${stderr}`);
  const events = lines.flatMap((line) => adapter.parse(line));
  assert.ok(events.length > 0);
  assert.ok(
    events.some((event) => event.kind === "ready" || event.kind === "text"),
    `unexpected events: ${JSON.stringify(events)}`,
  );
  assert.equal(code, 0, `claude exited with ${code}, stderr: ${stderr}`);
});
