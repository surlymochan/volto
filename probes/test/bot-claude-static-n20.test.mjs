import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test, { beforeEach } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const botPath = resolve(here, "../bots/claude.mjs");
const libPath = realpathSync(resolve(here, "../lib"));
const source = readFileSync(botPath, "utf8");
const readme = readFileSync(resolve(here, "../README.md"), "utf8");

beforeEach((t) => {
  const previous = process.env;
  process.env = {};
  t.after(() => { process.env = previous; });
});

function relativeImports(text) {
  return [...text.matchAll(/^import\s+(?:[^;\n]*?\s+from\s+)?["'](\.[^"']+)["'];/gm)].map((match) => match[1]);
}

function invalidImports(text) {
  return relativeImports(text).filter((specifier) => {
    const path = resolve(dirname(botPath), specifier);
    if (!existsSync(path) || !statSync(path).isFile()) return true;
    const rel = relative(libPath, realpathSync(path));
    return rel === "" || rel === ".." || rel.startsWith(`..${sep}`);
  });
}

function descriptor(text) {
  const match = /^export const probe = \{\s*id: "([^"]+)",\s*label: "([^"]+)",/m.exec(text);
  assert.ok(match, "exported probe descriptor must have an id and label");
  return { id: match[1], label: match[2] };
}

function readmeRow(text, label) {
  const rows = text.split("\n").map((line) => /^\| ([^|]+) \| ([^|]+) \| `([^`]+)` \|$/.exec(line)).filter(Boolean);
  const matches = rows.filter((row) => row[1] === label);
  assert.equal(matches.length, 1, `expected one README row for ${label}`);
  return { label: matches[0][1], binary: matches[0][3].split(" ")[0] };
}

function binaryName(text) {
  const calls = [...text.matchAll(/\bresolveBinary\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]);
  assert.equal(calls.length, 1);
  return calls[0];
}

// The probe only imports the read-only filesystem operation and never refers to
// HOME. Pinning these imports also catches newly introduced filesystem writers.
function homeAccess(text) {
  return {
    fsImports: [...text.matchAll(/^import\s+(.+?)\s+from\s+["']node:fs(?:\/promises)?["'];/gm)].map((match) => match[1]),
    homeReferences: [...text.matchAll(/\bprocess\s*\.\s*env\s*(?:\.\s*HOME\b|\[\s*["']HOME["']\s*\])/g)].map((match) => match[0]),
    homeCalls: [...text.matchAll(/\bhomedir\s*\(\s*\)/g)].length,
    writers: [...text.matchAll(/\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|mkdir(?:Sync)?|rm(?:Sync)?|unlink(?:Sync)?|rename(?:Sync)?)\s*\(/g)].map((match) => match[0]),
  };
}

function timeouts(text) {
  return [...text.matchAll(/\b(?:timeoutMs:\s*|waitFor\([^\n]*?,\s*|controlRequest\([^\n]*?,\s*|setTimeout\([^\n]*?,\s*)([\d_]+)\s*\)/g)].map((match) => Number(match[1].replaceAll("_", "")));
}

// runCommand uses an object literal, so its timeout is followed by a brace.
function allTimeouts(text) {
  const calls = timeouts(text);
  const options = [...text.matchAll(/\btimeoutMs:\s*([\d_]+)\s*\}/g)].map((match) => Number(match[1].replaceAll("_", "")));
  return [...options, ...calls];
}

test("relative imports resolve to files inside probes/lib", () => {
  assert.deepEqual(relativeImports(source), ["../lib/binary.mjs", "../lib/process.mjs", "../lib/result.mjs"]);
  assert.deepEqual(invalidImports(source), []);
  const mutated = source.replace('"../lib/binary.mjs"', '"../lib/missing-fixture.mjs"');
  assert.deepEqual(invalidImports(mutated), ["../lib/missing-fixture.mjs"]);
});

test("exported id and label identify the README row", () => {
  const probe = descriptor(source);
  assert.deepEqual(probe, { id: "claude", label: "Claude Code" });
  assert.deepEqual(readmeRow(readme, probe.label), { label: "Claude Code", binary: "claude" });
  assert.notDeepEqual(descriptor(source.replace('id: "claude",\n  label: "Claude Code",\n  command:', 'id: "other",\n  label: "Claude Code",\n  command:')), probe);
  assert.throws(() => readmeRow(readme, "Other"), /expected one README row/);
});

test("resolved binary matches the README started-as command", () => {
  assert.equal(binaryName(source), "claude");
  assert.equal(binaryName(source), readmeRow(readme, descriptor(source).label).binary);
  assert.notEqual(binaryName(source.replace('resolveBinary("claude")', 'resolveBinary("other")')), readmeRow(readme, "Claude Code").binary);
});

test("home access is limited to credential existence checks", () => {
  const expected = { fsImports: ["{ existsSync }"], homeReferences: [], homeCalls: 3, writers: [] };
  assert.deepEqual(homeAccess(source), expected);
  assert.notDeepEqual(homeAccess(source.replace("{ existsSync }", "{ existsSync, writeFileSync }")), expected);
  assert.notDeepEqual(homeAccess(`${source}\nprocess.env.HOME;`), expected);
  assert.notDeepEqual(homeAccess(`${source}\nhomedir();`), expected);
  assert.notDeepEqual(homeAccess(`${source}\nwriteFileSync(homedir(), "fixture");`), expected);
});

test("timeout literals are positive integer milliseconds with expected values", () => {
  const expected = [15000, 15000, 90000, 500, 15000, 20000, 100];
  const values = allTimeouts(source);
  assert.deepEqual(values, expected);
  assert.equal(values.every((value) => Number.isInteger(value) && value > 0), true);
  assert.notDeepEqual(allTimeouts(source.replace("90_000", "0")), expected);
  assert.equal(allTimeouts(source.replace("90_000", "0")).every((value) => Number.isInteger(value) && value > 0), false);
});
