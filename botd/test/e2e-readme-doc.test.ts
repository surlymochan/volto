// Filesystem-only drift checks for the end-to-end suite's README.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const e2eDir = join(repoRoot, "botd/e2e");
const doc = readFileSync(join(e2eDir, "README.md"), "utf8");

/** Resolve the simple filename glob used by the documented command. */
function exists(path: string): boolean {
  if (!path.includes("*")) return existsSync(join(repoRoot, path));
  const directory = dirname(path);
  const pattern = path.slice(directory.length + 1);
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const matcher = new RegExp(`^${escaped.join(".*")}$`);
  const absolute = join(repoRoot, directory);
  return existsSync(absolute) && readdirSync(absolute).some((name) => matcher.test(name));
}

test("file paths named in the README exist", () => {
  const paths = [...doc.matchAll(/\bbotd\/e2e\/([\w.*-]+(?:\/[\w.*-]+)*)/g)]
    .map((match) => match[0])
    // This is a runtime scratch directory, not a source file.
    .filter((path) => path !== "botd/e2e/.tmp");
  assert.ok(paths.length > 0, "the README names no e2e files");
  for (const path of paths) assert.ok(exists(path), `README path does not exist: ${path}`);
});

test("node --test commands in code blocks name existing paths", () => {
  const blocks = [...doc.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
  const commands = blocks.flatMap((block) => (block[1] ?? "").split("\n"))
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => /^node\s+--test(?:\s|$)/.test(line));
  assert.ok(commands.length > 0, "the README has no node --test commands");
  for (const command of commands) {
    const paths = command.split(/\s+/).slice(2).filter((arg) => !arg.startsWith("-"));
    assert.ok(paths.length > 0, `command has no paths: ${command}`);
    for (const path of paths) assert.ok(exists(path), `command path does not exist: ${path}`);
  }
});

// DEFECT: The README states Node 23 and later as well as Node 24.
test.todo("every Node version stated in the README is 24", () => {
  const versions = [...doc.matchAll(/\bNode\s+(\d+)/gi)].map((match) => Number(match[1]));
  for (const version of versions) assert.equal(version, 24);
});

test("the README lists every e2e test file", () => {
  const files = readdirSync(e2eDir).filter((name) => name.endsWith(".test.ts"));
  assert.ok(files.length > 0, "the e2e directory has no test files");
  for (const file of files) assert.ok(doc.includes(`\`${file}\``), `README does not list ${file}`);
});
