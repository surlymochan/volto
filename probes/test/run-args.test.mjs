import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const runner = readFileSync(new URL("../run.mjs", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const report = readFileSync(new URL("../lib/report.mjs", import.meta.url), "utf8");

// DEFECT: README bot names do not match all module basenames.
test("README bot names match the probe modules", { todo: true }, () => {
  const table = readme.match(/^\| bot \|.*(?:\n\|.*)+/m)?.[0];
  assert.ok(table, "bot table is missing");
  const names = table.split("\n").slice(2).map((row) => row.split("|")[1].trim().toLowerCase()).sort();
  const modules = readdirSync(new URL("../bots/", import.meta.url))
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => name.slice(0, -4))
    .sort();
  assert.deepEqual(names, modules);
});

test("the runner handles the required options", () => {
  for (const flag of ["--help", "--dry-run", "--bot", "--timeout"]) {
    assert.ok(runner.includes(`arg === "${flag}"`), `${flag} is not handled`);
  }
});

// DEFECT: README Usage omits --out, --report, --help, and -h.
test("README Usage documents every handled option", { todo: true }, () => {
  const usage = readme.match(/^## Usage\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1];
  assert.ok(usage, "Usage section is missing");
  const flags = [...runner.matchAll(/\barg\s*===\s*["'](-{1,2}[\w-]+)["']/g)].map((match) => match[1]);
  assert.ok(flags.length, "no handled flags found");
  for (const flag of flags) {
    assert.match(usage, new RegExp(`(^|[^\\w-])${flag}(?![\\w-])`, "m"), `${flag} is missing from Usage`);
  }
});

test("the report module does not read environment variables", () => {
  // No environment reads are currently allowed in the report module.
  const allowed = [];
  const reads = [...report.matchAll(/\bprocess\s*\.\s*env\b/g)].map((match) => match[0]);
  assert.deepEqual(reads.filter((read) => !allowed.includes(read)), []);
});

// DEFECT: the runner delegates missing-binary handling and contains no skipped path.
test("the runner contains the skipped-binary path", { todo: true }, () => {
  assert.ok(/\bskipped\b/i.test(runner), "runner does not contain skipped");
});
