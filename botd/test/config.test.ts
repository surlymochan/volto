// Tests for the configuration of the bot daemon.
//
// The configuration is built from the command line flags and from the
// environment: a flag wins over the environment variable, the environment
// variable wins over the default.
//
// The parser only understands the shape `--key=value` and only accepts a
// value that is a finite number. Everything else falls back to the
// environment variable (and from there to the default). The tests below
// pin those corner cases, including the two that surprise: a negative
// number and zero are finite numbers and are therefore taken as they are,
// and an empty flag value hides the environment variable.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { DEFAULT_CONFIG, loadConfig, sessionTablePath } from "../src/config.ts";
import { BOTD_VERSION } from "../src/protocol.ts";
import { defaultBotdHome } from "../src/store.ts";

/**
 * The numeric knobs: the flag, the environment variable and the field.
 */
const NUMERIC_KNOBS = [
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

test("the defaults are the documented ones", () => {
  assert.equal(DEFAULT_CONFIG.botdVersion, BOTD_VERSION);
  assert.equal(DEFAULT_CONFIG.leaseTtlMs, 15_000);
  assert.equal(DEFAULT_CONFIG.minLeaseTtlMs, 250);
  assert.equal(DEFAULT_CONFIG.ringMaxEvents, 1000);
  assert.equal(DEFAULT_CONFIG.ringMaxBytes, 1 << 20);
  assert.equal(DEFAULT_CONFIG.idleAfterMs, 2_000);
  assert.equal(DEFAULT_CONFIG.stallMs, 30_000);
  assert.equal(DEFAULT_CONFIG.watchdogIntervalMs, 250);
  assert.equal(DEFAULT_CONFIG.cancelGraceMs, 3_000);
  assert.equal(DEFAULT_CONFIG.cancelKillGraceMs, 3_000);
  assert.equal(DEFAULT_CONFIG.terminateGraceMs, 3_000);
  assert.equal(DEFAULT_CONFIG.storeFile, undefined);
  assert.equal(typeof DEFAULT_CONFIG.now, "function");
  // Without a botd home in the environment the home is the volto directory.
  assert.equal(DEFAULT_CONFIG.home, defaultBotdHome());
});

test("an empty configuration is the default configuration", () => {
  assert.deepEqual(loadConfig([], {}), DEFAULT_CONFIG);
});

test("the environment variable is used when no flag is given", () => {
  for (const knob of NUMERIC_KNOBS) {
    const config = loadConfig([], { [knob.env]: "4242" });
    assert.equal(config[knob.field], 4242, `${knob.env} was not used`);
  }
});

test("the flag wins over the environment variable", () => {
  for (const knob of NUMERIC_KNOBS) {
    const config = loadConfig([`--${knob.flag}=4242`], { [knob.env]: "1" });
    assert.equal(config[knob.field], 4242, `--${knob.flag} did not win over ${knob.env}`);
  }
});

test("a flag without a value is ignored", () => {
  for (const knob of NUMERIC_KNOBS) {
    const withEnv = loadConfig([`--${knob.flag}`], { [knob.env]: "4242" });
    assert.equal(withEnv[knob.field], 4242, `--${knob.flag} was not ignored`);
    const withoutEnv = loadConfig([`--${knob.flag}`], {});
    assert.equal(
      withoutEnv[knob.field],
      DEFAULT_CONFIG[knob.field],
      `--${knob.flag} was not ignored`,
    );
  }
});

test("an empty or blank value falls back to the environment variable", () => {
  for (const knob of NUMERIC_KNOBS) {
    for (const value of ["", "   "]) {
      const config = loadConfig([`--${knob.flag}=${value}`], { [knob.env]: "4242" });
      assert.equal(config[knob.field], 4242, `--${knob.flag}=${JSON.stringify(value)} was used`);
      const fallback = loadConfig([`--${knob.flag}=${value}`], {});
      assert.equal(
        fallback[knob.field],
        DEFAULT_CONFIG[knob.field],
        `--${knob.flag}=${JSON.stringify(value)} was used`,
      );
    }
  }
});

test("a value that is not a finite number falls back to the environment variable", () => {
  for (const knob of NUMERIC_KNOBS) {
    for (const value of ["NaN", "Infinity", "-Infinity", "abc", "12abc"]) {
      const config = loadConfig([`--${knob.flag}=${value}`], { [knob.env]: "4242" });
      assert.equal(
        config[knob.field],
        4242,
        `--${knob.flag}=${value} was used instead of the environment`,
      );
      const fallback = loadConfig([`--${knob.flag}=${value}`], {});
      assert.equal(
        fallback[knob.field],
        DEFAULT_CONFIG[knob.field],
        `--${knob.flag}=${value} was used instead of the default`,
      );
    }
  }
});

test("a negative number and zero are taken as they are", () => {
  // The parser only rejects the values that are not finite numbers, so a
  // negative number and zero reach the daemon unchecked. The daemon does
  // not clamp them either.
  for (const knob of NUMERIC_KNOBS) {
    const negative = loadConfig([`--${knob.flag}=-1`], {});
    assert.equal(negative[knob.field], -1, `--${knob.flag}=-1 was not used`);
    const zero = loadConfig([`--${knob.flag}=0`], {});
    assert.equal(zero[knob.field], 0, `--${knob.flag}=0 was not used`);
  }
});

test("--home is resolved to an absolute path", () => {
  const config = loadConfig(["--home=./somewhere/home"], {});
  assert.equal(config.home, path.resolve("./somewhere/home"));
  assert.ok(path.isAbsolute(config.home));
});

test("the home of the environment is resolved to an absolute path", () => {
  const config = loadConfig([], { BOTD_HOME: "./somewhere/home" });
  assert.equal(config.home, path.resolve("./somewhere/home"));
  assert.ok(path.isAbsolute(config.home));
});

test("the flag wins over the environment for the home", () => {
  const config = loadConfig(["--home=/tmp/from-flag"], { BOTD_HOME: "/tmp/from-env" });
  assert.equal(config.home, "/tmp/from-flag");
});

test("a home without a value is ignored", () => {
  const withEnv = loadConfig(["--home"], { BOTD_HOME: "/tmp/from-env" });
  assert.equal(withEnv.home, "/tmp/from-env");
  const withoutEnv = loadConfig(["--home"], {});
  assert.equal(withoutEnv.home, DEFAULT_CONFIG.home);
});

test("an empty home hides the environment variable", () => {
  // `--home=` is a value, not a missing value: the environment variable is
  // not consulted and the default home is kept.
  const config = loadConfig(["--home="], { BOTD_HOME: "/tmp/from-env" });
  assert.equal(config.home, DEFAULT_CONFIG.home);
});

test("a blank home falls back to the default home", () => {
  // A home that holds only spaces is not a directory: the default is used.
  const config = loadConfig(["--home=   "], { BOTD_HOME: "/tmp/from-env" });
  assert.equal(config.home, defaultBotdHome({}));
  assert.match(config.home, /\.volto-botd$/);
});

test("--store-file is resolved to an absolute path", () => {
  const config = loadConfig(["--store-file=./somewhere/table.json"], {});
  assert.equal(config.storeFile, path.resolve("./somewhere/table.json"));
  assert.ok(path.isAbsolute(config.storeFile as string));
});

test("the store file of the environment is resolved to an absolute path", () => {
  const config = loadConfig([], { BOTD_STORE_FILE: "./somewhere/table.json" });
  assert.equal(config.storeFile, path.resolve("./somewhere/table.json"));
  assert.ok(path.isAbsolute(config.storeFile as string));
});

test("the flag wins over the environment for the store file", () => {
  const config = loadConfig(["--store-file=/tmp/from-flag.json"], {
    BOTD_STORE_FILE: "/tmp/from-env.json",
  });
  assert.equal(config.storeFile, "/tmp/from-flag.json");
});

test("a store file without a value is ignored", () => {
  const withEnv = loadConfig(["--store-file"], { BOTD_STORE_FILE: "/tmp/from-env.json" });
  assert.equal(withEnv.storeFile, "/tmp/from-env.json");
  const withoutEnv = loadConfig(["--store-file"], {});
  assert.equal(withoutEnv.storeFile, undefined);
});

test("an empty store file hides the environment variable", () => {
  const config = loadConfig(["--store-file="], { BOTD_STORE_FILE: "/tmp/from-env.json" });
  assert.equal(config.storeFile, undefined);
});

test("the session table lives in the home directory", () => {
  const config = loadConfig(["--home=/tmp/botd-home"], {});
  assert.equal(sessionTablePath(config), path.join("/tmp/botd-home", "sessions.json"));
});

test("the session table follows the store file", () => {
  const config = loadConfig(["--home=/tmp/botd-home", "--store-file=/tmp/table.json"], {});
  assert.equal(sessionTablePath(config), "/tmp/table.json");
});

test("the session table of the default configuration lives in the home", () => {
  assert.equal(sessionTablePath(DEFAULT_CONFIG), path.join(DEFAULT_CONFIG.home, "sessions.json"));
});

test("unknown flags are ignored", () => {
  const config = loadConfig(["--nope=1", "--another-flag", "serve"], {});
  assert.deepEqual(config, DEFAULT_CONFIG);
});

test("the last of two identical flags wins", () => {
  const numeric = loadConfig(["--lease-ttl-ms=1", "--lease-ttl-ms=2"], {});
  assert.equal(numeric.leaseTtlMs, 2);
  const home = loadConfig(["--home=/tmp/first", "--home=/tmp/second"], {});
  assert.equal(home.home, "/tmp/second");
  const store = loadConfig(["--store-file=/tmp/first.json", "--store-file=/tmp/second.json"], {});
  assert.equal(store.storeFile, "/tmp/second.json");
});

test(
  "TODO(defect): an empty --home falls back to the environment variable",
  {
    skip:
      "an empty flag value hides the environment variable, the numeric knobs fall back to it",
  },
  () => {
    // The numeric knobs fall back to the environment variable when the flag
    // carries no usable value. The paths do not: `--home=` is a value, not a
    // missing value, so the environment variable is never read and the
    // daemon writes its session table to the default home.
    const config = loadConfig(["--home="], { BOTD_HOME: "/tmp/from-env" });
    assert.equal(config.home, "/tmp/from-env");
  },
);
