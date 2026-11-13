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
const LITERAL = /^(["'`])((?:\\.|(?!\1)[^\\$])*)\1$/;
// Every case label, whatever its expression: string-aware so `case "a:b":` is one label.
const caseLabels = [...registryBody[0].matchAll(
  /\bcase\s+((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^:"'`])+?)\s*:/g,
)].map((match) => match[1].trim());
// Labels may use any quote style, be empty, or share a line; empty ones are kept so the identifier
// checks below reject them. Labels that are not plain string literals are rejected by their own test.
const registryKinds = caseLabels.flatMap((label) => {
  const literal = LITERAL.exec(label);
  return literal ? [literal[2]] : [];
});
const capabilityKinds = ADAPTER_CAPABILITIES.map((row) => row.kind);

test("commented-out cases are not counted, literals containing slashes are kept", () => {
  const stripped = stripComments('switch (k) {\n  // case "a":\n  /* case "b": */\n  case "c": return "//x";\n}');
  assert.deepEqual([...stripped.matchAll(/\bcase\s+"([^"]*)"\s*:/g)].map((match) => match[1]), ["c"]);
  assert.ok(stripped.includes('"//x"'));
});

test("every registry case label is a plain string literal", () => {
  assert.deepEqual(caseLabels.filter((label) => !LITERAL.test(label)), []);
});

test("case labels that are constants or expressions are detected, not skipped", () => {
  const body = 'switch (k) { case KIND_X: return 1; case "a" + "b": return 2; case `t${v}`: return 3; case "ok": return 4; }';
  const labels = [...body.matchAll(/\bcase\s+((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^:"'`])+?)\s*:/g)].map((m) => m[1].trim());
  assert.deepEqual(labels.filter((label) => !LITERAL.test(label)), ["KIND_X", '"a" + "b"', "`t${v}`"]);
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
