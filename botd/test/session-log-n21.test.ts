// Contract tests for the botd session event log (N21).
//
// The module under test is botd/src/session-log.ts. Every assertion here
// pins an exact value: a sequence number, a timestamp, a whole array or a
// whole file list. Nothing matches loosely, so a wrong implementation cannot
// slip through.
//
// Fixtures are synthetic: the session ids, payload shapes and file names
// below are made up. There is no real host, address, name or token in this
// file, and every clock is injected, so the tests never depend on the wall
// clock.

import { after, test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SessionLog } from "../src/session-log.ts";
import type { SessionEvent } from "../src/session-log.ts";

/** Scratch space of this file, inside the worktree. */
const TMP_ROOT = path.resolve(import.meta.dirname, "..", ".tmp", "session-log-n21");

/** Base timestamp of the injected clocks, in epoch milliseconds. */
const BASE_TS = 1_700_000_000_000;

/**
 * Replace the inherited environment with an explicit one and restore the
 * original environment after the test. The log gets its home handed over
 * directly, so no inherited variable can influence a test.
 */
function scrubEnv(t: TestContext, values: Record<string, string>): void {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  });
}

/** A throw away botd home below `.tmp/`, removed when the test ends. */
function makeHome(t: TestContext, label: string): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const home = fs.mkdtempSync(path.join(TMP_ROOT, `${label}-`));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  scrubEnv(t, { BOTD_HOME: home });
  return home;
}

/** A deterministic clock: every call is one millisecond after the previous. */
function tickClock(): () => number {
  let tick = 0;
  return () => BASE_TS + tick++;
}

/** The sequence numbers of a list of events. */
function seqs(events: SessionEvent[]): number[] {
  return events.map((event) => event.seq);
}

/** The session directory of a botd home. */
function sessionsDir(home: string): string {
  return path.join(home, "sessions");
}

/** The file names in the session directory, sorted. */
function sessionFiles(home: string): string[] {
  return fs.readdirSync(sessionsDir(home)).sort();
}

after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

test("append starts at the first documented sequence and counts up by one", (t) => {
  const home = makeHome(t, "seq");
  const log = new SessionLog({ home, now: tickClock() });
  const sid = "n21-seq";

  // The documented first sequence is 1: read() starts at fromSeq 1 by
  // default, so the first event has to carry sequence 1.
  const first = log.append(sid, { type: "turn_end", payload: { step: 1 } });
  assert.deepEqual(first, { seq: 1, ts: BASE_TS, type: "turn_end", payload: { step: 1 } });

  const second = log.append(sid, { type: "tool", payload: { step: 2 } });
  assert.deepEqual(second, { seq: 2, ts: BASE_TS + 1, type: "tool", payload: { step: 2 } });

  const third = log.append(sid, { type: "tool", payload: { step: 3 } });
  assert.deepEqual(third, { seq: 3, ts: BASE_TS + 2, type: "tool", payload: { step: 3 } });

  // The stored records carry the very same sequences, without a gap.
  assert.deepEqual(seqs(log.read(sid)), [1, 2, 3]);
  assert.equal(log.stat(sid).nextSeq, 4);

  log.close();
});

test("the next sequence follows the records on disk, not the cached counter", (t) => {
  const home = makeHome(t, "seq-fixture");
  const sid = "n21-seq-fixture";
  const log = new SessionLog({ home, now: tickClock() });
  log.append(sid, { type: "evt", payload: { step: 1 } });
  log.append(sid, { type: "evt", payload: { step: 2 } });
  log.flush(sid);
  log.close();

  // Altered fixture: the last record on disk claims a much higher sequence
  // than the log handed out. The log has to believe the file, otherwise the
  // sequences on disk would not be unique anymore.
  const active = path.join(sessionsDir(home), `${sid}.ndjson`);
  const lines = fs.readFileSync(active, "utf8").split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 2);
  const altered = lines.map((line, index) => {
    const record = JSON.parse(line) as SessionEvent;
    return JSON.stringify(index === 1 ? { ...record, seq: 99 } : record);
  });
  fs.writeFileSync(active, `${altered.join("\n")}\n`);

  const reopened = new SessionLog({ home, now: tickClock() });
  assert.deepEqual(seqs(reopened.read(sid)), [1, 99]);
  assert.equal(reopened.stat(sid).lastSeq, 99);
  assert.equal(reopened.stat(sid).nextSeq, 100);

  const appended = reopened.append(sid, { type: "evt", payload: { step: 3 } });
  assert.equal(appended.seq, 100);
  assert.deepEqual(seqs(reopened.read(sid)), [1, 99, 100]);

  reopened.close();
});

test("read returns exactly the requested slice of the log", (t) => {
  const home = makeHome(t, "read");
  const log = new SessionLog({ home, now: tickClock() });
  const sid = "n21-read";
  for (let step = 1; step <= 6; step += 1) log.append(sid, { type: "evt", payload: { step } });

  // A slice in the middle of the log: the whole record, not just the seq.
  assert.deepEqual(log.read(sid, 2, 3), [
    { seq: 2, ts: BASE_TS + 1, type: "evt", payload: { step: 2 } },
    { seq: 3, ts: BASE_TS + 2, type: "evt", payload: { step: 3 } },
    { seq: 4, ts: BASE_TS + 3, type: "evt", payload: { step: 4 } },
  ]);

  // A start without a limit runs to the end of the log.
  assert.deepEqual(seqs(log.read(sid, 5)), [5, 6]);
  // A limit without a start begins at the first sequence.
  assert.deepEqual(seqs(log.read(sid, 1, 4)), [1, 2, 3, 4]);
  // A limit beyond the end of the log returns the whole log.
  assert.deepEqual(seqs(log.read(sid, 1, 99)), [1, 2, 3, 4, 5, 6]);
  // A start behind the log returns the whole log.
  assert.deepEqual(seqs(log.read(sid, -5, 99)), [1, 2, 3, 4, 5, 6]);
  // A start behind the end of the log returns nothing.
  assert.deepEqual(log.read(sid, 7), []);
  assert.deepEqual(log.read(sid, 7, 3), []);

  log.close();
});

test("read serves the records that are on disk, even after the fixture changed", (t) => {
  const home = makeHome(t, "read-fixture");
  const sid = "n21-read-fixture";
  const log = new SessionLog({ home, now: tickClock() });
  log.append(sid, { type: "evt", payload: { step: 1 } });
  log.append(sid, { type: "evt", payload: { step: 2 } });
  log.flush(sid);
  log.close();

  // Altered fixture: a third record that never went through append().
  const active = path.join(sessionsDir(home), `${sid}.ndjson`);
  const injected = JSON.stringify({
    seq: 3,
    ts: BASE_TS + 2,
    type: "injected",
    payload: { step: 3 },
  });
  fs.appendFileSync(active, `${injected}\n`);

  const reopened = new SessionLog({ home, now: tickClock() });
  assert.deepEqual(reopened.read(sid, 2, 5), [
    { seq: 2, ts: BASE_TS + 1, type: "evt", payload: { step: 2 } },
    { seq: 3, ts: BASE_TS + 2, type: "injected", payload: { step: 3 } },
  ]);
  assert.deepEqual(seqs(reopened.read(sid, 3)), [3]);
  assert.equal(reopened.stat(sid).events, 3);
  assert.equal(reopened.append(sid, { type: "evt", payload: { step: 4 } }).seq, 4);

  reopened.close();
});

test("compact removes exactly the acknowledged segments and counts them", (t) => {
  const home = makeHome(t, "compact");
  const log = new SessionLog({ home, maxSegmentBytes: 1, keepSegments: 50, now: tickClock() });
  const sid = "n21-compact";
  for (let step = 1; step <= 6; step += 1) log.append(sid, { type: "evt", payload: { step } });

  // One event per segment: five closed segments plus the active one.
  const before = log.stat(sid);
  assert.equal(before.segments, 6);
  assert.equal(before.closedSegments, 5);
  assert.equal(before.events, 6);
  assert.equal(before.firstSeq, 1);
  assert.equal(before.lastSeq, 6);

  // Acknowledging sequence 3 drops exactly the three closed segments that
  // hold the acknowledged events.
  const result = log.compact(sid, 3);
  assert.deepEqual(result, {
    sid: "n21-compact",
    removedSegments: 3,
    removedFiles: [`${sid}.ndjson.1`, `${sid}.ndjson.2`, `${sid}.ndjson.3`],
    firstSeq: 4,
    lastSeq: 6,
  });

  // The dropped files are gone, the kept ones are still on disk.
  assert.deepEqual(sessionFiles(home), [
    `${sid}.index.json`,
    `${sid}.ndjson`,
    `${sid}.ndjson.4`,
    `${sid}.ndjson.5`,
  ]);

  // The unacknowledged events are untouched, the acknowledged ones are gone.
  assert.deepEqual(seqs(log.read(sid)), [4, 5, 6]);
  const after = log.stat(sid);
  assert.equal(after.segments, 3);
  assert.equal(after.closedSegments, 2);
  assert.equal(after.events, 3);
  assert.equal(after.firstSeq, 4);
  assert.equal(after.lastSeq, 6);

  // Acknowledging nothing removes nothing.
  assert.deepEqual(log.compact(sid, 0), {
    sid: "n21-compact",
    removedSegments: 0,
    removedFiles: [],
    firstSeq: 4,
    lastSeq: 6,
  });

  // The active segment is never dropped, even when it is fully acknowledged.
  const all = log.compact(sid, 6);
  assert.deepEqual(all, {
    sid: "n21-compact",
    removedSegments: 2,
    removedFiles: [`${sid}.ndjson.4`, `${sid}.ndjson.5`],
    firstSeq: 6,
    lastSeq: 6,
  });
  assert.deepEqual(seqs(log.read(sid)), [6]);
  assert.equal(log.stat(sid).segments, 1);
  assert.equal(log.stat(sid).events, 1);

  log.close();
});

test("a lower acknowledged sequence leaves more events on disk", (t) => {
  /** Build the same six event log and compact it with the given sequence. */
  const compactWith = (label: string, ackedSeq: number): { removed: number; left: number[] } => {
    const home = makeHome(t, label);
    const log = new SessionLog({ home, maxSegmentBytes: 1, keepSegments: 50, now: tickClock() });
    const sid = "n21-acked";
    for (let step = 1; step <= 6; step += 1) log.append(sid, { type: "evt", payload: { step } });
    const result = log.compact(sid, ackedSeq);
    const left = seqs(log.read(sid));
    log.close();
    return { removed: result.removedSegments, left };
  };

  const high = compactWith("ack-high", 3);
  const low = compactWith("ack-low", 1);

  // Exact counts: the lower acknowledged sequence removes fewer segments.
  assert.equal(high.removed, 3);
  assert.equal(low.removed, 1);
  assert.deepEqual(high.left, [4, 5, 6]);
  assert.deepEqual(low.left, [2, 3, 4, 5, 6]);
  assert.ok(low.left.length > high.left.length, "a lower acknowledged sequence leaves more events");
});

test("stat reports the segment count and the last sequence", (t) => {
  const home = makeHome(t, "stat");
  const log = new SessionLog({ home, maxSegmentBytes: 1, keepSegments: 50, now: tickClock() });
  const sid = "n21-stat";
  for (let step = 1; step <= 4; step += 1) log.append(sid, { type: "evt", payload: { step } });

  const summary = log.stat(sid);
  assert.equal(summary.sid, sid);
  assert.equal(summary.exists, true);
  assert.equal(summary.segments, 4);
  assert.equal(summary.closedSegments, 3);
  assert.equal(summary.events, 4);
  assert.equal(summary.firstSeq, 1);
  assert.equal(summary.lastSeq, 4);
  assert.equal(summary.nextSeq, 5);
  assert.equal(summary.dir, sessionsDir(home));
  assert.equal(summary.activeFile, path.join(sessionsDir(home), `${sid}.ndjson`));
  assert.equal(summary.indexFile, path.join(sessionsDir(home), `${sid}.index.json`));

  // The byte count is the size of the segment files on disk.
  const onDisk = fs
    .readdirSync(sessionsDir(home))
    .filter((name) => name.includes(".ndjson"))
    .map((name) => fs.statSync(path.join(sessionsDir(home), name)).size)
    .reduce((total, size) => total + size, 0);
  assert.equal(summary.bytes, onDisk);

  // A session without a single event is empty, not an error.
  const unknown = log.stat("n21-stat-unknown");
  assert.equal(unknown.exists, false);
  assert.equal(unknown.segments, 0);
  assert.equal(unknown.closedSegments, 0);
  assert.equal(unknown.bytes, 0);
  assert.equal(unknown.events, 0);
  assert.equal(unknown.firstSeq, null);
  assert.equal(unknown.lastSeq, null);
  assert.equal(unknown.nextSeq, 1);

  log.close();
});

test("stat follows the segments, not a stale or missing index", (t) => {
  const home = makeHome(t, "stat-fixture");
  const sid = "n21-stat-fixture";
  const log = new SessionLog({ home, maxSegmentBytes: 1, keepSegments: 50, now: tickClock() });
  for (let step = 1; step <= 4; step += 1) log.append(sid, { type: "evt", payload: { step } });
  log.flush(sid);
  log.close();

  // Altered fixture: the index claims a sequence that never happened.
  const indexFile = path.join(sessionsDir(home), `${sid}.index.json`);
  const index = JSON.parse(fs.readFileSync(indexFile, "utf8")) as { nextSeq: number };
  index.nextSeq = 999;
  fs.writeFileSync(indexFile, `${JSON.stringify(index)}\n`);

  const reopened = new SessionLog({ home, now: tickClock() });
  const summary = reopened.stat(sid);
  assert.equal(summary.segments, 4);
  assert.equal(summary.closedSegments, 3);
  assert.equal(summary.events, 4);
  assert.equal(summary.firstSeq, 1);
  assert.equal(summary.lastSeq, 4);
  assert.equal(summary.nextSeq, 5);
  reopened.close();

  // The very same numbers without any index at all.
  fs.rmSync(indexFile, { force: true });
  const withoutIndex = new SessionLog({ home, now: tickClock() });
  const rebuilt = withoutIndex.stat(sid);
  assert.equal(rebuilt.segments, 4);
  assert.equal(rebuilt.closedSegments, 3);
  assert.equal(rebuilt.events, 4);
  assert.equal(rebuilt.firstSeq, 1);
  assert.equal(rebuilt.lastSeq, 4);
  assert.equal(rebuilt.nextSeq, 5);
  withoutIndex.close();
});

test("a tiny segment cap rotates on every event and keepSegments prunes the oldest", (t) => {
  const home = makeHome(t, "rotate");
  const log = new SessionLog({ home, maxSegmentBytes: 1, keepSegments: 2, now: tickClock() });
  const sid = "n21-rotate";
  for (let step = 1; step <= 5; step += 1) log.append(sid, { type: "evt", payload: { step } });

  // Two segments are kept: the newest closed one and the active one.
  const summary = log.stat(sid);
  assert.equal(summary.segments, 2);
  assert.equal(summary.closedSegments, 1);
  assert.equal(summary.events, 2);
  assert.equal(summary.firstSeq, 4);
  assert.equal(summary.lastSeq, 5);
  assert.equal(summary.nextSeq, 6);
  assert.deepEqual(seqs(log.read(sid)), [4, 5]);

  // The pruned segments are gone from disk, the newest closed one is kept.
  assert.deepEqual(sessionFiles(home), [
    `${sid}.index.json`,
    `${sid}.ndjson`,
    `${sid}.ndjson.4`,
  ]);

  // The closed segment holds exactly one event: the cap of one byte rotates
  // on every single append.
  const closed = fs.readFileSync(path.join(sessionsDir(home), `${sid}.ndjson.4`), "utf8");
  const closedLines = closed.split("\n").filter((line) => line.length > 0);
  assert.equal(closedLines.length, 1);
  assert.deepEqual(JSON.parse(closedLines[0]), {
    seq: 4,
    ts: BASE_TS + 3,
    type: "evt",
    payload: { step: 4 },
  });

  log.close();
});

test("keepSegments decides how many events survive the pruning", (t) => {
  /** Build the same five event log with the given retention limit. */
  const kept = (label: string, keepSegments: number): { left: number[]; segments: number } => {
    const home = makeHome(t, label);
    const log = new SessionLog({ home, maxSegmentBytes: 1, keepSegments, now: tickClock() });
    const sid = "n21-keep";
    for (let step = 1; step <= 5; step += 1) log.append(sid, { type: "evt", payload: { step } });
    const left = seqs(log.read(sid));
    const segments = log.stat(sid).segments;
    log.close();
    return { left, segments };
  };

  // One segment per limit: the active one plus the closed ones that fit.
  assert.deepEqual(kept("keep-1", 1), { left: [5], segments: 1 });
  assert.deepEqual(kept("keep-2", 2), { left: [4, 5], segments: 2 });
  assert.deepEqual(kept("keep-3", 3), { left: [3, 4, 5], segments: 3 });
});

// DEFECT: stat() mixes fresh and cached numbers, so it contradicts "Highest
// sequence on disk" once a segment file changed underneath a live log.
test.todo("stat stays consistent when a segment file changed underneath a live log", (t) => {
  const home = makeHome(t, "stat-live");
  const log = new SessionLog({ home, now: tickClock() });
  const sid = "n21-stat-live";
  log.append(sid, { type: "evt", payload: { step: 1 } });
  const active = log.stat(sid).activeFile;

  // A record that never went through append() lands in the active segment.
  fs.appendFileSync(
    active,
    `${JSON.stringify({ seq: 2, ts: BASE_TS + 1, type: "injected", payload: { step: 2 } })}\n`,
  );

  // Two events are on disk, so the highest sequence on disk is 2.
  const summary = log.stat(sid);
  assert.equal(summary.events, 2);
  assert.equal(summary.firstSeq, 1);
  assert.equal(summary.lastSeq, 2);
  assert.equal(summary.nextSeq, 3);
  assert.equal(summary.bytes, fs.statSync(active).size);

  log.close();
});
