import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock, test } from "node:test";
import {
  AGY_PROTOCOL_ENV,
  createAgyAdapter,
  defaultEnv,
  detectAgyProtocol,
  inheritedEnv,
  probeAgyAcpSupport,
} from "../../src/adapters/agy.ts";

test("probe uses filtered environment and recognizes ACP as a whole word", () => {
  const calls: unknown[][] = [];
  let help = "Usage: agy --ACP";
  const probe = mock.method(childProcess, "execFileSync", (...args: unknown[]) => {
    calls.push(args);
    return help;
  });
  syncBuiltinESMExports();
  try {
    assert.equal(probeAgyAcpSupport({ PATH: "/synthetic", EMPTY: "", OMIT: undefined }), true);
    assert.deepEqual(calls[0], ["agy", ["--help"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: "/synthetic", EMPTY: "" },
    }]);
    help = "acprefix";
    assert.equal(probeAgyAcpSupport({}), false);
  } finally {
    probe.mock.restore();
    syncBuiltinESMExports();
  }
});

test("detection normalizes overrides and otherwise uses the injected probe", () => {
  let help = "supports ACP";
  let calls = 0;
  const probe = mock.method(childProcess, "execFileSync", () => {
    calls++;
    if (help === "throw") throw new Error("synthetic failure");
    return help;
  });
  syncBuiltinESMExports();
  try {
    assert.equal(detectAgyProtocol({ [AGY_PROTOCOL_ENV]: "  AcP  " }), "acp");
    assert.equal(detectAgyProtocol({ [AGY_PROTOCOL_ENV]: " STREAM_JSON " }), "stream-json");
    assert.equal(calls, 0);
    assert.equal(detectAgyProtocol({ [AGY_PROTOCOL_ENV]: "unknown" }), "acp");
    help = "no protocol here";
    assert.equal(detectAgyProtocol({}), "stream-json");
    help = "throw";
    assert.equal(probeAgyAcpSupport({}), false);
    assert.equal(detectAgyProtocol({}), "stream-json");
    assert.equal(calls, 4);
  } finally {
    probe.mock.restore();
    syncBuiltinESMExports();
  }
});

test("environment helpers copy only strings and default to the process environment", () => {
  assert.equal(defaultEnv(), process.env);
  const source = { KEEP: "value", EMPTY: "", OMIT: undefined };
  const copy = inheritedEnv(source);
  assert.deepEqual(copy, { KEEP: "value", EMPTY: "" });
  assert.notEqual(copy, source);
  assert.deepEqual(inheritedEnv(), inheritedEnv(process.env));
});

test("spawn specs use the configured environment and protocol-specific options", () => {
  const env = { [AGY_PROTOCOL_ENV]: "acp", SYNTHETIC: "yes", OMIT: undefined };
  const opts = { cwd: "/synthetic/work", model: "model", systemPrompt: "prompt", resumeProviderSessionId: "session" };
  const acp = createAgyAdapter({ env }).spawn(opts);
  assert.deepEqual(acp, {
    command: ["agy", "--acp", "--model", "model"],
    env: { [AGY_PROTOCOL_ENV]: "acp", SYNTHETIC: "yes" },
    cwd: opts.cwd,
  });
  const stream = createAgyAdapter({ protocol: "stream-json", env }).spawn({ ...opts, systemPrompt: "", resumeProviderSessionId: "" });
  assert.deepEqual(stream, {
    command: ["agy", "-p", "--output-format", "stream-json", "--model", "model"],
    env: { [AGY_PROTOCOL_ENV]: "acp", SYNTHETIC: "yes" },
    cwd: opts.cwd,
  });
});

test("single-shot responses and plain text chunks map to events", () => {
  const adapter = createAgyAdapter({ protocol: "acp", env: {} });
  assert.deepEqual(adapter.parse(JSON.stringify({ response: "hello", stats: { inputTokens: 3, outputTokens: 2 } })), [
    { kind: "text", delta: "hello" },
    { kind: "turn_end", status: "ok", usage: { inputTokens: 3, outputTokens: 2 } },
  ]);
  assert.deepEqual(adapter.parse('{"response":""}'), [{ kind: "turn_end", status: "ok" }]);
  assert.deepEqual(adapter.parse('{"text":"chunk"}'), [{ kind: "text", delta: "chunk" }]);
  assert.deepEqual(adapter.parse('{"type":"result","result":"final"}'), [{ kind: "turn_end", status: "ok" }]);
});

test("parse returns the original input when an unexpected error occurs", () => {
  const adapter = createAgyAdapter({ protocol: "acp", env: {} });
  const input = { trim() { throw new Error("synthetic failure"); } } as unknown as string;
  assert.deepEqual(adapter.parse(input), [{ kind: "raw", payload: input }]);
});
