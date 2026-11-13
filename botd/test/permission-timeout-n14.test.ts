import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, normalizeRequest, referencePolicy } from "../src/permission.ts";

const CWD = "/workspace/project";

test("the reference policy asks for an unknown tool", () => {
  assert.equal(decide({ tool: "UnrecognizedTool" }, referencePolicy(CWD)), "ask");
});

test("empty and null payloads are denied by a default-deny policy", () => {
  const policy = { cwd: CWD, default: "deny" as const };
  for (const raw of [{}, null]) {
    const request = normalizeRequest(raw);
    assert.deepEqual(request.paths, []);
    assert.equal(decide(request, policy), "deny");
  }
});

test.todo("unanswered permissions time out to deny and ignore late answers");
