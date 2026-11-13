import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const doc = () => readFileSync(new URL("../HOST-POLICY.md", import.meta.url), "utf8");

function matrix(): Map<string, string[]> {
  const lines = doc().split("\n");
  const header = lines.findIndex((line) => /^\|\s*kind\s*\|\s*local\s*\|\s*remote\s*\|$/i.test(line));
  assert.notEqual(header, -1, "host policy matrix is missing");
  assert.match(lines[header + 1] ?? "", /^\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|$/);
  const rows = new Map<string, string[]>();
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim().replace(/`/g, ""));
    rows.set(cells[0] ?? "", cells.slice(1));
  }
  return rows;
}

test("document has a kind by host matrix", () => {
  const rows = matrix();
  for (const kind of ["claude", "codex", "pi", "agy", "dsh", "other"]) {
    assert.ok(rows.has(kind), `missing ${kind} row`);
  }
});

test("claude permits local and rejects remote", () => {
  assert.deepEqual(matrix().get("claude"), ["allowed", "rejected"]);
});

test("other kinds permit remote and reject local", () => {
  const rows = matrix();
  for (const kind of ["codex", "pi", "agy", "dsh", "other"]) {
    assert.deepEqual(rows.get(kind), ["rejected", "allowed"], kind);
  }
});

test("document specifies the alias charset and error code", () => {
  assert.ok(doc().includes("[A-Za-z0-9_.-]"));
  assert.ok(doc().includes("HOST_POLICY"));
});
