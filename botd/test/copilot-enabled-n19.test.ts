import { test } from "node:test";
import assert from "node:assert/strict";

import { assertCopilotEnabled } from "../src/adapters/copilot.ts";

test("the disabled adapter error names the opt-in environment variable", () => {
  assert.throws(() => assertCopilotEnabled({}), /COPILOT_ENABLED/);
});
