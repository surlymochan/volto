import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const botDir = resolve(here, "../bots");
const libDir = resolve(here, "../lib");
const source = readFileSync(resolve(botDir, "pi.mjs"), "utf8");
const readme = readFileSync(resolve(here, "../README.md"), "utf8");

function isolated(name, fn) {
  test(name, (t) => {
    const previous = process.env;
    process.env = {};
    t.after(() => { process.env = previous; });
    fn();
  });
}

function imports(text) {
  return [...text.matchAll(/\b(?:from\s*|import\s*\()(["'])(\.[^"']+)\1/g)].map((match) => match[2]);
}

function invalidImports(text) {
  return imports(text).filter((specifier) => {
    const path = resolve(botDir, specifier);
    const rel = relative(libDir, path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) return true;
    try { return !statSync(path).isFile(); } catch { return true; }
  });
}

function descriptorId(text) {
  return [...text.matchAll(/export\s+const\s+probe\s*=\s*\{\s*id:\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

function rows(text) {
  return text.split("\n").map((line) => /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|$/.exec(line))
    .filter(Boolean).map((match) => ({ name: match[1], startedAs: match[3] }));
}

function binaryNames(text) {
  return [...text.matchAll(/\bresolveBinary\s*\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);
}

// Reject home-directory access altogether, a stronger constraint than rejecting writes.
function homeReferences(text) {
  return [...text.matchAll(/\bhomedir\b|\bprocess\s*(?:\.\s*env\s*(?:\.\s*HOME\b|\[\s*["']HOME["']\s*\])|\[\s*["']env["']\s*\]\s*\[\s*["']HOME["']\s*\])/g)].map((match) => match[0]);
}

function timeouts(text) {
  const patterns = [
    /\brunCommand\(\s*\{[^}]*?\btimeoutMs\s*:\s*([^,}\s]+)/g,
    /\bMath\.min\(\s*([^,]+),\s*ctx\.timeoutMs\s*\)/g,
    /\bwaitForEvent\(\s*eventCounts\s*,\s*["'][^"']+["']\s*,\s*([^,\s)]+)/g,
    /\bsetTimeout\(\s*resolve\s*,\s*([^,\s)]+)/g,
  ];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1].trim()));
}

function validTimeouts(values) {
  return values.every((value) => /^(?:[1-9]\d*|[1-9]\d*(?:_\d+)+)$/.test(value) && Number.isSafeInteger(Number(value.replaceAll("_", ""))));
}

isolated("relative imports resolve to files in probes/lib", () => {
  assert.deepEqual(imports(source), ["../lib/binary.mjs", "../lib/process.mjs", "../lib/result.mjs", "../lib/result.mjs"]);
  assert.deepEqual(invalidImports(source), []);
  const changed = source.replace('../lib/binary.mjs', '../lib/missing-n20.mjs');
  assert.deepEqual(invalidImports(changed), ["../lib/missing-n20.mjs"]);
});

isolated("exported id matches the README row", () => {
  assert.deepEqual(descriptorId(source), ["pi"]);
  assert.deepEqual(rows(readme).filter((row) => row.name === "pi"), [{ name: "pi", startedAs: "pi --mode rpc" }]);
  assert.notDeepEqual(descriptorId(source.replace('id: "pi",\n  label:', 'id: "other",\n  label:')), ["pi"]);
  assert.deepEqual(rows(readme.replace('| pi | pi RPC', '| other | pi RPC')).filter((row) => row.name === "pi"), []);
});

isolated("resolved binary matches the README command", () => {
  const piRows = rows(readme).filter((row) => row.name === "pi");
  assert.equal(piRows.length, 1);
  assert.deepEqual(binaryNames(source), [piRows[0].startedAs.split(" ")[0]]);
  assert.notDeepEqual(binaryNames(source.replace('resolveBinary("pi")', 'resolveBinary("other")')), [piRows[0].startedAs.split(" ")[0]]);
});

isolated("source does not access home directories", () => {
  assert.deepEqual(homeReferences(source), []);
  assert.deepEqual(homeReferences('writeFileSync(os.homedir() + "/file", "x")'), ["homedir"]);
  assert.deepEqual(homeReferences('writeFileSync(process.env.HOME + "/file", "x")'), ["process.env.HOME"]);
});

isolated("timeout literals are positive integer milliseconds with expected values", () => {
  const expected = ["15_000", "30_000", "60_000", "20_000", "50", "100"];
  assert.deepEqual(timeouts(source), expected);
  assert.equal(validTimeouts(timeouts(source)), true);
  const changed = source.replace("timeoutMs: 15_000", "timeoutMs: 0");
  assert.notDeepEqual(timeouts(changed), expected);
  assert.equal(validTimeouts(timeouts(changed)), false);
});
