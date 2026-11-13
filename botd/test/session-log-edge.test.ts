import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SessionLog } from "../src/session-log.ts";

const root = path.resolve(import.meta.dirname, "..", "..", ".tmp", "session-log-edge-test");
function tempHome(): string {
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, "home-"));
}
after(() => fs.rmSync(root, { recursive: true, force: true }));

for (const [label, sid] of [
  ["parent traversal", "../escape"], ["slash", "a/b"], ["backslash", "a\\b"],
  ["NUL", "a\0b"], ["empty", ""], ["long", "a".repeat(1000)],
]) {
  test(`session id with ${label} stays inside sessions`, () => {
    const home = tempHome();
    const log = new SessionLog({ home });
    if (sid === "") {
      for (const operation of [() => log.append(sid, { type: "evt", payload: 1 }),
        () => log.read(sid), () => log.read(sid, 1, 0), () => log.compact(sid, 0), () => log.stat(sid)]) {
        assert.throws(operation, /session id/i);
      }
    } else {
      log.append(sid, { type: "evt", payload: 1 });
      assert.equal(log.read(sid)[0].payload, 1);
      log.compact(sid, 0);
      const stat = log.stat(sid);
      for (const file of [stat.activeFile, stat.indexFile]) {
        assert.equal(path.dirname(file), path.join(home, "sessions"));
        assert.ok(fs.existsSync(file));
      }
    }
    log.close();
    if (sid !== "") {
      const reopened = new SessionLog({ home });
      assert.equal(reopened.read(sid)[0].payload, 1);
      reopened.close();
    }
    assert.deepEqual(fs.readdirSync(home), sid === "" ? [] : ["sessions"]);
  });
}

test("unicode payload round trips byte-exact across read chunks and restart", () => {
  const home = tempHome();
  const payload = "a".repeat(65500) + "你好 🧑🏽‍💻 café e\u0301\n";
  const log = new SessionLog({ home });
  log.append("unicode", { type: "evt", payload });
  log.close();
  const reopened = new SessionLog({ home });
  assert.deepEqual(Buffer.from(reopened.read("unicode")[0].payload as string), Buffer.from(payload));
  reopened.close();
});

test("an oversized payload occupies a whole segment", () => {
  const home = tempHome();
  const log = new SessionLog({ home, maxSegmentBytes: 100, keepSegments: 10 });
  const payload = "x".repeat(500);
  log.append("large", { type: "evt", payload: "before" });
  log.append("large", { type: "evt", payload });
  log.append("large", { type: "evt", payload: "after" });
  assert.deepEqual(log.read("large").map((e) => e.payload), ["before", payload, "after"]);
  const files = fs.readdirSync(path.join(home, "sessions")).filter((name) => name.includes(".ndjson"));
  assert.equal(files.length, 3);
  assert.ok(files.some((name) => {
    const lines = fs.readFileSync(path.join(home, "sessions", name), "utf8").trim().split("\n");
    return lines.length === 1 && JSON.parse(lines[0]).payload === payload;
  }));
  log.close();
});

for (const [label, from, limit, expected] of [
  ["zero start", 0, 10, [1, 2, 3]], ["beyond last", 4, 10, []],
  ["zero limit", 1, 0, []], ["negative limit", 1, -1, []], ["bounded", 2, 1, [2]],
] as const) {
  test(`read boundaries: ${label}`, () => {
    const log = new SessionLog({ home: tempHome() });
    for (let i = 0; i < 3; i += 1) log.append("read", { type: "evt", payload: i });
    assert.deepEqual(log.read("read", from, limit).map((e) => e.seq), expected);
    log.close();
  });
}

test("interleaved sessions have independent sequences", () => {
  const log = new SessionLog({ home: tempHome() });
  assert.equal(log.append("a", { type: "evt", payload: 1 }).seq, 1);
  assert.equal(log.append("b", { type: "evt", payload: 2 }).seq, 1);
  assert.equal(log.append("a", { type: "evt", payload: 3 }).seq, 2);
  assert.deepEqual(log.read("b").map((e) => e.payload), [2]);
  assert.deepEqual(log.read("a").map((e) => e.payload), [1, 3]);
  log.close();
});

test("a new instance continues sequences after restart", () => {
  const home = tempHome();
  const first = new SessionLog({ home });
  first.append("restart", { type: "evt", payload: 1 });
  first.append("restart", { type: "evt", payload: 2 });
  first.close();
  const second = new SessionLog({ home });
  assert.equal(second.append("restart", { type: "evt", payload: 3 }).seq, 3);
  assert.deepEqual(second.read("restart").map((e) => e.seq), [1, 2, 3]);
  second.close();
});

const circular: { self?: unknown } = {};
circular.self = circular;
for (const [label, payload] of [["undefined", undefined], ["BigInt", 1n], ["circular", circular]] as const) {
  test(`${label} payload fails without corrupting the log`, () => {
    const home = tempHome();
    const log = new SessionLog({ home });
    log.append("invalid", { type: "evt", payload: "before" });
    assert.throws(() => log.append("invalid", { type: "evt", payload }), /payload.*JSON/i);
    assert.equal(log.append("invalid", { type: "evt", payload: "after" }).seq, 2);
    log.close();
    const reopened = new SessionLog({ home });
    assert.deepEqual(reopened.read("invalid").map((e) => e.payload), ["before", "after"]);
    reopened.close();
  });
}
