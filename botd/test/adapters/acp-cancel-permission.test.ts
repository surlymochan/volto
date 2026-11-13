// botd/test/adapters/acp-cancel-permission.test.ts
//
// A cancelled turn must not grant a pending permission.
//
// PROTOCOL.md §7 ("Cancellation and escalation") describes the contract of a
// cancel: the daemon writes the provider-native cancel to the child and the
// turn is over.  An ACP agent (agy, dsh, copilot) may be waiting for the
// answer of a `session/request_permission` when the cancel arrives.  That
// request belongs to the cancelled turn: answering it with "allow" after the
// cancel lets the agent run a tool the user already stopped.
//
// The three ACP adapters used to keep the pending request in their map, so a
// late `answerPermission(id, true)` still granted it (the todo of PR #70 in
// botd/test/adapters/cancel-midstream.test.ts).
//
// The suite is table driven: every ACP adapter of botd/src/adapters/ is one
// row of CASES.  The rows carry the provider specific fixtures (the
// permission request shape of the adapter, its session lines and the option
// ids it offers), everything else is shared.
//
// What is asserted for every adapter:
//
//   * a late allow after the cancel grants nothing: `answerPermission` returns
//     null, so nothing is written to the provider,
//   * a late deny after the cancel is answered with the harmless reject
//     option of the request: the provider is told "no" (never "yes"),
//   * a permission request that is raised *after* the cancel is answerable
//     again: the cancel only closes the requests of the cancelled turn,
//   * the cancel frame(s) of the adapter do not change,
//   * a permission of a running turn is answerable as before.
//
// All lines below are synthetic.  No provider, host, account or token is
// contacted; the fixtures follow the message shapes of the adapter tests in
// botd/test/adapters/ (agy.test.ts, dsh.test.ts, copilot.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

import type { BotAdapter, NormalizedEvent } from "../../src/adapter-types.ts";
import { createAgyAdapter } from "../../src/adapters/agy.ts";
import { CopilotAdapter } from "../../src/adapters/copilot.ts";
import { DshAdapter } from "../../src/adapters/dsh.ts";

/* ------------------------------------------------------------------ table */

/** One row of the adapter table. */
interface AcpCase {
  /** Name of the adapter (its `kind`). */
  readonly kind: string;
  /** A fresh adapter instance: one instance belongs to one session. */
  readonly create: () => BotAdapter;
  /** The provider session id of the adapter. */
  readonly providerSessionId: string;
  /** The lines that open the session (the agent announces its session id). */
  readonly sessionLines: () => string[];
  /** The `session/request_permission` request of the running turn. */
  readonly permissionRequest: (id: number) => string;
  /** The id of the permission request of the running turn. */
  readonly permissionId: string;
  /** The option that grants the permission. */
  readonly allowOptionId: string;
  /** The option that rejects the permission. */
  readonly rejectOptionId: string;
}

/* -------------------------------------------------------------------- agy */

const AGY_SESSION_ID = "agy-session-0001";

const agyCase: AcpCase = {
  kind: "agy",
  create: () => createAgyAdapter({ protocol: "acp" }),
  providerSessionId: AGY_SESSION_ID,
  sessionLines: () => [
    JSON.stringify({ jsonrpc: "2.0", id: 2, result: { sessionId: AGY_SESSION_ID } }),
  ],
  permissionRequest: (id) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId: AGY_SESSION_ID,
        toolCall: { toolCallId: "call-3", title: "Run shell command", kind: "execute" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    }),
  permissionId: "7",
  allowOptionId: "allow-once",
  rejectOptionId: "reject-once",
};

/* -------------------------------------------------------------------- dsh */

const DSH_SESSION_ID = "sess_synthetic_0001";

const dshCase: AcpCase = {
  kind: "dsh",
  create: () => new DshAdapter(),
  providerSessionId: DSH_SESSION_ID,
  sessionLines: () => [
    JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: DSH_SESSION_ID } }),
  ],
  permissionRequest: (id) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId: DSH_SESSION_ID,
        toolCall: {
          toolCallId: "call_synthetic_0003",
          title: "Run command",
          kind: "execute",
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    }),
  permissionId: "2",
  allowOptionId: "allow-once",
  rejectOptionId: "reject-once",
};

/* ---------------------------------------------------------------- copilot */

const COPILOT_SESSION_ID = "sess_synthetic_0001";

const copilotCase: AcpCase = {
  kind: "copilot",
  create: () => new CopilotAdapter(),
  providerSessionId: COPILOT_SESSION_ID,
  sessionLines: () => [
    JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: COPILOT_SESSION_ID } }),
  ],
  permissionRequest: (id) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId: COPILOT_SESSION_ID,
        toolCall: {
          toolCallId: "call_synthetic_0003",
          title: "Run command",
          kind: "execute",
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    }),
  permissionId: "2",
  allowOptionId: "allow-once",
  rejectOptionId: "reject-once",
};

/** Every ACP adapter of this build, one row each. */
const CASES: readonly AcpCase[] = [agyCase, dshCase, copilotCase];

/* --------------------------------------------------------------- helpers */

/** Parse a list of provider lines. */
function parseAll(adapter: BotAdapter, lines: readonly string[]): NormalizedEvent[] {
  return lines.flatMap((line) => adapter.parse(line));
}

/** The permission events of a list of events. */
function permissionsOf(events: readonly NormalizedEvent[]): { id: string }[] {
  return events.filter(
    (event): event is { kind: "permission"; id: string; request: unknown } =>
      event.kind === "permission",
  );
}

/** The option id an answer selects, if the answer selects one. */
function selectedOption(answer: unknown): string | undefined {
  if (answer === null || typeof answer !== "object") return undefined;
  const result = (answer as { result?: { outcome?: { optionId?: unknown } } }).result;
  const optionId = result?.outcome?.optionId;
  return typeof optionId === "string" ? optionId : undefined;
}

/** The JSON of an answer, for the "does not grant" checks. */
function jsonOf(answer: unknown): string {
  return answer === null || answer === undefined ? "" : JSON.stringify(answer) ?? "";
}

/* ----------------------------------------------------------------- tests */

for (const row of CASES) {
  test(`${row.kind}: a late allow after the cancel grants nothing`, () => {
    const adapter = row.create();
    parseAll(adapter, row.sessionLines());
    parseAll(adapter, [row.permissionRequest(Number(row.permissionId))]);

    adapter.cancel({ providerSessionId: row.providerSessionId });

    // The request of the cancelled turn may no longer be allowed: the adapter
    // answers nothing, so nothing is written to the provider.
    const answer = adapter.answerPermission(row.permissionId, true);
    assert.equal(
      answer,
      null,
      `${row.kind}: a late allow still answers the cancelled request: ${jsonOf(answer)}`,
    );
    assert.ok(
      !jsonOf(answer).includes(row.allowOptionId),
      `${row.kind}: a late allow still selects the allow option`,
    );
  });

  test(`${row.kind}: a late deny after the cancel is answered with the harmless reject`, () => {
    const adapter = row.create();
    parseAll(adapter, row.sessionLines());
    parseAll(adapter, [row.permissionRequest(Number(row.permissionId))]);

    adapter.cancel({ providerSessionId: row.providerSessionId });

    // The documented behaviour of a late deny: the adapter answers the
    // dropped request with its reject option, so the provider is told "no".
    // The answer never selects the allow option.
    const answer = adapter.answerPermission(row.permissionId, false);
    assert.notEqual(
      answer,
      null,
      `${row.kind}: a late deny answers nothing at all`,
    );
    assert.equal(
      selectedOption(answer),
      row.rejectOptionId,
      `${row.kind}: a late deny does not select the reject option: ${jsonOf(answer)}`,
    );
    assert.ok(
      !jsonOf(answer).includes(row.allowOptionId),
      `${row.kind}: a late deny selects the allow option: ${jsonOf(answer)}`,
    );
  });

  test(`${row.kind}: a permission request raised after the cancel is answerable`, () => {
    const adapter = row.create();
    parseAll(adapter, row.sessionLines());
    parseAll(adapter, [row.permissionRequest(Number(row.permissionId))]);

    adapter.cancel({ providerSessionId: row.providerSessionId });

    // The next turn asks for a new permission: the cancel of the previous
    // turn does not close the requests of the new one.
    const nextId = Number(row.permissionId) + 100;
    const events = parseAll(adapter, [row.permissionRequest(nextId)]);
    const permissions = permissionsOf(events);
    assert.equal(permissions.length, 1, `${row.kind}: the new request is not reported`);
    assert.equal(permissions[0].id, String(nextId));

    const answer = adapter.answerPermission(String(nextId), true);
    assert.notEqual(
      answer,
      null,
      `${row.kind}: the request of the new turn is not answerable`,
    );
    assert.equal(
      selectedOption(answer),
      row.allowOptionId,
      `${row.kind}: the request of the new turn does not select the allow option: ${jsonOf(answer)}`,
    );
  });

  test(`${row.kind}: cancel() still emits the documented session/cancel notification`, () => {
    const adapter = row.create();
    parseAll(adapter, row.sessionLines());

    const frames = adapter.cancel({ providerSessionId: row.providerSessionId });
    assert.deepEqual(frames, [
      {
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: row.providerSessionId },
      },
    ]);
  });

  test(`${row.kind}: a permission of a running turn is answerable`, () => {
    // A permission is single shot, so the allow and the reject are checked on
    // two instances of the adapter.
    const allowing = row.create();
    parseAll(allowing, row.sessionLines());
    const events = parseAll(allowing, [row.permissionRequest(Number(row.permissionId))]);
    const permissions = permissionsOf(events);
    assert.equal(permissions.length, 1, `${row.kind}: the request is not reported`);

    const allow = allowing.answerPermission(row.permissionId, true);
    assert.notEqual(allow, null, `${row.kind}: the request of a running turn is not answerable`);
    assert.equal(
      selectedOption(allow),
      row.allowOptionId,
      `${row.kind}: the request of a running turn does not select the allow option`,
    );

    const rejecting = row.create();
    parseAll(rejecting, row.sessionLines());
    parseAll(rejecting, [row.permissionRequest(Number(row.permissionId))]);

    const reject = rejecting.answerPermission(row.permissionId, false);
    assert.notEqual(reject, null, `${row.kind}: the request of a running turn is not answerable`);
    assert.equal(
      selectedOption(reject),
      row.rejectOptionId,
      `${row.kind}: the request of a running turn does not select the reject option`,
    );
  });
}

/* ------------------------------------------------- the agy stream-json path */

test("agy (stream-json fallback): a cancelled turn grants nothing", () => {
  const adapter = createAgyAdapter({ protocol: "stream-json" });
  // The fallback speaks the Claude compatible protocol: it has no permission
  // requests at all, so there is nothing to answer after a cancel.
  assert.deepEqual(adapter.cancel({ providerSessionId: AGY_SESSION_ID }), []);
  assert.equal(adapter.answerPermission("7", true), null);
  assert.equal(adapter.answerPermission("7", false), null);
});
