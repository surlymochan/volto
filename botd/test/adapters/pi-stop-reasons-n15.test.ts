// botd/test/adapters/pi-stop-reasons-n15.test.ts
//
// The stop reason of a finished pi turn decides the status of the
// normalized `turn_end` event.
//
// `pi --mode rpc` ends a turn with an `agent_end` line.  The adapter reads
// the stop reason of that line from three sources, in this order:
//
//   1. the last assistant message of the line (or its `message` field),
//   2. the `stopReason` of the line itself,
//   3. the `reason` of the line itself.
//
// The stop reason is mapped onto the normalized status:
//
//   aborted / abort / cancelled / canceled / interrupted / interrupt -> cancelled
//   error / failed / failure                                    -> error
//   every other stop reason (and none at all)                    -> ok
//
// The comparison is case insensitive.
//
// Every line below is synthetic: the pi CLI is never started by this suite,
// the protocol is exercised with recorded-style lines only.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PiAdapter } from "../../src/adapters/pi.ts";

/* --------------------------------------------------------------- helpers */

/** The normalized status of a `turn_end` event. */
type TurnStatus = "ok" | "error" | "cancelled";

/**
 * The status of the turn that an `agent_end` line ends.
 *
 * The line is parsed by a fresh adapter, so no state of an earlier turn
 * (a streamed text, a remembered usage) can influence the result.
 */
function statusOf(record: Record<string, unknown>): TurnStatus {
  const adapter = new PiAdapter();
  const events = adapter.parse(JSON.stringify({ type: "agent_end", ...record }));
  const turn = events.find((event) => event.kind === "turn_end");
  assert.ok(turn, `the line produced no turn_end event: ${JSON.stringify(events)}`);
  if (turn.kind !== "turn_end") throw new Error("unreachable");
  return turn.status;
}

/** The status of a turn that ended with the given stop reason. */
function statusOfStopReason(stopReason: string): TurnStatus {
  return statusOf({
    messages: [{ role: "assistant", stopReason }],
  });
}

/* ------------------------------------------------- cancelled stop reasons */

test("the stop reason 'abort' ends the turn as cancelled", () => {
  assert.equal(statusOfStopReason("abort"), "cancelled");
});

test("the stop reason 'cancelled' ends the turn as cancelled", () => {
  assert.equal(statusOfStopReason("cancelled"), "cancelled");
});

test("the stop reason 'canceled' ends the turn as cancelled", () => {
  assert.equal(statusOfStopReason("canceled"), "cancelled");
});

test("the stop reason 'interrupted' ends the turn as cancelled", () => {
  assert.equal(statusOfStopReason("interrupted"), "cancelled");
});

test("the stop reason 'interrupt' ends the turn as cancelled", () => {
  assert.equal(statusOfStopReason("interrupt"), "cancelled");
});

/* ---------------------------------------------------- error stop reasons */

test("the stop reason 'error' ends the turn as an error", () => {
  assert.equal(statusOfStopReason("error"), "error");
});

test("the stop reason 'failed' ends the turn as an error", () => {
  assert.equal(statusOfStopReason("failed"), "error");
});

test("the stop reason 'failure' ends the turn as an error", () => {
  assert.equal(statusOfStopReason("failure"), "error");
});

/* ------------------------------------------------------ other stop reasons */

test("an unknown stop reason ends the turn as ok", () => {
  for (const stopReason of ["stop", "end_turn", "toolUse", "refusal"]) {
    assert.equal(
      statusOfStopReason(stopReason),
      "ok",
      `the stop reason '${stopReason}' must not end the turn as an error`,
    );
  }
});

test("a turn without a stop reason ends the turn as ok", () => {
  assert.equal(statusOf({ messages: [{ role: "assistant" }] }), "ok");
  assert.equal(statusOf({}), "ok");
});

/* ------------------------------------------------------ case insensitivity */

test("the stop reason is matched case insensitively", () => {
  const cancelled = ["ABORTED", "Abort", "CANCELLED", "Canceled", "INTERRUPTED", "Interrupt"];
  for (const stopReason of cancelled) {
    assert.equal(
      statusOfStopReason(stopReason),
      "cancelled",
      `the stop reason '${stopReason}' must end the turn as cancelled`,
    );
  }

  const failed = ["ERROR", "Error", "FAILED", "Failed", "FAILURE", "Failure"];
  for (const stopReason of failed) {
    assert.equal(
      statusOfStopReason(stopReason),
      "error",
      `the stop reason '${stopReason}' must end the turn as an error`,
    );
  }

  assert.equal(statusOfStopReason("STOP"), "ok");
});

/* ----------------------------------------------------- the three sources */

test("the stop reason of the last message wins over the one of the line", () => {
  assert.equal(
    statusOf({
      messages: [{ role: "assistant", stopReason: "aborted" }],
      stopReason: "error",
      reason: "failed",
    }),
    "cancelled",
  );
});

test("the stop reason of the line wins over its reason", () => {
  assert.equal(
    statusOf({
      messages: [{ role: "assistant" }],
      stopReason: "error",
      reason: "failed",
    }),
    "error",
  );
});

test("the reason of the line is used when nothing else carries a stop reason", () => {
  assert.equal(
    statusOf({
      messages: [{ role: "assistant" }],
      reason: "aborted",
    }),
    "cancelled",
  );
  assert.equal(statusOf({ reason: "failure" }), "error");
});

test("the stop reason of the message of the line is used when there are no messages", () => {
  assert.equal(statusOf({ message: { role: "assistant", stopReason: "aborted" } }), "cancelled");
  assert.equal(statusOf({ message: { role: "assistant", stopReason: "failure" } }), "error");
});

test("a stop reason that is not a string is ignored", () => {
  assert.equal(
    statusOf({
      messages: [{ role: "assistant", stopReason: 42 }],
      stopReason: "aborted",
    }),
    "cancelled",
  );
});

/* ------------------------------------------------------------- known issue */

// TODO(defect): the adapter takes the FIRST assistant message of the line
// instead of the last one, so a turn that ended in 'aborted' is reported as
// 'ok' when the turn had several assistant messages -- the probe reads the
// stop reason of the last message (`probes/bots/pi.mjs`).  See the pull
// request body of this card.
test.todo("the stop reason of the last assistant message wins over an earlier one", () => {
  assert.equal(
    statusOf({
      messages: [
        { role: "assistant", stopReason: "stop" },
        { role: "assistant", stopReason: "aborted" },
      ],
    }),
    "cancelled",
  );
});
