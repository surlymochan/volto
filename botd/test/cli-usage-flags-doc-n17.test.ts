import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Read the entry point as text: importing it starts the daemon.
const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
const config = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
const protocol = readFileSync(new URL("../src/protocol.ts", import.meta.url), "utf8");
const usage = /const USAGE = `([^`]*)`;/s.exec(cli)?.[1] ?? "";
const loadConfig = /export function loadConfig\([\s\S]*?\n}\n/.exec(config)?.[0] ?? "";
const flagReads = [...loadConfig.matchAll(/flags\.get\("([a-z-]+)"\)/g)];
const pairs = [...loadConfig.matchAll(/flags\.get\("([a-z-]+)"\)\)[^;]*?\?\?\s*\w+\(env\.(BOTD_[A-Z_]+)\)/g)];
const usageEntries = [...usage.matchAll(/--([a-z-]+)=(?:(?!--[a-z-]+=)[\s\S])*?\[(BOTD_[A-Z_]+)\]/g)];

test("each configuration flag has an identifiable environment fallback", () => {
  assert.ok(flagReads.length > 0);
  assert.equal(pairs.length, flagReads.length);
  assert.deepEqual(pairs.map((pair) => pair[1]), flagReads.map((flag) => flag[1]));
});

for (const [, flag, env] of pairs) {
  test(`usage associates --${flag} with its configuration environment fallback`, () => {
    const entry = usageEntries.find((match) => match[1] === flag);
    assert.ok(entry, `missing --${flag}= in usage`);
    assert.equal(entry[2], env);
  });
}

test("usage starts with the protocol version reference", () => {
  const version = /export const BOTD_VERSION = "([^"]+)";/.exec(protocol)?.[1];
  assert.ok(version);
  assert.ok(usage.startsWith("botd ${BOTD_VERSION}"));
  assert.ok(usage.replace("${BOTD_VERSION}", version).startsWith(`botd ${version}`));
});
