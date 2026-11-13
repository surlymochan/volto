import { test } from "node:test";
import assert from "node:assert/strict";

import type { BotAdapter, BotKind } from "../../src/adapter-types.ts";
import { ADAPTER_CAPABILITIES } from "../../src/adapters/index.ts";
import { createClaudeAdapter } from "../../src/adapters/claude.ts";
import { CodexAdapter, codexAdapter } from "../../src/adapters/codex.ts";
import {
  ACP_PROTOCOL_VERSION as COPILOT_VERSION,
  COPILOT_COMMAND,
  COPILOT_ENABLED_ENV,
  CopilotAdapter,
  copilotAdapter,
} from "../../src/adapters/copilot.ts";
import { ACP_PROTOCOL_VERSION as DSH_VERSION, DSH_COMMAND, DshAdapter, dshAdapter } from "../../src/adapters/dsh.ts";
import { PI_COMMAND, PiAdapter, piAdapter } from "../../src/adapters/pi.ts";

const cwd = ".tmp/factory-shapes";
const cases: { kind: BotKind; exported: () => BotAdapter; fresh: () => BotAdapter; command: readonly string[] }[] = [
  { kind: "claude", exported: createClaudeAdapter, fresh: createClaudeAdapter, command: ["claude"] },
  { kind: "codex", exported: () => codexAdapter, fresh: () => new CodexAdapter(), command: ["codex", "app-server"] },
  { kind: "copilot", exported: () => copilotAdapter, fresh: () => new CopilotAdapter(), command: COPILOT_COMMAND },
  { kind: "dsh", exported: () => dshAdapter, fresh: () => new DshAdapter(), command: DSH_COMMAND },
  { kind: "pi", exported: () => piAdapter, fresh: () => new PiAdapter(), command: PI_COMMAND },
];

for (const { kind, exported, fresh, command } of cases) {
  test(`${kind} exported adapter has the contract and builds its spawn spec`, () => {
    const adapter = exported();
    const row = ADAPTER_CAPABILITIES.find((entry) => entry.kind === kind);
    assert.ok(row);
    assert.equal(adapter.kind, kind);
    assert.equal(adapter.kind, row.kind);
    assert.equal(adapter.family, row.family);
    for (const method of ["spawn", "handshake", "prompt", "cancel", "parse", "answerPermission"] as const) {
      assert.equal(typeof adapter[method], "function", method);
    }

    const previous = process.env[COPILOT_ENABLED_ENV];
    try {
      if (kind === "copilot") process.env[COPILOT_ENABLED_ENV] = "1";
      const spec = adapter.spawn({ cwd });
      assert.equal(spec.cwd, cwd);
      assert.deepEqual(spec.command.slice(0, command.length), [...command]);
      assert.equal(typeof spec.env, "object");
    } finally {
      if (previous === undefined) delete process.env[COPILOT_ENABLED_ENV];
      else process.env[COPILOT_ENABLED_ENV] = previous;
    }
  });

  test(`${kind} instances keep mutable session state separate`, () => {
    const first = fresh();
    const second = fresh();
    const control = fresh();
    assert.notEqual(first, second);
    if (kind === "claude") {
      first.parse(JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", id: "tool-1", name: "synthetic-tool", input: {} },
      ] } }));
      const result = JSON.stringify({ type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "tool-1", content: "done" },
      ] } });
      assert.notDeepEqual(first.parse(result), second.parse(result));
      assert.deepEqual(second.parse(result), control.parse(result));
    } else {
      first.handshake({ cwd });
      assert.deepEqual(second.handshake({ cwd }), control.handshake({ cwd }));
      assert.notDeepEqual(first.handshake({ cwd }), fresh().handshake({ cwd }));
    }
  });
}

test("ACP adapters use the same numeric protocol version", () => {
  assert.equal(typeof COPILOT_VERSION, "number");
  assert.equal(typeof DSH_VERSION, "number");
  assert.equal(COPILOT_VERSION, DSH_VERSION);
});
