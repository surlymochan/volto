// volto — botd client tests.
//
// Two kinds of tests live here: the unit tests drive the client against an
// in-process fake botd (NDJSON over a pair of streams), the end-to-end test
// starts the real daemon (botd/src/main.ts serve) and drives it over stdio.
//
// Everything is synthetic: no host name, address or credential shows up
// here, the scratch space lives inside the worktree (botd/.tmp).

import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import { test } from "node:test";

import { BotdClient, daemonCommand, spawnTransport, sshArgs } from "../src/client.ts";
import type { BotdTransport } from "../src/client.ts";

/** The fake bot the real daemon runs. */
const FAKE_CHILD = fileURLToPath(new URL("./fixtures/fake-child.mjs", import.meta.url));

/** Everything temporary lives inside the worktree, in botd/.tmp. */
const TMP_ROOT = fileURLToPath(new URL("../.tmp/", import.meta.url));

/** One connection of the fake botd. */
type FakeConnection = {
  toBotd: PassThrough;
  fromBotd: PassThrough;
  received: Record<string, unknown>[];
};

/** One event of the journal of the fake botd. */
type JournalEntry = { seq: number; payload: unknown };

/**
 * An in-process botd that speaks NDJSON over a pair of streams.
 *
 * The fake keeps a journal of the events per session, so a resume can be
 * answered with the replay of the events the client missed.
 */
class FakeBotd {
  /** Every connection the client opened. */
  readonly connections: FakeConnection[] = [];
  /** The journal of the fake, per session id. */
  readonly journal = new Map<string, JournalEntry[]>();
  /** The TTL the fake announces in the hello answer. */
  leaseTtlMs = 15_000;
  /** The id and the fence the fake announces. */
  leaseId = "lease-1";
  fence = 7;
  /** Answers the frames of the client. */
  onFrame: (frame: Record<string, unknown>, conn: FakeConnection) => void = () => {};

  /** A fresh transport towards the fake. */
  transport(): BotdTransport {
    const toBotd = new PassThrough();
    const fromBotd = new PassThrough();
    const conn: FakeConnection = { toBotd, fromBotd, received: [] };
    this.connections.push(conn);
    toBotd.setEncoding("utf8");
    toBotd.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim().length === 0) continue;
        const frame = JSON.parse(line) as Record<string, unknown>;
        conn.received.push(frame);
        this.onFrame(frame, conn);
      }
    });
    return {
      stdin: toBotd,
      stdout: fromBotd,
      kill: () => {
        toBotd.destroy();
        fromBotd.destroy();
      },
    };
  }

  /** Send a frame to the client. */
  send(conn: FakeConnection, frame: Record<string, unknown>): void {
    conn.fromBotd.write(`${JSON.stringify(frame)}\n`);
  }

  /** The frames of a kind the client sent over a connection. */
  frames(conn: FakeConnection, op: string): Record<string, unknown>[] {
    return conn.received.filter((frame) => frame.op === op);
  }

  /** Remember an event and hand it to the client. */
  emit(conn: FakeConnection, sid: string, payload: unknown): number {
    const entries = this.journal.get(sid) ?? [];
    const seq = entries.length + 1;
    entries.push({ seq, payload });
    this.journal.set(sid, entries);
    this.send(conn, { op: "event", sid, seq, payload });
    return seq;
  }

  /** The default answers of the fake: the hello and the states of a session. */
  answer(frame: Record<string, unknown>, conn: FakeConnection): boolean {
    switch (frame.op) {
      case "hello":
        this.send(conn, {
          op: "hello",
          botdVersion: "9.9.9",
          leaseId: this.leaseId,
          fence: this.fence,
          leaseTtlMs: this.leaseTtlMs,
        });
        return true;
      case "open": {
        const sid = String(frame.sid);
        this.send(conn, { op: "state", sid, state: "starting", progressAt: 1 });
        this.send(conn, { op: "state", sid, state: "running", progressAt: 2 });
        return true;
      }
      case "resume": {
        const sid = String(frame.sid);
        const from = Number(frame.fromSeq ?? 1);
        for (const entry of this.journal.get(sid) ?? []) {
          if (entry.seq < from) continue;
          this.send(conn, { op: "event", sid, seq: entry.seq, payload: entry.payload });
        }
        this.send(conn, { op: "state", sid, state: "running", progressAt: 3 });
        return true;
      }
      default:
        return false;
    }
  }
}

/** A throw away directory inside the worktree. */
function makeTempDir(prefix: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(path.join(TMP_ROOT, prefix));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until the predicate returns something truthy, or fail. */
async function waitFor<T>(
  predicate: () => T | undefined | null | false,
  options: { timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) {
      const label = options.label ?? "a condition";
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await delay(10);
  }
}

/** The next payload of a session. */
async function nextEvent(
  iterator: AsyncIterableIterator<unknown>,
  timeoutMs = 5000,
): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs}ms waiting for an event`)),
          timeoutMs,
        );
      }),
    ]);
    return result.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One row of the session table of the daemon. */
type SessionRow = { sid: string; state: string; lastSeq: number; ackedSeq: number };

/** Read the session table the daemon wrote. */
function readSessionTable(home: string): SessionRow[] {
  try {
    const parsed = JSON.parse(readFileSync(path.join(home, "sessions.json"), "utf8")) as {
      sessions?: SessionRow[];
    };
    return parsed.sessions ?? [];
  } catch {
    return [];
  }
}

test("the daemon of an executor host runs as a forced command over ssh", () => {
  assert.deepEqual(sshArgs("executor-a"), [
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=15",
    "executor-a",
    "botd",
    "serve",
  ]);
});

test("takes the lease with a hello and keeps the id and the fence", async () => {
  const fake = new FakeBotd();
  fake.onFrame = (frame, conn) => {
    fake.answer(frame, conn);
  };
  const client = new BotdClient({
    clientId: "client-a",
    transport: () => fake.transport(),
  });
  try {
    await client.start();
    const conn = fake.connections[0];
    assert.deepEqual(conn.received[0], { op: "hello", clientId: "client-a" });
    assert.deepEqual(client.lease, {
      leaseId: "lease-1",
      fence: 7,
      leaseTtlMs: 15_000,
      botdVersion: "9.9.9",
    });
    assert.equal(client.connected, true);
  } finally {
    await client.stop();
  }
});

test("renews the lease of the connection with the id and the fence of the hello", async () => {
  const fake = new FakeBotd();
  fake.leaseTtlMs = 300;
  fake.onFrame = (frame, conn) => {
    fake.answer(frame, conn);
  };
  const client = new BotdClient({
    clientId: "client-a",
    transport: () => fake.transport(),
  });
  try {
    await client.start();
    const conn = fake.connections[0];
    // The lease is renewed every ttl / 3; the daemon does not answer it.
    await waitFor(() => fake.frames(conn, "renew").length > 0, {
      label: "the renewal of the lease",
    });
    assert.deepEqual(fake.frames(conn, "renew")[0], {
      op: "renew",
      leaseId: "lease-1",
      fence: 7,
    });
  } finally {
    await client.stop();
  }
});

test("opens a session with the bot spec and waits for the state of the daemon", async () => {
  const fake = new FakeBotd();
  fake.onFrame = (frame, conn) => {
    fake.answer(frame, conn);
  };
  const client = new BotdClient({ transport: () => fake.transport() });
  try {
    await client.start();
    const conn = fake.connections[0];
    const session = await client.open({
      sid: "s1",
      bot: { kind: "acp", command: ["node", "bot"], cwd: "/work" },
    });
    assert.deepEqual(fake.frames(conn, "open")[0], {
      op: "open",
      sid: "s1",
      bot: { kind: "acp", command: ["node", "bot"], cwd: "/work" },
    });
    assert.equal(session.sid, "s1");
    assert.equal(session.state, "running");
  } finally {
    await client.stop();
  }
});

test("delivers the payload of an event unwrapped", async () => {
  const fake = new FakeBotd();
  fake.onFrame = (frame, conn) => {
    if (fake.answer(frame, conn)) return;
    if (frame.op === "send") {
      fake.emit(conn, "s1", { text: "hello", seq: 1 });
    }
  };
  const client = new BotdClient({ transport: () => fake.transport() });
  try {
    await client.start();
    const session = await client.open({
      sid: "s1",
      bot: { kind: "acp", command: ["node", "bot"] },
    });
    const iterator = session.events();
    session.send({ prompt: "hi" });
    assert.deepEqual(await nextEvent(iterator), { text: "hello", seq: 1 });
    const conn = fake.connections[0];
    assert.deepEqual(fake.frames(conn, "send")[0], {
      op: "send",
      sid: "s1",
      payload: { prompt: "hi" },
    });
  } finally {
    await client.stop();
  }
});

test("batches the acknowledgements of the events", async () => {
  const fake = new FakeBotd();
  fake.onFrame = (frame, conn) => {
    if (fake.answer(frame, conn)) return;
    if (frame.op === "send") {
      fake.emit(conn, "s1", { seq: 1 });
      fake.emit(conn, "s1", { seq: 2 });
      fake.emit(conn, "s1", { seq: 3 });
    }
  };
  const client = new BotdClient({
    transport: () => fake.transport(),
    ackBatchSize: 3,
    ackIntervalMs: 60_000,
  });
  try {
    await client.start();
    const session = await client.open({
      sid: "s1",
      bot: { kind: "acp", command: ["node", "bot"] },
    });
    const iterator = session.events();
    session.send({ prompt: "hi" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const conn = fake.connections[0];
    await waitFor(() => fake.frames(conn, "ack").length > 0, { label: "the acknowledgement" });
    assert.deepEqual(fake.frames(conn, "ack"), [{ op: "ack", sid: "s1", seq: 3 }]);
  } finally {
    await client.stop();
  }
});

test("cancels a session and waits until it settled", async () => {
  const fake = new FakeBotd();
  fake.onFrame = (frame, conn) => {
    if (fake.answer(frame, conn)) return;
    if (frame.op === "cancel") {
      const sid = String(frame.sid);
      fake.send(conn, { op: "state", sid, state: "paused", progressAt: 4 });
      fake.send(conn, { op: "state", sid, state: "exited", progressAt: 5 });
    }
  };
  const client = new BotdClient({ transport: () => fake.transport() });
  try {
    await client.start();
    const session = await client.open({
      sid: "s1",
      bot: { kind: "acp", command: ["node", "bot"] },
    });
    const cancelled = await session.cancel();
    assert.equal(cancelled, true);
    const conn = fake.connections[0];
    assert.deepEqual(fake.frames(conn, "cancel")[0], { op: "cancel", sid: "s1" });
    assert.equal(session.state, "exited");
  } finally {
    await client.stop();
  }
});

test("resumes a session: the events are replayed and one state frame ends the replay", async () => {
  const fake = new FakeBotd();
  fake.onFrame = (frame, conn) => {
    if (fake.answer(frame, conn)) return;
    if (frame.op === "send") {
      fake.emit(conn, "s1", { seq: 1 });
      // The second event never reaches the client: the transport broke.
      const entries = fake.journal.get("s1") ?? [];
      entries.push({ seq: 2, payload: { seq: 2 } });
      fake.journal.set("s1", entries);
    }
  };
  const client = new BotdClient({ transport: () => fake.transport() });
  try {
    await client.start();
    const session = await client.open({
      sid: "s1",
      bot: { kind: "acp", command: ["node", "bot"] },
    });
    const iterator = session.events();
    session.send({ prompt: "hi" });
    assert.deepEqual(await nextEvent(iterator), { seq: 1 });

    session.resume(2);
    const conn = fake.connections[0];
    await waitFor(() => fake.frames(conn, "resume").length > 0, { label: "the resume frame" });
    assert.deepEqual(fake.frames(conn, "resume")[0], { op: "resume", sid: "s1", fromSeq: 2 });
    // The replay brings the event the client missed.
    assert.deepEqual(await nextEvent(iterator), { seq: 2 });
  } finally {
    await client.stop();
  }
});

test("reports the gaps, the stalls and the errors of the daemon", async () => {
  const fake = new FakeBotd();
  fake.onFrame = (frame, conn) => {
    if (fake.answer(frame, conn)) return;
    if (frame.op === "send") {
      fake.send(conn, { op: "gap", sid: "s1", fromSeq: 2, toSeq: 4 });
      fake.send(conn, { op: "stall", sid: "s1", idleMs: 30_000 });
      fake.send(conn, {
        op: "error",
        code: "unknown_session",
        message: "no session s1",
        sid: "s1",
      });
      fake.send(conn, { op: "error", code: "bad_json", message: "not a frame" });
    }
  };
  const client = new BotdClient({ transport: () => fake.transport() });
  try {
    await client.start();
    const gaps: unknown[] = [];
    const stalls: unknown[] = [];
    const errors: { code: string; sid?: string }[] = [];
    client.on("gap", (payload) => gaps.push(payload));
    client.on("stall", (payload) => stalls.push(payload));
    client.on("error", (payload) => errors.push(payload));
    const session = await client.open({
      sid: "s1",
      bot: { kind: "acp", command: ["node", "bot"] },
    });
    session.send({ prompt: "hi" });
    await waitFor(() => errors.length >= 2, { label: "the errors of the daemon" });
    assert.deepEqual(gaps, [{ sid: "s1", fromSeq: 2, toSeq: 4 }]);
    assert.deepEqual(stalls, [{ sid: "s1", idleMs: 30_000 }]);
    assert.equal(errors[0].code, "unknown_session");
    assert.equal(errors[0].sid, "s1");
    assert.equal(errors[1].code, "bad_json");
  } finally {
    await client.stop();
  }
});

test("reconnects after a broken transport and resumes the sessions", async () => {
  const fake = new FakeBotd();
  fake.onFrame = (frame, conn) => {
    if (fake.answer(frame, conn)) return;
    if (frame.op === "send") {
      fake.emit(conn, "s1", { seq: 1 });
      // The event the client misses while the transport is down.
      const entries = fake.journal.get("s1") ?? [];
      entries.push({ seq: 2, payload: { seq: 2 } });
      fake.journal.set("s1", entries);
    }
  };
  const client = new BotdClient({
    transport: () => fake.transport(),
    ackBatchSize: 1,
    backoff: { baseMs: 20, maxMs: 50, jitter: 0 },
  });
  try {
    await client.start();
    const session = await client.open({
      sid: "s1",
      bot: { kind: "acp", command: ["node", "bot"] },
    });
    const iterator = session.events();
    session.send({ prompt: "hi" });
    assert.deepEqual(await nextEvent(iterator), { seq: 1 });
    const first = fake.connections[0];
    await waitFor(() => fake.frames(first, "ack").length > 0, { label: "the acknowledgement" });

    // The transport breaks: the client reconnects and resumes the session.
    first.fromBotd.destroy();
    await waitFor(() => fake.connections.length > 1, { label: "the reconnect" });
    const second = fake.connections[1];
    await waitFor(() => fake.frames(second, "resume").length > 0, { label: "the resume frame" });
    assert.deepEqual(fake.frames(second, "resume")[0], { op: "resume", sid: "s1", fromSeq: 2 });
    // The replay brings the event the client missed.
    assert.deepEqual(await nextEvent(iterator), { seq: 2 });
  } finally {
    await client.stop();
  }
});

test("drives the real daemon over stdio: hello, open, send, cancel and resume", async () => {
  const home = makeTempDir("client-real-");
  const command = [
    ...daemonCommand({ home }),
    "--watchdog-ms=100",
    "--cancel-grace-ms=200",
    "--cancel-kill-grace-ms=200",
  ];
  const client = new BotdClient({
    clientId: "client-a",
    ackBatchSize: 1,
    transport: () => spawnTransport(command[0], command.slice(1)),
  });
  try {
    await client.start();
    const lease = client.lease;
    assert.ok(lease, "the daemon granted a lease");
    assert.ok(lease.leaseId.length > 0, "the lease carries an id");
    assert.equal(typeof lease.fence, "number", "the lease carries a fence");
    assert.ok(lease.leaseTtlMs > 0, "the lease carries a ttl");

    const session = await client.open({
      sid: "s1",
      bot: { kind: "acp", command: [process.execPath, FAKE_CHILD] },
    });
    const iterator = session.events();
    session.send({ cmd: "emit", count: 3 });
    const first = (await nextEvent(iterator)) as { result: { seq: number } };
    assert.equal(first.result.seq, 0, "the first event of the bot");
    await nextEvent(iterator);
    await nextEvent(iterator);

    // The daemon stores the acknowledgement of the client.
    await waitFor(
      () => readSessionTable(home).some((row) => row.sid === "s1" && row.ackedSeq === 3),
      { label: "the acknowledgement in the session table" },
    );

    // The cancel stops the bot: the daemon escalates to the signal.
    const cancelled = await session.cancel();
    assert.equal(cancelled, true, "the cancel settled");
    assert.equal(session.state, "exited", "the bot is gone");

    // The resume replays the events of the session and ends with a state.
    const states: string[] = [];
    const off = client.on("state", (payload) => {
      if (payload.sid === "s1") states.push(payload.state);
    });
    session.resume(1);
    await waitFor(() => states.length > 0, { label: "the state frame of the resume" });
    off();
    assert.equal(states[0], "exited", "the daemon reports the state of the session");
  } finally {
    await client.stop();
  }
});

test("renews the lease of the real daemon: the session survives the ttl", async () => {
  const home = makeTempDir("client-lease-");
  const command = [...daemonCommand({ home }), "--watchdog-ms=100"];
  const client = new BotdClient({
    clientId: "client-a",
    leaseTtlMs: 600,
    transport: () => spawnTransport(command[0], command.slice(1)),
  });
  const errors: string[] = [];
  client.on("error", (payload) => errors.push(payload.code));
  try {
    await client.start();
    const session = await client.open({
      sid: "s1",
      bot: { kind: "acp", command: [process.execPath, FAKE_CHILD] },
    });
    const iterator = session.events();

    // The lease is short: without a renewal the daemon would pause the
    // session and kill the bot.
    await delay(1500);
    session.send({ cmd: "echo", text: "still alive" });
    const payload = (await nextEvent(iterator)) as { result: { echo: string } };
    assert.equal(payload.result.echo, "still alive", "the session is still running");
    assert.ok(
      !errors.includes("lease_paused"),
      `the lease was renewed, the daemon reported: ${errors.join(", ")}`,
    );
  } finally {
    await client.stop();
  }
});

test("a daemon that went away reports the gap of the events the client missed", async () => {
  const home = makeTempDir("client-gap-");
  const command = [...daemonCommand({ home }), "--watchdog-ms=100"];
  const holder: { transport?: BotdTransport } = {};
  const client = new BotdClient({
    clientId: "client-a",
    // The acknowledgements stay pending: the client never confirms the
    // events, so it asks for them again after the reconnect.
    ackBatchSize: 100,
    ackIntervalMs: 60_000,
    backoff: { baseMs: 20, maxMs: 50, jitter: 0 },
    transport: () => {
      holder.transport = spawnTransport(command[0], command.slice(1));
      return holder.transport;
    },
  });
  const gaps: { sid: string; fromSeq: number; toSeq: number }[] = [];
  client.on("gap", (payload) => gaps.push(payload));
  try {
    await client.start();
    const session = await client.open({
      sid: "s1",
      bot: { kind: "acp", command: [process.execPath, FAKE_CHILD] },
    });
    const iterator = session.events();
    session.send({ cmd: "emit", count: 2 });
    await nextEvent(iterator);
    await nextEvent(iterator);

    // The bot leaves: the daemon writes the session table.
    session.send({ cmd: "exit", code: 0 });
    await waitFor(
      () => readSessionTable(home).some((row) => row.sid === "s1" && row.lastSeq === 2),
      { label: "the session table of the daemon" },
    );

    // The daemon goes away: the client reconnects to a fresh daemon that
    // only knows the metadata of the session.
    holder.transport?.kill("SIGKILL");
    await waitFor(() => gaps.length > 0, {
      timeoutMs: 4000,
      label: "the gap of the events the client missed",
    });
    assert.deepEqual(gaps[0], { sid: "s1", fromSeq: 1, toSeq: 2 });
  } finally {
    await client.stop();
  }
});
