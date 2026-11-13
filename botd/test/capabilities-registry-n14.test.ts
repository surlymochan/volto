import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ADAPTER_CAPABILITIES } from "../src/adapters/index.ts";

// The registry is a switch rather than an exported map. Read its case labels
// without constructing adapters, since protocol detection can start a process.
/** Replace comments with a space, leaving string and template literals (which may contain `//`) intact. */
function stripComments(source: string): string {
  return source.replace(
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[^]*?\*\//g,
    (match, literal) => literal ?? " ",
  );
}

// Commented-out cases are not registered adapters, so comments are stripped before scanning.
const registrySource = stripComments(readFileSync(new URL("../src/adapters/index.ts", import.meta.url), "utf8"));
const registryBody = registrySource.match(/export function getAdapter\([^]*?\n}\n/);
assert.ok(registryBody, "getAdapter registry was not found");
// Labels may use any quote style, be empty, or share a line (`case "a": case "b":`); empty ones
// are kept so the identifier checks below reject them.
const registryKinds = [...registryBody[0].matchAll(/\bcase\s+(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*:/g)]
  .map((match) => match[2]);
const capabilityKinds = ADAPTER_CAPABILITIES.map((row) => row.kind);

test("commented-out cases are not counted, literals containing slashes are kept", () => {
  const stripped = stripComments('switch (k) {\n  // case "a":\n  /* case "b": */\n  case "c": return "//x";\n}');
  assert.deepEqual([...stripped.matchAll(/\bcase\s+"([^"]*)"\s*:/g)].map((match) => match[1]), ["c"]);
  assert.ok(stripped.includes('"//x"'));
});

test("each registry case has a capability row", () => {
  assert.ok(registryKinds.length > 0);
  for (const kind of registryKinds) {
    assert.ok(capabilityKinds.includes(kind as (typeof capabilityKinds)[number]), `missing capability: ${kind}`);
  }
});

test("each capability row has a registry case", () => {
  assert.ok(capabilityKinds.length > 0);
  for (const kind of capabilityKinds) {
    assert.ok(registryKinds.includes(kind), `missing registry case: ${kind}`);
  }
});

test("registry identifiers are nonempty lowercase strings", () => {
  for (const kind of registryKinds) {
    assert.match(kind, /^[a-z][a-z0-9-]*$/);
  }
});

test("capability identifiers are nonempty lowercase strings", () => {
  for (const kind of capabilityKinds) {
    assert.equal(typeof kind, "string");
    assert.match(kind, /^[a-z][a-z0-9-]*$/);
  }
});

test("registry identifiers are unique", () => {
  assert.equal(new Set(registryKinds).size, registryKinds.length);
});

test("capability identifiers are unique", () => {
  assert.equal(new Set(capabilityKinds).size, capabilityKinds.length);
});

test("raw capability entries contain typed, nonempty fields", () => {
  for (const row of ADAPTER_CAPABILITIES) {
    assert.ok(row && typeof row === "object");
    for (const field of ["kind", "family", "protocol"] as const) {
      assert.equal(typeof row[field], "string", `${row.kind}.${field}`);
      assert.ok(row[field].trim().length > 0, `${row.kind}.${field} is empty`);
    }
    for (const field of ["supportsResume", "supportsCancel", "enabled"] as const) {
      assert.equal(typeof row[field], "boolean", `${row.kind}.${field}`);
    }
  }
});
