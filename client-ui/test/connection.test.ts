// Tests for the connection description of client-ui/src/connection.ts.
//
// The module is pure: the wall clock and the random source are passed in, so
// every case below is fully determined by its input.

import assert from "node:assert/strict";
import test from "node:test";

import {
  describeConnection,
  FALLBACK_ERROR,
  MAX_ERROR_LENGTH,
  reconnectDelayMs,
  shouldGiveUp,
} from "../src/connection.ts";
import type { HostState, HostStatus } from "../src/state.ts";

/** A host in the given status, with an optional error message. */
function host(status: HostStatus, error: string | null = null): HostState {
  return { alias: "alpha", label: "Alpha", status, error };
}

test("a connected host is shown as fine", () => {
  const view = describeConnection(host("connected"), 1000);
  assert.equal(view.tone, "ok");
  assert.equal(view.label, "online");
  assert.equal(view.canRetry, false);
  assert.equal(view.retryInMs, null);
});

test("a host that is being connected is shown as busy", () => {
  const view = describeConnection(host("connecting"), 1000);
  assert.equal(view.tone, "busy");
  assert.equal(view.label, "connecting");
  assert.equal(view.canRetry, false);
  assert.equal(view.retryInMs, null);
});

test("a disconnected host is shown as offline and can be retried", () => {
  const view = describeConnection(host("disconnected"), 1000);
  assert.equal(view.tone, "warn");
  assert.equal(view.label, "offline");
  assert.equal(view.canRetry, true);
  assert.equal(view.retryInMs, null);
});

test("a host whose connection failed shows the error of the daemon", () => {
  const view = describeConnection(host("error", "botd: transport closed"), 1000);
  assert.equal(view.tone, "error");
  assert.equal(view.label, "botd: transport closed");
  assert.equal(view.canRetry, true);
  assert.equal(view.retryInMs, null);
});

test("a failed connection without a message falls back to a fixed text", () => {
  assert.equal(describeConnection(host("error", null), 0).label, FALLBACK_ERROR);
  assert.equal(describeConnection(host("error", ""), 0).label, FALLBACK_ERROR);
  assert.equal(describeConnection(host("error", "   "), 0).label, FALLBACK_ERROR);
});

test("a long error message is cut to 120 characters", () => {
  const message = "e".repeat(500);
  const view = describeConnection(host("error", message), 0);
  assert.equal(view.label.length, MAX_ERROR_LENGTH);
  assert.equal(view.label, message.slice(0, MAX_ERROR_LENGTH));
});

test("an error message of exactly 120 characters is kept as it is", () => {
  const message = "e".repeat(MAX_ERROR_LENGTH);
  assert.equal(describeConnection(host("error", message), 0).label, message);
});

test("the time until the next attempt is counted down", () => {
  const view = describeConnection(host("error", "boom"), 1000, { retryAt: 4000 });
  assert.equal(view.retryInMs, 3000);
});

test("an attempt that is due is not counted into the past", () => {
  const view = describeConnection(host("disconnected"), 5000, { retryAt: 4000 });
  assert.equal(view.retryInMs, 0);
});

test("a failed connection cannot be retried once the attempts are used up", () => {
  const view = describeConnection(host("error", "boom"), 0, { attempt: 8, maxAttempts: 8 });
  assert.equal(view.canRetry, false);
  assert.equal(view.tone, "error");
});

test("the reconnect delay grows exponentially and stops at the cap", () => {
  const delays = [1, 2, 3, 4, 5, 6, 7].map((attempt) => reconnectDelayMs(attempt));
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test("the reconnect delay honours the given base and cap", () => {
  assert.equal(reconnectDelayMs(1, { baseMs: 500 }), 500);
  assert.equal(reconnectDelayMs(3, { baseMs: 500 }), 2000);
  assert.equal(reconnectDelayMs(9, { baseMs: 500, maxMs: 2000 }), 2000);
});

test("the jitter keeps the delay within its bounds", () => {
  const base = 1000;
  const jitter = 0.25;
  assert.equal(reconnectDelayMs(1, { jitter, random: () => 0 }), 750);
  assert.equal(reconnectDelayMs(1, { jitter, random: () => 1 }), 1250);
  assert.equal(reconnectDelayMs(1, { jitter, random: () => 0.5 }), 1000);
});

test("the jitter stays within its bounds on a capped delay", () => {
  const capped = reconnectDelayMs(6, { jitter: 0.5, random: () => 1 });
  assert.equal(capped, 45000);
  assert.ok(capped <= 30000 * 1.5, "the jitter spreads the delay, it does not remove the cap");
});

test("without a jitter the delay is the same every time", () => {
  let calls = 0;
  const random = (): number => {
    calls += 1;
    return 0.42;
  };
  assert.equal(reconnectDelayMs(3, { random }), 4000);
  assert.equal(calls, 0, "the random source is not used without a jitter");
});

test("an attempt that is not a positive number waits for no time", () => {
  assert.equal(reconnectDelayMs(0), 0);
  assert.equal(reconnectDelayMs(-1), 0);
  assert.equal(reconnectDelayMs(Number.NaN), 0);
});

test("an endless run of attempts waits for the cap", () => {
  assert.equal(reconnectDelayMs(Number.POSITIVE_INFINITY), 30000);
});

test("a base of zero waits for no time at all", () => {
  assert.equal(reconnectDelayMs(3, { baseMs: 0 }), 0);
});

test("the client gives up after the last attempt", () => {
  assert.equal(shouldGiveUp(7), false);
  assert.equal(shouldGiveUp(8), true);
  assert.equal(shouldGiveUp(9), true);
});

test("the limit of the attempts can be given", () => {
  assert.equal(shouldGiveUp(2, 3), false);
  assert.equal(shouldGiveUp(3, 3), true);
  assert.equal(shouldGiveUp(1, 1), true);
});

test("an attempt that is not a positive number never gives up", () => {
  assert.equal(shouldGiveUp(0), false);
  assert.equal(shouldGiveUp(-2), false);
  assert.equal(shouldGiveUp(Number.NaN), false);
});
