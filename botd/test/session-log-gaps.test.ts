import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SessionLog } from "../src/session-log.ts";

function tempHome(t: import("node:test").TestContext): string {
  fs.mkdirSync(".tmp", { recursive: true });
  const home = fs.mkdtempSync(path.join(".tmp", "t-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function record(seq: number): string {
  return JSON.stringify({ seq, ts: 1, type: "evt", payload: seq });
}

test("recovery sorts numbered segments and ignores unrelated files", (t) => {
  const home = tempHome(t);
  const dir = path.join(home, "sessions");
  fs.mkdirSync(dir);
  for (const [name, contents] of [
    ["a.b.ndjson.10", `${record(2)}\n`],
    ["a.b.ndjson.2", `${record(1)}\n`],
    ["a.b.ndjson", `${record(3)}\n`],
    ["axb.ndjson.1", `${record(99)}\n`],
    ["a.b.ndjson.bak", `${record(100)}\n`],
  ]) fs.writeFileSync(path.join(dir, name), contents);
  const log = new SessionLog({ home, maxSegmentBytes: 1, keepSegments: 3 });
  assert.deepEqual(log.read("a.b").map((event) => event.seq), [1, 2, 3]);
  assert.equal(log.append("a.b", { type: "evt" }).seq, 4);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith("a.b.ndjson")).sort(),
    ["a.b.ndjson", "a.b.ndjson.10", "a.b.ndjson.11", "a.b.ndjson.bak"].sort());
  log.close();
});

test("recovery discards a whole torn segment and skips complete malformed lines", (t) => {
  const home = tempHome(t);
  const dir = path.join(home, "sessions");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "empty.ndjson"), '{"seq":');
  fs.writeFileSync(path.join(dir, "bad.ndjson"), `\nnot-json\n${record(2)}\n{"seq":"3"}\n`);
  const log = new SessionLog({ home });
  assert.deepEqual(log.read("empty"), []);
  assert.equal(fs.readFileSync(path.join(dir, "empty.ndjson"), "utf8"), "");
  assert.equal(log.append("empty", { type: "evt" }).seq, 1);
  assert.deepEqual(log.read("bad").map((event) => event.seq), [2]);
  log.close();
});

test("flush and close can target all sessions or a single session", (t) => {
  const home = tempHome(t);
  const log = new SessionLog({ home });
  log.append("a", { type: "evt" });
  log.append("b", { type: "evt" });
  log.flush();
  log.close("missing");
  log.close("a");
  assert.equal(log.append("a", { type: "evt" }).seq, 2);
  log.close();
  const reopened = new SessionLog({ home });
  assert.deepEqual(reopened.read("a").map((event) => event.seq), [1, 2]);
  assert.deepEqual(reopened.read("b").map((event) => event.seq), [1]);
  reopened.close();
});

test("an unreadable directory or vanished segment is tolerated", (t) => {
  const home = tempHome(t);
  const dir = path.join(home, "sessions");
  fs.mkdirSync(dir);
  const file = path.join(dir, "gone.ndjson");
  fs.writeFileSync(file, `${record(1)}\n`);
  const readdir = fs.readdirSync;
  const stat = fs.statSync;
  let hideDirectory = true;
  t.mock.method(fs, "readdirSync", ((p: fs.PathLike, ...args: unknown[]) => {
    if (String(p) === dir && hideDirectory) throw new Error("synthetic readdir failure");
    return (readdir as Function)(p, ...args);
  }) as typeof fs.readdirSync);
  t.mock.method(fs, "statSync", ((p: fs.PathLike, ...args: unknown[]) => {
    if (String(p) === file) throw new Error("synthetic stat failure");
    return (stat as Function)(p, ...args);
  }) as typeof fs.statSync);
  const log = new SessionLog({ home });
  assert.deepEqual(log.read("other"), []);
  hideDirectory = false;
  assert.deepEqual(log.read("gone").map((event) => event.seq), [1]);
  log.close();
});

test("missing segment during reads and close errors are tolerated", (t) => {
  const home = tempHome(t);
  const log = new SessionLog({ home });
  log.append("a", { type: "evt" });
  const file = log.stat("a").activeFile;
  fs.unlinkSync(file);
  assert.deepEqual(log.read("a"), []);
  assert.equal(log.stat("a").events, 0);
  const close = fs.closeSync;
  t.mock.method(fs, "closeSync", ((fd: number) => {
    close(fd);
    throw new Error("synthetic close failure");
  }) as typeof fs.closeSync);
  assert.doesNotThrow(() => log.close("a"));
});

test("index replacement failures leave the segment readable and clean up temporary files", (t) => {
  const home = tempHome(t);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).endsWith(".index.json")) throw new Error("synthetic rename failure");
    return rename(from, to);
  }) as typeof fs.renameSync);
  const log = new SessionLog({ home });
  assert.equal(log.append("a", { type: "evt" }).seq, 1);
  log.flush();
  assert.deepEqual(log.read("a").map((event) => event.seq), [1]);
  assert.deepEqual(fs.readdirSync(path.join(home, "sessions")), ["a.ndjson"]);
  log.close();
  const reopened = new SessionLog({ home });
  assert.equal(reopened.append("a", { type: "evt" }).seq, 2);
  reopened.close();
});

test("index write failure with no temporary file is tolerated", (t) => {
  const home = tempHome(t);
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(file).includes(".index.json.tmp-")) throw new Error("synthetic write failure");
    return (write as Function)(file, ...args);
  }) as typeof fs.writeFileSync);
  const log = new SessionLog({ home });
  assert.equal(log.append("a", { type: "evt" }).seq, 1);
  assert.deepEqual(log.read("a").map((event) => event.seq), [1]);
  assert.doesNotThrow(() => log.close());
});

test("a segment that disappears between recovery stat calls does not prevent reading", (t) => {
  const home = tempHome(t);
  const dir = path.join(home, "sessions");
  fs.mkdirSync(dir);
  const file = path.join(dir, "a.ndjson");
  fs.writeFileSync(file, `${record(1)}\n`);
  const stat = fs.statSync;
  let calls = 0;
  t.mock.method(fs, "statSync", ((p: fs.PathLike, ...args: unknown[]) => {
    if (String(p) === file && ++calls === 2) throw new Error("synthetic stat failure");
    return (stat as Function)(p, ...args);
  }) as typeof fs.statSync);
  const log = new SessionLog({ home });
  assert.deepEqual(log.read("a").map((event) => event.seq), [1]);
  log.close();
});

test("rotation uses known segment numbers if directory listing fails", (t) => {
  const home = tempHome(t);
  const log = new SessionLog({ home, maxSegmentBytes: 1, keepSegments: 3 });
  log.append("a", { type: "evt" });
  const readdir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", ((p: fs.PathLike, ...args: unknown[]) => {
    if (String(p) === path.join(home, "sessions")) throw new Error("synthetic readdir failure");
    return (readdir as Function)(p, ...args);
  }) as typeof fs.readdirSync);
  assert.equal(log.append("a", { type: "evt" }).seq, 2);
  assert.deepEqual(log.read("a").map((event) => event.seq), [1, 2]);
  log.close();
});
