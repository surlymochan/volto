// botd/test/adapters/cancel-midstream.test.ts
//
// Cancelling a turn in the middle of the stream, for every adapter.
//
// PROTOCOL.md §7 ("Cancellation and escalation") describes the contract of a
// cancel: the control plane escalates monotonically, the daemon sends the
// provider-native cancel and the turn ends with exactly one `turn_end` frame
// whose status is `cancelled`.  A cancel that arrives while the bot is still
// working is the normal case, not the exception: the provider may still be
// streaming deltas, may still have a tool call open and may still be waiting
// for the answer of a permission request.
//
// This suite therefore drives every adapter of botd/src/adapters/ through the
// same three steps:
//
//   1. a partial turn is fed to parse(): a message delta, a pending tool call
//      and a pending permission request,
//   2. cancel() is called and the documented provider-native cancel frame(s)
//      are checked,
//   3. the lines that arrive after the cancel (a late delta and the final
//      cancelled/aborted result) are parsed again.
//
// What is asserted:
//
//   * cancel() emits the cancel frame(s) the adapter documents,
//   * cancel() does not throw when no provider session id is known yet,
//   * a late answerPermission() after the cancel never allows the pending
//     request (it answers with the documented deny frame or with null),
//   * the lines after the cancel still yield well-formed events that end in
//     exactly one `turn_end` with the status `cancelled`.
//
// The suite is table driven: every adapter is one row of CASES, the rows only
// carry the provider specific fixtures and the assertions of their own cancel
// frame, everything else is shared.
//
// Known gap: no adapter drops the pending permission of a cancelled turn, so a
// late `answerPermission(id, true)` still grants it.  That check is marked as
// a todo at the bottom of this file (with the reason), the deny path is
// checked for every adapter.
//
// All lines below are synthetic.  No provider, host, account or token is
// contacted; the fixtures follow the message shapes documented in the
// adapters themselves (botd/src/adapters/*.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

import type { BotAdapter, NormalizedEvent } from "../../src/adapter-types.ts";
import { createAgyAdapter } from "../../src/adapters/agy.ts";
import { ClaudeAdapter } from "../../src/adapters/claude.ts";
import { CodexAdapter } from "../../src/adapters/codex.ts";
import { CopilotAdapter } from "../../src/adapters/copilot.ts";
import { DshAdapter } from "../../src/adapters/dsh.ts";
import { PiAdapter } from "../../src/adapters/pi.ts";

/* ------------------------------------------------------------------ table */

/** One row of the adapter table. */
interface CancelCase {
  /** Name of the adapter (its `kind`). */
  readonly kind: string;
  /** A fresh adapter instance: one instance belongs to one session. */
  readonly create: () => BotAdapter;
  /** The provider session id the adapter knows after the partial turn. */
  readonly providerSessionId?: string;
  /**
   * The lines of the partial turn: a message delta, a pending tool call and
   * a pending permission request.  Some protocols need the adapter itself to
   * build the lines (pi answers with the id of the `get_state` command).
   */
  readonly partialLines: (adapter: BotAdapter) => string[];
  /** The id of the permission request the partial turn registered. */
  readonly permissionId: string;
  /** The lines that arrive after the cancel: a late delta and the final result. */
  readonly lateLines: () => string[];
  /** The text delta the late lines carry. */
  readonly lateText: string;
  /** A token that only shows up in a frame that grants the permission. */
  readonly allowToken: string;
  /** The documented cancel frame(s) of this adapter. */
  readonly assertCancel: (frames: unknown[]) => void;
  /** The documented cancel frame(s) of a session without a provider session id. */
  readonly assertCancelWithoutSession: (frames: unknown[]) => void;
  /** The documented answer to a late deny of a pending permission request. */
  readonly assertDeny: (answer: unknown) => void;
}

/* ----------------------------------------------------------------- claude */

const CLAUDE_SESSION_ID = "claude-session-0001";
const CLAUDE_PERMISSION_ID = "req-0001";

function assertClaudeCancel(frames: unknown[]): void {
  assert.equal(frames.length, 1, "the claude cancel is one interrupt control request");
  const frame = frames[0] as Record<string, unknown>;
  assert.equal(frame.type, "control_request");
  assert.equal(typeof frame.request_id, "string");
  assert.ok((frame.request_id as string).length > 0, "the interrupt carries a request id");
  const request = frame.request as Record<string, unknown>;
  assert.equal(request.subtype, "interrupt");
}

function assertClaudeDeny(answer: unknown): void {
  const frame = answer as Record<string, unknown>;
  assert.equal(frame.type, "control_response");
  const response = frame.response as Record<string, unknown>;
  assert.equal(response.subtype, "success");
  assert.equal(response.request_id, CLAUDE_PERMISSION_ID);
  const body = response.response as Record<string, unknown>;
  assert.equal(body.behavior, "deny");
  assert.equal(typeof body.message, "string");
}

const claudeCase: CancelCase = {
  kind: "claude",
  create: () => new ClaudeAdapter(),
  providerSessionId: CLAUDE_SESSION_ID,
  permissionId: CLAUDE_PERMISSION_ID,
  allowToken: '"behavior":"allow"',
  partialLines: () => [
    JSON.stringify({ type: "system", subtype: "init", session_id: CLAUDE_SESSION_ID }),
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "PO" } },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "toolu-0001", name: "Bash", input: { command: "ls" } },
        ],
      },
    }),
    JSON.stringify({
      type: "control_request",
      request_id: CLAUDE_PERMISSION_ID,
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "ls" },
      },
    }),
  ],
  lateLines: () => [
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "late" } },
    }),
    JSON.stringify({
      type: "result",
      subtype: "cancelled",
      is_error: false,
      usage: { input_tokens: 7, output_tokens: 2 },
    }),
  ],
  lateText: "late",
  assertCancel: assertClaudeCancel,
  // The interrupt needs no session id, it interrupts the running turn.
  assertCancelWithoutSession: assertClaudeCancel,
  assertDeny: assertClaudeDeny,
};

/* ------------------------------------------------------------------ codex */

const CODEX_THREAD_ID = "thread-synthetic-0001";
const CODEX_TURN_ID = "turn-synthetic-0001";
const CODEX_PERMISSION_ID = "11";

function assertCodexCancel(frames: unknown[]): void {
  assert.equal(frames.length, 1, "the codex cancel is one turn/interrupt request");
  const frame = frames[0] as Record<string, unknown>;
  assert.equal(frame.method, "turn/interrupt");
  assert.equal(typeof frame.id, "number");
  assert.deepEqual(frame.params, { threadId: CODEX_THREAD_ID, turnId: CODEX_TURN_ID });
}

function assertCodexDeny(answer: unknown): void {
  const frame = answer as Record<string, unknown>;
  assert.equal(frame.id, 11);
  const result = frame.result as Record<string, unknown>;
  assert.equal(result.decision, "decline");
}

const codexCase: CancelCase = {
  kind: "codex",
  create: () => new CodexAdapter(),
  providerSessionId: CODEX_THREAD_ID,
  permissionId: CODEX_PERMISSION_ID,
  allowToken: '"accept"',
  partialLines: () => [
    JSON.stringify({ id: 2, result: { thread: { id: CODEX_THREAD_ID } } }),
    JSON.stringify({
      method: "turn/started",
      params: {
        threadId: CODEX_THREAD_ID,
        turn: { id: CODEX_TURN_ID, status: "inProgress" },
      },
    }),
    JSON.stringify({
      method: "item/agentMessage/delta",
      params: {
        threadId: CODEX_THREAD_ID,
        turnId: CODEX_TURN_ID,
        itemId: "item-0001",
        delta: "PO",
      },
    }),
    JSON.stringify({
      method: "item/started",
      params: {
        threadId: CODEX_THREAD_ID,
        turnId: CODEX_TURN_ID,
        item: {
          id: "item-0002",
          type: "commandExecution",
          command: "ls -la",
          status: "inProgress",
        },
      },
    }),
    JSON.stringify({
      id: 11,
      method: "item/commandExecution/requestApproval",
      params: { threadId: CODEX_THREAD_ID, turnId: CODEX_TURN_ID, command: "ls -la" },
    }),
  ],
  lateLines: () => [
    JSON.stringify({
      method: "item/agentMessage/delta",
      params: {
        threadId: CODEX_THREAD_ID,
        turnId: CODEX_TURN_ID,
        itemId: "item-0001",
        delta: "late",
      },
    }),
    JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: CODEX_THREAD_ID,
        turn: { id: CODEX_TURN_ID, status: "interrupted", items: [] },
      },
    }),
  ],
  lateText: "late",
  assertCancel: assertCodexCancel,
  // Without a thread and a turn id codex cannot be interrupted: it sends
  // nothing instead of guessing.
  assertCancelWithoutSession: (frames) => {
    assert.deepEqual(frames, []);
  },
  assertDeny: assertCodexDeny,
};

/* ---------------------------------------------------------------- copilot */

const COPILOT_SESSION_ID = "copilot-session-0001";
const COPILOT_PERMISSION_ID = "7";

function assertCopilotCancel(frames: unknown[]): void {
  assert.deepEqual(frames, [
    {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: COPILOT_SESSION_ID },
    },
  ]);
}

function assertCopilotDeny(answer: unknown): void {
  const frame = answer as Record<string, unknown>;
  assert.equal(frame.jsonrpc, "2.0");
  assert.equal(frame.id, 7);
  const result = frame.result as { outcome: { outcome: string; optionId: string } };
  assert.equal(result.outcome.outcome, "selected");
  assert.equal(result.outcome.optionId, "reject-once");
}

const copilotCase: CancelCase = {
  kind: "copilot",
  create: () => new CopilotAdapter(),
  providerSessionId: COPILOT_SESSION_ID,
  permissionId: COPILOT_PERMISSION_ID,
  allowToken: '"allow-once"',
  partialLines: () => [
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: COPILOT_SESSION_ID } }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: COPILOT_SESSION_ID,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "PO" },
        },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: COPILOT_SESSION_ID,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-0001",
          title: "Read notes.md",
          kind: "read",
          status: "pending",
          rawInput: { path: "notes.md" },
        },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "session/request_permission",
      params: {
        sessionId: COPILOT_SESSION_ID,
        toolCall: { toolCallId: "call-0002", title: "Run shell" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    }),
  ],
  lateLines: () => [
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: COPILOT_SESSION_ID,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "late" },
        },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, result: { stopReason: "cancelled" } }),
  ],
  lateText: "late",
  assertCancel: assertCopilotCancel,
  // Without a session id there is nothing to cancel yet.
  assertCancelWithoutSession: (frames) => {
    assert.deepEqual(frames, []);
  },
  assertDeny: assertCopilotDeny,
};

/* -------------------------------------------------------------------- dsh */

const DSH_SESSION_ID = "dsh-session-0001";
const DSH_PERMISSION_ID = "2";

function assertDshCancel(frames: unknown[]): void {
  assert.deepEqual(frames, [
    {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: DSH_SESSION_ID },
    },
  ]);
}

function assertDshDeny(answer: unknown): void {
  const frame = answer as Record<string, unknown>;
  assert.equal(frame.jsonrpc, "2.0");
  assert.equal(frame.id, 2);
  const result = frame.result as { outcome: { outcome: string; optionId: string } };
  assert.equal(result.outcome.outcome, "selected");
  assert.equal(result.outcome.optionId, "reject-once");
}

const dshCase: CancelCase = {
  kind: "dsh",
  create: () => new DshAdapter(),
  providerSessionId: DSH_SESSION_ID,
  permissionId: DSH_PERMISSION_ID,
  allowToken: '"allow-once"',
  partialLines: () => [
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: DSH_SESSION_ID } }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: DSH_SESSION_ID,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "PO" },
        },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: DSH_SESSION_ID,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-0001",
          title: "List files",
          kind: "execute",
          status: "pending",
        },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/request_permission",
      params: {
        sessionId: DSH_SESSION_ID,
        toolCall: { toolCallId: "call-0003", title: "Run command" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    }),
  ],
  lateLines: () => [
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: DSH_SESSION_ID,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "late" },
        },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 4, result: { stopReason: "cancelled" } }),
  ],
  lateText: "late",
  assertCancel: assertDshCancel,
  assertCancelWithoutSession: (frames) => {
    assert.deepEqual(frames, []);
  },
  assertDeny: assertDshDeny,
};

/* --------------------------------------------------------------------- agy */

const AGY_SESSION_ID = "agy-session-0001";
const AGY_PERMISSION_ID = "7";

function assertAgyCancel(frames: unknown[]): void {
  assert.deepEqual(frames, [
    {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: AGY_SESSION_ID },
    },
  ]);
}

function assertAgyDeny(answer: unknown): void {
  const frame = answer as Record<string, unknown>;
  assert.equal(frame.jsonrpc, "2.0");
  assert.equal(frame.id, 7);
  const result = frame.result as { outcome: { outcome: string; optionId: string } };
  assert.equal(result.outcome.outcome, "selected");
  assert.equal(result.outcome.optionId, "reject-once");
}

const agyCase: CancelCase = {
  kind: "agy",
  create: () => createAgyAdapter({ protocol: "acp" }),
  providerSessionId: AGY_SESSION_ID,
  permissionId: AGY_PERMISSION_ID,
  allowToken: '"allow-once"',
  partialLines: () => [
    JSON.stringify({ jsonrpc: "2.0", id: 2, result: { sessionId: AGY_SESSION_ID } }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: AGY_SESSION_ID,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "PO" },
        },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: AGY_SESSION_ID,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-0001",
          title: "Read notes.md",
          kind: "read",
          status: "pending",
        },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "session/request_permission",
      params: {
        sessionId: AGY_SESSION_ID,
        toolCall: { toolCallId: "call-0003", title: "Run command" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    }),
  ],
  lateLines: () => [
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: AGY_SESSION_ID,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "late" },
        },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 4, result: { stopReason: "cancelled" } }),
  ],
  lateText: "late",
  assertCancel: assertAgyCancel,
  // agy sends the cancel unconditionally; without a session the id is empty.
  assertCancelWithoutSession: (frames) => {
    assert.deepEqual(frames, [
      { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "" } },
    ]);
  },
  assertDeny: assertAgyDeny,
};

/* --------------------------------------------------------------------- pi */

const PI_SESSION_ID = "pi-session-0001";
const PI_SESSION_FILE = "/synthetic/sessions/pi-session-0001.jsonl";
const PI_PERMISSION_ID = "ui-0001";

function assertPiCancel(frames: unknown[]): void {
  assert.equal(frames.length, 1, "the pi cancel is one abort command");
  const frame = frames[0] as Record<string, unknown>;
  assert.equal(frame.type, "abort");
  assert.equal(typeof frame.id, "string");
  assert.ok((frame.id as string).length > 0);
}

function assertPiDeny(answer: unknown): void {
  const frame = answer as Record<string, unknown>;
  assert.equal(frame.type, "extension_ui_response");
  assert.equal(frame.id, PI_PERMISSION_ID);
  assert.equal(frame.confirmed, false);
}

const piCase: CancelCase = {
  kind: "pi",
  create: () => new PiAdapter(),
  providerSessionId: PI_SESSION_FILE,
  permissionId: PI_PERMISSION_ID,
  allowToken: '"confirmed":true',
  partialLines: (adapter) => {
    // pi answers with the id of the command, so the reply is built from the
    // handshake of this very adapter instance.
    const commands = adapter.handshake({ cwd: "/synthetic/work" }) as Record<
      string,
      unknown
    >[];
    const state = commands.find((command) => command.type === "get_state");
    assert.ok(state, "the pi handshake asks for the state");
    return [
      JSON.stringify({
        type: "response",
        id: state.id,
        success: true,
        data: { sessionId: PI_SESSION_ID, sessionFile: PI_SESSION_FILE },
      }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "PO" },
      }),
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "call-0001",
        toolName: "read_file",
        args: { path: "README.md" },
      }),
      JSON.stringify({
        type: "extension_ui_request",
        id: PI_PERMISSION_ID,
        method: "confirm",
        title: "Run the command?",
      }),
    ];
  },
  lateLines: () => [
    JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "late" },
    }),
    JSON.stringify({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "partial" }],
          stopReason: "aborted",
        },
      ],
    }),
  ],
  lateText: "late",
  assertCancel: assertPiCancel,
  // The abort command stops the running prompt, no session id needed.
  assertCancelWithoutSession: assertPiCancel,
  assertDeny: assertPiDeny,
};

/** Every adapter of this build, one row each. */
const CASES: readonly CancelCase[] = [
  claudeCase,
  codexCase,
  copilotCase,
  dshCase,
  agyCase,
  piCase,
];

/* --------------------------------------------------------------- helpers */

/** Parse a list of provider lines. */
function parseAll(adapter: BotAdapter, lines: readonly string[]): NormalizedEvent[] {
  return lines.flatMap((line) => adapter.parse(line));
}

/** One normalized event has the shape the daemon expects. */
function assertWellFormed(events: NormalizedEvent[], label: string): void {
  assert.ok(Array.isArray(events), `${label}: parse() must return an array`);
  for (const event of events) {
    assert.ok(event !== null && typeof event === "object", `${label}: not an event object`);
    switch (event.kind) {
      case "ready":
        break;
      case "text":
        assert.equal(typeof event.delta, "string", `${label}: a text event carries no delta`);
        break;
      case "tool":
        assert.equal(typeof event.name, "string", `${label}: a tool event carries no name`);
        assert.ok(
          event.status === "start" || event.status === "end" || event.status === "error",
          `${label}: a tool event carries the unknown status ${event.status}`,
        );
        break;
      case "permission":
        assert.equal(typeof event.id, "string", `${label}: a permission event carries no id`);
        break;
      case "turn_end":
        assert.ok(
          event.status === "ok" || event.status === "error" || event.status === "cancelled",
          `${label}: a turn_end event carries the unknown status ${event.status}`,
        );
        break;
      case "error":
        assert.equal(typeof event.message, "string", `${label}: an error event carries no message`);
        break;
      case "raw":
        assert.ok("payload" in event, `${label}: a raw event carries no payload`);
        break;
      default:
        assert.fail(`${label}: parse() produced an unknown event kind`);
    }
  }
}

/** The text deltas of a list of events. */
function deltasOf(events: readonly NormalizedEvent[]): string[] {
  return events
    .filter((event): event is { kind: "text"; delta: string } => event.kind === "text")
    .map((event) => event.delta);
}

/* ----------------------------------------------------------------- tests */

for (const row of CASES) {
  test(`${row.kind}: a partial turn yields a text, a tool and a permission event`, () => {
    const adapter = row.create();
    const events = parseAll(adapter, row.partialLines(adapter));

    assertWellFormed(events, row.kind);
    assert.ok(
      events.some((event) => event.kind === "ready"),
      `${row.kind}: the partial turn does not announce the session`,
    );
    assert.deepEqual(
      deltasOf(events),
      ["PO"],
      `${row.kind}: the partial turn does not carry its message delta`,
    );

    const tools = events.filter((event) => event.kind === "tool");
    assert.equal(tools.length, 1, `${row.kind}: the partial turn carries one tool call`);
    const tool = tools[0] as { name: string; status: string };
    assert.equal(tool.status, "start", `${row.kind}: the tool call is still open`);

    const permissions = events.filter((event) => event.kind === "permission");
    assert.equal(
      permissions.length,
      1,
      `${row.kind}: the partial turn carries one pending permission request`,
    );
    const permission = permissions[0] as { id: string };
    assert.equal(permission.id, row.permissionId);

    assert.equal(
      events.filter((event) => event.kind === "turn_end").length,
      0,
      `${row.kind}: the turn has not ended yet`,
    );
  });

  test(`${row.kind}: cancel() emits the documented provider-native cancel frame(s)`, () => {
    const adapter = row.create();
    parseAll(adapter, row.partialLines(adapter));

    const frames = adapter.cancel({ providerSessionId: row.providerSessionId });
    assert.ok(Array.isArray(frames), `${row.kind}: cancel() must return an array`);
    row.assertCancel(frames);

    // The frames go to the provider as NDJSON: they have to be serializable.
    for (const frame of frames) {
      assert.doesNotThrow(
        () => JSON.stringify(frame),
        `${row.kind}: a cancel frame is not JSON serializable`,
      );
    }
  });

  test(`${row.kind}: cancel() without a provider session id does not throw`, () => {
    const adapter = row.create();

    let frames: unknown[] = [];
    assert.doesNotThrow(
      () => {
        frames = adapter.cancel({});
      },
      `${row.kind}: cancel() threw while no provider session id was known`,
    );
    assert.ok(Array.isArray(frames), `${row.kind}: cancel() must return an array`);
    row.assertCancelWithoutSession(frames);

    assert.doesNotThrow(
      () => adapter.cancel({ providerSessionId: undefined }),
      `${row.kind}: cancel() threw for an undefined provider session id`,
    );
  });

  test(`${row.kind}: the lines after the cancel end in exactly one cancelled turn_end`, () => {
    const adapter = row.create();
    const before = parseAll(adapter, row.partialLines(adapter));
    adapter.cancel({ providerSessionId: row.providerSessionId });

    const after = parseAll(adapter, row.lateLines());
    assertWellFormed(after, row.kind);

    // The late delta of the provider is still delivered.
    assert.deepEqual(
      deltasOf(after),
      [row.lateText],
      `${row.kind}: the late delta of the provider is lost`,
    );

    const turnEnds = after.filter((event) => event.kind === "turn_end");
    assert.equal(
      turnEnds.length,
      1,
      `${row.kind}: the cancelled turn ends with exactly one turn_end`,
    );
    const turnEnd = turnEnds[0] as { status: string };
    assert.equal(turnEnd.status, "cancelled", `${row.kind}: the turn did not end as cancelled`);
    assert.equal(
      after[after.length - 1]?.kind,
      "turn_end",
      `${row.kind}: the turn_end is the last event of the turn`,
    );

    // The whole turn carries one turn_end: none before the cancel, one after.
    assert.equal(
      [...before, ...after].filter((event) => event.kind === "turn_end").length,
      1,
      `${row.kind}: the turn carries more than one turn_end`,
    );
  });

  test(`${row.kind}: a late deny answer after the cancel never allows the request`, () => {
    const adapter = row.create();
    parseAll(adapter, row.partialLines(adapter));
    adapter.cancel({ providerSessionId: row.providerSessionId });

    const answer = adapter.answerPermission(row.permissionId, false);
    row.assertDeny(answer);

    const json = JSON.stringify(answer) ?? "";
    assert.ok(
      !json.includes(row.allowToken),
      `${row.kind}: the late answer still grants the permission: ${json}`,
    );
  });
}

/**
 * Known gap: an adapter keeps the pending permission of a cancelled turn, so
 * a late `answerPermission(id, true)` still grants it.  The adapters do not
 * drop (or deny) the pending request when the turn is cancelled, so the
 * provider may run a tool the user already cancelled.  The check stays as a
 * todo until the adapters clear their pending permissions in cancel().
 */
const LATE_ALLOW_TODO =
  "the adapters keep the pending permission of a cancelled turn: a late allow still grants it";

test("a late allow answer after the cancel must not grant the pending request", {
  todo: LATE_ALLOW_TODO,
}, () => {
  const granting: string[] = [];
  for (const row of CASES) {
    const adapter = row.create();
    parseAll(adapter, row.partialLines(adapter));
    adapter.cancel({ providerSessionId: row.providerSessionId });

    const answer = adapter.answerPermission(row.permissionId, true);
    const json = JSON.stringify(answer) ?? "";
    if (json.includes(row.allowToken)) granting.push(row.kind);
  }
  assert.deepEqual(
    granting,
    [],
    `a late allow answer still grants the pending permission: ${granting.join(", ")}`,
  );
});

/* ------------------------------------------------- the agy stream-json path */

test("agy (stream-json fallback): cancel() has no provider-native frame", () => {
  const adapter = createAgyAdapter({ protocol: "stream-json" });
  // The fallback speaks the Claude compatible protocol: it can only be
  // stopped with a signal, so there is no cancel frame to write.
  assert.deepEqual(adapter.cancel({ providerSessionId: AGY_SESSION_ID }), []);
  assert.deepEqual(adapter.cancel({}), []);
});

test("agy (stream-json fallback): a cancelled result ends the turn", () => {
  const adapter = createAgyAdapter({ protocol: "stream-json" });
  const partial = parseAll(adapter, [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "PO" }] },
    }),
  ]);
  assert.deepEqual(deltasOf(partial), ["PO"]);

  const events = parseAll(adapter, [
    JSON.stringify({
      type: "result",
      subtype: "cancelled",
      is_error: false,
      usage: { input_tokens: 7, output_tokens: 2 },
    }),
  ]);
  assertWellFormed(events, "agy (stream-json fallback)");
  assert.deepEqual(events, [
    { kind: "turn_end", status: "cancelled", usage: { inputTokens: 7, outputTokens: 2 } },
  ]);
});
