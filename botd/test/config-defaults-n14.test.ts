import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

const NUMERIC_ENV = [
  { env: "BOTD_LEASE_TTL_MS", field: "leaseTtlMs" },
  { env: "BOTD_RING_MAX_EVENTS", field: "ringMaxEvents" },
  { env: "BOTD_RING_MAX_BYTES", field: "ringMaxBytes" },
  { env: "BOTD_IDLE_MS", field: "idleAfterMs" },
  { env: "BOTD_STALL_MS", field: "stallMs" },
  { env: "BOTD_WATCHDOG_MS", field: "watchdogIntervalMs" },
  { env: "BOTD_CANCEL_GRACE_MS", field: "cancelGraceMs" },
  { env: "BOTD_CANCEL_KILL_GRACE_MS", field: "cancelKillGraceMs" },
  { env: "BOTD_TERMINATE_GRACE_MS", field: "terminateGraceMs" },
] as const;

test("empty environment values use defaults", () => {
  for (const knob of NUMERIC_ENV) {
    assert.equal(loadConfig([], { [knob.env]: "" })[knob.field], DEFAULT_CONFIG[knob.field]);
  }
  assert.equal(loadConfig([], { BOTD_STORE_FILE: "" }).storeFile, DEFAULT_CONFIG.storeFile);
});

test("numeric environment values accept finite numbers and ignore invalid values", () => {
  for (const knob of NUMERIC_ENV) {
    for (const [value, expected] of [["-1", -1], ["0", 0]] as const) {
      assert.equal(loadConfig([], { [knob.env]: value })[knob.field], expected, knob.env);
    }
    assert.equal(loadConfig([], { [knob.env]: "abc" })[knob.field], DEFAULT_CONFIG[knob.field]);
  }
});

test("loading configuration leaves the environment and defaults unchanged", () => {
  const env = { BOTD_LEASE_TTL_MS: "0", BOTD_STORE_FILE: "./table.json", OTHER: undefined };
  const before = { ...env };
  const defaults = { ...DEFAULT_CONFIG };
  loadConfig([], env);
  assert.deepEqual(env, before);
  assert.deepEqual(DEFAULT_CONFIG, defaults);
});
