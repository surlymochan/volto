// botd/test/adapters/codex-item-tools-n17.test.ts
//
// Focused tests for the item mapping of the Codex adapter
// (`botd/src/adapters/codex.ts`).
//
// `codex app-server` reports the work of a turn through `item/started` and
// `item/completed` notifications.  Every item carries a `type` that decides
// how the item is normalized:
//
//   commandExecution -> tool "shell"
//   fileChange       -> tool "apply_patch"
//   webSearch        -> tool "web_search"
//   plan             -> tool "update_plan"
//   mcpToolCall      -> tool "mcp:<server>/<tool>"
//   dynamicToolCall  -> tool "dynamic:<tool>"
//
// Items that are not tool calls (an assistant message) become text, and
// everything else is passed through as a raw event.
//
// The companion suite `codex.test.ts` already covers the happy path of every
// item type (a shell command with `exit 0` and `exit 1`, a single changed
// file, a web search, a plan, an mcp tool call that fails with an error
// message, a dynamic tool call, and an agent message that was streamed as
// deltas).  This file only adds the cases that are not covered there: the
// fallbacks of the summaries, the status mapping, the mcp naming fallbacks
// and the de-duplication rules.
//
// Every value is synthetic: no real hosts, accounts, tokens or paths.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CodexAdapter } from "../../src/adapters/codex.ts";
import type { NormalizedEvent } from "../../src/adapter-types.ts";

/* ------------------------------------------------------------------ helpers */

const THREAD_ID = "thread_synthetic_0001";
const TURN_ID = "turn_synthetic_0001";

/** A fresh adapter that already knows the thread of THREAD_ID. */
function adapterWithThread(): CodexAdapter {
  const adapter = new CodexAdapter();
  adapter.parse(
    JSON.stringify({ id: 2, result: { thread: { id: THREAD_ID, cwd: "/synthetic/work" } } }),
  );
  return adapter;
}

/** An `item/started` notification for one item. */
function started(item: unknown): string {
  return JSON.stringify({
    method: "item/started",
    params: { threadId: THREAD_ID, turnId: TURN_ID, item },
  });
}

/** An `item/completed` notification for one item. */
function completed(item: unknown): string {
  return JSON.stringify({
    method: "item/completed",
    params: { threadId: THREAD_ID, turnId: TURN_ID, item },
  });
}

/** An `item/agentMessage/delta` notification for one item id. */
function delta(itemId: string, text: string): string {
  return JSON.stringify({
    method: "item/agentMessage/delta",
    params: { threadId: THREAD_ID, turnId: TURN_ID, itemId, delta: text },
  });
}

/** The single tool event of a parse result, with its optional summary. */
function toolEvent(events: NormalizedEvent[]): {
  kind: string;
  name: string;
  status: string;
  summary?: string;
} {
  assert.equal(events.length, 1, "expected exactly one event");
  const event = events[0];
  assert.equal(event.kind, "tool");
  if (event.kind !== "tool") throw new Error("expected a tool event");
  return event;
}

/** Assert that a tool event carries no summary at all. */
function assertNoSummary(event: { summary?: string }): void {
  assert.equal(
    Object.prototype.hasOwnProperty.call(event, "summary"),
    false,
    "a tool event without a summary must not carry the key",
  );
}

/* ------------------------------------------------------- command execution */

test("a command without a finite exit code ends with the command as summary", () => {
  const adapter = adapterWithThread();

  const event = toolEvent(
    adapter.parse(
      completed({
        id: "item_synthetic_0101",
        type: "commandExecution",
        command: "make check",
        status: "completed",
      }),
    ),
  );

  assert.equal(event.name, "shell");
  assert.equal(event.status, "end");
  assert.equal(event.summary, "make check");
});

test("a non numeric or missing exit code ends with the command as summary", () => {
  const adapter = adapterWithThread();

  const stringCode = toolEvent(
    adapter.parse(
      completed({
        id: "item_synthetic_0102",
        type: "commandExecution",
        command: "make check",
        status: "completed",
        exitCode: "0",
      }),
    ),
  );
  assert.equal(stringCode.summary, "make check");

  const nullCode = toolEvent(
    adapter.parse(
      completed({
        id: "item_synthetic_0103",
        type: "commandExecution",
        command: "make check",
        status: "completed",
        exitCode: null,
      }),
    ),
  );
  assert.equal(nullCode.summary, "make check");
});

test("a command start without a command carries no summary", () => {
  const adapter = adapterWithThread();

  const event = toolEvent(
    adapter.parse(
      started({
        id: "item_synthetic_0104",
        type: "commandExecution",
        status: "inProgress",
      }),
    ),
  );

  assert.equal(event.name, "shell");
  assert.equal(event.status, "start");
  assertNoSummary(event);
});

/* -------------------------------------------------------------- file change */

test("a file change joins several change paths with a comma", () => {
  const adapter = adapterWithThread();

  const event = toolEvent(
    adapter.parse(
      started({
        id: "item_synthetic_0201",
        type: "fileChange",
        status: "inProgress",
        changes: [{ path: "src/one.ts", kind: "update" }, { path: "src/two.ts", kind: "add" }],
      }),
    ),
  );

  assert.equal(event.name, "apply_patch");
  assert.equal(event.status, "start");
  assert.equal(event.summary, "src/one.ts, src/two.ts");
});

test("a file change without changes carries no summary", () => {
  const adapter = adapterWithThread();

  const empty = toolEvent(
    adapter.parse(
      started({
        id: "item_synthetic_0202",
        type: "fileChange",
        status: "inProgress",
        changes: [],
      }),
    ),
  );
  assert.equal(empty.name, "apply_patch");
  assertNoSummary(empty);

  const missing = toolEvent(
    adapter.parse(
      started({
        id: "item_synthetic_0203",
        type: "fileChange",
        status: "inProgress",
      }),
    ),
  );
  assert.equal(missing.name, "apply_patch");
  assertNoSummary(missing);
});

test("a file change skips change entries without a path", () => {
  const adapter = adapterWithThread();

  const partial = toolEvent(
    adapter.parse(
      started({
        id: "item_synthetic_0204",
        type: "fileChange",
        status: "inProgress",
        changes: [{ kind: "update" }, { path: "src/only.ts", kind: "update" }],
      }),
    ),
  );
  assert.equal(partial.summary, "src/only.ts");

  const noPath = toolEvent(
    adapter.parse(
      started({
        id: "item_synthetic_0205",
        type: "fileChange",
        status: "inProgress",
        changes: [{ kind: "update" }],
      }),
    ),
  );
  assertNoSummary(noPath);
});

/* --------------------------------------------------------------- web search */

test("a web search ends with the query as summary", () => {
  const adapter = adapterWithThread();

  const event = toolEvent(
    adapter.parse(
      completed({
        id: "item_synthetic_0301",
        type: "webSearch",
        query: "volto bots",
        status: "completed",
      }),
    ),
  );

  assert.equal(event.name, "web_search");
  assert.equal(event.status, "end");
  assert.equal(event.summary, "volto bots");
});

test("a web search without a query carries no summary", () => {
  const adapter = adapterWithThread();

  const event = toolEvent(
    adapter.parse(
      started({
        id: "item_synthetic_0302",
        type: "webSearch",
        status: "inProgress",
      }),
    ),
  );

  assert.equal(event.name, "web_search");
  assertNoSummary(event);
});

/* --------------------------------------------------------------------- plan */

test("a plan ends as update_plan without a summary", () => {
  const adapter = adapterWithThread();

  const event = toolEvent(
    adapter.parse(
      completed({
        id: "item_synthetic_0401",
        type: "plan",
        text: "a synthetic plan",
        status: "completed",
      }),
    ),
  );

  assert.equal(event.name, "update_plan");
  assert.equal(event.status, "end");
  assertNoSummary(event);
});

/* -------------------------------------------------------------- mcp tool call */

test("an mcp tool call with only a tool uses the bare tool name", () => {
  const adapter = adapterWithThread();

  const event = toolEvent(
    adapter.parse(
      started({
        id: "item_synthetic_0501",
        type: "mcpToolCall",
        tool: "lookup",
        status: "inProgress",
      }),
    ),
  );

  assert.equal(event.name, "lookup");
  assert.equal(event.status, "start");
  assertNoSummary(event);
});

test("an mcp tool call with only a server uses the bare server name", () => {
  const adapter = adapterWithThread();

  const event = toolEvent(
    adapter.parse(
      started({
        id: "item_synthetic_0502",
        type: "mcpToolCall",
        server: "synthetic-docs",
        status: "inProgress",
      }),
    ),
  );

  assert.equal(event.name, "synthetic-docs");
  assert.equal(event.status, "start");
  assertNoSummary(event);
});

test("an mcp tool call without a tool and without a server stays raw", () => {
  const adapter = adapterWithThread();
  const line = started({ id: "item_synthetic_0503", type: "mcpToolCall", status: "inProgress" });

  assert.deepEqual(adapter.parse(line), [{ kind: "raw", payload: JSON.parse(line) }]);
});

test("an mcp tool call ends with the error message as summary", () => {
  const adapter = adapterWithThread();

  const event = toolEvent(
    adapter.parse(
      completed({
        id: "item_synthetic_0504",
        type: "mcpToolCall",
        server: "synthetic-docs",
        tool: "search",
        status: "completed",
        error: { message: "server said no" },
      }),
    ),
  );

  assert.equal(event.name, "mcp:synthetic-docs/search");
  assert.equal(event.status, "end");
  assert.equal(event.summary, "server said no");
});

test("an mcp tool call without an error message carries no summary", () => {
  const adapter = adapterWithThread();

  const event = toolEvent(
    adapter.parse(
      completed({
        id: "item_synthetic_0505",
        type: "mcpToolCall",
        server: "synthetic-docs",
        tool: "search",
        status: "completed",
      }),
    ),
  );

  assert.equal(event.name, "mcp:synthetic-docs/search");
  assertNoSummary(event);
});

/* ---------------------------------------------------------- dynamic tool call */

test("a dynamic tool call without a tool name stays raw", () => {
  const adapter = adapterWithThread();
  const line = started({ id: "item_synthetic_0601", type: "dynamicToolCall", status: "inProgress" });

  assert.deepEqual(adapter.parse(line), [{ kind: "raw", payload: JSON.parse(line) }]);
});

/* --------------------------------------------------------------- tool status */

test("a declined tool item ends as an error", () => {
  const adapter = adapterWithThread();

  const event = toolEvent(
    adapter.parse(
      completed({
        id: "item_synthetic_0701",
        type: "commandExecution",
        command: "rm -rf synthetic",
        status: "declined",
      }),
    ),
  );

  assert.equal(event.name, "shell");
  assert.equal(event.status, "error");
  assert.equal(event.summary, "rm -rf synthetic");
});

test("every tool status other than failed and declined ends normally", () => {
  const adapter = adapterWithThread();

  for (const status of ["completed", "inProgress", "unknown-status", undefined]) {
    const event = toolEvent(
      adapter.parse(
        completed({
          id: "item_synthetic_0702",
          type: "commandExecution",
          command: "make check",
          status,
          exitCode: 0,
        }),
      ),
    );
    assert.equal(event.status, "end", `status ${String(status)} must end normally`);
  }

  const withoutStatus = toolEvent(
    adapter.parse(
      completed({
        id: "item_synthetic_0703",
        type: "commandExecution",
        command: "make check",
        exitCode: 0,
      }),
    ),
  );
  assert.equal(withoutStatus.status, "end");
});

/* ---------------------------------------------------------------- raw items */

test("an item without an item object stays raw", () => {
  const adapter = adapterWithThread();

  const noItem = JSON.stringify({
    method: "item/started",
    params: { threadId: THREAD_ID, turnId: TURN_ID },
  });
  assert.deepEqual(adapter.parse(noItem), [{ kind: "raw", payload: JSON.parse(noItem) }]);

  const nullItem = JSON.stringify({
    method: "item/completed",
    params: { threadId: THREAD_ID, turnId: TURN_ID, item: null },
  });
  assert.deepEqual(adapter.parse(nullItem), [{ kind: "raw", payload: JSON.parse(nullItem) }]);

  const stringItem = JSON.stringify({
    method: "item/completed",
    params: { threadId: THREAD_ID, turnId: TURN_ID, item: "not-an-object" },
  });
  assert.deepEqual(adapter.parse(stringItem), [{ kind: "raw", payload: JSON.parse(stringItem) }]);
});

test("an unknown item type stays raw", () => {
  const adapter = adapterWithThread();

  const reasoning = completed({
    id: "item_synthetic_0801",
    type: "reasoning",
    text: "thinking out loud",
  });
  assert.deepEqual(adapter.parse(reasoning), [{ kind: "raw", payload: JSON.parse(reasoning) }]);

  const untyped = completed({ id: "item_synthetic_0802", text: "no type at all" });
  assert.deepEqual(adapter.parse(untyped), [{ kind: "raw", payload: JSON.parse(untyped) }]);
});

/* ---------------------------------------------------------- agent messages */

test("an agent message emits its text only once", () => {
  const adapter = adapterWithThread();
  const line = completed({ id: "item_synthetic_0901", type: "agentMessage", text: "hello" });

  assert.deepEqual(adapter.parse(line), [{ kind: "text", delta: "hello" }]);
  // The same item again is suppressed: the text is not repeated.
  assert.deepEqual(adapter.parse(line), [{ kind: "raw", payload: JSON.parse(line) }]);
});

test("an agent message without an item id always emits its text", () => {
  const adapter = adapterWithThread();
  const line = completed({ type: "agentMessage", text: "hello" });

  assert.deepEqual(adapter.parse(line), [{ kind: "text", delta: "hello" }]);
  // Without an id there is nothing to remember, so the text is emitted again.
  assert.deepEqual(adapter.parse(line), [{ kind: "text", delta: "hello" }]);
});

test("an agent message without text stays raw", () => {
  const adapter = adapterWithThread();
  const line = completed({ id: "item_synthetic_0902", type: "agentMessage" });

  assert.deepEqual(adapter.parse(line), [{ kind: "raw", payload: JSON.parse(line) }]);
});

test("a delta of another item does not suppress the completed agent message", () => {
  const adapter = adapterWithThread();

  assert.deepEqual(adapter.parse(delta("item_synthetic_0903", "PO")), [
    { kind: "text", delta: "PO" },
  ]);

  const line = completed({ id: "item_synthetic_0904", type: "agentMessage", text: "PONG" });
  assert.deepEqual(adapter.parse(line), [{ kind: "text", delta: "PONG" }]);
});
