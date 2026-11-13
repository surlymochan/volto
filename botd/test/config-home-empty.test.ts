import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

test("an empty home flag falls back to the environment", () => {
  assert.equal(loadConfig(["--home="], { BOTD_HOME: "/x" }).home, "/x");
});

test("a nonempty home flag wins over the environment", () => {
  assert.equal(loadConfig(["--home=/y"], { BOTD_HOME: "/x" }).home, "/y");
});

test("an empty home flag without an environment value uses the default", () => {
  assert.equal(loadConfig(["--home="], {}).home, DEFAULT_CONFIG.home);
});

test("a whitespace-only home flag falls back to the environment", () => {
  assert.equal(loadConfig(["--home=  "], { BOTD_HOME: "/x" }).home, "/x");
});

test("an empty store-file flag falls back to the environment", () => {
  assert.equal(loadConfig(["--store-file="], { BOTD_STORE_FILE: "/s.json" }).storeFile, "/s.json");
});

test("a whitespace-only store-file flag falls back to the environment", () => {
  assert.equal(loadConfig(["--store-file=  "], { BOTD_STORE_FILE: "/s.json" }).storeFile, "/s.json");
});

test("an empty home environment value uses the default", () => {
  assert.equal(loadConfig([], { BOTD_HOME: "" }).home, DEFAULT_CONFIG.home);
});

test("an empty numeric flag falls back to the environment", () => {
  assert.equal(loadConfig(["--lease-ttl-ms="], { BOTD_LEASE_TTL_MS: "4242" }).leaseTtlMs, 4242);
});
