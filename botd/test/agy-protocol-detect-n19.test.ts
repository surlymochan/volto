import assert from "node:assert/strict";
import { test } from "node:test";

import { AGY_BINARY, AGY_PROTOCOL_ENV, inheritedEnv } from "../src/adapters/agy.ts";

test("agy exposes its binary and protocol environment names", () => {
  assert.equal(AGY_BINARY, "agy");
  assert.equal(AGY_PROTOCOL_ENV, "VOLTO_AGY_PROTOCOL");
});

test("inheritedEnv retains arbitrary string keys, including a synthetic sentinel", () => {
  const source = { PATH: "synthetic-path", SENTINEL: "synthetic-secret", OMIT: undefined };
  assert.deepEqual(inheritedEnv(source), {
    PATH: "synthetic-path",
    SENTINEL: "synthetic-secret",
  });
});
