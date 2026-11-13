// Tests for the botd frame validation.
//
// Frames come from an untrusted client, so every field is checked before it
// reaches the daemon.

import test from "node:test";
import assert from "node:assert/strict";

import { parseClientFrame, BOT_KINDS } from "../src/protocol.ts";
import type { ClientFrame } from "../src/protocol.ts";

function parse(raw: unknown): ClientFrame {
  const result = parseClientFrame(raw);
  assert.equal(result.ok, true, `expected a frame, got ${JSON.stringify(result)}`);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.frame;
}

function rejects(raw: unknown): string {
  const result = parseClientFrame(raw);
  assert.equal(result.ok, false, `expected a rejection, got ${JSON.stringify(result)}`);
  if (result.ok) throw new Error("unreachable");
  return result.message;
}

test("parses a hello frame", () => {
  const frame = parse({ op: "hello", clientId: "client-a", leaseTtlMs: 5000 });
  assert.deepEqual(frame, { op: "hello", clientId: "client-a", leaseTtlMs: 5000 });
});

test("rejects a hello without a client id", () => {
  assert.match(rejects({ op: "hello" }), /clientId/);
});

test("rejects a hello with a bogus ttl", () => {
  assert.match(rejects({ op: "hello", clientId: "c", leaseTtlMs: "soon" }), /leaseTtlMs/);
  assert.match(rejects({ op: "hello", clientId: "c", leaseTtlMs: 0 }), /leaseTtlMs/);
});

test("parses an open frame", () => {
  const frame = parse({
    op: "open",
    sid: "s1",
    bot: { kind: "acp", command: ["bot", "--stdio"], cwd: "/tmp" },
    resume: { providerSessionId: "prov-1" },
  });
  assert.equal(frame.op, "open");
  if (frame.op !== "open") throw new Error("unreachable");
  assert.equal(frame.sid, "s1");
  assert.deepEqual(frame.bot, { kind: "acp", command: ["bot", "--stdio"], cwd: "/tmp" });
  assert.deepEqual(frame.resume, { providerSessionId: "prov-1" });
});

test("rejects an open frame with an unknown bot kind", () => {
  assert.match(
    rejects({ op: "open", sid: "s1", bot: { kind: "nope", command: ["bot"] } }),
    /bot.kind/,
  );
});

test("rejects an open frame without a command", () => {
  assert.match(rejects({ op: "open", sid: "s1", bot: { kind: "acp", command: [] } }), /command/);
  assert.match(rejects({ op: "open", sid: "s1", bot: { kind: "acp" } }), /command/);
});

test("knows every bot kind", () => {
  assert.deepEqual([...BOT_KINDS], ["acp", "codex-app-server", "pi-rpc"]);
});

test("parses send, cancel, ack, close and resume", () => {
  const send = parse({ op: "send", sid: "s1", payload: { jsonrpc: "2.0", method: "x" } });
  assert.deepEqual(send, { op: "send", sid: "s1", payload: { jsonrpc: "2.0", method: "x" } });

  const cancel = parse({ op: "cancel", sid: "s1", payload: { method: "session/cancel" } });
  assert.deepEqual(cancel, { op: "cancel", sid: "s1", payload: { method: "session/cancel" } });

  const bareCancel = parse({ op: "cancel", sid: "s1" });
  assert.deepEqual(bareCancel, { op: "cancel", sid: "s1" });

  assert.deepEqual(parse({ op: "ack", sid: "s1", seq: 4 }), { op: "ack", sid: "s1", seq: 4 });
  assert.deepEqual(parse({ op: "close", sid: "s1" }), { op: "close", sid: "s1" });
  assert.deepEqual(parse({ op: "resume", sid: "s1", fromSeq: 7 }), {
    op: "resume",
    sid: "s1",
    fromSeq: 7,
  });
});

test("rejects frames without a session id", () => {
  assert.match(rejects({ op: "send", payload: {} }), /sid/);
  assert.match(rejects({ op: "cancel" }), /sid/);
  assert.match(rejects({ op: "ack", sid: "s1" }), /seq/);
  assert.match(rejects({ op: "resume", sid: "s1", fromSeq: 0 }), /fromSeq/);
});

test("rejects unknown ops and non objects", () => {
  assert.match(rejects({ op: "explode" }), /unknown op/);
  assert.match(rejects("hello"), /JSON object/);
  assert.match(rejects([1, 2, 3]), /JSON object/);
});
