import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

const relay = readFileSync(new URL("../../client-ui/relay.mjs", import.meta.url), "utf8");
const client = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");

test("daemon configuration does not select a default host", () => {
  for (const config of [DEFAULT_CONFIG, loadConfig([], {})]) {
    assert.equal(Object.hasOwn(config, "host"), false);
    assert.equal(Object.hasOwn(config, "hosts"), false);
  }
});

test("relay starts with no hosts unless explicitly configured", () => {
  // Inspect the defaults without starting the HTTP server or a transport.
  assert.match(relay, /startRelay\(\{\s*hosts\s*=\s*\[\]/);
  assert.match(relay, /process\.env\.BOTD_HOSTS\s*\?\?\s*["']\[\]["']/);
  assert.match(relay, /hostsFile\s*\?\s*await readFile\(hostsFile,\s*["']utf8["']\)/);
  assert.match(relay, /host\.command\s*\?\s*spawnTransport\([^;]+:\s*sshTransport\(host\.alias\)/);
});

// botd/src/client.ts:369-370 defaults to spawning the local daemon when no
// transport is supplied. A follow-up must require an explicit SSH alias.
test.todo("BotdClient without host configuration must not spawn locally (botd/src/client.ts:369-370)", () => {
  assert.doesNotMatch(client, /options\.transport\s*\?\?\s*\(\(\)\s*=>\s*spawnTransport\(/);
});
