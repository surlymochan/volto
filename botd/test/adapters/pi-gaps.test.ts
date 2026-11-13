import { test } from "node:test";
import assert from "node:assert/strict";

import { PiAdapter } from "../../src/adapters/pi.ts";

test("handshake ignores effort and system prompt for a new or resumed session", () => {
  const options = { cwd: "/synthetic/work", effort: "high", systemPrompt: "synthetic prompt" };

  assert.deepEqual(new PiAdapter({ env: {} }).handshake(options), [
    { id: "pi-1", type: "new_session" },
    { id: "pi-2", type: "get_state" },
  ]);
  assert.deepEqual(
    new PiAdapter({ env: {} }).handshake({ ...options, resumeProviderSessionId: "synthetic-session" }),
    [
      { id: "pi-1", type: "switch_session", sessionPath: "synthetic-session" },
      { id: "pi-2", type: "get_state" },
    ],
  );
});

test("allowing a select request with no options returns null and consumes it", () => {
  const adapter = new PiAdapter({ env: {} });
  const request = { type: "extension_ui_request", id: "synthetic-ui", method: "select", options: [] };

  assert.deepEqual(adapter.parse(JSON.stringify(request)), [
    { kind: "permission", id: request.id, request },
  ]);
  assert.equal(adapter.answerPermission(request.id, true), null);
  assert.equal(adapter.answerPermission(request.id, false), null);
});
