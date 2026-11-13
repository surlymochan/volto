import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { BotdClient, backoffDelay, daemonCommand, sshArgs } from "../src/client.ts";

class FakeBotd {
  input = new PassThrough();
  output = new PassThrough();
  frames: Record<string, unknown>[] = [];
  answerOpen = true;
  hello = true;
  constructor() {
    this.input.setEncoding("utf8");
    let buffer = "";
    this.input.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const frame = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        this.frames.push(frame);
        if (frame.op === "hello" && this.hello) this.send({ op: "hello", leaseId: "lease", fence: 1 });
        if (frame.op === "open" && this.answerOpen) this.send({ op: "state", sid: frame.sid, state: "running" });
      }
    });
  }
  send(frame: unknown) { this.output.write(`${JSON.stringify(frame)}\n`); }
  transport() { return { stdin: this.input, stdout: this.output, kill: () => { this.input.destroy(); this.output.destroy(); } }; }
  of(op: string) { return this.frames.filter((frame) => frame.op === op); }
}
const bot = { kind: "acp" as const, command: ["bot"] };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 200;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await delay(2);
  }
}
function setup(options: ConstructorParameters<typeof BotdClient>[0] = {}) {
  const fake = new FakeBotd();
  const client = new BotdClient({ transport: () => fake.transport(), openTimeoutMs: 20, cancelTimeoutMs: 20, handshakeTimeoutMs: 20, ...options });
  return { fake, client };
}

test("backoff clamps attempts, jitter and maximum", () => {
  const opts = { baseMs: 10, maxMs: 50, jitter: 0.25 };
  assert.equal(backoffDelay(-1, opts, () => 0), 10);
  assert.equal(backoffDelay(0, opts, () => 0.5), 10);
  assert.equal(backoffDelay(2.9, opts, () => 0), 15);
  assert.equal(backoffDelay(2, opts, () => 0.5), 20);
  assert.equal(backoffDelay(2, opts, () => 1), 25);
  assert.equal(backoffDelay(20, opts, () => 1), 50);
});

test("open timeout forgets the sid", async () => {
  const { fake, client } = setup(); fake.answerOpen = false;
  try { await client.start(); await assert.rejects(client.open({ sid: "s", bot }), /open timeout/); assert.deepEqual(client.sessions, []); fake.answerOpen = true; assert.equal((await client.open({ sid: "s", bot })).sid, "s"); } finally { await client.stop(); }
});
test("duplicate live sid rejects", async () => {
  const { client } = setup(); try { await client.start(); await client.open({ sid: "s", bot }); await assert.rejects(client.open({ sid: "s", bot }), /already open/); } finally { await client.stop(); }
});
test("session error rejects pending open", async () => {
  const { fake, client } = setup(); fake.answerOpen = false;
  try { await client.start(); const opening = client.open({ sid: "s", bot }); await waitFor(() => fake.of("open").length > 0); fake.send({ op: "error", sid: "s", code: "denied", message: "no" }); await assert.rejects(opening, /botd: denied: no/); } finally { await client.stop(); }
});
test("cancel unknown sid returns false", async () => { const { client } = setup(); try { assert.equal(await client.cancel("missing"), false); } finally { await client.stop(); } });
test("cancel exited sid returns true", async () => {
  const { fake, client } = setup(); try { await client.start(); const s = await client.open({ sid: "s", bot }); fake.send({ op: "state", sid: "s", state: "exited" }); await waitFor(() => s.state === "exited"); assert.equal(await s.cancel(), true); } finally { await client.stop(); }
});
test("cancel times out", async () => { const { client } = setup(); try { await client.start(); const s = await client.open({ sid: "s", bot }); assert.equal(await s.cancel(), false); } finally { await client.stop(); } });
test("silent handshake times out", async () => { const { fake, client } = setup(); fake.hello = false; try { await assert.rejects(client.start(), /handshake timeout/); } finally { await client.stop(); } });
test("bad hello emits bad_hello", async () => {
  const { fake, client } = setup(); fake.hello = false; const errors: string[] = []; client.on("error", (e) => errors.push(e.code));
  try { const start = client.start(); fake.send({ op: "hello", fence: 1 }); await assert.rejects(start, /handshake timeout/); assert.deepEqual(errors, ["bad_hello"]); } finally { await client.stop(); }
});
test("replay is acknowledged without duplicate delivery", async () => {
  const { fake, client } = setup({ ackBatchSize: 2, ackIntervalMs: 50 });
  try { await client.start(); const s = await client.open({ sid: "s", bot }); const it = s.events(); fake.send({ op: "event", sid: "s", seq: 1, payload: "one" }); assert.equal((await it.next()).value, "one"); fake.send({ op: "event", sid: "s", seq: 1, payload: "duplicate" }); await waitFor(() => fake.of("ack").length === 1); assert.equal(fake.of("ack")[0].seq, 1); const next = it.next(); fake.send({ op: "event", sid: "s", seq: 2, payload: "two" }); assert.equal((await next).value, "two"); } finally { await client.stop(); }
});
test("batch and interval acknowledgements are cumulative", async () => {
  const { fake, client } = setup({ ackBatchSize: 2, ackIntervalMs: 20 });
  try { await client.start(); await client.open({ sid: "s", bot }); for (const seq of [1, 2]) fake.send({ op: "event", sid: "s", seq, payload: seq }); await waitFor(() => fake.of("ack").length === 1); fake.send({ op: "event", sid: "s", seq: 3, payload: 3 }); await waitFor(() => fake.of("ack").length === 2); assert.deepEqual(fake.of("ack").map((f) => f.seq), [2, 3]); } finally { await client.stop(); }
});
test("stop settles pending operations and iterators", async () => {
  const { fake, client } = setup(); try { await client.start(); const s = await client.open({ sid: "s", bot }); const next = s.events().next(); const cancel = s.cancel(); fake.answerOpen = false; const opening = client.open({ sid: "other", bot }); await waitFor(() => fake.of("open").length === 2); const rejected = assert.rejects(opening, /client stopped/); await client.stop(); await rejected; assert.equal(await cancel, false); assert.equal((await next).done, true); } finally { await client.stop(); }
});
test("close ends iterator and removes sid", async () => { const { client } = setup(); try { await client.start(); const s = await client.open({ sid: "s", bot }); const next = s.events().next(); s.close(); assert.equal((await next).done, true); assert.deepEqual(client.sessions, []); } finally { await client.stop(); } });
test("adopt and resume from acknowledged sequence", async () => {
  const { fake, client } = setup({ ackBatchSize: 1 }); try { await client.start(); const s = client.session("adopted"); assert.deepEqual(client.sessions, ["adopted"]); s.resume(); fake.send({ op: "event", sid: "adopted", seq: 2, payload: 2 }); await waitFor(() => fake.of("ack").length === 1); s.resume(); assert.deepEqual(fake.of("resume").map((f) => f.fromSeq), [1, 3]); } finally { await client.stop(); }
});
test("reconnect disabled reports disconnect without retry", async () => {
  const { fake, client } = setup({ reconnect: false, backoff: { baseMs: 5, maxMs: 5, jitter: 0 } }); let disconnected = 0; let reconnects = 0; client.on("disconnected", () => disconnected++); client.on("reconnect", () => reconnects++);
  try { await client.start(); fake.output.destroy(); await waitFor(() => disconnected === 1); await delay(20); assert.equal(reconnects, 0); } finally { await client.stop(); }
});
test("unknown and non-object frames are ignored", async () => {
  const { fake, client } = setup(); const errors: unknown[] = []; client.on("error", (e) => errors.push(e)); try { await client.start(); fake.send({ op: "future" }); fake.send(42); await delay(5); assert.deepEqual(errors, []); } finally { await client.stop(); }
});
test("daemon and ssh command shapes", () => {
  const command = daemonCommand({ home: "/tmp/example" }); assert.equal(command[0], process.execPath); assert.ok(command.some((arg) => arg.endsWith("/src/main.ts"))); assert.deepEqual(command.slice(-2), ["serve", "--home=/tmp/example"]);
  const args = sshArgs("executor-alias"); assert.ok(args.includes("BatchMode=yes")); assert.deepEqual(args.slice(-3), ["executor-alias", "botd", "serve"]);
});
