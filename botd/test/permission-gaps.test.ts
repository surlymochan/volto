import test from "node:test";
import assert from "node:assert/strict";

import { decide, normalizeRequest, referencePolicy } from "../src/permission.ts";

const policy = referencePolicy("/w");

for (const row of [
  { name: "null", raw: null, tool: "" },
  { name: "undefined", raw: undefined, tool: "" },
  { name: "number", raw: 42, tool: "" },
  { name: "empty object", raw: {}, tool: "unknown" },
  { name: "unknown tool", raw: { tool: "Unrecognized" }, tool: "Unrecognized" },
  { name: "missing tool", raw: { paths: ["file"] }, tool: "unknown" },
]) {
  test(`incomplete request: ${row.name}`, () => {
    const request = normalizeRequest(row.raw);
    assert.equal(request.tool, row.tool);
    assert.ok(Array.isArray(request.paths));
    assert.equal(decide(request, policy), "ask");
  });
}

// DEFECT: referencePolicy asks instead of denying malformed and unknown requests.
test.todo("reference policy denies malformed and unknown requests");
