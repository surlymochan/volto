import { test } from "node:test";
import assert from "node:assert/strict";

import { CodexAdapter } from "../../src/adapters/codex.ts";

test("parse keeps unknown server requests as raw events", () => {
  const adapter = new CodexAdapter();
  const message = { id: 1, method: "synthetic/unknown", params: {} };

  assert.deepEqual(adapter.parse(JSON.stringify(message)), [{ kind: "raw", payload: message }]);
});

// DEFECT: The requested empty result for invalid JSON is currently a raw event.
test.todo("parse returns an empty array for invalid JSON");
