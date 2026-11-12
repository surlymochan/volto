/**
 * volto-botd tests: `agy` adapter.
 *
 * The sample lines below are recorded-style fixtures written inline from the
 * documented message shapes of the two protocols the adapter speaks:
 *
 *   - ACP (Agent Client Protocol, JSON-RPC 2.0 over stdio): `initialize`,
 *     `session/new`, `session/prompt`, `session/update`,
 *     `session/request_permission`, `session/cancel`.
 *   - The Claude-Code compatible streaming fallback: `system` / `assistant` /
 *     `stream_event` / `result` lines.
 *
 * The live section at the bottom runs the real binary when it is installed on
 * the host (trivial "reply PONG" prompt, no tools, 60 s budget). The binary was
 * not installed on the authoring host, so that part is skipped there.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGY_BINARY,
  AGY_PROTOCOL_ENV,
  AgyAdapter,
  createAgyAdapter,
  detectAgyProtocol,
  probeAgyAcpSupport,
} from "../../src/adapters/agy.ts";
import type { NormalizedEvent } from "../../src/adapter-types.ts";

// --------------------------------------------------------------- fixtures

/** PATH of the current process (empty when unavailable). */
function pathEnv(): string {
  const proc = (
    globalThis as unknown as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process;
  return proc?.env?.PATH ?? "";
}

const ACP_SESSION_ID = "agy-session-0001";

const ACP_INITIALIZE_RESULT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: true },
    },
  },
});

const ACP_SESSION_NEW_RESULT = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  result: { sessionId: ACP_SESSION_ID },
});

const ACP_AGENT_MESSAGE_CHUNK = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: ACP_SESSION_ID,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "PONG" },
    },
  },
});

const ACP_TOOL_CALL = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: ACP_SESSION_ID,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "Read notes.md",
      kind: "read",
      status: "pending",
      rawInput: { path: "notes.md" },
    },
  },
});

const ACP_TOOL_CALL_UPDATE = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: ACP_SESSION_ID,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
    },
  },
});

const ACP_TOOL_CALL_FAILED = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: ACP_SESSION_ID,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-2",
      status: "failed",
    },
  },
});

const ACP_PERMISSION_REQUEST = JSON.stringify({
  jsonrpc: "2.0",
  id: 7,
  method: "session/request_permission",
  params: {
    sessionId: ACP_SESSION_ID,
    toolCall: { toolCallId: "call-3", title: "Run shell command", kind: "execute" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  },
});

const ACP_PROMPT_RESULT = JSON.stringify({
  jsonrpc: "2.0",
  id: 3,
  result: { stopReason: "end_turn" },
});

const ACP_PROMPT_CANCELLED = JSON.stringify({
  jsonrpc: "2.0",
  id: 4,
  result: { stopReason: "cancelled" },
});

const ACP_ERROR_RESPONSE = JSON.stringify({
  jsonrpc: "2.0",
  id: 5,
  error: { code: -32601, message: "method not found" },
});

const STREAM_JSON_INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: ACP_SESSION_ID,
  model: "gemini-test-model",
  tools: [],
});

const STREAM_JSON_ASSISTANT = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg-1",
    role: "assistant",
    model: "gemini-test-model",
    content: [{ type: "text", text: "PONG" }],
  },
  session_id: ACP_SESSION_ID,
});

const STREAM_JSON_TOOL_USE = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg-2",
    role: "assistant",
    content: [
      { type: "tool_use", id: "tool-1", name: "list_files", input: { path: "." } },
    ],
  },
  session_id: ACP_SESSION_ID,
});

const STREAM_JSON_STREAM_EVENT = JSON.stringify({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text: "PO" } },
  session_id: ACP_SESSION_ID,
});

const STREAM_JSON_RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 120,
  num_turns: 1,
  result: "PONG",
  session_id: ACP_SESSION_ID,
  usage: { input_tokens: 11, output_tokens: 3 },
});

const STREAM_JSON_ERROR = JSON.stringify({
  type: "error",
  error: { message: "model unavailable" },
});

// ------------------------------------------------------------------- spawn

test("spawn: ACP mode builds `agy --acp`", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });
  const spec = adapter.spawn({ cwd: "/tmp/work" });
  assert.deepEqual(spec.command, ["agy", "--acp"]);
  assert.equal(spec.cwd, "/tmp/work");
  assert.equal(typeof spec.env.PATH, "string");
});

test("spawn: ACP mode appends the requested model", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });
  const spec = adapter.spawn({ cwd: "/tmp/work", model: "gemini-test-model" });
  assert.deepEqual(spec.command, ["agy", "--acp", "--model", "gemini-test-model"]);
});

test("spawn: stream-json fallback builds `agy -p --output-format stream-json`", () => {
  const adapter = createAgyAdapter({ protocol: "stream-json" });
  const spec = adapter.spawn({ cwd: "/tmp/work" });
  assert.deepEqual(spec.command, ["agy", "-p", "--output-format", "stream-json"]);
  assert.equal(spec.cwd, "/tmp/work");
});

test("spawn: stream-json fallback carries model, system prompt and resume id", () => {
  const adapter = createAgyAdapter({ protocol: "stream-json" });
  const spec = adapter.spawn({
    cwd: "/tmp/work",
    model: "gemini-test-model",
    systemPrompt: "be brief",
    resumeProviderSessionId: ACP_SESSION_ID,
  });
  assert.deepEqual(spec.command, [
    "agy",
    "-p",
    "--output-format",
    "stream-json",
    "--append-system-prompt",
    "be brief",
    "--resume",
    ACP_SESSION_ID,
    "--model",
    "gemini-test-model",
  ]);
});

test("spawn: no secret ever reaches argv", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });
  const spec = adapter.spawn({ cwd: "/tmp/work" });
  for (const argument of spec.command) {
    assert.doesNotMatch(argument, /token|secret|key=/i);
  }
});

test("kind and family", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });
  assert.equal(adapter.kind, "agy");
  assert.equal(adapter.family, "gemini");
});

// --------------------------------------------------------------- handshake

test("handshake: ACP mode opens the session with initialize + session/new", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });
  const messages = adapter.handshake({ cwd: "/tmp/work" }) as Array<
    Record<string, unknown>
  >;
  assert.equal(messages.length, 2);

  const [initialize, open] = messages;
  assert.equal(initialize.jsonrpc, "2.0");
  assert.equal(initialize.method, "initialize");
  const initParams = initialize.params as Record<string, unknown>;
  assert.equal(initParams.protocolVersion, 1);

  assert.equal(open.method, "session/new");
  assert.equal(open.id, 2);
  const openParams = open.params as Record<string, unknown>;
  assert.equal(openParams.cwd, "/tmp/work");
  assert.deepEqual(openParams.mcpServers, []);
});

test("handshake: ACP mode resumes with session/load", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });
  const messages = adapter.handshake({
    cwd: "/tmp/work",
    resumeProviderSessionId: ACP_SESSION_ID,
  }) as Array<Record<string, unknown>>;
  const open = messages[1];
  assert.equal(open.method, "session/load");
  const params = open.params as Record<string, unknown>;
  assert.equal(params.sessionId, ACP_SESSION_ID);
});

test("handshake: ACP mode carries model/effort/system prompt in _meta", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });
  const messages = adapter.handshake({
    cwd: "/tmp/work",
    model: "gemini-test-model",
    effort: "high",
    systemPrompt: "be brief",
  }) as Array<Record<string, unknown>>;
  const params = messages[1].params as Record<string, unknown>;
  const meta = params._meta as { volto: Record<string, unknown> };
  assert.equal(meta.volto.model, "gemini-test-model");
  assert.equal(meta.volto.effort, "high");
  assert.equal(meta.volto.systemPrompt, "be brief");
});

test("handshake: stream-json fallback needs no handshake", () => {
  const adapter = createAgyAdapter({ protocol: "stream-json" });
  assert.deepEqual(adapter.handshake({ cwd: "/tmp/work" }), []);
});

// ------------------------------------------------------------------ prompt

test("prompt: ACP mode wraps the text in session/prompt", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });
  const message = adapter.prompt("reply PONG", {
    providerSessionId: ACP_SESSION_ID,
  }) as Record<string, unknown>;
  assert.equal(message.jsonrpc, "2.0");
  assert.equal(message.method, "session/prompt");
  const params = message.params as Record<string, unknown>;
  assert.equal(params.sessionId, ACP_SESSION_ID);
  assert.deepEqual(params.prompt, [{ type: "text", text: "reply PONG" }]);
});

test("prompt: stream-json fallback writes the plain prompt", () => {
  const adapter = createAgyAdapter({ protocol: "stream-json" });
  assert.equal(adapter.prompt("reply PONG", {}), "reply PONG");
});

// ------------------------------------------------------------------ cancel

test("cancel: ACP mode sends the session/cancel notification", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });
  const messages = adapter.cancel({ providerSessionId: ACP_SESSION_ID }) as Array<
    Record<string, unknown>
  >;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].jsonrpc, "2.0");
  assert.equal(messages[0].method, "session/cancel");
  assert.equal(messages[0].id, undefined);
  const params = messages[0].params as Record<string, unknown>;
  assert.equal(params.sessionId, ACP_SESSION_ID);
});

test("cancel: stream-json fallback only supports signals", () => {
  const adapter = createAgyAdapter({ protocol: "stream-json" });
  assert.deepEqual(adapter.cancel({ providerSessionId: ACP_SESSION_ID }), []);
});

// -------------------------------------------------------- answerPermission

test("answerPermission: ACP mode selects the allow option", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });
  const events = adapter.parse(ACP_PERMISSION_REQUEST);
  assert.equal(events.length, 1);
  const permission = events[0];
  assert.equal(permission.kind, "permission");
  assert.equal(permission.kind === "permission" ? permission.id : "", "7");

  const answer = adapter.answerPermission("7", true) as Record<string, unknown>;
  assert.equal(answer.jsonrpc, "2.0");
  assert.equal(answer.id, 7);
  const result = answer.result as { outcome: { outcome: string; optionId: string } };
  assert.equal(result.outcome.outcome, "selected");
  assert.equal(result.outcome.optionId, "allow-once");
});

test("answerPermission: ACP mode selects the reject option", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });
  adapter.parse(ACP_PERMISSION_REQUEST);
  const answer = adapter.answerPermission("7", false) as Record<string, unknown>;
  const result = answer.result as { outcome: { optionId: string } };
  assert.equal(result.outcome.optionId, "reject-once");
});

test("answerPermission: unknown id and stream-json fallback answer nothing", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });
  assert.equal(adapter.answerPermission("does-not-exist", true), null);

  const fallback = createAgyAdapter({ protocol: "stream-json" });
  assert.equal(fallback.answerPermission("7", true), null);
});

// ------------------------------------------------------------------- parse

test("parse: ACP session lifecycle", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });

  assert.deepEqual(adapter.parse(ACP_INITIALIZE_RESULT), [{ kind: "ready" }]);
  assert.deepEqual(adapter.parse(ACP_SESSION_NEW_RESULT), [
    { kind: "ready", providerSessionId: ACP_SESSION_ID },
  ]);
  assert.deepEqual(adapter.parse(ACP_AGENT_MESSAGE_CHUNK), [
    { kind: "text", delta: "PONG" },
  ]);
});

test("parse: ACP tool calls", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });

  assert.deepEqual(adapter.parse(ACP_TOOL_CALL), [
    {
      kind: "tool",
      name: "Read notes.md",
      status: "start",
      summary: '{"path":"notes.md"}',
    },
  ]);
  assert.deepEqual(adapter.parse(ACP_TOOL_CALL_UPDATE), [
    { kind: "tool", name: "Read notes.md", status: "end" },
  ]);
  assert.deepEqual(adapter.parse(ACP_TOOL_CALL_FAILED), [
    { kind: "tool", name: "tool", status: "error" },
  ]);
});

test("parse: ACP prompt result and error response", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });

  assert.deepEqual(adapter.parse(ACP_PROMPT_RESULT), [
    { kind: "turn_end", status: "ok" },
  ]);
  assert.deepEqual(adapter.parse(ACP_PROMPT_CANCELLED), [
    { kind: "turn_end", status: "cancelled" },
  ]);
  assert.deepEqual(adapter.parse(ACP_ERROR_RESPONSE), [
    { kind: "error", message: "method not found" },
  ]);
});

test("parse: stream-json lifecycle", () => {
  const adapter = createAgyAdapter({ protocol: "stream-json" });

  assert.deepEqual(adapter.parse(STREAM_JSON_INIT), [
    { kind: "ready", providerSessionId: ACP_SESSION_ID },
  ]);
  assert.deepEqual(adapter.parse(STREAM_JSON_ASSISTANT), [
    { kind: "text", delta: "PONG" },
  ]);
  assert.deepEqual(adapter.parse(STREAM_JSON_STREAM_EVENT), [
    { kind: "text", delta: "PO" },
  ]);
  assert.deepEqual(adapter.parse(STREAM_JSON_RESULT), [
    {
      kind: "turn_end",
      status: "ok",
      usage: { inputTokens: 11, outputTokens: 3 },
    },
  ]);
  assert.deepEqual(adapter.parse(STREAM_JSON_ERROR), [
    { kind: "error", message: "model unavailable" },
  ]);
});

test("parse: stream-json tool use", () => {
  const adapter = createAgyAdapter({ protocol: "stream-json" });
  assert.deepEqual(adapter.parse(STREAM_JSON_TOOL_USE), [
    {
      kind: "tool",
      name: "list_files",
      status: "start",
      summary: '{"path":"."}',
    },
  ]);
});

test("parse: unknown lines become raw events", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });

  assert.deepEqual(adapter.parse('{"type":"something_new","payload":42}'), [
    { kind: "raw", payload: { type: "something_new", payload: 42 } },
  ]);
  assert.deepEqual(adapter.parse("not json at all"), [
    { kind: "raw", payload: "not json at all" },
  ]);
  assert.deepEqual(adapter.parse("[1,2,3]"), [{ kind: "raw", payload: [1, 2, 3] }]);
  assert.deepEqual(adapter.parse("null"), [{ kind: "raw", payload: null }]);
  assert.deepEqual(adapter.parse("42"), [{ kind: "raw", payload: 42 }]);
});

test("parse: never throws and ignores blank lines", () => {
  const adapter = createAgyAdapter({ protocol: "acp" });
  const nasty = [
    "",
    "   ",
    "{",
    '{"jsonrpc":"2.0"',
    '{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call"}}}',
    '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update"}}}',
    '{"jsonrpc":"2.0","method":"session/update","params":null}',
    '{"jsonrpc":"2.0","id":1,"result":{"stopReason":42}}',
    '{"jsonrpc":"2.0","id":1,"result":[1,2]}',
    '{"type":"assistant","message":{"content":"not-an-array"}}',
    '{"type":"result","usage":"nope"}',
    "",
  ];
  for (const line of nasty) {
    const events = adapter.parse(line);
    assert.ok(Array.isArray(events));
    for (const event of events) {
      assert.ok(
        ["ready", "text", "tool", "permission", "turn_end", "error", "raw"].includes(
          event.kind,
        ),
      );
    }
  }
  assert.deepEqual(adapter.parse(""), []);
});

// ------------------------------------------------------- protocol detection

test("detectAgyProtocol: the environment variable pins the protocol", () => {
  assert.equal(detectAgyProtocol({ [AGY_PROTOCOL_ENV]: "acp" }), "acp");
  assert.equal(detectAgyProtocol({ [AGY_PROTOCOL_ENV]: "stream-json" }), "stream-json");
  assert.equal(detectAgyProtocol({ [AGY_PROTOCOL_ENV]: "STREAM_JSON" }), "stream-json");
});

test("detectAgyProtocol: a missing binary falls back to stream-json", () => {
  assert.equal(detectAgyProtocol({ PATH: "" }), "stream-json");
});

test("probeAgyAcpSupport: reads the ACP flag out of `agy --help`", () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const tmp = mkdtempSync(path.join(root, ".tmp", "agy-probe-"));
  try {
    const withAcp = path.join(tmp, "with-acp");
    const withoutAcp = path.join(tmp, "without-acp");
    mkdirSync(withAcp);
    mkdirSync(withoutAcp);

    const acpScript = path.join(withAcp, AGY_BINARY);
    writeFileSync(acpScript, "#!/bin/sh\necho 'Usage: agy [--acp]'\n");
    chmodSync(acpScript, 0o755);

    const plainScript = path.join(withoutAcp, AGY_BINARY);
    writeFileSync(plainScript, "#!/bin/sh\necho 'Usage: agy -p --output-format stream-json'\n");
    chmodSync(plainScript, 0o755);

    assert.equal(
      probeAgyAcpSupport({ PATH: `${withAcp}:${pathEnv()}` }),
      true,
    );
    assert.equal(
      probeAgyAcpSupport({ PATH: `${withoutAcp}:${pathEnv()}` }),
      false,
    );
    assert.equal(detectAgyProtocol({ PATH: `${withAcp}:${pathEnv()}` }), "acp");
    assert.equal(
      detectAgyProtocol({ PATH: `${withoutAcp}:${pathEnv()}` }),
      "stream-json",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("adapter instances expose the protocol they use", () => {
  assert.equal(new AgyAdapter({ protocol: "acp" }).protocol, "acp");
  assert.equal(new AgyAdapter({ protocol: "stream-json" }).protocol, "stream-json");
});

// --------------------------------------------------------------- live check

/** Minimal shape of the child process streams used below. */
interface ByteStream {
  setEncoding(encoding: string): void;
  on(event: string, listener: (chunk: string) => void): void;
  resume(): void;
}

function agyIsInstalled(): boolean {
  const probe = spawnSync(AGY_BINARY, ["--help"], {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return !probe.error;
}

class LineSource {
  #lines: string[] = [];
  #buffer = "";
  #onLine: (line: string) => void;

  constructor(stream: ByteStream, onLine: (line: string) => void) {
    this.#onLine = onLine;
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let index = this.#buffer.indexOf("\n");
      while (index >= 0) {
        const line = this.#buffer.slice(0, index).trim();
        this.#buffer = this.#buffer.slice(index + 1);
        if (line !== "") {
          this.#lines.push(line);
          this.#onLine(line);
        }
        index = this.#buffer.indexOf("\n");
      }
    });
  }

  async waitFor(
    predicate: (line: string) => boolean,
    timeoutMs: number,
  ): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = this.#lines.shift();
      if (line !== undefined) {
        if (predicate(line)) return line;
        continue;
      }
      if (Date.now() > deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function parseJsonRpcId(line: string): number | undefined {
  try {
    const parsed = JSON.parse(line) as { id?: unknown };
    return typeof parsed.id === "number" ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

function sessionIdOf(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as {
      result?: { sessionId?: unknown };
      params?: { sessionId?: unknown };
    };
    const candidate = parsed.result?.sessionId ?? parsed.params?.sessionId;
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

test("live: the real agy binary answers a trivial prompt", async (t) => {
  if (process.env.BOTD_LIVE !== "1" || !agyIsInstalled()) {
    t.skip("live checks are opt-in (BOTD_LIVE=1) and need the agy binary installed");
    return;
  }

  const cwd = fileURLToPath(new URL("../../..", import.meta.url));
  const protocol = detectAgyProtocol();
  const adapter = createAgyAdapter({ protocol });
  const spec = adapter.spawn({ cwd });
  const events: NormalizedEvent[] = [];

  const child = spawn(spec.command[0], spec.command.slice(1), {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const source = new LineSource(child.stdout as unknown as ByteStream, (line) => {
    events.push(...adapter.parse(line));
  });
  child.stderr.resume();

  const budget = 60_000;
  let stdinClosed = false;
  const closeStdin = () => {
    if (stdinClosed) return;
    stdinClosed = true;
    child.stdin.end();
  };

  if (protocol === "acp") {
    const [initialize, open] = adapter.handshake({ cwd }) as Array<
      Record<string, unknown>
    >;
    child.stdin.write(`${JSON.stringify(initialize)}\n`);
    await source.waitFor(
      (line) => parseJsonRpcId(line) === initialize.id,
      budget / 2,
    );
    child.stdin.write(`${JSON.stringify(open)}\n`);
    const sessionLine = await source.waitFor(
      (line) => sessionIdOf(line) !== undefined,
      budget / 2,
    );
    const sessionId = sessionLine ? sessionIdOf(sessionLine) : undefined;
    child.stdin.write(
      `${JSON.stringify(adapter.prompt("reply PONG", { providerSessionId: sessionId }))}\n`,
    );
    await source.waitFor((line) => line.includes("stopReason"), budget / 2);
    closeStdin();
  } else {
    child.stdin.write("reply PONG\n");
    closeStdin();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, budget);
      child.on("close", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }

  closeStdin();
  child.kill();

  assert.ok(events.length > 0, "the live run produced no normalized event");
  const kinds = events.map((event) => event.kind);
  assert.ok(
    kinds.includes("text") || kinds.includes("turn_end") || kinds.includes("error"),
    `unexpected live events: ${JSON.stringify(events)}`,
  );
});
