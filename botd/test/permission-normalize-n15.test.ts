import test from "node:test";
import assert from "node:assert/strict";

import { normalizeRequest } from "../src/permission.ts";

test("tool keys use precedence and skip blank or non-string values", () => {
  const keys = ["tool_name", "toolName", "tool", "name"];
  for (let i = 0; i < keys.length; i++) {
    const raw = Object.fromEntries(keys.map((key, j) => [key, j < i ? (j % 2 ? 7 : "  ") : ` value${j} `]));
    assert.equal(normalizeRequest(raw).tool, `value${i}`);
  }
});

test("tool call keys use precedence for both container spellings", () => {
  for (const container of ["toolCall", "tool_call"]) {
    assert.equal(normalizeRequest({ [container]: { name: " first ", kind: "second", title: "third" } }).tool, "first");
    assert.equal(normalizeRequest({ [container]: { name: " ", kind: " second ", title: "third" } }).tool, "second");
    assert.equal(normalizeRequest({ [container]: { name: 1, kind: "", title: " third " } }).tool, "third");
  }
});

test("root tool keys take precedence over tool call keys", () => {
  assert.equal(normalizeRequest({ name: "outer", toolCall: { name: "inner" } }).tool, "outer");
});

test("toolCall takes precedence over tool_call when both are objects", () => {
  assert.equal(normalizeRequest({ toolCall: { kind: "first" }, tool_call: { name: "second" } }).tool, "first");
});

test("all singular path aliases are collected in key order", () => {
  const keys = ["file_path", "filePath", "abs_path", "absPath", "notebook_path", "notebookPath", "target_file", "targetFile", "file", "path"];
  const raw = Object.fromEntries([...keys].reverse().map((key) => [key, `${key}.txt`]));
  assert.deepEqual(normalizeRequest(raw).paths, keys.map((key) => `${key}.txt`));
});

test("path list aliases collect only nonempty strings in key and entry order", () => {
  const facts = normalizeRequest({ filePaths: ["d", null], file_paths: ["c", 1], files: ["b", ""], paths: ["a", false] });
  assert.deepEqual(facts.paths, ["a", "b", "c", "d"]);
});

test("command aliases use precedence and skip invalid values", () => {
  const keys = ["command", "cmd", "script", "command_line", "commandLine"];
  for (let i = 0; i < keys.length; i++) {
    const raw = Object.fromEntries(keys.map((key, j) => [key, j < i ? (j % 2 ? [] : " ") : `cmd${j}`]));
    assert.equal(normalizeRequest(raw).command, `cmd${i}`);
  }
});

test("command aliases accept argv and reject mixed arrays", () => {
  assert.deepEqual(normalizeRequest({ command: ["x", 1], cmd: ["run", "item"] }).command, ["run", "item"]);
});

test("each container alias is traversed for paths and commands", () => {
  const keys = ["input", "rawInput", "raw_input", "params", "arguments", "args", "toolCall", "tool_call", "permissions", "edits"];
  for (const key of keys) {
    const facts = normalizeRequest({ [key]: { path: `${key}.txt`, command: "run" } });
    assert.equal(facts.command, "run", key);
    assert.deepEqual(facts.paths, [`${key}.txt`, "run"], key);
  }
});

test("container arrays traverse objects in order and select the first command", () => {
  const facts = normalizeRequest({ edits: [null, { path: "a", cmd: "first" }, { path: "b", cmd: "second" }] });
  assert.equal(facts.command, "first");
  assert.deepEqual(facts.paths, ["a", "b", "first"]);
});

test("container precedence selects the first nested command", () => {
  const facts = normalizeRequest({ args: { cmd: "later" }, input: { cmd: "earlier" } });
  assert.equal(facts.command, "earlier");
});

test("walk includes depth four but stops before depth five", () => {
  const facts = normalizeRequest({ input: { input: { input: { input: {
    path: "included", cmd: "accepted", input: { path: "excluded", command: "ignored" },
  } } } } });
  assert.equal(facts.command, "accepted");
  assert.deepEqual(facts.paths, ["included", "accepted"]);
  assert.equal(normalizeRequest({ input: { input: { input: { input: { input: { cmd: "ignored" } } } } } }).command, undefined);
});

test("permission wrapper uses request facts instead of wrapper facts", () => {
  const facts = normalizeRequest({ kind: "permission", tool: "outer", path: "outer", request: { tool: "inner", path: "inner" } });
  assert.deepEqual(facts, { tool: "inner", paths: ["inner"], command: undefined });
});

test("non-object inputs normalize to an empty request", () => {
  for (const raw of [undefined, false, 42, []]) {
    assert.deepEqual(normalizeRequest(raw), { tool: "", paths: [] });
  }
});

test("command paths are appended after explicitly supplied paths", () => {
  const facts = normalizeRequest({ path: "explicit", command: ["run", "./target", "--flag"] });
  assert.deepEqual(facts.paths, ["explicit", "run", "./target"]);
});
