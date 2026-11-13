// Text-only drift checks for the demo runbook.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const doc = readFileSync(join(root, "botd/DEMO.md"), "utf8");
const protocol = readFileSync(join(root, "botd/src/protocol.ts"), "utf8");

function sourceText(dir: string): string {
  return readdirSync(dir, { withFileTypes: true }).map((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceText(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? readFileSync(path, "utf8") : "";
  }).join("\n");
}

test("backticked repository file paths in the demo exist", () => {
  const paths = new Set([...doc.matchAll(/`((?:botd\/src\/(?:adapters\/)?[\w-]+\.ts|botd\/(?:PROTOCOL|DEMO)\.md|client-ui\/src\/[\w-]+\.ts|scripts\/[\w-]+\.sh|botd\/\.gitignore))`/g)]
    .map((match) => match[1] as string));
  assert.ok(paths.size >= 10, "expected repository paths in the runbook");
  for (const path of paths) assert.ok(existsSync(join(root, path)), `missing ${path}`);
});

test("every example frame operation appears in the protocol types", () => {
  const operations = new Set([...doc.matchAll(/"op":"([a-z]+)"/g)].map((match) => match[1] as string));
  assert.deepEqual([...operations].sort(), ["ack", "cancel", "error", "event", "hello", "open", "renew", "resume", "send", "state"]);
  const declared = new Set([...protocol.matchAll(/\bop:\s*"([a-z]+)"/g)].map((match) => match[1]));
  for (const op of operations) assert.ok(declared.has(op), `protocol.ts does not declare ${op}`);
});

test("Appendix B error codes appear in the source", () => {
  const appendix = doc.split(/^## Appendix B\b/m)[1];
  assert.ok(appendix, "Appendix B is missing");
  const errorRow = appendix.split("\n").find((line) => line.startsWith("| `error` with a code"));
  assert.ok(errorRow, "Appendix B has no error code row");
  const codes = [...errorRow.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1] as string);
  assert.deepEqual(codes, ["bad_frame", "no_lease", "lease_paused", "stale_fence", "stale_lease", "session_exited", "unknown_session", "child_error", "bad_json"]);
  const source = sourceText(join(root, "botd/src"));
  for (const code of codes) assert.match(source, new RegExp(`\\b${code}\\b`), `source does not mention ${code}`);
});

test("numbered sections are consecutive and unique", () => {
  const numbers = [...doc.matchAll(/^## (\d+)\./gm)].map((match) => Number(match[1]));
  assert.deepEqual(numbers, Array.from({ length: 11 }, (_, index) => index));
});

test("both appendices have unique headings", () => {
  for (const letter of ["A", "B"]) {
    const headings = [...doc.matchAll(new RegExp(`^## Appendix ${letter}\\b.*$`, "gm"))];
    assert.equal(headings.length, 1, `expected one Appendix ${letter} heading`);
  }
});
