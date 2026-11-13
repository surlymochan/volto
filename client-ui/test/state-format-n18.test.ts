import assert from "node:assert/strict";
import test from "node:test";

import type { RemoteBot } from "../src/client.ts";
import { formatLease, formatQuota } from "../src/state.ts";

const bot: RemoteBot = {
  id: "bot-1",
  host: "example",
  kind: "codex",
  family: "gpt",
  lane: "primary",
  status: "idle",
  leaseExpiresAt: null,
  quotaUsedPct: 0,
  sessionId: null,
};

test("an expired lease formats as zero", () => {
  assert.equal(formatLease({ ...bot, leaseExpiresAt: 1000 }, 2000), "0:00");
});

test("lease formatting rounds up partial seconds", () => {
  assert.equal(formatLease({ ...bot, leaseExpiresAt: 61_000 }, 0), "1:01");
  assert.equal(formatLease({ ...bot, leaseExpiresAt: 59_001 }, 0), "1:00");
});

test("quota formatting rounds percentages", () => {
  assert.equal(formatQuota({ ...bot, quotaUsedPct: 41.5 }), "42%");
  assert.equal(formatQuota(bot), "0%");
  assert.equal(formatQuota({ ...bot, quotaUsedPct: 100.4 }), "100%");
});
