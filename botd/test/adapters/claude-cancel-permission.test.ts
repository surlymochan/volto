import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAdapter } from "../../src/adapters/claude.ts";

function permissionLine(id: string, command = "ls"): string {
  return JSON.stringify({
    type: "control_request",
    request_id: id,
    request: { subtype: "can_use_tool", tool_name: "Bash", input: { command } },
  });
}

test("cancel prevents a late allow for a pending permission", () => {
  const adapter = new ClaudeAdapter();
  assert.equal(adapter.parse(permissionLine("req-1"))[0]?.kind, "permission");
  adapter.cancel({});
  assert.equal(adapter.answerPermission("req-1", true), null);
});

test("a late denial after cancel still answers the request with deny", () => {
  const adapter = new ClaudeAdapter();
  adapter.parse(permissionLine("req-1"));
  adapter.cancel({});
  assert.deepEqual(adapter.answerPermission("req-1", false), {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "req-1",
      response: { behavior: "deny", message: "Permission denied by user" },
    },
  });
});

test("cancel blocks a late allow for all pending permissions and still returns an interrupt", () => {
  const adapter = new ClaudeAdapter();
  adapter.parse(permissionLine("req-1"));
  adapter.parse(permissionLine("req-2"));
  const messages = adapter.cancel({}) as Record<string, unknown>[];
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "control_request");
  assert.equal(typeof messages[0].request_id, "string");
  assert.deepEqual(messages[0].request, { subtype: "interrupt" });
  assert.equal(adapter.answerPermission("req-1", true), null);
  assert.equal(adapter.answerPermission("req-2", true), null);
});

test("a permission request arriving after cancel can be answered, including a reused id", () => {
  const adapter = new ClaudeAdapter();
  adapter.parse(permissionLine("req-1"));
  adapter.cancel({});
  adapter.parse(permissionLine("req-1", "pwd"));
  assert.deepEqual(adapter.answerPermission("req-1", true), {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "req-1",
      response: { behavior: "allow", updatedInput: { command: "pwd" } },
    },
  });
});
