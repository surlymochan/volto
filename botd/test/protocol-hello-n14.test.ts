import test from "node:test";
import assert from "node:assert/strict";

import { parseClientFrame } from "../src/protocol.ts";

test("hello parsing preserves an unsupported positive version for negotiation", () => {
  const frame = { op: "hello", clientId: "client-a", v: 2 };
  assert.deepEqual(parseClientFrame(frame), { ok: true, frame });
});

test("hello parsing leaves an omitted version absent", () => {
  const frame = { op: "hello", clientId: "client-a" };
  assert.deepEqual(parseClientFrame(frame), { ok: true, frame });
});

test("hello parsing accepts a numeric version but rejects its string form", () => {
  const frame = { op: "hello", clientId: "client-a", v: 1 };
  assert.deepEqual(parseClientFrame(frame), { ok: true, frame });
  assert.deepEqual(parseClientFrame({ ...frame, v: "1" }), {
    ok: false, message: "hello.v must be a positive integer",
  });
});

test("hello parsing ignores unknown fields", () => {
  assert.deepEqual(parseClientFrame({ op: "hello", clientId: "client-a", v: 1, future: true }), {
    ok: true, frame: { op: "hello", clientId: "client-a", v: 1 },
  });
});
