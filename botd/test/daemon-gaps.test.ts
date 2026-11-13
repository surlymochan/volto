import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Botd } from "../src/daemon.ts";
import { Session } from "../src/session.ts";
import { makeTempDir, startHarness, TestClient } from "./helpers.ts";

const bot = { kind: "acp" as const, command: ["synthetic"] };

test("handles session requests and snapshots with an in-memory child", async (t) => {
  const children: Array<{ exitCode: number | null; signalCode: NodeJS.Signals | null; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }> = [];
  t.mock.method(Session.prototype, "start", function (this: Session) {
    const child = { exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
    children.push(child);
    this.child = child as unknown as Session["child"];
    this.setState("running");
  });
  t.mock.method(Session.prototype, "terminate", function () {});
  t.mock.method(Session.prototype, "requestCancel", function (this: Session) {
    this.cancelling = true;
  });
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());
  await client.hello();
  for (const frame of [
    { op: "send", sid: "missing", payload: {} },
    { op: "ack", sid: "missing", seq: 1 },
    { op: "close", sid: "missing" },
  ]) {
    const mark = client.mark();
    client.send(frame);
    assert.deepEqual(client.sinceMark(mark).map((f) => f.op === "error" && [f.code, f.sid]), [["unknown_session", "missing"]]);
  }
  client.send({ op: "open", sid: "s1", bot });
  assert.equal(daemon.listSessions()[0].state, "running");
  assert.equal(daemon.sessionStatus("missing"), undefined);
  const mark = client.mark();
  client.send({ op: "open", sid: "s1", bot });
  assert.deepEqual(client.sinceMark(mark).map((f) => f.op === "error" && f.code), ["session_exists"]);
  client.send({ op: "ack", sid: "s1", seq: 4 });
  client.send({ op: "ack", sid: "s1", seq: 2 });
  assert.equal(daemon.sessionStatus("s1")?.ackedSeq, 4);
  client.send({ op: "cancel", sid: "s1" });
  const cancellingMark = client.mark();
  client.send({ op: "send", sid: "s1", payload: {} });
  assert.deepEqual(client.sinceMark(cancellingMark).map((f) => f.op === "error" && f.code), ["session_cancelling"]);
  children[0].exitCode = 0;
  for (const frame of [{ op: "send", sid: "s1", payload: {} }, { op: "cancel", sid: "s1" }]) {
    const start = client.mark();
    client.send(frame);
    assert.deepEqual(client.sinceMark(start).map((f) => f.op === "error" && f.code), ["session_exited"]);
  }
  client.send({ op: "open", sid: "s1", bot });
  assert.equal(children.length, 2);
  client.send({ op: "close", sid: "s1" });
  assert.deepEqual(daemon.listSessions(), []);
  assert.deepEqual(daemon.table(), []);
});

test("resumes persisted metadata with a gap only for lost events", async (t) => {
  const home = makeTempDir("resume-record-");
  const storeFile = path.join(home, "sessions.json");
  fs.writeFileSync(storeFile, JSON.stringify({ sessions: [{ sid: "old", kind: "acp", command: ["synthetic"], state: "running", lastSeq: 3, progressAt: 42 }] }));
  const daemon = new Botd({ home, storeFile, now: () => 100 });
  t.after(() => daemon.close());
  const client = new TestClient(daemon);
  await client.hello();
  assert.equal(daemon.table()[0].state, "exited");
  let mark = client.mark();
  client.send({ op: "resume", sid: "old", fromSeq: 2 });
  assert.deepEqual(client.sinceMark(mark), [
    { op: "gap", sid: "old", fromSeq: 2, toSeq: 3 },
    { op: "state", sid: "old", state: "exited", progressAt: 42 },
  ]);
  mark = client.mark();
  client.send({ op: "resume", sid: "old", fromSeq: 4 });
  assert.deepEqual(client.sinceMark(mark), [{ op: "state", sid: "old", state: "exited", progressAt: 42 }]);
});

test("logs a persistence failure without disrupting request handling", async (t) => {
  const home = makeTempDir("persist-error-");
  const parent = path.join(home, "regular-file");
  fs.writeFileSync(parent, "synthetic");
  const logs: string[] = [];
  const daemon = new Botd({ home, storeFile: path.join(parent, "sessions.json") }, { onFrame: () => {}, onLog: (message) => logs.push(message) });
  t.after(() => daemon.close());
  const client = new TestClient(daemon);
  await client.hello();
  daemon.close();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^could not persist the session table:/);
});
