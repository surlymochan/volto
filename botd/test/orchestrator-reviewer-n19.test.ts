import assert from "node:assert/strict";
import test from "node:test";

import { systemClock } from "../src/orchestrator.ts";

test("systemClock.now returns the current time in milliseconds", () => {
  const before = Date.now();
  const now = systemClock.now();
  const after = Date.now();

  assert.equal(typeof now, "number");
  assert.ok(now >= before && now <= after);
});
