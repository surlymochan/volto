// volto — the error codes of the botd client.
//
// The client reports the problems of the transport and of the handshake
// through its `error` notification:
//
//   transport_error  the stdin of the transport broke
//   write_failed     a frame could not be written
//   reconnect_failed a reconnect never got the answer of its hello
//   handshake_failed the re-hello after an expired lease never arrived
//
// Every test here drives the client against an in-process fake botd (NDJSON
// over a pair of streams) with small timeouts. Everything is synthetic: no
// host name, address or credential shows up here and the scratch space of
// the suite lives inside the worktree (botd/.tmp).

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { BotdClient } from "../src/client.ts";
import type { BotdTransport } from "../src/client.ts";

/** The bot the fake daemon runs; the name is synthetic. */
const bot = { kind: "acp" as const, command: ["bot"] };

/** The rejections nobody handled; the suite must not leave any behind. */
const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason: unknown) => {
  unhandled.push(reason);
});

/**
 * A stdin that can be broken: once it is broken every write throws, the
 * way a pipe that is gone behaves.
 */
class BreakableStdin extends PassThrough {
  /** True when the writes of the client have to fail. */
  broken = false;

  override write(chunk: any, encoding?: any, callback?: any): boolean {
    if (this.broken) throw new Error("the pipe is gone");
    if (typeof encoding === "function") return super.write(chunk, encoding);
    if (typeof encoding === "string") return super.write(chunk, encoding, callback);
    return super.write(chunk);
  }
}

/**
 * An in-process botd that speaks NDJSON over a pair of streams.
 *
 * The fake answers the hello of the client (as many hellos as it was told)
 * and the open of a session; every frame the client writes is recorded.
 */
class FakeBotd {
  /** The frames the client wrote. */
  frames: Record<string, unknown>[] = [];
  /** How many hellos the fake answers; the others stay silent. */
  hellos = Infinity;
  /** The stdin of the client. */
  readonly stdin = new BreakableStdin();
  /** The stdout of the client. */
  readonly output = new PassThrough();

  constructor() {
    this.stdin.setEncoding("utf8");
    let buffer = "";
    this.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const frame = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
        buffer = buffer.slice(end + 1);
        this.frames.push(frame);
        if (frame.op === "hello" && this.hellos > 0) {
          this.hellos -= 1;
          this.send({ op: "hello", leaseId: "lease", fence: 1, leaseTtlMs: 15_000 });
        }
        if (frame.op === "open") {
          this.send({ op: "state", sid: frame.sid, state: "running" });
        }
      }
    });
  }

  /** Send a frame to the client. */
  send(frame: unknown): void {
    this.output.write(`${JSON.stringify(frame)}\n`);
  }

  /** A transport towards the fake. */
  transport(): BotdTransport {
    return {
      stdin: this.stdin,
      stdout: this.output,
      kill: () => {
        this.stdin.destroy();
        this.output.destroy();
      },
    };
  }

  /** The frames of a kind the client wrote. */
  of(op: string): Record<string, unknown>[] {
    return this.frames.filter((frame) => frame.op === op);
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until the predicate holds, or fail. */
async function waitFor(predicate: () => boolean, label = "a condition"): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await delay(5);
  }
}

/** The number of timers the process holds right now. */
function activeTimers(): number {
  return process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
}

/** A client with small timeouts, driven by a fake botd. */
function setup(options: ConstructorParameters<typeof BotdClient>[0] = {}) {
  const fake = new FakeBotd();
  const client = new BotdClient({
    transport: () => fake.transport(),
    openTimeoutMs: 50,
    cancelTimeoutMs: 50,
    handshakeTimeoutMs: 50,
    ...options,
  });
  return { fake, client };
}

/** A client that builds a fresh fake botd for every connection. */
function setupWithFreshTransports(
  options: ConstructorParameters<typeof BotdClient>[0] = {},
) {
  const fakes: FakeBotd[] = [];
  const client = new BotdClient({
    transport: () => {
      const fake = new FakeBotd();
      fakes.push(fake);
      return fake.transport();
    },
    openTimeoutMs: 50,
    cancelTimeoutMs: 50,
    handshakeTimeoutMs: 50,
    ...options,
  });
  return { fakes, client };
}

/**
 * A client whose first transport answers the hello and whose later
 * transports stay silent: the reconnects of the client never get a lease.
 */
function setupWithSilentReconnect(
  options: ConstructorParameters<typeof BotdClient>[0] = {},
) {
  const fakes: FakeBotd[] = [];
  const client = new BotdClient({
    transport: () => {
      const fake = new FakeBotd();
      if (fakes.length > 0) fake.hellos = 0;
      fakes.push(fake);
      return fake.transport();
    },
    handshakeTimeoutMs: 30,
    backoff: { baseMs: 10, maxMs: 10, jitter: 0 },
    ...options,
  });
  return { fakes, client };
}

test("a broken stdin reports transport_error and keeps the client connected", async () => {
  const baseline = activeTimers();
  const { fake, client } = setup();
  const errors: { code: string; message: string }[] = [];
  const disconnected: string[] = [];
  client.on("error", (error) => errors.push(error));
  client.on("disconnected", (payload) => disconnected.push(payload.reason));
  try {
    await client.start();
    assert.equal(client.connected, true);
    fake.stdin.destroy(new Error("the pipe is closed"));
    await waitFor(() => errors.length > 0, "the transport error");
    assert.equal(errors[0].code, "transport_error");
    assert.match(errors[0].message, /the pipe is closed/);
    // A broken stdin is not a lost transport: the client stays connected.
    assert.equal(client.connected, true);
    assert.deepEqual(disconnected, []);
  } finally {
    await client.stop();
  }
  await delay(10);
  assert.equal(activeTimers(), baseline, "the client left a timer behind");
  assert.deepEqual(unhandled, [], "a rejection went unhandled");
});

test("a broken stdout disconnects the client and reconnects with a new transport", async () => {
  const baseline = activeTimers();
  const { fakes, client } = setupWithFreshTransports({
    backoff: { baseMs: 10, maxMs: 10, jitter: 0 },
  });
  const errors: string[] = [];
  const disconnected: string[] = [];
  const reconnects: number[] = [];
  const connected: boolean[] = [];
  client.on("error", (error) => errors.push(error.code));
  client.on("disconnected", (payload) => disconnected.push(payload.reason));
  client.on("reconnect", (payload) => reconnects.push(payload.attempt));
  client.on("connected", (payload) => connected.push(payload.reconnected));
  try {
    await client.start();
    fakes[0].output.destroy();
    await waitFor(() => disconnected.length > 0, "the disconnection");
    assert.equal(disconnected[0], "the transport closed");
    await waitFor(() => reconnects.length > 0, "the reconnect");
    await waitFor(() => connected.length > 1, "the reconnected client");
    // The client took the lease again, over a fresh transport.
    assert.deepEqual(connected, [false, true]);
    assert.equal(fakes.length, 2);
    assert.deepEqual(errors, []);
  } finally {
    await client.stop();
  }
  await delay(10);
  assert.equal(activeTimers(), baseline, "the client left a timer behind");
  assert.deepEqual(unhandled, [], "a rejection went unhandled");
});

test("a throwing write reports write_failed and the client keeps running", async () => {
  const baseline = activeTimers();
  const { fake, client } = setup();
  const errors: { code: string; message: string }[] = [];
  client.on("error", (error) => errors.push(error));
  try {
    await client.start();
    const session = await client.open({ sid: "s1", bot });
    fake.stdin.broken = true;
    session.send({ text: "hi" });
    await waitFor(() => errors.length > 0, "the write error");
    assert.equal(errors[0].code, "write_failed");
    assert.match(errors[0].message, /the pipe is gone/);
    assert.equal(client.connected, true);
    // The pipe works again: the next frame goes through.
    fake.stdin.broken = false;
    session.send({ text: "again" });
    await waitFor(() => fake.of("send").length === 1, "the send after the failure");
  } finally {
    await client.stop();
  }
  await delay(10);
  assert.equal(activeTimers(), baseline, "the client left a timer behind");
  assert.deepEqual(unhandled, [], "a rejection went unhandled");
});

test("a throwing hello reports write_failed and the handshake times out", async () => {
  const baseline = activeTimers();
  const { fake, client } = setup({ handshakeTimeoutMs: 30 });
  const errors: { code: string; message: string }[] = [];
  client.on("error", (error) => errors.push(error));
  fake.stdin.broken = true;
  try {
    await assert.rejects(client.start(), /handshake timeout/);
    assert.equal(errors[0].code, "write_failed");
    assert.match(errors[0].message, /the pipe is gone/);
    assert.equal(client.connected, false);
  } finally {
    await client.stop();
  }
  await delay(10);
  assert.equal(activeTimers(), baseline, "the client left a timer behind");
  assert.deepEqual(unhandled, [], "a rejection went unhandled");
});

test("a reconnect that never gets a hello reports reconnect_failed and reschedules", async () => {
  const baseline = activeTimers();
  const { fakes, client } = setupWithSilentReconnect();
  const errors: { code: string; message: string }[] = [];
  const reconnects: { attempt: number; delayMs: number; reason: string }[] = [];
  client.on("error", (error) => errors.push(error));
  client.on("reconnect", (payload) => reconnects.push(payload));
  try {
    await client.start();
    fakes[0].output.destroy();
    await waitFor(
      () => errors.some((error) => error.code === "reconnect_failed"),
      "the failed reconnect",
    );
    const failure = errors.find((error) => error.code === "reconnect_failed");
    assert.ok(failure, "the client reported the failed reconnect");
    assert.match(failure.message, /handshake timeout/);
    // The client reschedules the reconnect after the failure.
    assert.ok(reconnects.length >= 2, "the client rescheduled the reconnect");
    assert.equal(reconnects[0].attempt, 1);
    assert.ok(
      reconnects.some((entry) => entry.attempt >= 2),
      "the client rescheduled the reconnect",
    );
    assert.ok(fakes.length >= 2, "the client built a second transport");
  } finally {
    await client.stop();
  }
  await delay(10);
  assert.equal(activeTimers(), baseline, "the client left a timer behind");
  assert.deepEqual(unhandled, [], "a rejection went unhandled");
});

test("a re-hello after an expired lease that stays silent reports handshake_failed", async () => {
  const baseline = activeTimers();
  const { fake, client } = setup({ handshakeTimeoutMs: 30 });
  fake.hellos = 1;
  const errors: { code: string; message: string }[] = [];
  client.on("error", (error) => errors.push(error));
  try {
    await client.start();
    fake.send({ op: "error", code: "lease_expired" });
    await waitFor(
      () => errors.some((error) => error.code === "handshake_failed"),
      "the failed handshake",
    );
    assert.deepEqual(
      errors.map((error) => error.code),
      ["lease_expired", "handshake_failed"],
    );
    assert.match(errors[1].message, /handshake timeout/);
    // The client asked for the lease again before it gave up.
    assert.equal(fake.of("hello").length, 2);
  } finally {
    await client.stop();
  }
  await delay(10);
  assert.equal(activeTimers(), baseline, "the client left a timer behind");
  assert.deepEqual(unhandled, [], "a rejection went unhandled");
});

test("stopping the client during a pending handshake leaves no rejection behind", async () => {
  const baseline = activeTimers();
  const { fakes, client } = setupWithSilentReconnect({ handshakeTimeoutMs: 5000 });
  const errors: string[] = [];
  client.on("error", (error) => errors.push(error.code));
  try {
    await client.start();
    fakes[0].output.destroy();
    await waitFor(() => fakes.length >= 2, "the reconnect");
    // The hello of the reconnect is still pending: the client stops.
    await client.stop();
  } finally {
    await client.stop();
  }
  await delay(20);
  assert.deepEqual(errors, [], "the stopped client reported an error");
  assert.deepEqual(unhandled, [], "a rejection went unhandled");
  assert.equal(activeTimers(), baseline, "the client left a timer behind");
});

// --- the defect the client still has ----------------------------------------

test("a broken stdout reports transport_error and not bad_json", async (t) => {
  t.todo("DEFECT: botd/src/client.ts reports the error of the stdout as bad_json");
  const { fake, client } = setup();
  const errors: { code: string; message: string }[] = [];
  client.on("error", (error) => errors.push(error));
  try {
    await client.start();
    fake.output.destroy(new Error("the daemon is gone"));
    await waitFor(() => errors.length > 0, "the transport error");
    assert.equal(errors[0].code, "transport_error");
    assert.match(errors[0].message, /the daemon is gone/);
  } finally {
    await client.stop();
  }
});
