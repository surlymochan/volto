import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_KEEP_SEGMENTS,
  DEFAULT_MAX_SEGMENT_BYTES,
  SessionLog,
  append,
  compact,
  defaultSessionLog,
  read,
} from "../src/session-log.ts";

const root = path.resolve(import.meta.dirname, "..", "..", ".tmp", "session-log-defaults-test");
fs.mkdirSync(root, { recursive: true });
const home = fs.mkdtempSync(path.join(root, "home-"));
const previousHome = process.env.BOTD_HOME;
process.env.BOTD_HOME = home;

after(() => {
  defaultSessionLog().close();
  if (previousHome === undefined) delete process.env.BOTD_HOME;
  else process.env.BOTD_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

test("a log without options uses the 8 MiB segment default", () => {
  assert.equal(DEFAULT_MAX_SEGMENT_BYTES, 8 * 1024 * 1024);
  assert.equal(new SessionLog().maxSegmentBytes, DEFAULT_MAX_SEGMENT_BYTES);
});

test("a log without options keeps four segments by default", () => {
  assert.equal(DEFAULT_KEEP_SEGMENTS, 4);
  assert.equal(new SessionLog().keepSegments, DEFAULT_KEEP_SEGMENTS);
});

test("segment sizes below one are clamped to one", () => {
  for (const value of [0, -10, 0.5]) {
    assert.equal(new SessionLog({ maxSegmentBytes: value }).maxSegmentBytes, 1);
  }
});

test("retention values below one are clamped to one", () => {
  for (const value of [0, -10, 0.5]) {
    assert.equal(new SessionLog({ keepSegments: value }).keepSegments, 1);
  }
});

test("defaultSessionLog returns the same instance rooted at BOTD_HOME", () => {
  const log = defaultSessionLog();
  assert.equal(log.home, home);
  assert.strictEqual(defaultSessionLog(), log);
});

test("append delegates its arguments and result to the default log", (t) => {
  const log = defaultSessionLog();
  const record = { seq: 7, ts: 123, type: "evt", payload: { value: 1 } };
  const method = t.mock.method(log, "append", () => record);
  const event = { type: "evt", payload: { value: 1 }, ts: 123 };
  assert.strictEqual(append("append-case", event), record);
  assert.equal(method.mock.callCount(), 1);
  assert.deepEqual(method.mock.calls[0].arguments, ["append-case", event]);
});

test("read delegates its arguments and result to the default log", (t) => {
  const log = defaultSessionLog();
  const events = [{ seq: 2, ts: 123, type: "evt", payload: null }];
  const method = t.mock.method(log, "read", () => events);
  assert.strictEqual(read("read-case", 2, 1), events);
  assert.equal(method.mock.callCount(), 1);
  assert.deepEqual(method.mock.calls[0].arguments, ["read-case", 2, 1]);
});

test("compact delegates its arguments and result to the default log", (t) => {
  const log = defaultSessionLog();
  const result = { sid: "compact-case", removedSegments: 1, removedFiles: ["segment"], firstSeq: 2, lastSeq: 3 };
  const method = t.mock.method(log, "compact", () => result);
  assert.strictEqual(compact("compact-case", 1), result);
  assert.equal(method.mock.callCount(), 1);
  assert.deepEqual(method.mock.calls[0].arguments, ["compact-case", 1]);
});
