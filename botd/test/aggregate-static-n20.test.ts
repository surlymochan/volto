import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

beforeEach((t) => {
  const original = process.env;
  process.env = {};
  t.after(() => { process.env = original; });
});

const botd = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The aggregate currently runs only its original core suite; these tests run separately.
const ALLOWED_UNLISTED = new Map([
  ["adapter-contract.test.ts", "Not included in the original core aggregate"],
  ["adapters-doc.test.ts", "Not included in the original core aggregate"],
  ["aggregate-static-n20.test.ts", "Not included in the original core aggregate"],
  ["capabilities-registry-n14.test.ts", "Not included in the original core aggregate"],
  ["cli-exit-codes.test.ts", "Not included in the original core aggregate"],
  ["cli-flags.test.ts", "Not included in the original core aggregate"],
  ["client-backoff.test.ts", "Not included in the original core aggregate"],
  ["client-edge.test.ts", "Not included in the original core aggregate"],
  ["client-error-codes-n15.test.ts", "Not included in the original core aggregate"],
  ["client-lease-expired.test.ts", "Not included in the original core aggregate"],
  ["client-ssh-transport.test.ts", "Not included in the original core aggregate"],
  ["client.test.ts", "Not included in the original core aggregate"],
  ["config-defaults-n14.test.ts", "Not included in the original core aggregate"],
  ["config-home-empty.test.ts", "Not included in the original core aggregate"],
  ["config.test.ts", "Not included in the original core aggregate"],
  ["daemon-errors.test.ts", "Not included in the original core aggregate"],
  ["daemon-gaps.test.ts", "Not included in the original core aggregate"],
  ["daemon-hello-version.test.ts", "Not included in the original core aggregate"],
  ["daemon-multi-session.test.ts", "Not included in the original core aggregate"],
  ["daemon-oversize-frame.test.ts", "Not included in the original core aggregate"],
  ["daemon-restart-resume.test.ts", "Not included in the original core aggregate"],
  ["frames-limits.test.ts", "Not included in the original core aggregate"],
  ["frames-n14.test.ts", "Not included in the original core aggregate"],
  ["frames.test.ts", "Not included in the original core aggregate"],
  ["install-doc.test.ts", "Not included in the original core aggregate"],
  ["lease-edge.test.ts", "Not included in the original core aggregate"],
  ["lease-expiry-n14.test.ts", "Not included in the original core aggregate"],
  ["lease-fixes.test.ts", "Not included in the original core aggregate"],
  ["lease-store-edge.test.ts", "Not included in the original core aggregate"],
  ["lease-store-parent.test.ts", "Not included in the original core aggregate"],
  ["lease-store.test.ts", "Not included in the original core aggregate"],
  ["log-env-level.test.ts", "Not included in the original core aggregate"],
  ["log.test.ts", "Not included in the original core aggregate"],
  ["main-entry.test.ts", "Not included in the original core aggregate"],
  ["metrics-doc.test.ts", "Not included in the original core aggregate"],
  ["metrics-registry-edge.test.ts", "Not included in the original core aggregate"],
  ["metrics.test.ts", "Not included in the original core aggregate"],
  ["orchestrator-gaps.test.ts", "Not included in the original core aggregate"],
  ["orchestrator-stall.test.ts", "Not included in the original core aggregate"],
  ["orchestrator.test.ts", "Not included in the original core aggregate"],
  ["permission-scope-edge.test.ts", "Not included in the original core aggregate"],
  ["permission-timeout-n14.test.ts", "Not included in the original core aggregate"],
  ["permission.test.ts", "Not included in the original core aggregate"],
  ["protocol-doc.test.ts", "Not included in the original core aggregate"],
  ["protocol-hello-n14.test.ts", "Not included in the original core aggregate"],
  ["protocol-parse-edge.test.ts", "Not included in the original core aggregate"],
  ["readme-links-n14.test.ts", "Not included in the original core aggregate"],
  ["redact-home-paths.test.ts", "Not included in the original core aggregate"],
  ["redact-idempotent-n14.test.ts", "Not included in the original core aggregate"],
  ["redact-leak.test.ts", "Not included in the original core aggregate"],
  ["redact-structured.test.ts", "Not included in the original core aggregate"],
  ["redact-token-patterns.test.ts", "Not included in the original core aggregate"],
  ["redact.test.ts", "Not included in the original core aggregate"],
  ["replay-edge.test.ts", "Not included in the original core aggregate"],
  ["ring-edge.test.ts", "Not included in the original core aggregate"],
  ["ring-n14.test.ts", "Not included in the original core aggregate"],
  ["router-n14.test.ts", "Not included in the original core aggregate"],
  ["router-property.test.ts", "Not included in the original core aggregate"],
  ["router.test.ts", "Not included in the original core aggregate"],
  ["session-log-defaults.test.ts", "Not included in the original core aggregate"],
  ["session-log-edge.test.ts", "Not included in the original core aggregate"],
  ["session-log-gaps.test.ts", "Not included in the original core aggregate"],
  ["session-log.test.ts", "Not included in the original core aggregate"],
  ["session-parse-line.test.ts", "Not included in the original core aggregate"],
  ["session-states-doc.test.ts", "Not included in the original core aggregate"],
  ["session-states-n14.test.ts", "Not included in the original core aggregate"],
  ["state-file-modes.test.ts", "Not included in the original core aggregate"],
  ["store-corrupt.test.ts", "Not included in the original core aggregate"],
  ["store-redact.test.ts", "Not included in the original core aggregate"],
  ["supervisor-window.test.ts", "Not included in the original core aggregate"],
  ["supervisor.test.ts", "Not included in the original core aggregate"],
  ["troubleshooting-doc.test.ts", "Not included in the original core aggregate"],
  ["usage-forget.test.ts", "Not included in the original core aggregate"],
  ["usage.test.ts", "Not included in the original core aggregate"],
]);

function specifiers(source: string): string[] {
  return [...source.matchAll(/^\s*import\s+(?:[^"'\n]+?\s+from\s+)?["']([^"']+)["']\s*;?\s*$/gm)]
    .map((match) => match[1]);
}

function invalidTargets(directory: string, imports: string[]): string[] {
  return imports.filter((specifier) => {
    if (!specifier.startsWith("./") || !specifier.endsWith(".test.ts")) return true;
    try {
      return !statSync(resolve(directory, specifier)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  });
}

function unlisted(files: string[], imports: string[], prefix: string, allowed: Map<string, string>): string[] {
  const listed = new Set(imports);
  return files.filter((file) => !listed.has(prefix + file) && !allowed.get(file)).sort();
}

function duplicates(imports: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const specifier of imports) {
    if (seen.has(specifier)) repeated.add(specifier);
    seen.add(specifier);
  }
  return [...repeated].sort();
}

function testFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => entry.name).sort();
}

const suites = [
  { name: "main", directory: botd, testDirectory: resolve(botd, "test"), prefix: "./test/", allowed: ALLOWED_UNLISTED },
  { name: "e2e", directory: resolve(botd, "e2e"), testDirectory: resolve(botd, "e2e"), prefix: "./", allowed: new Map<string, string>() },
];

for (const suite of suites) {
  const imports = specifiers(readFileSync(resolve(suite.directory, "aggregate.ts"), "utf8"));
  test(`${suite.name} aggregate imports existing test files`, () => {
    assert.notEqual(imports.length, 0);
    assert.deepEqual(invalidTargets(suite.directory, imports), []);
  });
  test(`${suite.name} aggregate covers its test directory`, () => {
    assert.deepEqual(unlisted(testFiles(suite.testDirectory), imports, suite.prefix, suite.allowed), []);
  });
  test(`${suite.name} aggregate has no duplicate imports`, () => {
    assert.deepEqual(duplicates(imports), []);
  });
}

test("checks detect altered aggregate inputs", () => {
  assert.deepEqual(specifiers('import "./one.test.ts";\nimport value from "./two.test.ts";'), ["./one.test.ts", "./two.test.ts"]);
  assert.deepEqual(invalidTargets(botd, ["./test/protocol.test.ts", "./test/missing-synthetic.test.ts"]), ["./test/missing-synthetic.test.ts"]);
  assert.deepEqual(unlisted(["one.test.ts", "two.test.ts"], ["./one.test.ts"], "./", new Map()), ["two.test.ts"]);
  assert.deepEqual(unlisted(["one.test.ts", "two.test.ts"], ["./one.test.ts"], "./", new Map([["two.test.ts", "intentional"]])), []);
  assert.deepEqual(duplicates(["./one.test.ts", "./two.test.ts", "./one.test.ts"]), ["./one.test.ts"]);
});

test("exceptions name existing tests and give a reason", () => {
  const files = new Set(testFiles(resolve(botd, "test")));
  assert.deepEqual([...ALLOWED_UNLISTED].filter(([name, reason]) => !files.has(name) || !reason.trim()), []);
});
