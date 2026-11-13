// botd/test/adapters/pi-cancel-permission.test.ts
//
// The pi adapter must not grant a permission of a cancelled turn.
//
// `pi --mode rpc` asks the client for the approval of an extension UI
// request (`confirm` / `select`) and waits for the answer.  The request
// belongs to the run that raised it: when that run is cancelled (`abort`),
// the user gave the run up, so a late answer of the control plane must not
// allow the request any more.  The provider would otherwise run the tool of
// a turn that was aborted.
//
// The suite therefore:
//
//   1. raises a `confirm` and a `select` request,
//   2. cancels the run,
//   3. answers the two requests late, with an allow, and
//   4. checks that the late allow grants nothing, that a request raised
//      after the cancel is answered as usual and that the cancel still
//      sends the documented abort command.
//
// Every line is synthetic: the pi CLI is never started by this suite, the
// protocol is exercised with recorded-style lines only.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PiAdapter } from "../../src/adapters/pi.ts";

/* --------------------------------------------------------------- fixtures */

const WORK_DIR = "/synthetic/work";
const SESSION_ID = "sess_synthetic_0001";
const SESSION_FILE = "/synthetic/sessions/sess_synthetic_0001.jsonl";

/** The id of the confirm request of the cancelled run. */
const CONFIRM_ID = "ui_synthetic_confirm_0001";
/** The id of the select request of the cancelled run. */
const SELECT_ID = "ui_synthetic_select_0002";
/** The id of the confirm request that arrives after the cancel. */
const LATE_CONFIRM_ID = "ui_synthetic_confirm_0003";
/** The id of the select request that arrives after the cancel. */
const LATE_SELECT_ID = "ui_synthetic_select_0004";

/** The agent asks the client to confirm something. */
function uiRequestConfirm(id: string): string {
  return JSON.stringify({
    type: "extension_ui_request",
    id,
    method: "confirm",
    title: "Run the command?",
  });
}

/** The agent asks the client to pick one of several options. */
function uiRequestSelect(id: string): string {
  return JSON.stringify({
    type: "extension_ui_request",
    id,
    method: "select",
    title: "Pick a file",
    options: [{ value: "first_synthetic", label: "First" }],
  });
}

/** Reply to `get_state`: the session of the running CLI. */
const GET_STATE_DATA = {
  sessionId: SESSION_ID,
  sessionFile: SESSION_FILE,
  model: { provider: "synthetic-provider", id: "synthetic-model-0001" },
};

/**
 * An adapter with an open session and the two pending requests of the run
 * that is cancelled afterwards.
 */
function adapterWithPendingRequests(): PiAdapter {
  const adapter = new PiAdapter();
  const commands = adapter.handshake({ cwd: WORK_DIR }) as Record<string, unknown>[];
  const state = commands.find((command) => command.type === "get_state");
  assert.ok(state, "the handshake asks for the state");

  adapter.parse(
    JSON.stringify({ type: "response", id: state.id, success: true, data: GET_STATE_DATA }),
  );
  adapter.parse(uiRequestConfirm(CONFIRM_ID));
  adapter.parse(uiRequestSelect(SELECT_ID));
  return adapter;
}

/* ------------------------------------------------------------------ tests */

test("a late allow after the cancel grants no confirm request", () => {
  const adapter = adapterWithPendingRequests();

  const frames = adapter.cancel({ providerSessionId: SESSION_FILE });
  assert.ok(Array.isArray(frames));

  // The request of the cancelled run is not answerable with an allow any more.
  const answer = adapter.answerPermission(CONFIRM_ID, true);
  assert.equal(answer, null, "the late allow answered the confirm request");

  const json = JSON.stringify(answer) ?? "";
  assert.ok(
    !json.includes('"confirmed":true'),
    `the late allow still confirms the request: ${json}`,
  );
});

test("a late allow after the cancel grants no select request", () => {
  const adapter = adapterWithPendingRequests();

  adapter.cancel({ providerSessionId: SESSION_FILE });

  const answer = adapter.answerPermission(SELECT_ID, true);
  assert.equal(answer, null, "the late allow answered the select request");

  const json = JSON.stringify(answer) ?? "";
  assert.ok(
    !json.includes('"value"'),
    `the late allow still picked an option of the request: ${json}`,
  );
});

test("a late deny after the cancel denies the request", () => {
  const adapter = adapterWithPendingRequests();

  adapter.cancel({ providerSessionId: SESSION_FILE });

  // The deny path is unchanged: a denied request is denied, not ignored.
  const answer = adapter.answerPermission(CONFIRM_ID, false) as Record<string, unknown>;
  assert.ok(answer, "the late deny answers nothing");
  assert.equal(answer.type, "extension_ui_response");
  assert.equal(answer.id, CONFIRM_ID);
  assert.equal(answer.confirmed, false);
});

test("a request raised after the cancel is answered normally", () => {
  const adapter = adapterWithPendingRequests();

  adapter.cancel({ providerSessionId: SESSION_FILE });

  // The next run raises its own requests: they are not affected by the
  // cancel of the run before.
  const confirm = adapter.parse(uiRequestConfirm(LATE_CONFIRM_ID))[0];
  assert.equal(confirm.kind, "permission");
  if (confirm.kind !== "permission") return;

  const select = adapter.parse(uiRequestSelect(LATE_SELECT_ID))[0];
  assert.equal(select.kind, "permission");
  if (select.kind !== "permission") return;

  const confirmed = adapter.answerPermission(LATE_CONFIRM_ID, true) as Record<string, unknown>;
  assert.equal(confirmed.type, "extension_ui_response");
  assert.equal(confirmed.id, LATE_CONFIRM_ID);
  assert.equal(confirmed.confirmed, true);

  const chosen = adapter.answerPermission(LATE_SELECT_ID, true) as Record<string, unknown>;
  assert.equal(chosen.type, "extension_ui_response");
  assert.equal(chosen.id, LATE_SELECT_ID);
  assert.equal(chosen.value, "first_synthetic");
});

test("cancel() still returns the abort command", () => {
  const adapter = adapterWithPendingRequests();

  const frames = adapter.cancel({ providerSessionId: SESSION_FILE }) as Record<
    string,
    unknown
  >[];

  assert.equal(frames.length, 1, "the cancel is one abort command");
  const command = frames[0];
  assert.equal(command.type, "abort");
  assert.equal(typeof command.id, "string");
  assert.ok((command.id as string).length > 0, "the abort command carries an id");
  assert.doesNotThrow(() => JSON.stringify(command), "the abort command is not serializable");
});

test("the pending requests of a cancelled run are answered once", () => {
  const adapter = adapterWithPendingRequests();

  adapter.cancel({ providerSessionId: SESSION_FILE });

  // The first answer takes the request, the second one finds nothing.
  adapter.answerPermission(CONFIRM_ID, false);
  assert.equal(
    adapter.answerPermission(CONFIRM_ID, true),
    null,
    "the request of the cancelled run was answered twice",
  );
});
