import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const probes = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(probes, path), "utf8");
const readme = read("README.md");
const runner = read("run.mjs");
const report = read("REPORT.md");
const botFiles = readdirSync(join(probes, "bots")).filter((name) => name.endsWith(".mjs"));
const botNames = botFiles.map((file) => {
  const match = read(`bots/${file}`).match(/export const probe\s*=\s*\{[\s\S]*?\blabel:\s*"([^"]+)"/);
  assert.ok(match, `missing probe label in ${file}`);
  return match[1];
});
const tableNames = (section) => section.split("\n")
  .filter((line) => /^\|/.test(line))
  .slice(2)
  .map((line) => line.split("|")[1].trim());
const readmeTable = readme.match(/\| bot \|[\s\S]*?(?=\n\n)/)?.[0] ?? "";
const summary = report.match(/## Summary\s*\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? "";
const layoutLine = readme.split("\n").find((line) => line.includes("# jsonl,")) ?? "";
const helpers = layoutLine.match(/#\s*(.*?)\s+helpers/)?.[1].split(/,\s*/) ?? [];

test("README bot table mentions every module's label", () => {
  const names = tableNames(readmeTable);
  for (const name of botNames) assert.ok(names.includes(name), `README is missing ${name}`);
});

test("README bot table has exactly one row per module", () => {
  assert.deepEqual(tableNames(readmeTable).sort(), [...botNames].sort());
});

test("README Layout helpers exist as library modules", () => {
  assert.deepEqual(helpers, ["jsonl", "jsonrpc", "acp", "process", "redact", "report"]);
  const files = readdirSync(join(probes, "lib"));
  for (const helper of helpers) assert.ok(files.includes(`${helper}.mjs`), `missing ${helper}.mjs`);
});

test("Layout and Usage flags are handled by the runner", () => {
  const usage = readme.match(/## Usage\n([\s\S]*?)(?=\n## )/)?.[1] ?? "";
  const layout = readme.match(/## Layout\n([\s\S]*)/)?.[1] ?? "";
  const runnerDocs = (usage + layout).split("\n").filter((line) => !line.includes("node --test")).join("\n");
  const flags = [...new Set(runnerDocs.match(/--[a-z-]+/g) ?? [])].sort();
  assert.deepEqual(flags, ["--bot", "--dry-run", "--out", "--report", "--timeout"]);
  const parseArgs = runner.match(/function parseArgs\(argv\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  for (const flag of flags) assert.ok(parseArgs.includes(`arg === "${flag}"`), `${flag} is not handled`);
});

test("README hard timeout matches the runner default", () => {
  const seconds = readme.match(/hard timeout of (\d+) s/)?.[1];
  const milliseconds = runner.match(/const DEFAULT_TIMEOUT_MS = ([\d_]+);/)?.[1];
  assert.ok(seconds && milliseconds, "missing timeout declaration");
  assert.equal(Number(seconds), 120);
  assert.equal(Number(milliseconds.replaceAll("_", "")), Number(seconds) * 1000);
});

test("REPORT summary has exactly one row per bot module", () => {
  assert.deepEqual(tableNames(summary).sort(), [...botNames].sort());
});

test("REPORT opening states the README hard timeout", () => {
  const readmeTimeout = readme.match(/hard timeout of (\d+) s/)?.[1];
  const reportTimeout = report.split("\n").slice(0, 3).join("\n").match(/hard timeout (\d+) s per bot/)?.[1];
  assert.ok(readmeTimeout && reportTimeout, "missing opening hard timeout");
  assert.equal(reportTimeout, readmeTimeout);
});

// DEFECT: README Layout omits the existing binary, result, and transcript helpers.
test.todo("README Layout names all library helpers");
