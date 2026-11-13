import { test } from "node:test";
import assert from "node:assert/strict";

import { CodexAdapter } from "../../src/adapters/codex.ts";

const methods = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
] as const;

for (const [index, method] of methods.entries()) {
  test(`${method} preserves the complete request and normalizes its id`, () => {
    const adapter = new CodexAdapter();
    const id = index + 101;
    const params = { marker: `synthetic-${index}`, nested: { value: index } };
    assert.deepEqual(adapter.parse(JSON.stringify({ id, method, params })), [
      { kind: "permission", id: String(id), request: { method, params } },
    ]);
    assert.deepEqual(adapter.parse(JSON.stringify({ id: `missing-${index}`, method })), [
      { kind: "permission", id: `missing-${index}`, request: { method, params: null } },
    ]);
  });
}

test("a different server request remains raw and cannot be answered", () => {
  const adapter = new CodexAdapter();
  const message = { id: "question-1", method: "synthetic/question", params: { value: 1 } };
  assert.deepEqual(adapter.parse(JSON.stringify(message)), [{ kind: "raw", payload: message }]);
  assert.equal(adapter.answerPermission(message.id, true), null);
});

for (const [method, allow, decision] of [
  [methods[0], false, "decline"],
  [methods[1], true, "accept"],
] as const) {
  test(`${method} returns ${decision} with a string wire id`, () => {
    const adapter = new CodexAdapter();
    const id = `wire-${decision}`;
    adapter.parse(JSON.stringify({ id, method, params: {} }));
    assert.deepEqual(adapter.answerPermission(id, allow), { id, result: { decision } });
    assert.equal(adapter.answerPermission(id, !allow), null);
  });
}

test("permission grants echo only requested network and file system permissions", () => {
  const adapter = new CodexAdapter();
  const permissions = { network: { enabled: false }, fileSystem: { read: [".tmp/input"] } };
  adapter.parse(JSON.stringify({ id: "grant-1", method: methods[2], params: { permissions } }));
  assert.deepEqual(adapter.answerPermission("grant-1", true), {
    id: "grant-1", result: { permissions, scope: "turn" },
  });
  assert.equal(adapter.answerPermission("grant-1", false), null);
});

test("permission denial preserves a string wire id and grants nothing", () => {
  const adapter = new CodexAdapter();
  adapter.parse(JSON.stringify({ id: "deny-1", method: methods[2], params: { permissions: { network: { enabled: true } } } }));
  assert.deepEqual(adapter.answerPermission("deny-1", false), {
    id: "deny-1", result: { permissions: {}, scope: "turn" },
  });
});

for (const [method, allow, decision] of [
  [methods[3], false, { denied: { rejection: "denied by policy" } }],
  [methods[4], true, "approved"],
] as const) {
  test(`${method} answers the complementary legacy decision`, () => {
    const adapter = new CodexAdapter();
    const id = `legacy-${allow}`;
    adapter.parse(JSON.stringify({ id, method, params: null }));
    assert.deepEqual(adapter.answerPermission(id, allow), { id, result: { decision } });
    assert.equal(adapter.answerPermission(id, !allow), null);
  });
}

test("an unknown id leaves a separate numeric approval pending", () => {
  const adapter = new CodexAdapter();
  adapter.parse(JSON.stringify({ id: 201, method: methods[1], params: {} }));
  assert.equal(adapter.answerPermission("unknown", false), null);
  assert.deepEqual(adapter.answerPermission("201", true), { id: 201, result: { decision: "accept" } });
  assert.equal(adapter.answerPermission("201", false), null);
});
