// botd session event log.
//
// Durable, append-only event log for one bot session. Events are stored as
// newline-delimited JSON (NDJSON) segments under `${BOTD_HOME}/sessions/`:
//
//   <sid>.ndjson        active segment (the one we append to)
//   <sid>.ndjson.<n>    rotated segments, n increases with age
//   <sid>.index.json    segment index, replaced atomically (write + rename)
//
// Every event carries a monotonically increasing `seq`, so a reader can resume
// from the last sequence it processed (`read(sid, fromSeq)`) and acknowledge
// progress (`compact(sid, ackedSeq)`).
//
// The API is synchronous: writes are small and go straight to the file, and a
// blocked event loop for a few microseconds is cheaper than the bookkeeping a
// write queue would need.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Default cap for a single segment before it is rotated out. */
export const DEFAULT_MAX_SEGMENT_BYTES = 8 * 1024 * 1024;
/** Default number of segments (active + rotated) kept per session. */
export const DEFAULT_KEEP_SEGMENTS = 4;

const INDEX_VERSION = 1;
const INDEX_SUFFIX = ".index.json";
const READ_CHUNK = 64 * 1024;

/** Event as handed to {@link SessionLog.append}. */
export interface SessionEventInput {
  /** Event kind, e.g. "turn_end" or "tool". */
  type: string;
  /** Arbitrary JSON-serializable payload. Runs through the redaction hook. */
  payload?: unknown;
  /** Timestamp in epoch milliseconds. Defaults to the logger clock. */
  ts?: number;
}

/** Event as stored on disk and returned by {@link SessionLog.read}. */
export interface SessionEvent {
  /** Monotonically increasing sequence number, unique per session. */
  seq: number;
  /** Timestamp in epoch milliseconds. */
  ts: number;
  /** Event kind. */
  type: string;
  /** Redacted payload. */
  payload: unknown;
}

export interface SessionLogOptions {
  /** Root directory. Defaults to `$BOTD_HOME`, else `~/.botd`. */
  home?: string;
  /** Rotate a segment once it would exceed this size. Default 8 MB. */
  maxSegmentBytes?: number;
  /** Segments kept per session (active + rotated). Default 4. */
  keepSegments?: number;
  /** Runs on every payload before it is written. */
  redact?: (payload: unknown) => unknown;
  /** Clock used for event timestamps. Defaults to `Date.now`. */
  now?: () => number;
}

/** Summary of a session log. */
export interface SessionStat {
  sid: string;
  /** True when the session has at least one segment on disk. */
  exists: boolean;
  /** Segments currently on disk (active + rotated). */
  segments: number;
  /** Rotated segments currently on disk. */
  closedSegments: number;
  /** Total bytes across all segments. */
  bytes: number;
  /** Events currently on disk. */
  events: number;
  /** Lowest sequence still on disk, null when empty. */
  firstSeq: number | null;
  /** Highest sequence on disk, null when empty. */
  lastSeq: number | null;
  /** Sequence the next appended event will get. */
  nextSeq: number;
  /** Directory holding the session files. */
  dir: string;
  /** Absolute path of the active segment. */
  activeFile: string;
  /** Absolute path of the segment index. */
  indexFile: string;
}

/** Result of {@link SessionLog.compact}. */
export interface CompactResult {
  sid: string;
  /** Segments dropped by this call. */
  removedSegments: number;
  /** File names of the dropped segments. */
  removedFiles: string[];
  /** Lowest sequence still on disk after compaction. */
  firstSeq: number | null;
  /** Highest sequence still on disk after compaction. */
  lastSeq: number | null;
}

interface SegmentMeta {
  /** File name inside the sessions directory. */
  name: string;
  /** Absolute path. */
  file: string;
  /** First sequence in the segment, null when the segment is empty. */
  seqFrom: number | null;
  /** Last sequence in the segment, null when the segment is empty. */
  seqTo: number | null;
  /** Bytes on disk. */
  bytes: number;
  /** Events in the segment. */
  events: number;
  /** True for rotated segments. */
  closed: boolean;
}

interface SessionState {
  sid: string;
  key: string;
  dir: string;
  indexPath: string;
  segments: SegmentMeta[];
  nextSeq: number;
  fd: number | null;
  activeBytes: number;
  pendingIndexWrites: number;
  indexDirty: boolean;
}

interface IndexSegment {
  name: string;
  seqFrom: number | null;
  seqTo: number | null;
  bytes: number;
  events: number;
  closed: boolean;
}

interface SegmentIndex {
  version: number;
  sid: string;
  nextSeq: number;
  segments: IndexSegment[];
}

/** File name for a session id, safe to use as a path segment. */
function sessionKey(sid: string): string {
  if (typeof sid !== "string" || sid.length === 0) throw new Error("session id is required");
  const cleaned = sid.replace(/[^A-Za-z0-9._-]/g, "_");
  if (cleaned === sid && cleaned !== "." && cleaned !== "..") return cleaned;
  const hash = createHash("sha256").update(sid).digest("hex").slice(0, 12);
  return `${cleaned.slice(0, 48) || "sid"}-${hash}`;
}

/** Segment files of one session, oldest rotated segment first. */
function listSegmentFiles(dir: string, key: string): { closed: string[]; active: string | null } {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { closed: [], active: null };
  }
  const closed: Array<{ name: string; n: number }> = [];
  let active: string | null = null;
  for (const name of names) {
    if (name === `${key}.ndjson`) {
      active = name;
      continue;
    }
    const match = new RegExp(`^${escapeRegExp(key)}\\.ndjson\\.(\\d+)$`).exec(name);
    if (match) closed.push({ name, n: Number(match[1]) });
  }
  closed.sort((a, b) => a.n - b.n);
  return { closed: closed.map((c) => c.name), active };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Drop a partially written trailing line, as left behind by a crash.
 * Returns true when the file was truncated.
 */
function repairTornTail(file: string): boolean {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false;
  }
  if (size === 0) return false;
  const fd = fs.openSync(file, "r+");
  try {
    const buf = Buffer.allocUnsafe(READ_CHUNK);
    let end = size;
    let lastNewline = -1;
    while (end > 0 && lastNewline < 0) {
      const start = Math.max(0, end - READ_CHUNK);
      const read = fs.readSync(fd, buf, 0, end - start, start);
      // A UTF-8 continuation byte is never 0x0A, so slicing on a chunk
      // boundary cannot hide a newline.
      const idx = buf.toString("latin1", 0, read).lastIndexOf("\n");
      if (idx >= 0) lastNewline = start + idx;
      end = start;
    }
    if (lastNewline === size - 1) return false;
    fs.ftruncateSync(fd, lastNewline + 1);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/** Sequence of the first record of a segment, null when the segment is empty. */
function readFirstSeq(file: string): number | null {
  for (const line of iterLines(file)) {
    if (line.trim().length === 0) continue;
    return seqOf(line);
  }
  return null;
}

/** Sequence of the last record of a segment, null when the segment is empty. */
function readLastSeq(file: string): number | null {
  let last: string | null = null;
  for (const line of iterLines(file)) {
    if (line.trim().length === 0) continue;
    last = line;
  }
  return last === null ? null : seqOf(last);
}

/** Sequence carried by one NDJSON line, null when the line is not a record. */
function seqOf(line: string): number | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as { seq?: unknown };
    return typeof parsed.seq === "number" ? parsed.seq : null;
  } catch {
    return null;
  }
}

/** Number of records in a segment. */
function countRecords(file: string): number {
  let count = 0;
  for (const line of iterLines(file)) {
    if (line.trim().length > 0) count += 1;
  }
  return count;
}

/** Stream the lines of a file without loading it all into memory. */
function* iterLines(file: string): Generator<string> {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return;
  }
  const decoder = new StringDecoder("utf8");
  const chunk = Buffer.allocUnsafe(READ_CHUNK);
  let rest = "";
  try {
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      const text = rest + decoder.write(chunk.subarray(0, read));
      const parts = text.split("\n");
      rest = parts.pop() ?? "";
      for (const part of parts) yield part;
    }
    rest += decoder.end();
    if (rest.length > 0) yield rest;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Append-only NDJSON event log for bot sessions.
 *
 * Segments rotate once they exceed `maxSegmentBytes`; at most `keepSegments`
 * segments are kept per session, the oldest rotated ones are dropped first.
 */
export class SessionLog {
  readonly home: string;
  readonly sessionsDir: string;
  readonly maxSegmentBytes: number;
  readonly keepSegments: number;
  private readonly redactHook: ((payload: unknown) => unknown) | null;
  private readonly clock: () => number;
  private readonly states = new Map<string, SessionState>();

  constructor(options: SessionLogOptions = {}) {
    this.home = options.home ?? process.env.BOTD_HOME ?? path.join(os.homedir(), ".botd");
    this.sessionsDir = path.join(this.home, "sessions");
    this.maxSegmentBytes = Math.max(1, options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES);
    this.keepSegments = Math.max(1, options.keepSegments ?? DEFAULT_KEEP_SEGMENTS);
    this.redactHook = typeof options.redact === "function" ? options.redact : null;
    this.clock = options.now ?? Date.now;
  }

  /** Append an event to a session and return the stored record. */
  append(sid: string, event: SessionEventInput): SessionEvent {
    const state = this.openSession(sid);
    const record: SessionEvent = {
      seq: state.nextSeq,
      ts: typeof event.ts === "number" ? event.ts : this.clock(),
      type: typeof event.type === "string" && event.type.length > 0 ? event.type : "event",
      payload: this.applyRedaction(event.payload),
    };
    const line = `${JSON.stringify(record)}\n`;
    const buf = Buffer.from(line, "utf8");
    if (state.activeBytes > 0 && state.activeBytes + buf.length > this.maxSegmentBytes) {
      this.rotate(state);
    }
    const fd = this.activeFd(state);
    fs.writeSync(fd, buf);
    state.activeBytes += buf.length;
    state.nextSeq += 1;
    const active = this.activeSegment(state);
    if (active) {
      active.seqTo = record.seq;
      active.bytes = state.activeBytes;
      active.events += 1;
      if (active.seqFrom === null) active.seqFrom = record.seq;
    }
    state.pendingIndexWrites += 1;
    // The index is a cache of the segments: write it on the first append of a
    // session, every 512 appends after that, and on rotation or compaction.
    if (state.indexDirty || state.pendingIndexWrites >= 512) this.persistIndex(state);
    return record;
  }

  /** Read events with `seq >= fromSeq`, at most `limit` of them, in order. */
  read(sid: string, fromSeq = 1, limit = Number.POSITIVE_INFINITY): SessionEvent[] {
    const out: SessionEvent[] = [];
    if (limit <= 0) return out;
    const state = this.openSession(sid);
    for (const segment of state.segments) {
      if (out.length >= limit) break;
      if (segment.seqTo !== null && segment.seqTo < fromSeq) continue;
      for (const line of iterLines(segment.file)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let parsed: SessionEvent;
        try {
          parsed = JSON.parse(trimmed) as SessionEvent;
        } catch {
          continue;
        }
        if (typeof parsed.seq !== "number" || parsed.seq < fromSeq) continue;
        out.push(parsed);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /**
   * Drop segments whose events are fully acknowledged.
   *
   * The active segment is never dropped: it is the write target and may still
   * hold unacknowledged events. It leaves the log on the next rotation.
   */
  compact(sid: string, ackedSeq: number): CompactResult {
    const state = this.openSession(sid);
    const removedFiles: string[] = [];
    const kept: SegmentMeta[] = [];
    for (const segment of state.segments) {
      const fullyAcked = segment.closed && segment.seqTo !== null && segment.seqTo <= ackedSeq;
      if (fullyAcked) {
        removedFiles.push(segment.name);
        try {
          fs.unlinkSync(segment.file);
        } catch {
          // Already gone: the index is the source of truth, keep going.
        }
      } else {
        kept.push(segment);
      }
    }
    state.segments = kept;
    this.persistIndex(state);
    const first = state.segments[0];
    const last = state.segments[state.segments.length - 1];
    return {
      sid,
      removedSegments: removedFiles.length,
      removedFiles,
      firstSeq: first ? first.seqFrom : null,
      lastSeq: last ? last.seqTo : null,
    };
  }

  /** Summarize a session log. */
  stat(sid: string): SessionStat {
    const state = this.openSession(sid);
    let bytes = 0;
    let events = 0;
    for (const segment of state.segments) {
      bytes += segment.bytes;
      events += countRecords(segment.file);
    }
    const first = state.segments[0];
    const last = state.segments[state.segments.length - 1];
    return {
      sid,
      exists: state.segments.length > 0 && events > 0,
      segments: state.segments.length,
      closedSegments: state.segments.filter((s) => s.closed).length,
      bytes,
      events,
      firstSeq: first ? first.seqFrom : null,
      lastSeq: last ? last.seqTo : null,
      nextSeq: state.nextSeq,
      dir: state.dir,
      activeFile: path.join(state.dir, `${state.key}.ndjson`),
      indexFile: state.indexPath,
    };
  }

  /** Persist the segment index of one session (or of every open session). */
  flush(sid?: string): void {
    if (sid === undefined) {
      for (const state of this.states.values()) this.persistIndex(state);
      return;
    }
    const state = this.openSession(sid);
    this.persistIndex(state);
  }

  /** Close open file descriptors of one session (or of every session). */
  close(sid?: string): void {
    if (sid === undefined) {
      for (const state of this.states.values()) this.closeState(state);
      this.states.clear();
      return;
    }
    const state = this.states.get(sid);
    if (!state) return;
    this.closeState(state);
    this.states.delete(sid);
  }

  private closeState(state: SessionState): void {
    if (state.fd !== null) {
      try {
        fs.closeSync(state.fd);
      } catch {
        // Ignore: the descriptor is gone either way.
      }
      state.fd = null;
    }
    this.persistIndex(state);
  }

  private applyRedaction(payload: unknown): unknown {
    if (!this.redactHook) return payload ?? null;
    try {
      const redacted = this.redactHook(payload);
      return redacted === undefined ? null : redacted;
    } catch {
      // Fail closed: a broken hook must not leak the raw payload into the log.
      return null;
    }
  }

  private openSession(sid: string): SessionState {
    const cached = this.states.get(sid);
    if (cached) return cached;
    const key = sessionKey(sid);
    const dir = this.sessionsDir;
    fs.mkdirSync(dir, { recursive: true });
    const state: SessionState = {
      sid,
      key,
      dir,
      indexPath: path.join(dir, `${key}${INDEX_SUFFIX}`),
      segments: [],
      nextSeq: 1,
      fd: null,
      activeBytes: 0,
      pendingIndexWrites: 0,
      indexDirty: true,
    };
    this.states.set(sid, state);
    this.recover(state);
    return state;
  }

  /** Rebuild the segment list of a session from disk. */
  private recover(state: SessionState): void {
    const index = this.readIndex(state);
    const files = listSegmentFiles(state.dir, state.key);
    const segments: SegmentMeta[] = [];
    for (const name of files.closed) {
      const known = index?.segments.find((s) => s.name === name);
      segments.push({
        name,
        file: path.join(state.dir, name),
        seqFrom: known?.seqFrom ?? null,
        seqTo: known?.seqTo ?? null,
        bytes: known?.bytes ?? 0,
        events: known?.events ?? 0,
        closed: true,
      });
    }
    if (files.active) {
      const known = index?.segments.find((s) => s.name === files.active);
      segments.push({
        name: files.active,
        file: path.join(state.dir, files.active),
        seqFrom: known?.seqFrom ?? null,
        seqTo: known?.seqTo ?? null,
        bytes: known?.bytes ?? 0,
        events: known?.events ?? 0,
        closed: false,
      });
    }
    state.segments = segments;

    for (const segment of state.segments) {
      try {
        fs.statSync(segment.file);
      } catch {
        continue;
      }
      // A crash can leave a half written line behind: drop it before reading.
      const repaired = repairTornTail(segment.file);
      segment.bytes = fs.statSync(segment.file).size;
      if (repaired) {
        segment.seqTo = null;
        segment.events = 0;
      }
      if (segment.seqFrom === null) segment.seqFrom = readFirstSeq(segment.file);
    }

    for (let i = 0; i < state.segments.length - 1; i += 1) {
      const segment = state.segments[i];
      const next = state.segments[i + 1];
      if (segment && next && next.seqFrom !== null) segment.seqTo = next.seqFrom - 1;
    }
    // The segments are authoritative: the last sequence is read back from the
    // file, the index may lag behind.
    const lastSegment = state.segments[state.segments.length - 1];
    if (lastSegment && lastSegment.seqFrom !== null) {
      const lastSeq = readLastSeq(lastSegment.file);
      if (lastSeq !== null) lastSegment.seqTo = lastSeq;
    }
    const active = this.activeSegment(state);
    state.activeBytes = active ? active.bytes : 0;

    let maxSeq: number | null = null;
    for (const segment of state.segments) {
      if (segment.seqTo !== null && (maxSeq === null || segment.seqTo > maxSeq)) maxSeq = segment.seqTo;
    }
    state.nextSeq = maxSeq !== null ? maxSeq + 1 : (index?.nextSeq ?? 1);
  }

  private readIndex(state: SessionState): SegmentIndex | null {
    let raw: string;
    try {
      raw = fs.readFileSync(state.indexPath, "utf8");
    } catch {
      return null;
    }
    let parsed: SegmentIndex;
    try {
      parsed = JSON.parse(raw) as SegmentIndex;
    } catch {
      return null;
    }
    if (!parsed || parsed.version !== INDEX_VERSION || !Array.isArray(parsed.segments)) return null;
    return parsed;
  }

  private activeSegment(state: SessionState): SegmentMeta | null {
    if (state.segments.length === 0) return null;
    const last = state.segments[state.segments.length - 1];
    return last.closed ? null : last;
  }

  private activeFd(state: SessionState): number {
    if (state.fd !== null) return state.fd;
    let segment = this.activeSegment(state);
    if (!segment) {
      segment = {
        name: `${state.key}.ndjson`,
        file: path.join(state.dir, `${state.key}.ndjson`),
        seqFrom: null,
        seqTo: null,
        bytes: 0,
        events: 0,
        closed: false,
      };
      state.segments.push(segment);
    }
    state.fd = fs.openSync(segment.file, "a");
    return state.fd;
  }

  /** Close the active segment and start a new one. */
  private rotate(state: SessionState): void {
    if (state.fd !== null) {
      fs.closeSync(state.fd);
      state.fd = null;
    }
    const active = this.activeSegment(state);
    if (active && active.bytes > 0) {
      const next = this.nextSegmentNumber(state);
      const name = `${state.key}.ndjson.${next}`;
      fs.renameSync(active.file, path.join(state.dir, name));
      active.name = name;
      active.file = path.join(state.dir, name);
      active.closed = true;
    } else if (active) {
      // Nothing was written to the active segment: drop it instead of
      // leaving two segments with the same file name behind.
      state.segments.splice(state.segments.indexOf(active), 1);
    }
    state.segments.push({
      name: `${state.key}.ndjson`,
      file: path.join(state.dir, `${state.key}.ndjson`),
      seqFrom: null,
      seqTo: null,
      bytes: 0,
      events: 0,
      closed: false,
    });
    state.activeBytes = 0;
    this.enforceRetention(state);
    this.persistIndex(state);
  }

  private nextSegmentNumber(state: SessionState): number {
    let max = 0;
    for (const segment of state.segments) {
      const match = /\.ndjson\.(\d+)$/.exec(segment.name);
      if (match) max = Math.max(max, Number(match[1]));
    }
    try {
      for (const name of fs.readdirSync(state.dir)) {
        const match = new RegExp(`^${escapeRegExp(state.key)}\\.ndjson\\.(\\d+)$`).exec(name);
        if (match) max = Math.max(max, Number(match[1]));
      }
    } catch {
      // No directory yet: the first segment number is 1.
    }
    return max + 1;
  }

  /** Drop the oldest rotated segments once the retention limit is exceeded. */
  private enforceRetention(state: SessionState): void {
    while (state.segments.length > this.keepSegments) {
      const victim = state.segments.find((segment) => segment.closed);
      if (!victim) break;
      try {
        fs.unlinkSync(victim.file);
      } catch {
        // Ignore a missing file: the index is updated either way.
      }
      state.segments.splice(state.segments.indexOf(victim), 1);
    }
  }

  /** Replace the segment index atomically. */
  private persistIndex(state: SessionState): void {
    const index: SegmentIndex = {
      version: INDEX_VERSION,
      sid: state.sid,
      nextSeq: state.nextSeq,
      segments: state.segments.map((segment) => ({
        name: segment.name,
        seqFrom: segment.seqFrom,
        seqTo: segment.seqTo,
        bytes: segment.bytes,
        events: segment.events,
        closed: segment.closed,
      })),
    };
    const tmp = `${state.indexPath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(index)}\n`);
      fs.renameSync(tmp, state.indexPath);
      state.pendingIndexWrites = 0;
      state.indexDirty = false;
    } catch {
      // The index is a cache: the segments themselves stay authoritative.
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Nothing to clean up.
      }
    }
  }
}

let sharedLog: SessionLog | null = null;

/** Process wide log rooted at `$BOTD_HOME`. */
export function defaultSessionLog(): SessionLog {
  if (!sharedLog) sharedLog = new SessionLog();
  return sharedLog;
}

/** Append an event using the process wide log. */
export function append(sid: string, event: SessionEventInput): SessionEvent {
  return defaultSessionLog().append(sid, event);
}

/** Read events using the process wide log. */
export function read(sid: string, fromSeq?: number, limit?: number): SessionEvent[] {
  return defaultSessionLog().read(sid, fromSeq, limit);
}

/** Compact a session using the process wide log. */
export function compact(sid: string, ackedSeq: number): CompactResult {
  return defaultSessionLog().compact(sid, ackedSeq);
}

/** Summarize a session using the process wide log. */
export function stat(sid: string): SessionStat {
  return defaultSessionLog().stat(sid);
}
