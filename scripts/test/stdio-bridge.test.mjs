// scripts/test/stdio-bridge.test.mjs
//
// Tests of the ssh stdio bridge (scripts/botd-stdio-bridge.mjs).
//
// The fixtures are synthetic: the fake ssh is a local relay process, the host
// is an alias that exists nowhere and no hostname, address or credential
// shows up in this file.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { startBridge } from "../botd-stdio-bridge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bridgeScript = join(here, "..", "botd-stdio-bridge.mjs");

// The bridge speaks over a unix socket: the suite needs a posix host.
const skip = process.platform === "win32" ? "the bridge needs a unix socket" : false;

// Scratch space for the fixtures, inside the worktree.
const scratch = join(here, ".tmp");
mkdirSync(scratch, { recursive: true });

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The shebang of the fake ssh: the node of this run. */
const shebang = process.execPath.includes(" ") ? "#!/usr/bin/env node" : `#!${process.execPath}`;

/**
 * The fake ssh: a local relay that pretends to be a remote botd.
 *
 * Every frame that arrives on stdin is answered on stdout. Two frames make
 * the fake die, which is how the tests exercise the reconnect of the bridge.
 */
const FAKE_SSH_SOURCE = `${shebang}
// Fake ssh: a local relay that pretends to be a remote botd.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.FAKE_SSH_LOG;
if (log) {
  appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }) + "\\n");
}

let seq = 0;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim().length === 0) return;
  seq += 1;
  let frame = { raw: line };
  try {
    frame = JSON.parse(line);
  } catch {
    /* the tests only send json */
  }
  if (frame.op === "die") {
    process.exit(7);
  }
  if (frame.op === "half") {
    // A frame that the death of the connection cuts in half.
    process.stdout.write('{"op":"half"', () => process.exit(9));
    return;
  }
  process.stdout.write(JSON.stringify({ op: "echo", seq, pid: process.pid, frame }) + "\\n");
});
lines.on("close", () => process.exit(0));
`;

/** Write the fake ssh into a directory and return its path. */
function writeFakeSsh(directory) {
  const path = join(directory, "fake-ssh.mjs");
  writeFileSync(path, FAKE_SSH_SOURCE);
  chmodSync(path, 0o755);
  return path;
}

/** The calls the fake ssh recorded. */
function readSshLog(logFile) {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until the predicate returns something truthy, or fail. */
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await delay(intervalMs);
  }
}

/**
 * A client of the unix socket of the bridge.
 *
 * The client keeps every line it received; `next()` hands them out one by
 * one.
 */
function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.setEncoding("utf8");

    const lines = [];
    const waiters = [];
    let cursor = 0;
    let buffer = "";

    const deliver = () => {
      while (waiters.length > 0 && cursor < lines.length) {
        const waiter = waiters.shift();
        waiter.resolve(lines[cursor]);
        cursor += 1;
      }
    };

    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index === -1) break;
        lines.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
      deliver();
    });
    socket.on("error", reject);
    socket.on("close", () => {
      while (waiters.length > 0) {
        waiters.shift().reject(new Error("the socket closed before the frame arrived"));
      }
    });
    socket.on("connect", () => {
      resolve({
        socket,
        /** Every line the client received. */
        lines,
        /** Write raw text on the socket. */
        send(text) {
          socket.write(text);
        },
        /** Wait for the next line. */
        next(timeoutMs = 5000) {
          if (cursor < lines.length) {
            const line = lines[cursor];
            cursor += 1;
            return Promise.resolve(line);
          }
          return new Promise((resolveNext, rejectNext) => {
            const timer = setTimeout(() => {
              rejectNext(new Error(`timed out after ${timeoutMs}ms waiting for a frame`));
            }, timeoutMs);
            waiters.push({
              resolve: (line) => {
                clearTimeout(timer);
                resolveNext(line);
              },
              reject: (error) => {
                clearTimeout(timer);
                rejectNext(error);
              },
            });
          });
        },
      });
    });
  });
}

/** Start a bridge on a fresh socket and clean it up when the test ends. */
async function setup(t, options = {}) {
  const directory = mkdtempSync(join(scratch, "case-"));
  const fakeSsh = writeFakeSsh(directory);
  const logFile = join(directory, "ssh.log");
  const socketPath = join(directory, "bridge.sock");

  const previousLog = process.env.FAKE_SSH_LOG;
  process.env.FAKE_SSH_LOG = logFile;

  /** The messages the bridge logged. */
  const messages = [];

  const bridge = await startBridge({
    host: "host-a",
    socketPath,
    sshCommand: fakeSsh,
    reconnectDelayMs: 50,
    maxReconnectDelayMs: 200,
    log: (message) => messages.push(message),
    ...options,
  });

  t.after(async () => {
    await bridge.close();
    if (previousLog === undefined) delete process.env.FAKE_SSH_LOG;
    else process.env.FAKE_SSH_LOG = previousLog;
    rmSync(directory, { recursive: true, force: true });
  });

  return { bridge, directory, fakeSsh, logFile, messages, socketPath };
}

test("relays the frames of the client to the remote and back", { skip }, async (t) => {
  const { socketPath } = await setup(t);
  const client = await connect(socketPath);
  t.after(() => client.socket.destroy());

  client.send(`${JSON.stringify({ op: "hello", clientId: "client-1" })}\n`);
  const line = await client.next();
  const frame = JSON.parse(line);

  assert.equal(frame.op, "echo");
  assert.deepEqual(frame.frame, { op: "hello", clientId: "client-1" });
});

test("keeps the frames line aligned", { skip }, async (t) => {
  const { socketPath } = await setup(t);
  const client = await connect(socketPath);
  t.after(() => client.socket.destroy());

  // The frame arrives in two pieces: nothing goes out before its newline.
  client.send('{"op":"split"');
  await delay(200);
  assert.equal(client.lines.length, 0);

  client.send(',"value":1}\n');
  const line = await client.next();
  const frame = JSON.parse(line);

  assert.deepEqual(frame.frame, { op: "split", value: 1 });
  assert.equal(client.lines.length, 1);
});

test("reconnects when ssh exits and never splits a frame", { skip }, async (t) => {
  const { socketPath, logFile } = await setup(t);
  const client = await connect(socketPath);
  t.after(() => client.socket.destroy());

  // The remote dies in the middle of a frame.
  client.send(`${JSON.stringify({ op: "half" })}\n`);

  // The half frame never reaches the client.
  await waitFor(() => readSshLog(logFile).length >= 2, { label: "the second ssh" });
  await delay(100);
  assert.equal(client.lines.length, 0);

  // The relay works again, over the new ssh.
  client.send(`${JSON.stringify({ op: "hello", clientId: "client-2" })}\n`);
  const line = await client.next();
  const frame = JSON.parse(line);

  assert.equal(frame.op, "echo");
  assert.deepEqual(frame.frame, { op: "hello", clientId: "client-2" });
});

test("keeps the frames that wait for ssh", { skip }, async (t) => {
  const { socketPath, logFile, messages } = await setup(t, { reconnectDelayMs: 300 });
  const client = await connect(socketPath);
  t.after(() => client.socket.destroy());

  // The remote is gone.
  client.send(`${JSON.stringify({ op: "die" })}\n`);
  await waitFor(() => messages.some((message) => message.includes("ssh exited")), {
    label: "the death of ssh",
  });

  // The frame has no ssh to go to: it waits.
  client.send(`${JSON.stringify({ op: "queued" })}\n`);
  await delay(100);
  assert.equal(client.lines.length, 0);

  // The next ssh takes the frame that waited.
  await waitFor(() => readSshLog(logFile).length >= 2, { label: "the second ssh" });
  const line = await client.next();
  assert.deepEqual(JSON.parse(line).frame, { op: "queued" });
});

test("never splits a frame of the client when ssh is replaced", { skip }, async (t) => {
  const { socketPath, logFile, messages } = await setup(t, { reconnectDelayMs: 300 });
  const client = await connect(socketPath);
  t.after(() => client.socket.destroy());

  // The frame of the client is not complete yet.
  client.send('{"op":"partial"');

  // The ssh of the moment dies.
  const [first] = await waitFor(() => {
    const calls = readSshLog(logFile);
    return calls.length > 0 ? calls : undefined;
  }, { label: "the first ssh" });
  process.kill(first.pid, "SIGTERM");
  await waitFor(() => messages.some((message) => message.includes("ssh exited")), {
    label: "the death of ssh",
  });

  // The rest of the frame arrives: the whole frame goes to the next ssh.
  client.send("}\n");
  await waitFor(() => readSshLog(logFile).length >= 2, { label: "the second ssh" });

  const line = await client.next();
  assert.deepEqual(JSON.parse(line).frame, { op: "partial" });
  assert.equal(client.lines.length, 1);
});

test("removes the socket file when the bridge shuts down", { skip }, async (t) => {
  const { bridge, socketPath } = await setup(t);
  assert.ok(existsSync(socketPath));

  await bridge.close();
  assert.equal(existsSync(socketPath), false);
});

test("the command line bridges a host alias and the default command", { skip }, async (t) => {
  const directory = mkdtempSync(join(scratch, "cli-"));
  const fakeSsh = writeFakeSsh(directory);
  const logFile = join(directory, "ssh.log");
  const socketPath = join(directory, "bridge.sock");

  const child = spawn(process.execPath, [bridgeScript, "host-b", socketPath], {
    env: { ...process.env, BOTD_SSH: fakeSsh, FAKE_SSH_LOG: logFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();

  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    child.kill("SIGKILL");
    await exited;
    rmSync(directory, { recursive: true, force: true });
  });

  await waitFor(() => existsSync(socketPath), { label: "the socket file" });

  const client = await connect(socketPath);
  t.after(() => client.socket.destroy());
  client.send(`${JSON.stringify({ op: "ping" })}\n`);
  const line = await client.next();
  assert.deepEqual(JSON.parse(line).frame, { op: "ping" });

  // The ssh call carries the alias and the default command.
  const calls = readSshLog(logFile);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ["host-b", "botd serve"]);

  // A clean shutdown removes the socket file.
  child.kill("SIGTERM");
  await waitFor(() => !existsSync(socketPath), { label: "the removal of the socket file" });
  const code = await exited;
  assert.equal(code, 0);
});
