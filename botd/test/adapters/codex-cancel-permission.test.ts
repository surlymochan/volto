import { test } from "node:test";
import assert from "node:assert/strict";

import { CodexAdapter } from "../../src/adapters/codex.ts";

const THREAD_ID = "thread_synthetic_0001";
const TURN_ID = "turn_synthetic_0001";

function startTurn(adapter: CodexAdapter): void {
  adapter.parse(JSON.stringify({
    method: "turn/started",
    params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "inProgress", items: [] } },
  }));
}

function requestApproval(adapter: CodexAdapter, id: number): string {
  const event = adapter.parse(JSON.stringify({
    id,
    method: "item/commandExecution/requestApproval",
    params: { threadId: THREAD_ID, turnId: TURN_ID, command: "ls -la" },
  }))[0];
  if (event.kind !== "permission") throw new Error("expected a permission event");
  return event.id;
}

test("cancel drops a pending approval so a late allow returns null", () => {
  const adapter = new CodexAdapter();
  startTurn(adapter);
  const id = requestApproval(adapter, 11);

  const messages = adapter.cancel({ providerSessionId: THREAD_ID }) as Record<string, unknown>[];
  assert.equal(messages.length, 1);
  assert.equal(messages[0].method, "turn/interrupt");
  assert.deepEqual(messages[0].params, { threadId: THREAD_ID, turnId: TURN_ID });
  assert.equal(adapter.answerPermission(id, true), null);
});

test("approvals raised after cancel remain answerable", () => {
  const adapter = new CodexAdapter();
  startTurn(adapter);
  adapter.cancel({ providerSessionId: THREAD_ID });
  const id = requestApproval(adapter, 12);

  assert.deepEqual(adapter.answerPermission(id, true), { id: 12, result: { decision: "accept" } });
});

test("cancel without a known turn drops pending approvals and returns no messages", () => {
  const adapter = new CodexAdapter();
  const id = requestApproval(adapter, 13);

  assert.deepEqual(adapter.cancel({ providerSessionId: THREAD_ID }), []);
  assert.equal(adapter.answerPermission(id, true), null);
});

test("cancel drops all pending approvals", () => {
  const adapter = new CodexAdapter();
  startTurn(adapter);
  const first = requestApproval(adapter, 14);
  const second = requestApproval(adapter, 15);

  adapter.cancel({ providerSessionId: THREAD_ID });
  assert.equal(adapter.answerPermission(first, false), null);
  assert.equal(adapter.answerPermission(second, true), null);
});
