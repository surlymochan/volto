// Tests for the botd session event log (append, read, rotate, compact,
// recover, redact). Fixtures are synthetic: no real hosts, tokens or names.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SessionLog, append, compact, read, stat } from "../src/session-log.ts";
import type { SessionEvent } from "../src/session-log.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const TMP_ROOT = path.join(REPO_ROOT, ".tmp", "session-log-test");

function tempHome(name: string): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TMP_ROOT, `${name}-`));
}

function seqs(events: SessionEvent[]): number[] {
  return events.map((event) => event.seq);
}

function sessionFile(home: string, name: string): string {
  return path.join(home, "sessions", name);
}

after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

test("append assigns increasing sequence numbers and read preserves order", () => {
  const home = tempHome("order");
  const log = new SessionLog({ home });
  const sid = "sess-order";

  for (let i = 0; i < 5; i += 1) log.append(sid, { type: "evt", payload: { i } });

  const all = log.read(sid);
  assert.equal(all.length, 5);
  assert.deepEqual(seqs(all), [1, 2, 3, 4, 5]);
  assert.deepEqual(
    all.map((event) => (event.payload as { i: number }).i),
    [0, 1, 2, 3, 4],
  );

  // One JSON object per line on disk.
  const raw = fs.readFileSync(sessionFile(home, `${sid}.ndjson`), "utf8");
  const lines = raw.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 5);
  for (const line of lines) assert.equal(typeof (JSON.parse(line) as { seq: number }).seq, "number");

  // Resume from a sequence and cap the result.
  assert.deepEqual(seqs(log.read(sid, 3)), [3, 4, 5]);
  assert.deepEqual(seqs(log.read(sid, 2, 2)), [2, 3]);
  assert.deepEqual(log.read(sid, 99), []);
  assert.deepEqual(log.read(sid, 1, 0), []);

  const summary = log.stat(sid);
  assert.equal(summary.events, 5);
  assert.equal(summary.segments, 1);
  assert.equal(summary.firstSeq, 1);
  assert.equal(summary.lastSeq, 5);
  assert.equal(summary.nextSeq, 6);

  // The segment index is plain JSON and is replaced atomically.
  log.flush(sid);
  const index = JSON.parse(fs.readFileSync(sessionFile(home, `${sid}.index.json`), "utf8")) as {
    version: number;
    nextSeq: number;
    segments: Array<{ name: string }>;
  };
  assert.equal(index.version, 1);
  assert.equal(index.nextSeq, 6);
  assert.deepEqual(
    index.segments.map((segment) => segment.name),
    [`${sid}.ndjson`],
  );

  // An unknown session is empty, not an error.
  const unknown = log.stat("sess-missing");
  assert.equal(unknown.exists, false);
  assert.equal(unknown.events, 0);
  assert.equal(unknown.segments, 0);
  assert.deepEqual(log.read("sess-missing"), []);

  log.close();
});

test("segments rotate on the size cap and retention keeps the newest ones", () => {
  const home = tempHome("rotate");
  const log = new SessionLog({ home, maxSegmentBytes: 1024, keepSegments: 3 });
  const sid = "sess-rotate";

  for (let i = 0; i < 200; i += 1) {
    log.append(sid, { type: "evt", payload: { i, filler: "x".repeat(64) } });
  }

  const summary = log.stat(sid);
  assert.ok(summary.segments <= 3, `expected at most 3 segments, got ${summary.segments}`);
  assert.ok(summary.segments >= 2, `expected a rotation, got ${summary.segments} segments`);
  assert.equal(summary.closedSegments, summary.segments - 1);

  const files = fs.readdirSync(path.join(home, "sessions")).filter((name) => name.startsWith(`${sid}.ndjson`));
  assert.equal(files.length, summary.segments, "one file per segment");
  assert.ok(files.includes(`${sid}.ndjson`), "the active segment keeps the plain name");

  // Retained events stay contiguous and ascending.
  const events = log.read(sid);
  assert.ok(events.length > 0);
  for (let i = 1; i < events.length; i += 1) {
    assert.equal(events[i].seq, events[i - 1].seq + 1);
  }
  assert.equal(events[events.length - 1].seq, 200);
  assert.ok(summary.firstSeq !== null && summary.firstSeq > 1, "old segments are dropped");

  log.close();
});

test("rotation keeps every event when retention is generous", () => {
  const home = tempHome("rotate-all");
  const log = new SessionLog({ home, maxSegmentBytes: 512, keepSegments: 100 });
  const sid = "sess-rotate-all";

  for (let i = 0; i < 100; i += 1) log.append(sid, { type: "evt", payload: { i } });

  const events = log.read(sid);
  assert.equal(events.length, 100);
  assert.equal(events[0].seq, 1);
  assert.equal(events[99].seq, 100);
  assert.ok(log.stat(sid).segments > 1, "the log really rotated");

  log.close();
});

test("compact drops fully acknowledged segments and keeps the rest", () => {
  const home = tempHome("compact");
  const log = new SessionLog({ home, maxSegmentBytes: 512, keepSegments: 50 });
  const sid = "sess-compact";

  for (let i = 0; i < 60; i += 1) log.append(sid, { type: "evt", payload: { i } });

  const before = log.stat(sid);
  assert.ok(before.closedSegments >= 2, `expected rotated segments, got ${before.closedSegments}`);

  const events = log.read(sid);
  const acked = events[20].seq;
  const result = log.compact(sid, acked);

  assert.ok(result.removedSegments >= 1, "compaction removed something");
  for (const name of result.removedFiles) {
    assert.equal(fs.existsSync(sessionFile(home, name)), false, `${name} is gone`);
  }

  const after = log.stat(sid);
  assert.equal(after.segments, before.segments - result.removedSegments);
  assert.ok(after.firstSeq !== null && after.firstSeq > 1, "the first segment was dropped");
  assert.equal(after.lastSeq, 60);

  // Nothing that is not acknowledged was lost.
  const kept = log.read(sid).filter((event) => event.seq > acked);
  assert.equal(kept.length, 60 - acked);
  assert.equal(kept[kept.length - 1].seq, 60);

  // Compacting again is a no-op.
  const second = log.compact(sid, acked);
  assert.equal(second.removedSegments, 0);

  // Appending after compaction continues the sequence.
  const appended = log.append(sid, { type: "evt", payload: { i: 60 } });
  assert.equal(appended.seq, 61);

  log.close();
});

test("a torn trailing line is truncated when the log is reopened", () => {
  const home = tempHome("torn");
  const sid = "sess-torn";
  const log = new SessionLog({ home });
  log.append(sid, { type: "evt", payload: { i: 1 } });
  log.append(sid, { type: "evt", payload: { i: 2 } });
  log.close();

  // Simulate a crash in the middle of a write.
  const active = sessionFile(home, `${sid}.ndjson`);
  fs.appendFileSync(active, '{"seq":99,"ts":1,"type":"evt","payl');

  const reopened = new SessionLog({ home });
  const events = reopened.read(sid);
  assert.equal(events.length, 2);
  assert.deepEqual(seqs(events), [1, 2]);

  const raw = fs.readFileSync(active, "utf8");
  assert.ok(raw.endsWith("\n"), "the torn line is gone");
  for (const line of raw.split("\n").filter((l) => l.length > 0)) {
    assert.equal(typeof (JSON.parse(line) as { seq: number }).seq, "number");
  }

  // The log keeps working after the repair.
  const appended = reopened.append(sid, { type: "evt", payload: { i: 3 } });
  assert.equal(appended.seq, 3);
  assert.deepEqual(seqs(reopened.read(sid)), [1, 2, 3]);

  reopened.close();
});

test("the redaction hook runs before an event is written", () => {
  const home = tempHome("redact");
  const log = new SessionLog({
    home,
    redact: (payload) => {
      const value = payload as { secret?: string; keep?: string };
      return { ...value, secret: value?.secret === undefined ? undefined : "[redacted]" };
    },
  });
  const sid = "sess-redact";
  log.append(sid, { type: "evt", payload: { secret: "s3cr3t-value", keep: "ok" } });

  const raw = fs.readFileSync(sessionFile(home, `${sid}.ndjson`), "utf8");
  assert.ok(!raw.includes("s3cr3t-value"), "the raw payload never reaches the disk");
  const events = log.read(sid);
  assert.deepEqual(events[0].payload, { secret: "[redacted]", keep: "ok" });

  log.close();
});

test("a failing redaction hook fails closed", () => {
  const home = tempHome("redact-throw");
  const log = new SessionLog({
    home,
    redact: () => {
      throw new Error("hook exploded");
    },
  });
  const sid = "sess-redact-throw";
  log.append(sid, { type: "evt", payload: { secret: "leaked-value" } });

  const raw = fs.readFileSync(sessionFile(home, `${sid}.ndjson`), "utf8");
  assert.ok(!raw.includes("leaked-value"), "the raw payload never reaches the disk");
  assert.equal(log.read(sid)[0].payload, null);

  log.close();
});

test("the log recovers when the segment index is missing or broken", () => {
  const home = tempHome("no-index");
  const sid = "sess-no-index";
  const log = new SessionLog({ home, maxSegmentBytes: 512, keepSegments: 50 });
  for (let i = 0; i < 40; i += 1) log.append(sid, { type: "evt", payload: { i } });
  log.close();

  const indexFile = sessionFile(home, `${sid}.index.json`);
  fs.rmSync(indexFile, { force: true });

  const reopened = new SessionLog({ home });
  const events = reopened.read(sid);
  assert.equal(events.length, 40);
  assert.deepEqual(
    seqs(events),
    Array.from({ length: 40 }, (_unused, i) => i + 1),
  );
  const appended = reopened.append(sid, { type: "evt", payload: { i: 40 } });
  assert.equal(appended.seq, 41);
  reopened.close();

  // A broken index is rebuilt from the segments as well.
  fs.writeFileSync(indexFile, "not json");
  const repaired = new SessionLog({ home });
  assert.equal(repaired.read(sid).length, 41);
  assert.equal(repaired.append(sid, { type: "evt", payload: { i: 41 } }).seq, 42);
  repaired.close();
});

test("a stale segment index does not duplicate sequence numbers", () => {
  const home = tempHome("stale-index");
  const sid = "sess-stale";
  const log = new SessionLog({ home });
  for (let i = 0; i < 5; i += 1) log.append(sid, { type: "evt", payload: { i } });
  log.close();

  // Pretend the index only knows about the first event.
  const indexFile = sessionFile(home, `${sid}.index.json`);
  const index = JSON.parse(fs.readFileSync(indexFile, "utf8")) as {
    nextSeq: number;
    segments: Array<{ seqTo: number | null }>;
  };
  index.nextSeq = 2;
  index.segments[0].seqTo = 1;
  fs.writeFileSync(indexFile, JSON.stringify(index));

  const reopened = new SessionLog({ home });
  assert.deepEqual(seqs(reopened.read(sid)), [1, 2, 3, 4, 5]);
  const appended = reopened.append(sid, { type: "evt", payload: { i: 5 } });
  assert.equal(appended.seq, 6);
  reopened.close();
});

test("the process wide helpers write below BOTD_HOME", () => {
  const home = tempHome("default-log");
  const previous = process.env.BOTD_HOME;
  process.env.BOTD_HOME = home;
  try {
    const record = append("sess-default", { type: "evt", payload: { i: 1 } });
    assert.equal(record.seq, 1);
    assert.equal(read("sess-default").length, 1);
    assert.equal(stat("sess-default").events, 1);
    assert.equal(compact("sess-default", 1).removedSegments, 0);
    assert.ok(fs.existsSync(path.join(home, "sessions", "sess-default.ndjson")));
  } finally {
    if (previous === undefined) delete process.env.BOTD_HOME;
    else process.env.BOTD_HOME = previous;
  }
});

test("50k appends stay under five seconds", () => {
  const home = tempHome("perf");
  const log = new SessionLog({ home });
  const sid = "sess-perf";

  const start = process.hrtime.bigint();
  for (let i = 0; i < 50_000; i += 1) log.append(sid, { type: "evt", payload: { i } });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  assert.equal(log.stat(sid).events, 50_000);
  assert.equal(log.read(sid, 50_000).length, 1);
  assert.ok(elapsedMs < 5000, `50k appends took ${elapsedMs.toFixed(0)} ms`);

  log.close();
});
