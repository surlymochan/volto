import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { DEFAULT_CONFIG, loadConfig, sessionTablePath } from "../src/config.ts";

const knobs = [
  { flag: "lease-ttl-ms", env: "BOTD_LEASE_TTL_MS", field: "leaseTtlMs" },
  { flag: "ring-max-events", env: "BOTD_RING_MAX_EVENTS", field: "ringMaxEvents" },
  { flag: "ring-max-bytes", env: "BOTD_RING_MAX_BYTES", field: "ringMaxBytes" },
  { flag: "idle-ms", env: "BOTD_IDLE_MS", field: "idleAfterMs" },
  { flag: "stall-ms", env: "BOTD_STALL_MS", field: "stallMs" },
  { flag: "watchdog-ms", env: "BOTD_WATCHDOG_MS", field: "watchdogIntervalMs" },
  { flag: "cancel-grace-ms", env: "BOTD_CANCEL_GRACE_MS", field: "cancelGraceMs" },
  { flag: "cancel-kill-grace-ms", env: "BOTD_CANCEL_KILL_GRACE_MS", field: "cancelKillGraceMs" },
  { flag: "terminate-grace-ms", env: "BOTD_TERMINATE_GRACE_MS", field: "terminateGraceMs" },
] as const;

for (const knob of knobs) {
  test(`${knob.flag} uses the last duplicate and falls back when it is invalid`, () => {
    const env = { [knob.env]: "31" };
    assert.equal(loadConfig([`--${knob.flag}=11`, `--${knob.flag}=22`], env)[knob.field], 22);
    assert.equal(loadConfig([`--${knob.flag}=11`, `--${knob.flag}`], env)[knob.field], 11);
    for (const value of ["", " \t ", "abc", "NaN", "Infinity"]) {
      const flags = [`--${knob.flag}=11`, `--${knob.flag}=${value}`];
      assert.equal(loadConfig(flags, env)[knob.field], 31, value);
      assert.equal(loadConfig(flags, { [knob.env]: value })[knob.field], DEFAULT_CONFIG[knob.field], value);
    }
  });
}

test("relative store file selects the session table even with a relative home", () => {
  const home = ".tmp/config-home";
  const store = ".tmp/config-store/sessions.json";
  const config = loadConfig([`--home=${home}`, `--store-file=${store}`], {});
  assert.equal(sessionTablePath(config), path.resolve(store));
  const withoutStore = loadConfig([`--home=${home}`], {});
  assert.equal(sessionTablePath(withoutStore), path.join(path.resolve(home), "sessions.json"));
});

test("loading and modifying configurations leaves defaults and other loads unchanged", () => {
  const snapshot = { ...DEFAULT_CONFIG };
  const flags = knobs.map((knob) => `--${knob.flag}=123`);
  const first = loadConfig([...flags, "--home=.tmp/config-home", "--store-file=.tmp/table.json"], {});
  assert.deepEqual(DEFAULT_CONFIG, snapshot);
  first.leaseTtlMs = 456;
  first.home = ".tmp/changed";
  assert.deepEqual(DEFAULT_CONFIG, snapshot);
  assert.deepEqual(loadConfig([], {}), snapshot);
});
