// botd/test/adapters/dsh-permission-options-n17.test.ts
//
// Focused tests for the permission handling of the DeepSeek Shell (`dsh`)
// adapter (`botd/src/adapters/dsh.ts`).
//
// `dsh --profile acp` speaks the Agent Client Protocol (ACP) over stdio.  The
// agent asks the client for a decision with a `session/request_permission`
// request:
//
//   agent -> client  {"jsonrpc":"2.0","id":7,"method":"session/request_permission",
//                     "params":{"sessionId":"...","options":[{"optionId":"once","kind":"allow_once"}]}}
//   client -> agent  {"jsonrpc":"2.0","id":7,"result":{"outcome":{"outcome":"selected","optionId":"once"}}}
//
// The adapter keeps the pending request under `String(id)` and answers it
// with the option that matches the decision: `allow_once` before
// `allow_always` for an allow, `reject_once` before `reject_always` for a
// deny.  When nothing matches, the answer carries the `cancelled` outcome.
//
// The companion suites `dsh.test.ts` and `dsh-gaps.test.ts` already cover the
// happy path (a numeric id with an `allow_once` option, a string id with an
// `allow_always` option, a numeric id with a `reject_always` option, an
// unmatched option, an id-less request, and a JSON-RPC error with a message).
// This file only adds the cases that are not covered there: the type of the
// rpc id in the reply, the precedence of the options, the normalisation of
// broken options and the error replies without a message.
//
// Every value is synthetic: no real hosts, accounts, tokens or paths.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DshAdapter } from "../../src/adapters/dsh.ts";
import type { NormalizedEvent } from "../../src/adapter-types.ts";

/* ------------------------------------------------------------------ helpers */

/** Parse one ACP message with the adapter. */
function parse(adapter: DshAdapter, message: unknown): NormalizedEvent[] {
  return adapter.parse(JSON.stringify(message));
}

/** A `session/request_permission` request with the given id and params. */
function request(id: unknown, params: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "session/request_permission", params };
}

/** The `outcome` object of a reply to a permission request. */
function outcomeOf(reply: unknown): Record<string, unknown> {
  const message = reply as Record<string, unknown>;
  const result = message.result as Record<string, unknown>;
  return result.outcome as Record<string, unknown>;
}

/** The single permission event of a parse result. */
function permissionEvent(events: NormalizedEvent[]): { id: string; request: unknown } {
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event?.kind, "permission");
  if (!event || event.kind !== "permission") throw new Error("no permission event");
  return { id: event.id, request: event.request };
}

/* ------------------------------------------------------- the permission id */

test("a permission request with a numeric rpc id is reported with String(id)", () => {
  const adapter = new DshAdapter();
  const params = {
    sessionId: "sess_synthetic_0001",
    toolCall: {
      toolCallId: "call_synthetic_0001",
      title: "Run command",
      kind: "execute",
    },
    options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
  };

  const permission = permissionEvent(parse(adapter, request(42, params)));

  assert.equal(permission.id, "42");
  assert.deepEqual(permission.request, params, "the event carries the request params");
});

test("a permission request with a string rpc id is reported with the same id", () => {
  const adapter = new DshAdapter();
  const params = {
    sessionId: "sess_synthetic_0001",
    options: [{ optionId: "never", name: "Reject", kind: "reject_once" }],
  };

  const permission = permissionEvent(parse(adapter, request("perm-9", params)));

  assert.equal(permission.id, "perm-9");
  assert.deepEqual(permission.request, params, "the event carries the request params");
});

test("a permission request without an id stays raw and cannot be answered", () => {
  const adapter = new DshAdapter();
  const message = {
    jsonrpc: "2.0",
    method: "session/request_permission",
    params: { sessionId: "sess_synthetic_0001", options: [] },
  };

  assert.deepEqual(parse(adapter, message), [{ kind: "raw", payload: message }]);
  // Nothing was registered, so there is nothing to answer.
  assert.equal(adapter.answerPermission("2", true), null);
  assert.equal(adapter.answerPermission("", false), null);
});

test("a permission request whose params are not an object reports an empty request", () => {
  const adapter = new DshAdapter();

  const permission = permissionEvent(
    parse(adapter, {
      jsonrpc: "2.0",
      id: 5,
      method: "session/request_permission",
      params: "not-an-object",
    }),
  );
  assert.deepEqual(permission.request, {});

  // The request is still answerable: without options there is nothing to pick.
  assert.deepEqual(adapter.answerPermission("5", true), {
    jsonrpc: "2.0",
    id: 5,
    result: { outcome: { outcome: "cancelled" } },
  });
});

test("a permission request with a non-scalar id stays raw and cannot be answered", () => {
  for (const id of [null, true, { rpc: 1 }, ["rpc-1"]]) {
    const adapter = new DshAdapter();
    const message = request(id, { options: [{ optionId: "once", kind: "allow_once" }] });

    assert.deepEqual(
      parse(adapter, message),
      [{ kind: "raw", payload: message }],
      `id ${JSON.stringify(id)} must not be answered`,
    );
    assert.equal(adapter.answerPermission(String(id), true), null);
  }
});

/* ------------------------------------------------------ picking the option */

test("allow picks the first allow_once option, even when allow_comes first", () => {
  const adapter = new DshAdapter();
  parse(
    adapter,
    request(11, {
      options: [
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "once-a", name: "Allow once", kind: "allow_once" },
        { optionId: "once-b", name: "Allow once", kind: "allow_once" },
      ],
    }),
  );

  const reply = adapter.answerPermission("11", true);

  assert.deepEqual(reply, {
    jsonrpc: "2.0",
    id: 11,
    result: { outcome: { outcome: "selected", optionId: "once-a" } },
  });
  assert.deepEqual(outcomeOf(reply), { outcome: "selected", optionId: "once-a" });
});

test("allow falls back to allow_always when no allow_once option exists", () => {
  const adapter = new DshAdapter();
  parse(
    adapter,
    request(12, {
      options: [
        { optionId: "reject", name: "Reject", kind: "reject_once" },
        { optionId: "always", name: "Always", kind: "allow_always" },
      ],
    }),
  );

  assert.deepEqual(outcomeOf(adapter.answerPermission("12", true)), {
    outcome: "selected",
    optionId: "always",
  });
});

test("deny picks the first reject_once option, even when reject_always comes first", () => {
  const adapter = new DshAdapter();
  parse(
    adapter,
    request(13, {
      options: [
        { optionId: "never", name: "Never", kind: "reject_always" },
        { optionId: "no-a", name: "Reject", kind: "reject_once" },
        { optionId: "no-b", name: "Reject", kind: "reject_once" },
      ],
    }),
  );

  assert.deepEqual(outcomeOf(adapter.answerPermission("13", false)), {
    outcome: "selected",
    optionId: "no-a",
  });
});

test("deny falls back to reject_always and ignores the allow options", () => {
  const adapter = new DshAdapter();
  parse(
    adapter,
    request(14, {
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "never", name: "Never", kind: "reject_always" },
      ],
    }),
  );

  assert.deepEqual(outcomeOf(adapter.answerPermission("14", false)), {
    outcome: "selected",
    optionId: "never",
  });
});

test("the option kind decides, the option name does not", () => {
  const adapter = new DshAdapter();
  parse(
    adapter,
    request(15, {
      options: [{ optionId: "lookalike", name: "Allow once", kind: "something_else" }],
    }),
  );

  // The name says "Allow once" but the kind does not match: nothing to pick.
  assert.deepEqual(outcomeOf(adapter.answerPermission("15", true)), { outcome: "cancelled" });
});

/* --------------------------------------------------- no matching option */

test("a request without a matching option is answered with a cancelled outcome", () => {
  const adapter = new DshAdapter();

  parse(adapter, request(21, { options: [{ optionId: "once", kind: "allow_once" }] }));
  assert.deepEqual(adapter.answerPermission("21", false), {
    jsonrpc: "2.0",
    id: 21,
    result: { outcome: { outcome: "cancelled" } },
  });

  const other = new DshAdapter();
  parse(other, request(22, { options: [{ optionId: "never", kind: "reject_once" }] }));
  assert.deepEqual(other.answerPermission("22", true), {
    jsonrpc: "2.0",
    id: 22,
    result: { outcome: { outcome: "cancelled" } },
  });

  const empty = new DshAdapter();
  parse(empty, request(23, { options: [] }));
  assert.deepEqual(empty.answerPermission("23", true), {
    jsonrpc: "2.0",
    id: 23,
    result: { outcome: { outcome: "cancelled" } },
  });
});

/* ------------------------------------------------ normalisation of options */

test("options that are not objects are dropped and the raw params are kept", () => {
  const adapter = new DshAdapter();
  const params = {
    options: [
      "allow_once",
      42,
      null,
      true,
      ["allow_once"],
      { optionId: "only-object", kind: "allow_once" },
    ],
  };

  const permission = permissionEvent(parse(adapter, request(31, params)));

  // The event still carries the untouched params of the request...
  assert.deepEqual(permission.request, params);
  // ... but only the object option can be picked.
  assert.deepEqual(outcomeOf(adapter.answerPermission("31", true)), {
    outcome: "selected",
    optionId: "only-object",
  });
});

test("a request whose options are all broken is answered with a cancelled outcome", () => {
  const adapter = new DshAdapter();
  parse(adapter, request(32, { options: ["allow_once", 42, null, true] }));

  assert.deepEqual(adapter.answerPermission("32", true), {
    jsonrpc: "2.0",
    id: 32,
    result: { outcome: { outcome: "cancelled" } },
  });
});

test("options with non-string fields are normalised and cannot be picked", () => {
  const adapter = new DshAdapter();
  parse(
    adapter,
    request(33, {
      options: [
        { optionId: 42, name: 7, kind: "allow_once" },
        { optionId: "wrong-kind", name: "Always", kind: 9 },
      ],
    }),
  );

  // Neither option has a string kind and optionId, so nothing matches.
  assert.deepEqual(adapter.answerPermission("33", true), {
    jsonrpc: "2.0",
    id: 33,
    result: { outcome: { outcome: "cancelled" } },
  });
});

test("an option with a broken optionId is skipped while a valid sibling is picked", () => {
  const adapter = new DshAdapter();
  parse(
    adapter,
    request(34, {
      options: [
        { optionId: 42, kind: "allow_once" },
        { optionId: "valid", kind: "allow_once" },
      ],
    }),
  );

  assert.deepEqual(outcomeOf(adapter.answerPermission("34", true)), {
    outcome: "selected",
    optionId: "valid",
  });
});

/* ------------------------------------------------------- the reply and ids */

test("the reply keeps the type of the original rpc id", () => {
  const numeric = new DshAdapter();
  parse(numeric, request(0, { options: [{ optionId: "once", kind: "allow_once" }] }));
  const numericReply = numeric.answerPermission("0", true) as Record<string, unknown>;
  assert.equal(numericReply.id, 0);
  assert.equal(typeof numericReply.id, "number");

  const text = new DshAdapter();
  parse(text, request("perm-3", { options: [{ optionId: "once", kind: "allow_once" }] }));
  const textReply = text.answerPermission("perm-3", true) as Record<string, unknown>;
  assert.equal(textReply.id, "perm-3");
  assert.equal(typeof textReply.id, "string");
});

test("a permission can only be answered once and an unknown id has nothing to answer", () => {
  const adapter = new DshAdapter();
  parse(adapter, request("perm-4", { options: [{ optionId: "once", kind: "allow_once" }] }));

  const first = adapter.answerPermission("perm-4", true);
  assert.deepEqual(outcomeOf(first), { outcome: "selected", optionId: "once" });

  // The second answer has nothing left to answer, whatever the decision is.
  assert.equal(adapter.answerPermission("perm-4", true), null);
  assert.equal(adapter.answerPermission("perm-4", false), null);
  // An id that was never requested has nothing to answer either.
  assert.equal(adapter.answerPermission("perm-does-not-exist", true), null);
  assert.equal(adapter.answerPermission("perm-does-not-exist", false), null);
});

/* ------------------------------------------------------------ error replies */

test("a JSON-RPC error with a message becomes an error event", () => {
  const adapter = new DshAdapter();
  const message = {
    jsonrpc: "2.0",
    id: 3,
    error: { code: -32601, message: "method not found", data: "session/prompt" },
  };

  assert.deepEqual(parse(adapter, message), [{ kind: "error", message: "method not found" }]);
});

test("a JSON-RPC error without a usable message is stringified", () => {
  const adapter = new DshAdapter();

  // An error object without a message...
  const objectError = { code: -32603 };
  assert.deepEqual(parse(adapter, { jsonrpc: "2.0", id: 4, error: objectError }), [
    { kind: "error", message: String(objectError) },
  ]);
  // ... a number...
  assert.deepEqual(parse(adapter, { jsonrpc: "2.0", id: 5, error: 42 }), [
    { kind: "error", message: "42" },
  ]);
  // ... an empty message...
  const emptyMessage = { code: -32603, message: "" };
  assert.deepEqual(parse(adapter, { jsonrpc: "2.0", id: 6, error: emptyMessage }), [
    { kind: "error", message: String(emptyMessage) },
  ]);
  // ... and a message that is not a string.
  const numericMessage = { code: -32603, message: 42 };
  assert.deepEqual(parse(adapter, { jsonrpc: "2.0", id: 7, error: numericMessage }), [
    { kind: "error", message: String(numericMessage) },
  ]);
});

test("a null JSON-RPC error becomes an unknown error event", () => {
  const adapter = new DshAdapter();

  assert.deepEqual(parse(adapter, { jsonrpc: "2.0", id: 6, error: null }), [
    { kind: "error", message: "unknown error" },
  ]);
});
