// volto — botd client tests.
//
// The tests drive an in-process fake botd over duplex streams, so no ssh, no
// network and no real host names are involved.

import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BotdClient, sshArgs } from "../src/client.ts";
import type {
  BotdSession,
  BotdTransport,
  ClientEvent,
  TimerHandle,
} from "../src/client.ts";

interface FakeConnection {
  toBotd: PassThrough;
  fromBotd: PassThrough;
  received: Record<string, unknown>[];
  buffer: string;
}

/** In-process botd speaking NDJSON over a pair of duplex streams. */
class FakeBotd {
  connections: FakeConnection[] = [];
  onFrame: (frame: Record<string, unknown>, conn: FakeConnection) => void = () => {};

  transport(): BotdTransport {
    const toBotd = new PassThrough();
    const fromBotd = new PassThrough();
    const conn: FakeConnection = { toBotd, fromBotd, received: [], buffer: "" };
    this.connections.push(conn);
    toBotd.setEncoding("utf8");
    toBotd.on("data", (chunk: string) => {
      conn.buffer += chunk;
      let index = conn.buffer.indexOf("\n");
      while (index >= 0) {
        const line = conn.buffer.slice(0, index).trim();
        conn.buffer = conn.buffer.slice(index + 1);
        if (line.length > 0) {
          const frame = JSON.parse(line) as Record<string, unknown>;
          conn.received.push(frame);
          this.onFrame(frame, conn);
        }
        index = conn.buffer.indexOf("\n");
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

  send(conn: FakeConnection, frame: Record<string, unknown>): void {
    conn.fromBotd.write(JSON.stringify(frame) + "\n");
  }

  /** Simulates a transport drop (the ssh connection dies). */
  drop(conn: FakeConnection): void {
    conn.fromBotd.destroy();
  }

  frames(conn: FakeConnection, type: string): Record<string, unknown>[] {
    return conn.received.filter((frame) => frame.type === type);
  }
}

/** Clock with manual time; every timer of the client is driven from here. */
class FakeClock {
  now = 0;
  #timers = new Map<number, { at: number; fn: () => void }>();
  #next = 0;

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.#next;
    this.#timers.set(id, { at: this.now + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    if (typeof handle === "number") this.#timers.delete(handle);
  }

  /** Moves time forward, firing every timer that becomes due. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.#timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueId = id;
          dueAt = timer.at;
        }
      }
      if (dueId === null) break;
      const timer = this.#timers.get(dueId);
      this.#timers.delete(dueId);
      if (!timer) break;
      this.now = timer.at;
      timer.fn();
      await flush();
    }
    this.now = target;
    await flush();
  }
}

async function flush(times = 4): Promise<void> {
  for (let index = 0; index < times; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Consumes a session in the background and records every event. */
function collect(session: BotdSession): { events: ClientEvent[] } {
  const events: ClientEvent[] = [];
  void (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  return { events };
}

function deltas(events: ClientEvent[]): string[] {
  return events.map((event) => String((event as { delta?: string }).delta ?? ""));
}

test("reconnect resumes open sessions from the last acked seq without duplicates", async () => {
  const clock = new FakeClock();
  const botd = new FakeBotd();
  const sids: string[] = [];
  botd.onFrame = (frame, conn) => {
    if (frame.type === "hello") {
      botd.send(conn, { type: "state", scope: "daemon", fence: 1, ttl: 30_000 });
      return;
    }
    if (frame.type === "open") {
      const sid = String(frame.sid);
      sids.push(sid);
      botd.send(conn, { type: "state", sid, state: "open" });
      if (sids.length === 1) {
        for (const seq of [1, 2, 3]) {
          botd.send(conn, { type: "event", sid, seq, kind: "text", delta: `e${seq}` });
        }
      }
      return;
    }
    if (frame.type === "resume") {
      const sid = String(frame.sid);
      const from = Number(frame.fromSeq);
      if (sid !== sids[0]) return;
      for (const seq of [1, 2, 3, 4]) {
        if (seq >= from) {
          botd.send(conn, { type: "event", sid, seq, kind: "text", delta: `e${seq}` });
        }
      }
    }
  };

  const client = new BotdClient({
    hostAlias: "bot-01",
    transport: () => botd.transport(),
    clock,
    backoff: { baseMs: 100, maxMs: 100, jitter: 0 },
  });
  await client.start();
  const session = await client.open({ cwd: "/srv/work" });
  const second = await client.open({ cwd: "/srv/work" });
  const collector = collect(session);
  await waitFor(() => collector.events.length === 3);
  assert.deepEqual(deltas(collector.events), ["e1", "e2", "e3"]);

  const reconnects: number[] = [];
  client.on("reconnect", (info: { delayMs: number }) => reconnects.push(info.delayMs));

  // The transport dies; the client reconnects and resumes the sessions.
  botd.drop(botd.connections[0]);
  await waitFor(() => reconnects.length === 1);
  await clock.advance(100);
  await waitFor(() => botd.connections.length === 2);
  await waitFor(() => botd.frames(botd.connections[1], "resume").length === 2);

  const resumes = botd.frames(botd.connections[1], "resume");
  assert.deepEqual(
    resumes.map((frame) => frame.sid).sort(),
    [session.sid, second.sid].sort(),
  );
  // Nothing was acked yet, so the daemon replays from the first sequence.
  for (const resume of resumes) assert.equal(resume.fromSeq, 1);
  assert.equal(botd.frames(botd.connections[1], "hello").length, 1);

  await waitFor(() => collector.events.length === 4);
  await flush();
  // The replayed events are not delivered twice.
  assert.deepEqual(deltas(collector.events), ["e1", "e2", "e3", "e4"]);

  await client.stop();
});

test("resume asks for the sequence after the last acknowledged event", async () => {
  const clock = new FakeClock();
  const botd = new FakeBotd();
  botd.onFrame = (frame, conn) => {
    if (frame.type === "hello") {
      botd.send(conn, { type: "state", scope: "daemon", fence: 1, ttl: 30_000 });
      return;
    }
    if (frame.type === "open") {
      botd.send(conn, { type: "state", sid: frame.sid, state: "open" });
      botd.send(conn, { type: "event", sid: frame.sid, seq: 1, kind: "text", delta: "a" });
      botd.send(conn, { type: "event", sid: frame.sid, seq: 2, kind: "text", delta: "b" });
      return;
    }
  };

  const client = new BotdClient({
    hostAlias: "bot-01",
    transport: () => botd.transport(),
    clock,
    backoff: { baseMs: 100, maxMs: 100, jitter: 0 },
  });
  await client.start();
  const session = await client.open({});
  const collector = collect(session);
  await waitFor(() => collector.events.length === 2);

  // The 500ms ack timer flushes the pending acknowledgement.
  await clock.advance(500);
  await waitFor(() => botd.frames(botd.connections[0], "ack").length === 1);
  assert.equal(botd.frames(botd.connections[0], "ack")[0].seq, 2);

  const reconnects: number[] = [];
  client.on("reconnect", (info: { delayMs: number }) => reconnects.push(info.delayMs));
  botd.drop(botd.connections[0]);
  await waitFor(() => reconnects.length === 1);
  await clock.advance(100);
  await waitFor(() => botd.connections.length === 2);
  await waitFor(() => botd.frames(botd.connections[1], "resume").length === 1);

  assert.equal(botd.frames(botd.connections[1], "resume")[0].fromSeq, 3);
  assert.equal(botd.frames(botd.connections[1], "resume")[0].sid, session.sid);

  await client.stop();
});

test("acks are batched after twenty events", async () => {
  const clock = new FakeClock();
  const botd = new FakeBotd();
  botd.onFrame = (frame, conn) => {
    if (frame.type === "hello") {
      botd.send(conn, { type: "state", scope: "daemon", fence: 1, ttl: 30_000 });
      return;
    }
    if (frame.type === "open") {
      botd.send(conn, { type: "state", sid: frame.sid, state: "open" });
      for (let seq = 1; seq <= 20; seq++) {
        botd.send(conn, { type: "event", sid: frame.sid, seq, kind: "text", delta: `e${seq}` });
      }
    }
  };

  const client = new BotdClient({
    hostAlias: "bot-01",
    transport: () => botd.transport(),
    clock,
  });
  await client.start();
  await client.open({});
  await waitFor(() => botd.frames(botd.connections[0], "ack").length === 1);
  const acks = botd.frames(botd.connections[0], "ack");
  assert.equal(acks.length, 1);
  assert.equal(acks[0].seq, 20);

  await client.stop();
});

test("gap frames are surfaced as session events", async () => {
  const clock = new FakeClock();
  const botd = new FakeBotd();
  botd.onFrame = (frame, conn) => {
    if (frame.type === "hello") {
      botd.send(conn, { type: "state", scope: "daemon", fence: 1, ttl: 30_000 });
      return;
    }
    if (frame.type === "open") {
      botd.send(conn, { type: "state", sid: frame.sid, state: "open" });
      botd.send(conn, { type: "event", sid: frame.sid, seq: 1, kind: "text", delta: "a" });
      botd.send(conn, { type: "gap", sid: frame.sid, from: 2, to: 4 });
    }
  };

  const client = new BotdClient({
    hostAlias: "bot-01",
    transport: () => botd.transport(),
    clock,
  });
  await client.start();
  const session = await client.open({});
  const collector = collect(session);
  await waitFor(() => collector.events.length === 2);
  assert.deepEqual(collector.events[1], { kind: "gap", from: 2, to: 4 });

  await client.stop();
});

test("the lease is renewed every ttl/3", async () => {
  const clock = new FakeClock();
  const botd = new FakeBotd();
  botd.onFrame = (frame, conn) => {
    if (frame.type === "hello") {
      botd.send(conn, { type: "state", scope: "daemon", fence: 1, ttl: 3_000 });
      return;
    }
    if (frame.type === "open") {
      botd.send(conn, { type: "state", sid: frame.sid, state: "open" });
    }
  };

  const client = new BotdClient({
    hostAlias: "bot-01",
    transport: () => botd.transport(),
    clock,
  });
  await client.start();
  const session = await client.open({});
  const conn = botd.connections[0];

  assert.equal(botd.frames(conn, "renew").length, 0);
  await clock.advance(1_000);
  assert.equal(botd.frames(conn, "renew").length, 1);
  assert.equal(botd.frames(conn, "renew")[0].sid, session.sid);
  await clock.advance(1_000);
  assert.equal(botd.frames(conn, "renew").length, 2);
  assert.equal(botd.frames(conn, "renew")[1].sid, session.sid);

  await client.stop();
});

test("cancel resolves once the session reports an exited state", async () => {
  const clock = new FakeClock();
  const botd = new FakeBotd();
  botd.onFrame = (frame, conn) => {
    if (frame.type === "hello") {
      botd.send(conn, { type: "state", scope: "daemon", fence: 1, ttl: 30_000 });
      return;
    }
    if (frame.type === "open") {
      botd.send(conn, { type: "state", sid: frame.sid, state: "open" });
      return;
    }
    if (frame.type === "cancel") {
      botd.send(conn, { type: "state", sid: frame.sid, state: "exited" });
    }
  };

  const client = new BotdClient({
    hostAlias: "bot-01",
    transport: () => botd.transport(),
    clock,
  });
  await client.start();
  const session = await client.open({});
  assert.equal(await session.cancel(), true);
  assert.equal(botd.frames(botd.connections[0], "cancel").length, 1);

  await client.stop();
});

test("cancel gives up after the cancel timeout", async () => {
  const clock = new FakeClock();
  const botd = new FakeBotd();
  botd.onFrame = (frame, conn) => {
    if (frame.type === "hello") {
      botd.send(conn, { type: "state", scope: "daemon", fence: 1, ttl: 30_000 });
      return;
    }
    if (frame.type === "open") {
      botd.send(conn, { type: "state", sid: frame.sid, state: "open" });
      return;
    }
    // the daemon never acknowledges the cancel
  };

  const client = new BotdClient({
    hostAlias: "bot-01",
    transport: () => botd.transport(),
    clock,
  });
  await client.start();
  const session = await client.open({});
  const pending = session.cancel();
  await flush();
  await clock.advance(15_000);
  assert.equal(await pending, false);

  await client.stop();
});

test("reconnect backoff grows from one second to thirty seconds", async () => {
  const clock = new FakeClock();
  const delays: number[] = [];
  const client = new BotdClient({
    hostAlias: "bot-01",
    clock,
    random: () => 0.5,
    transport: () => {
      throw new Error("transport unavailable");
    },
  });
  client.on("reconnect", (info: { delayMs: number }) => delays.push(info.delayMs));
  void client.start().catch(() => {});

  // let the first attempt fail before the clock starts running
  await flush();
  await clock.advance(100_000);
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);

  await client.stop();
});

test("a newer fence stops all sessions with an error", async () => {
  const clock = new FakeClock();
  const botd = new FakeBotd();
  let fence = 1;
  botd.onFrame = (frame, conn) => {
    if (frame.type === "hello") {
      botd.send(conn, { type: "state", scope: "daemon", fence, ttl: 30_000 });
      return;
    }
    if (frame.type === "open") {
      botd.send(conn, { type: "state", sid: frame.sid, state: "open" });
    }
  };

  const client = new BotdClient({
    hostAlias: "bot-01",
    transport: () => botd.transport(),
    clock,
    backoff: { baseMs: 100, maxMs: 100, jitter: 0 },
  });
  const errors: Error[] = [];
  client.on("error", (err: Error) => errors.push(err));
  await client.start();
  const session = await client.open({});
  const collector = collect(session);

  fence = 2;
  const reconnects: number[] = [];
  client.on("reconnect", (info: { delayMs: number }) => reconnects.push(info.delayMs));
  botd.drop(botd.connections[0]);
  await waitFor(() => reconnects.length === 1);
  await clock.advance(100);
  await waitFor(() => botd.connections.length === 2);

  await waitFor(() => errors.some((err) => /fence/.test(err.message)));
  await waitFor(() => collector.events.some((event) => event.kind === "error"));
  const failure = collector.events.find((event) => event.kind === "error");
  assert.ok(failure && /fence/.test(String((failure as { message?: string }).message)));
  assert.equal(client.fence, 2);

  await client.stop();
});

test("the default transport talks to botd over ssh", () => {
  assert.deepEqual(sshArgs("bot-01"), [
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=15",
    "bot-01",
    "botd",
    "serve",
  ]);
});
