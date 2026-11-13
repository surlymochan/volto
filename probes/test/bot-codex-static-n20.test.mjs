import assert from "node:assert/strict";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test, { beforeEach } from "node:test";

const probesDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const botPath = resolve(probesDir, "bots/codex.mjs");
const libDir = realpathSync(resolve(probesDir, "lib"));
const source = readFileSync(botPath, "utf8");
const readme = readFileSync(resolve(probesDir, "README.md"), "utf8");

beforeEach((t) => {
  const original = process.env;
  process.env = {};
  t.after(() => { process.env = original; });
});

function relativeImports(text) {
  return [...text.matchAll(/\b(?:from\s+|import\s*(?:\(\s*)?)(["'])(\.{1,2}\/[^"']+)\1/g)].map((match) => match[2]);
}

function invalidImports(text) {
  return relativeImports(text).filter((specifier) => {
    try {
      const path = realpathSync(resolve(dirname(botPath), specifier));
      const rel = relative(libDir, path);
      return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || !statSync(path).isFile();
    } catch {
      return true;
    }
  });
}

function probeId(text) {
  return [...text.matchAll(/export\s+const\s+probe\s*=\s*\{\s*id:\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

function readmeRow(text) {
  return text.split("\n").map((line) => line.split("|").map((cell) => cell.trim()))
    .filter((cells) => cells.length === 5 && cells[1] === "Codex")
    .map((cells) => ({ id: cells[1].toLowerCase(), startedAs: cells[3] }));
}

function binaryNames(text) {
  return [...text.matchAll(/\bresolveBinary\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);
}

function homeReferences(text) {
  return [...text.matchAll(/\b(?:os\s*\.\s*homedir\s*\(|homedir\s*\(|process\s*\.\s*env\s*(?:\.\s*HOME\b|\[\s*["']HOME["']\s*\]))/g)].map((match) => match[0]);
}

function timeoutValues(text) {
  const values = [];
  const patterns = [
    /\btimeoutMs:\s*(?:Math\.min\(\s*)?([\d_]+)(?=\s*[,}])/g,
    /\bwaitForTurn\([^,]+,\s*(?:loggedIn\s*\?\s*)?([\d_]+)(?:\s*:\s*([\d_]+))?\s*\)/g,
    /\bsetTimeout\([^,]+,\s*([\d_]+)\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      for (const value of match.slice(1)) if (value !== undefined) values.push(Number(value.replaceAll("_", "")));
    }
  }
  return values;
}

function checkTimeouts(text) {
  const values = timeoutValues(text);
  assert.deepEqual(values, [15000, 20000, 45000, 20000, 10000, 30000, 30000, 20000, 10000, 20000, 60000, 20000, 15000, 100, 400]);
  assert.equal(values.every((value) => Number.isSafeInteger(value) && value > 0), true);
}

test("relative imports resolve to files under probes/lib", () => {
  assert.deepEqual(relativeImports(source), ["../lib/jsonrpc.mjs", "../lib/binary.mjs", "../lib/process.mjs", "../lib/result.mjs", "../lib/result.mjs"]);
  assert.deepEqual(invalidImports(source), []);
  const mutated = source.replace("../lib/jsonrpc.mjs", "../lib/missing-fixture.mjs");
  assert.deepEqual(invalidImports(mutated), ["../lib/missing-fixture.mjs"]);
});

test("exported probe id matches the README row", () => {
  assert.deepEqual(probeId(source), ["codex"]);
  assert.deepEqual(readmeRow(readme), [{ id: "codex", startedAs: "`codex app-server`" }]);
  assert.deepEqual(probeId(source), readmeRow(readme).map((row) => row.id));
  assert.notDeepEqual(probeId(source.replace('id: "codex",\n  label:', 'id: "other",\n  label:')), readmeRow(readme).map((row) => row.id));
  assert.deepEqual(readmeRow(readme.replace("| Codex |", "| Other |")), []);
});

test("resolved binary is the README command", () => {
  const command = readmeRow(readme)[0].startedAs;
  assert.deepEqual(binaryNames(source), ["codex"]);
  assert.equal(command, "`codex app-server`");
  assert.equal(binaryNames(source)[0], command.slice(1, -1).split(" ")[0]);
  assert.notEqual(binaryNames(source.replace('resolveBinary("codex")', 'resolveBinary("other")'))[0], command.slice(1, -1).split(" ")[0]);
});

test("probe contains no home directory references", () => {
  assert.deepEqual(homeReferences(source), []);
  for (const fixture of ['writeFile(join(os.homedir(), "x"), data)', 'writeFile(join(process.env.HOME, "x"), data)', 'writeFile(join(process.env["HOME"], "x"), data)']) {
    assert.equal(homeReferences(fixture).length, 1);
  }
});

test("timeout literals are the expected positive integer milliseconds", () => {
  checkTimeouts(source);
  assert.throws(() => checkTimeouts(source.replace("timeoutMs: 15_000", "timeoutMs: 0")), assert.AssertionError);
  assert.throws(() => checkTimeouts(source.replace("setTimeout(resolve, 400)", "setTimeout(resolve, 401)")), assert.AssertionError);
});
