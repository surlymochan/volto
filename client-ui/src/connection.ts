// volto client UI: how the connection to a host is shown to the user.
//
// The panel has to tell four situations apart at a glance: a host that is
// reachable, a host that is being connected right now, a host that is
// offline and a host whose connection failed. This module turns the pure
// host state of state.ts into that description, so the view only has to
// render it.
//
// Everything here is a plain function: no DOM, no timers, no network. The
// wall clock and the random source are passed in, which keeps the behaviour
// fully determined by its input and testable without a browser.

import type { HostState } from "./state.ts";

/** How a connection is coloured in the panel. */
export type ConnectionTone = "ok" | "busy" | "warn" | "error";

/** What the panel shows for one host. */
export interface ConnectionView {
  /** Colour of the connection: ok, busy, warn or error. */
  tone: ConnectionTone;
  /** Short text shown next to the host, e.g. "offline". */
  label: string;
  /** True when the user may ask for another attempt. */
  canRetry: boolean;
  /** Milliseconds until the next attempt, or null when none is scheduled. */
  retryInMs: number | null;
}

/** Options of describeConnection. */
export interface ConnectionOptions {
  /** Number of the reconnect attempt that failed last, counting from one. */
  attempt?: number;
  /** Epoch milliseconds of the next scheduled attempt, null when none is. */
  retryAt?: number | null;
  /** Attempts before the client stops retrying. */
  maxAttempts?: number;
}

/** Options of reconnectDelayMs. */
export interface DelayOptions {
  /** Delay of the first attempt, in milliseconds. */
  baseMs?: number;
  /** Upper bound of the delay between two attempts, in milliseconds. */
  maxMs?: number;
  /** Fraction of the delay the jitter may add or remove. */
  jitter?: number;
  /** Source of randomness for the jitter. */
  random?: () => number;
}

/** Delay of the first reconnect attempt, in milliseconds. */
export const DEFAULT_BASE_MS = 1000;

/** Upper bound of the reconnect delay, in milliseconds. */
export const DEFAULT_MAX_MS = 30000;

/** Attempts before the client stops retrying. */
export const DEFAULT_MAX_ATTEMPTS = 8;

/** Longest error text shown to the user, in characters. */
export const MAX_ERROR_LENGTH = 120;

/** Text shown when a connection failed without a message. */
export const FALLBACK_ERROR = "connection failed";

/**
 * Describe the connection of one host for the panel.
 *
 * A host that is disconnected is offline and can be retried, a host that is
 * being connected is busy, a reachable host is fine and a host whose
 * connection failed shows the error of the daemon.
 */
export function describeConnection(
  host: HostState,
  now: number,
  opts: ConnectionOptions = {},
): ConnectionView {
  const attempt = opts.attempt ?? 0;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  switch (host.status) {
    case "connecting":
      return { tone: "busy", label: "connecting", canRetry: false, retryInMs: null };

    case "connected":
      return { tone: "ok", label: "online", canRetry: false, retryInMs: null };

    case "error":
      return {
        tone: "error",
        label: errorLabel(host.error),
        canRetry: !shouldGiveUp(attempt, maxAttempts),
        retryInMs: pendingRetry(now, opts.retryAt),
      };

    default:
      return {
        tone: "warn",
        label: "offline",
        canRetry: true,
        retryInMs: pendingRetry(now, opts.retryAt),
      };
  }
}

/**
 * Milliseconds to wait before the next reconnect attempt.
 *
 * The delay grows exponentially: the first attempt waits `baseMs`, the
 * second twice as long, and so on, never longer than `maxMs`. The jitter
 * spreads the attempts of several clients apart by up to `jitter` of the
 * delay; without a jitter the result is deterministic.
 *
 * An attempt that is not a positive number waits for no time at all.
 */
export function reconnectDelayMs(attempt: number, options: DelayOptions = {}): number {
  const baseMs = numberOr(options.baseMs, DEFAULT_BASE_MS);
  const maxMs = numberOr(options.maxMs, DEFAULT_MAX_MS);
  const jitter = options.jitter === undefined ? 0 : Math.abs(options.jitter);

  if (Number.isNaN(attempt) || attempt <= 0) return 0;
  if (baseMs <= 0) return 0;

  const exponential = baseMs * 2 ** (Math.floor(attempt) - 1);
  const capped = Math.min(exponential, maxMs);
  if (jitter <= 0) return Math.round(capped);

  const random = options.random ?? (() => 0.5);
  const spread = (random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(capped * (1 + spread)));
}

/**
 * True when the client has to stop retrying.
 *
 * The attempt counts the failures, starting at one: after `maxAttempts`
 * failures there is no further attempt. An attempt that is not a positive
 * number means that nothing failed yet, so the client keeps trying.
 */
export function shouldGiveUp(attempt: number, maxAttempts: number = DEFAULT_MAX_ATTEMPTS): boolean {
  if (Number.isNaN(attempt) || attempt <= 0) return false;
  const limit = Number.isFinite(maxAttempts) ? Math.floor(maxAttempts) : DEFAULT_MAX_ATTEMPTS;
  if (limit <= 0) return true;
  return Math.floor(attempt) >= limit;
}

/** The error of a host as it is shown: short, never empty. */
function errorLabel(error: string | null | undefined): string {
  const text = (error ?? "").trim();
  if (text === "") return FALLBACK_ERROR;
  return text.slice(0, MAX_ERROR_LENGTH);
}

/** Milliseconds until the scheduled attempt, or null when none is scheduled. */
function pendingRetry(now: number, retryAt: number | null | undefined): number | null {
  if (retryAt === null || retryAt === undefined || !Number.isFinite(retryAt)) return null;
  return Math.max(0, Math.round(retryAt - now));
}

/** The given number, or the fallback when it is missing or not a number. */
function numberOr(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return value;
}
