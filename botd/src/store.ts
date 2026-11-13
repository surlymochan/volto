/**
 * Session table persistence.
 *
 * The table is a JSON file in the botd home directory (`BOTD_HOME`, by
 * default `~/.volto-botd`). It is written atomically: the new content goes
 * to a temporary file in the same directory which is then renamed over the
 * old one, so a crash never leaves a half written table behind.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BotKind, SessionState } from "./protocol.ts";
import { redact } from "./redact.ts";

// Identity, resume, state and counters must survive persistence exactly.
const ROUNDTRIP_KEYS = new Set([
  "sid", "kind", "providerSessionId", "state", "createdAt", "updatedAt",
  "lastSeq", "ackedSeq", "progressAt",
]);

export type SessionRecord = {
  sid: string;
  kind: BotKind;
  command: string[];
  cwd?: string;
  providerSessionId?: string;
  state: SessionState;
  createdAt: number;
  updatedAt: number;
  /** Sequence number of the last event of the session. */
  lastSeq: number;
  /** Highest sequence number acknowledged by the client. */
  ackedSeq: number;
  /** Timestamp of the last child output. */
  progressAt: number;
};

/** The botd home directory: `BOTD_HOME` or `~/.volto-botd`. */
export function defaultBotdHome(env: Record<string, string | undefined> = process.env): string {
  const home = env.BOTD_HOME;
  if (home && home.trim().length > 0) return path.resolve(home);
  return path.join(os.homedir(), ".volto-botd");
}

export class SessionStore {
  private file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** Absolute path of the session table. */
  get path(): string {
    return this.file;
  }

  /** Read the table; a missing or broken file yields an empty table. */
  load(): SessionRecord[] {
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    const entries = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { sessions?: unknown }).sessions)
        ? ((parsed as { sessions: unknown[] }).sessions as unknown[])
        : [];
    const records: SessionRecord[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Partial<SessionRecord>;
      if (typeof record.sid !== "string" || record.sid.length === 0) continue;
      records.push({
        sid: record.sid,
        kind: (record.kind ?? "acp") as BotKind,
        command: Array.isArray(record.command) ? record.command.map(String) : [],
        cwd: typeof record.cwd === "string" ? record.cwd : undefined,
        providerSessionId:
          typeof record.providerSessionId === "string" ? record.providerSessionId : undefined,
        state: (record.state ?? "exited") as SessionState,
        createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
        updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
        lastSeq: typeof record.lastSeq === "number" ? record.lastSeq : 0,
        ackedSeq: typeof record.ackedSeq === "number" ? record.ackedSeq : 0,
        progressAt: typeof record.progressAt === "number" ? record.progressAt : 0,
      });
    }
    return records;
  }

  /** Write the table atomically. */
  save(records: SessionRecord[]): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this.file)}.tmp-${process.pid}`);
    const sessions = records.map((record) =>
      Object.fromEntries(
        Object.entries(record).map(([key, value]) => [
          key,
          ROUNDTRIP_KEYS.has(key) ? value : redact(value),
        ]),
      ),
    );
    const data = `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`;
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }
}
