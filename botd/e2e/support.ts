/**
 * Helpers of the botd end-to-end tests.
 *
 * The end-to-end suite starts the real daemon (botd/src/main.ts) as a child
 * process and drives it over stdio. Everything temporary lives inside the
 * worktree (botd/e2e/.tmp) and every fixture is synthetic: no host name,
 * address or credential shows up here.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";

/** The entry point of the daemon the suite starts. */
export const MAIN_TS = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/** The fake bot the suite drives. */
export const FAKE_BOT = fileURLToPath(new URL("./fixtures/fake-bot.mjs", import.meta.url));

/** Everything temporary lives inside the worktree, in botd/e2e/.tmp. */
const TMP_ROOT = fileURLToPath(new URL("./.tmp/", import.meta.url));

/** True when the daemon entry point is there. */
export function hasDaemon(): boolean {
  return existsSync(MAIN_TS);
}

/**
 * Skip the test when the daemon entry point is missing.
 *
 * Returns true when the test has to stop: the suite is then reported as
 * skipped instead of failed.
 */
export function skipWithoutDaemon(t: TestContext): boolean {
  if (hasDaemon()) return false;
  t.skip("botd/src/main.ts is missing: the end-to-end suite needs the daemon entry point");
  return true;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A throw away directory inside the worktree. */
export function makeTempDir(prefix: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(path.join(TMP_ROOT, prefix));
}

/** Poll until the predicate returns something truthy, or fail. */
export async function waitFor<T>(
  predicate: () => T | undefined | null | false,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${options.label ?? "condition"}`);
    }
    await delay(intervalMs);
  }
}

/** One session of the session table of the daemon. */
export type SessionRow = {
  sid: string;
  state: string;
  lastSeq: number;
  ackedSeq: number;
};

/** Read the session table the daemon wrote. */
export function readSessionTable(home: string): SessionRow[] {
  try {
    const parsed = JSON.parse(readFileSync(path.join(home, "sessions.json"), "utf8")) as {
      sessions?: SessionRow[];
    };
    return parsed.sessions ?? [];
  } catch {
    return [];
  }
}

/** One entry of the log of the fake bot. */
export type FakeBotEntry = {
  event: string;
  line?: string;
  method?: string | null;
};

/** Read the log the fake bot wrote. */
export function readFakeBotLog(file: string): FakeBotEntry[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FakeBotEntry);
}

/** The shape of the ACP-like payloads of the fake bot. */
export type AcpPayload = {
  jsonrpc?: string;
  id?: number | null;
  method?: string;
  result?: { stopReason?: string; sessionId?: string };
  params?: {
    sessionId?: string;
    update?: {
      sessionUpdate?: string;
      content?: { type?: string; text?: string };
    };
  };
};
