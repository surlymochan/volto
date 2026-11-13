// Synthetic boundary cases for the permission policy.
import test from "node:test";
import assert from "node:assert/strict";

import { decide, normalizeRequest, pathScope, referencePolicy } from "../src/permission.ts";

const CWD = "/workspace/ws";

test("pathScope resolves a parent segment that stays inside", () => {
  assert.equal(pathScope(["./a/../b"], CWD), "inside");
});

test("pathScope detects traversal after an inside segment", () => {
  assert.equal(pathScope(["a/../../outside"], CWD), "outside");
});

test("pathScope normalizes trailing slashes on both root and path", () => {
  assert.equal(pathScope(["/workspace/ws/dir/"], `${CWD}/`), "inside");
});

test("pathScope treats an empty path as unresolvable", () => {
  assert.equal(pathScope([""], CWD), "outside");
});

test("normalization drops empty paths before scope classification", () => {
  const facts = normalizeRequest({ tool: "Read", paths: ["", "./a/../b"] });
  assert.deepEqual(facts.paths, ["./a/../b"]);
  assert.equal(pathScope(facts.paths ?? [], CWD), "inside");
});

test("normalization leaves an empty path list with no scope", () => {
  const facts = normalizeRequest({ tool: "Read", path: "" });
  assert.deepEqual(facts.paths, []);
  assert.equal(pathScope(facts.paths ?? [], CWD), "none");
});

test("relative and absolute paths to the same location have the same scope", () => {
  assert.equal(pathScope(["./a/../b"], CWD), pathScope([`${CWD}/b`], CWD));
  assert.equal(pathScope(["../ws-other/b"], CWD), pathScope(["/workspace/ws-other/b"], CWD));
  assert.equal(pathScope(["../ws-other/b"], CWD), "outside");
});

test("reference policy denies a prefix sibling even for reads", () => {
  assert.equal(decide({ tool: "Read", paths: ["/workspace/ws-other/file"] }, referencePolicy(CWD)), "deny");
});

test("reference policy denies an absolute path that traverses out", () => {
  assert.equal(decide({ tool: "Read", paths: [`${CWD}/a/../../outside`] }, referencePolicy(CWD)), "deny");
});

test("reference policy allows a read after traversal within the workspace", () => {
  assert.equal(decide({ tool: "Read", paths: ["./a/../b"] }, referencePolicy(CWD)), "allow");
});

test("an explicitly empty rule list falls back to ask", () => {
  assert.equal(decide({ tool: "Write" }, { cwd: CWD, rules: [] }), "ask");
});

test("an explicitly empty rule list honors a configured default", () => {
  assert.equal(decide({ tool: "Write" }, { cwd: CWD, rules: [], default: "deny" }), "deny");
});

test("a broad first rule wins over a later more specific rule", () => {
  assert.equal(decide({ tool: "Read", paths: ["b"] }, {
    cwd: CWD,
    rules: [
      { decision: "ask" },
      { tool: "Read", scope: "inside", decision: "allow" },
    ],
  }), "ask");
});

test("an unknown request kind with no recognized facts reaches the default", () => {
  const facts = normalizeRequest({ kind: "unrecognized", request: { tool: "Read", paths: ["b"] } });
  assert.equal(facts.tool, "unknown");
  assert.deepEqual(facts.paths, []);
  assert.equal(decide(facts, { cwd: CWD, rules: [], default: "deny" }), "deny");
});
