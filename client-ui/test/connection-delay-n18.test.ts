// Tests for the reconnect delay and the retry budget of
// client-ui/src/connection.ts (card N18).
//
// The module is pure: no clock, no randomness, no network, so every case
// below is decided by its input alone. The general behaviour of the module
// is covered by connection.test.ts; the cases here pin the spec of this
// card on their own, so a changed delay schedule or a changed error label
// is caught here as well.
//
// All data below is synthetic: a made up host alias and a made up error
// text, never a real name, host, address or token.

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_BASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_MS,
  describeConnection,
  FALLBACK_ERROR,
  MAX_ERROR_LENGTH,
  reconnectDelayMs,
  shouldGiveUp,
} from "../src/connection.ts";
import type { HostState } from "../src/state.ts";

/** A host whose connection failed with the given error message. */
function failedHost(error: string | null): HostState {
  return { alias: "alpha", label: "Alpha", status: "error", error };
}

test("the delay doubles with every attempt", () => {
  assert.equal(reconnectDelayMs(1), DEFAULT_BASE_MS);
  for (let attempt = 2; attempt <= 5; attempt += 1) {
    assert.equal(
      reconnectDelayMs(attempt),
      reconnectDelayMs(attempt - 1) * 2,
      `attempt ${attempt} does not wait twice as long as attempt ${attempt - 1}`,
    );
  }
});

test("a long run of attempts never waits longer than the cap", () => {
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const delay = reconnectDelayMs(attempt);
    assert.ok(delay <= DEFAULT_MAX_MS, `attempt ${attempt} waits longer than the cap`);
    assert.ok(delay >= 0, `attempt ${attempt} waits for a negative time`);
  }
  assert.equal(reconnectDelayMs(50), DEFAULT_MAX_MS);
});

test("an attempt of zero or less waits for no time at all", () => {
  assert.equal(reconnectDelayMs(0), 0);
  assert.equal(reconnectDelayMs(-1), 0);
  assert.equal(reconnectDelayMs(-50), 0);
});

test("the client gives up with the last attempt", () => {
  assert.equal(shouldGiveUp(7), false);
  assert.equal(shouldGiveUp(8), true);
  assert.equal(DEFAULT_MAX_ATTEMPTS, 8);
  assert.equal(shouldGiveUp(DEFAULT_MAX_ATTEMPTS - 1), false);
  assert.equal(shouldGiveUp(DEFAULT_MAX_ATTEMPTS), true);
});

test("a long error message is cut to the maximum length", () => {
  const message = `botd: ${"e".repeat(400)}`;
  const view = describeConnection(failedHost(message), 0);
  assert.equal(view.tone, "error");
  assert.equal(view.label.length, MAX_ERROR_LENGTH);
  assert.equal(view.label, message.slice(0, MAX_ERROR_LENGTH));
});

test("an empty error message falls back to a fixed text", () => {
  assert.equal(describeConnection(failedHost(""), 0).label, FALLBACK_ERROR);
  assert.equal(describeConnection(failedHost(null), 0).label, FALLBACK_ERROR);
});
