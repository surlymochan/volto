import test from "node:test";
import assert from "node:assert/strict";

import { BOT_KINDS, SESSION_STATES, parseClientFrame } from "../src/protocol.ts";

const rejected: { name: string; raw: unknown; message: string }[] = [
  { name: "unknown op", raw: { op: "greet" }, message: 'unknown op "greet"' },
  { name: "missing send payload", raw: { op: "send", sid: "s" }, message: "send requires a payload" },
  { name: "missing renew lease", raw: { op: "renew", fence: 1 }, message: "renew requires a leaseId" },
  { name: "missing close sid", raw: { op: "close" }, message: "close requires a sid" },
  { name: "numeric client id", raw: { op: "hello", clientId: 7 }, message: "hello requires a non-empty clientId" },
  { name: "numeric sid", raw: { op: "close", sid: 7 }, message: "close requires a sid" },
  { name: "string fence", raw: { op: "renew", leaseId: "l", fence: "1" }, message: "renew requires a numeric fence" },
  { name: "array bot", raw: { op: "open", sid: "s", bot: [] }, message: "bot must be an object" },
  { name: "non-string command element", raw: { op: "open", sid: "s", bot: { kind: "acp", command: [7] } }, message: "bot.command must be a non-empty array of strings" },
  { name: "near-miss bot kind", raw: { op: "open", sid: "s", bot: { kind: "acp-rpc", command: ["bot"] } }, message: `bot.kind must be one of ${BOT_KINDS.join(", ")}` },
  { name: "null frame", raw: null, message: "frame must be a JSON object" },
  { name: "number frame", raw: 7, message: "frame must be a JSON object" },
];

for (const { name, raw, message } of rejected) {
  test(`rejects ${name} with a stable reason`, () => {
    assert.deepEqual(parseClientFrame(raw), { ok: false, message });
  });
}

for (const kind of BOT_KINDS) {
  test(`accepts bot kind ${kind}`, () => {
    const frame = { op: "open", sid: "s", bot: { kind, command: ["bot"] } };
    assert.deepEqual(parseClientFrame(frame), { ok: true, frame });
  });
}

test("ignores unknown frame and nested fields", () => {
  assert.deepEqual(
    parseClientFrame({
      op: "open", sid: "s", extra: true,
      bot: { kind: "acp", command: ["bot"], extra: true },
      resume: { providerSessionId: "p", extra: true },
    }),
    { ok: true, frame: { op: "open", sid: "s", bot: { kind: "acp", command: ["bot"] }, resume: { providerSessionId: "p" } } },
  );
});

test("session states are daemon-only, including a near miss", () => {
  assert.deepEqual([...SESSION_STATES], ["starting", "running", "idle", "paused", "exited"]);
  for (const state of [...SESSION_STATES, "running-now"]) {
    assert.deepEqual(parseClientFrame({ op: "state", sid: "s", state, progressAt: 1 }), {
      ok: false, message: 'unknown op "state"',
    });
  }
});

test.todo("rejects an array in the optional open.resume object field", () => {
  assert.deepEqual(parseClientFrame({ op: "open", sid: "s", bot: { kind: "acp", command: ["bot"] }, resume: [] }), {
    ok: false, message: "open.resume must be an object",
  });
});
