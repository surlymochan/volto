/**
 * Configuration of the bot daemon.
 *
 * Every knob can be set with a command line flag or with an environment
 * variable; the environment variable is the fallback. Defaults are chosen so
 * that a plain `botd serve` behaves sensibly.
 */
import path from "node:path";
import { BOTD_VERSION } from "./protocol.ts";
import { defaultBotdHome } from "./store.ts";

export type BotdConfig = {
  botdVersion: string;
  /** Lease TTL used when the client does not ask for one. */
  leaseTtlMs: number;
  /** Lower bound for a client supplied lease TTL. */
  minLeaseTtlMs: number;
  /** Maximum number of events kept per session. */
  ringMaxEvents: number;
  /** Maximum number of bytes kept per session. */
  ringMaxBytes: number;
  /** A session without output for this long is reported as `idle`. */
  idleAfterMs: number;
  /** A session without output for this long raises a `stall` frame. */
  stallMs: number;
  /** How often the watchdog runs. */
  watchdogIntervalMs: number;
  /** Time between the cancel message and the SIGINT. */
  cancelGraceMs: number;
  /** Time between the SIGINT and the SIGKILL of the process group. */
  cancelKillGraceMs: number;
  /** Time between the SIGTERM and the SIGKILL of the process group. */
  terminateGraceMs: number;
  /** Directory holding the session table. */
  home: string;
  /** Explicit path of the session table (defaults to `<home>/sessions.json`). */
  storeFile: string | undefined;
  /** Clock, injectable for tests. */
  now: () => number;
};

export const DEFAULT_CONFIG: BotdConfig = {
  botdVersion: BOTD_VERSION,
  leaseTtlMs: 15_000,
  minLeaseTtlMs: 250,
  ringMaxEvents: 1000,
  ringMaxBytes: 1 << 20,
  idleAfterMs: 2_000,
  stallMs: 30_000,
  watchdogIntervalMs: 250,
  cancelGraceMs: 3_000,
  cancelKillGraceMs: 3_000,
  terminateGraceMs: 3_000,
  home: defaultBotdHome(),
  storeFile: undefined,
  now: Date.now,
};

/** Path of the session table for a configuration. */
export function sessionTablePath(config: BotdConfig): string {
  return config.storeFile ?? path.join(config.home, "sessions.json");
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonempty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

/** Build the configuration from command line flags and the environment. */
export function loadConfig(
  argv: string[] = [],
  env: Record<string, string | undefined> = process.env,
): BotdConfig {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) flags.set(match[1], match[2]);
  }

  const config: BotdConfig = { ...DEFAULT_CONFIG };

  const home = nonempty(flags.get("home")) ?? nonempty(env.BOTD_HOME);
  if (home) config.home = defaultBotdHome({ BOTD_HOME: home });

  const leaseTtlMs = num(flags.get("lease-ttl-ms")) ?? num(env.BOTD_LEASE_TTL_MS);
  if (leaseTtlMs !== undefined) config.leaseTtlMs = leaseTtlMs;

  const ringMaxEvents = num(flags.get("ring-max-events")) ?? num(env.BOTD_RING_MAX_EVENTS);
  if (ringMaxEvents !== undefined) config.ringMaxEvents = ringMaxEvents;

  const ringMaxBytes = num(flags.get("ring-max-bytes")) ?? num(env.BOTD_RING_MAX_BYTES);
  if (ringMaxBytes !== undefined) config.ringMaxBytes = ringMaxBytes;

  const idleAfterMs = num(flags.get("idle-ms")) ?? num(env.BOTD_IDLE_MS);
  if (idleAfterMs !== undefined) config.idleAfterMs = idleAfterMs;

  const stallMs = num(flags.get("stall-ms")) ?? num(env.BOTD_STALL_MS);
  if (stallMs !== undefined) config.stallMs = stallMs;

  const watchdogIntervalMs = num(flags.get("watchdog-ms")) ?? num(env.BOTD_WATCHDOG_MS);
  if (watchdogIntervalMs !== undefined) config.watchdogIntervalMs = watchdogIntervalMs;

  const cancelGraceMs = num(flags.get("cancel-grace-ms")) ?? num(env.BOTD_CANCEL_GRACE_MS);
  if (cancelGraceMs !== undefined) config.cancelGraceMs = cancelGraceMs;

  const cancelKillGraceMs =
    num(flags.get("cancel-kill-grace-ms")) ?? num(env.BOTD_CANCEL_KILL_GRACE_MS);
  if (cancelKillGraceMs !== undefined) config.cancelKillGraceMs = cancelKillGraceMs;

  const terminateGraceMs = num(flags.get("terminate-grace-ms")) ?? num(env.BOTD_TERMINATE_GRACE_MS);
  if (terminateGraceMs !== undefined) config.terminateGraceMs = terminateGraceMs;

  const storeFile = nonempty(flags.get("store-file")) ?? nonempty(env.BOTD_STORE_FILE);
  if (storeFile) config.storeFile = path.resolve(storeFile);

  return config;
}
