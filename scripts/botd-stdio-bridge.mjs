#!/usr/bin/env node
// scripts/botd-stdio-bridge.mjs
//
// Bridge between a local unix socket and a remote `botd serve` over ssh.
//
// The control plane speaks NDJSON to botd. botd runs on an executor host and
// is started as a forced command (`ssh <host> botd serve`), so the frames
// travel over the stdio of ssh. The bridge gives the control plane a plain
// local unix socket instead:
//
//   control plane <-- NDJSON --> unix socket <-- NDJSON --> ssh <--> botd
//
// The frames stay line aligned in both directions: a frame is forwarded only
// once its newline arrived, so a frame is never cut in half, not even when
// ssh dies in the middle of one. When ssh exits the bridge reconnects with a
// backoff; the socket stays up and the frames that waited in the meantime go
// out as soon as the new ssh is there.
//
// Usage:
//   node scripts/botd-stdio-bridge.mjs <ssh-alias> <socket-path>
//        [--command <remote command>] [--ssh <path>] [--reconnect-delay-ms <n>]
//
// Environment:
//   BOTD_SSH                 the ssh executable (default: ssh)
//   BOTD_COMMAND             the remote command (default: "botd serve")
//   BOTD_RECONNECT_DELAY_MS  the first backoff between two ssh attempts
//
// The host is an alias the operator passes on the command line: no host
// name, address or credential is stored in this file.
//
// Node 24, no dependencies: only the standard library is used.

import { spawn } from "node:child_process";
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

/** The remote command the bridge runs when the operator does not pick one. */
export const DEFAULT_COMMAND = "botd serve";

/** The ssh executable the bridge runs when the operator does not pick one. */
export const DEFAULT_SSH = "ssh";

/** The first backoff between two ssh attempts. */
const DEFAULT_RECONNECT_DELAY_MS = 250;

/** The longest backoff between two ssh attempts. */
const DEFAULT_MAX_RECONNECT_DELAY_MS = 5000;

/** How many frames the bridge keeps while no client is connected. */
const MAX_BACKLOG = 1000;

/** How long the bridge waits for the ssh child before it kills it. */
const KILL_GRACE_MS = 1000;

const USAGE = `Usage: botd-stdio-bridge.mjs <ssh-alias> <socket-path> [options]

Bridge a remote \`botd serve\` (reached over ssh) to a local unix socket.
The socket speaks NDJSON: one JSON object per line, in both directions.

Options:
  -c, --command <cmd>       the remote command (default: ${DEFAULT_COMMAND})
      --ssh <path>          the ssh executable (default: ${DEFAULT_SSH})
      --reconnect-delay-ms <n>
                            the first backoff between two ssh attempts
                            (default: ${DEFAULT_RECONNECT_DELAY_MS})
  -h, --help               print this help
`;

/**
 * A line reader over a byte stream.
 *
 * The reader is line oriented and tolerant of chunk boundaries: a line may
 * arrive in several chunks and one chunk may carry several lines. The
 * incomplete tail stays in the buffer until its newline arrives.
 *
 * @param {(line: string) => void} onLine
 */
function createLineReader(onLine) {
  let buffer = "";

  return {
    /** @param {string} chunk */
    push(chunk) {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index === -1) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        onLine(line);
      }
    },

    /** Drop the incomplete tail: the next stream starts a new frame. */
    reset() {
      buffer = "";
    },
  };
}

/**
 * A number from the environment, or undefined when it is not one.
 *
 * @param {string | undefined} value
 */
function envNumber(value) {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * The bridge itself: a unix socket in front of an ssh child.
 */
class Bridge {
  /**
   * @param {{
   *   host: string,
   *   socketPath: string,
   *   command?: string,
   *   sshCommand?: string,
   *   reconnectDelayMs?: number,
   *   maxReconnectDelayMs?: number,
   *   log?: (message: string) => void,
   * }} options
   */
  constructor(options) {
    this.host = options.host;
    this.socketPath = options.socketPath;
    this.command = options.command ?? process.env.BOTD_COMMAND ?? DEFAULT_COMMAND;
    this.sshCommand = options.sshCommand ?? process.env.BOTD_SSH ?? DEFAULT_SSH;
    this.reconnectDelayMs =
      options.reconnectDelayMs ??
      envNumber(process.env.BOTD_RECONNECT_DELAY_MS) ??
      DEFAULT_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    this.log = options.log ?? ((message) => process.stderr.write(`bridge: ${message}\n`));

    /** @type {import("node:net").Server | null} */
    this.server = null;
    /** @type {Set<import("node:net").Socket>} */
    this.clients = new Set();
    /** @type {Map<import("node:net").Socket, ReturnType<typeof createLineReader>>} */
    this.clientReaders = new Map();
    /** @type {import("node:child_process").ChildProcess | null} */
    this.ssh = null;
    /** @type {ReturnType<typeof createLineReader> | null} */
    this.sshReader = null;
    /** @type {Promise<void> | null} */
    this.sshExit = null;
    /** Complete lines that wait for ssh. @type {string[]} */
    this.outQueue = [];
    /** Complete lines that wait for a client. @type {string[]} */
    this.inQueue = [];
    this.attempt = 0;
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    this.closed = false;
  }

  /** Listen on the unix socket and start the first ssh. */
  async start() {
    await this.listen();
    this.spawnSsh();
    return this;
  }

  /** Open the unix socket; a stale socket file is replaced. */
  listen() {
    return new Promise((resolve, reject) => {
      if (existsSync(this.socketPath)) {
        const stat = lstatSync(this.socketPath);
        if (!stat.isSocket()) {
          reject(new Error(`${this.socketPath} exists and is not a socket`));
          return;
        }
        unlinkSync(this.socketPath);
      }

      const server = createServer((socket) => this.onClient(socket));
      this.server = server;
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve(undefined);
      });
    });
  }

  /** Start an ssh child and wire its stdio to the bridge. */
  spawnSsh() {
    if (this.closed) return;

    const child = spawn(this.sshCommand, [this.host, this.command], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.ssh = child;

    const reader = createLineReader((line) => this.onSshLine(line));
    this.sshReader = reader;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      // The connection works: the backoff starts over.
      this.attempt = 0;
      reader.push(chunk);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        if (line.trim().length > 0) this.log(`ssh: ${line}`);
      }
    });

    // The child may be gone already: a broken pipe is not a bridge failure.
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      this.sshExit = null;
      this.onSshDown(code, signal);
    };
    this.sshExit = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        finish(code, signal);
        resolve(undefined);
      });
    });
    child.on("error", (error) => {
      this.log(`ssh could not be started: ${error instanceof Error ? error.message : error}`);
      finish(null, null);
    });

    // The frames that waited for ssh go out now, in order.
    this.flushOutQueue();
  }

  /** The ssh child is gone: forget it and plan the next attempt. */
  onSshDown(code, signal) {
    if (this.ssh) {
      this.ssh = null;
      // The tail of the dead stream is not a frame: drop it, the next ssh
      // starts a new frame.
      this.sshReader?.reset();
      this.sshReader = null;
    }
    if (this.closed) return;
    const how = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    this.log(`ssh exited (${how})`);
    this.scheduleReconnect();
  }

  /** Try ssh again, waiting longer after every attempt. */
  scheduleReconnect() {
    if (this.closed || this.timer) return;
    const delay = Math.min(this.reconnectDelayMs * 2 ** this.attempt, this.maxReconnectDelayMs);
    this.attempt += 1;
    this.log(`reconnecting in ${delay}ms`);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.spawnSsh();
    }, delay);
  }

  /** A client of the socket connected. */
  onClient(socket) {
    socket.setEncoding("utf8");
    const reader = createLineReader((line) => this.onClientLine(line));
    this.clientReaders.set(socket, reader);
    this.clients.add(socket);

    socket.on("data", (chunk) => reader.push(chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      this.clients.delete(socket);
      this.clientReaders.delete(socket);
    });

    // The frames that arrived while nobody was connected go out now.
    if (this.clients.size === 1 && this.inQueue.length > 0) {
      const queued = this.inQueue;
      this.inQueue = [];
      for (const line of queued) socket.write(`${line}\n`);
    }
  }

  /** A complete frame arrived from a client. */
  onClientLine(line) {
    if (line.length === 0) return;
    // The queue keeps the order: the frames that wait go out first.
    this.outQueue.push(line);
    this.flushOutQueue();
  }

  /** Send the frames that wait for ssh, oldest first. */
  flushOutQueue() {
    while (this.outQueue.length > 0) {
      const child = this.ssh;
      if (!child) return;
      try {
        child.stdin.write(`${this.outQueue[0]}\n`);
      } catch {
        // The child is gone: the frames wait for the next ssh.
        return;
      }
      this.outQueue.shift();
    }
  }

  /** A complete frame arrived from ssh. */
  onSshLine(line) {
    if (line.length === 0) return;
    if (this.clients.size === 0) {
      // No client yet: keep the frame, it goes out to the next one.
      this.inQueue.push(line);
      while (this.inQueue.length > MAX_BACKLOG) this.inQueue.shift();
      return;
    }
    const payload = `${line}\n`;
    for (const client of this.clients) client.write(payload);
  }

  /** Stop the bridge: the socket file goes away with it. */
  async close() {
    if (this.closed) return;
    this.closed = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const child = this.ssh;
    const exited = this.sshExit;
    this.ssh = null;
    this.sshReader = null;
    if (child) {
      try {
        child.stdin.end();
      } catch {
        /* already gone */
      }
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      const killer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
      killer.unref?.();
      if (exited) await exited;
      clearTimeout(killer);
    }

    for (const client of this.clients) client.destroy();
    this.clients.clear();
    this.clientReaders.clear();
    this.outQueue = [];
    this.inQueue = [];

    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }

    removeSocketFile(this.socketPath);
  }
}

/**
 * Remove the socket file of the bridge.
 *
 * @param {string} socketPath
 */
function removeSocketFile(socketPath) {
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    /* the file is gone already */
  }
}

/**
 * Start the bridge and wait until the socket accepts connections.
 *
 * @param {{
 *   host: string,
 *   socketPath: string,
 *   command?: string,
 *   sshCommand?: string,
 *   reconnectDelayMs?: number,
 *   maxReconnectDelayMs?: number,
 *   log?: (message: string) => void,
 * }} options
 */
export async function startBridge(options) {
  const bridge = new Bridge(options);
  await bridge.start();
  return bridge;
}

/**
 * The value of an option, or an error when the value is missing.
 *
 * @param {string[]} argv
 * @param {number} index the position of the option
 * @param {string} option the name of the option
 */
function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`missing the value of ${option}`);
  }
  return value;
}

/**
 * Parse the command line of the bridge.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = {
    host: "",
    socketPath: "",
    command: undefined,
    sshCommand: undefined,
    reconnectDelayMs: undefined,
    help: false,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--command" || arg === "-c") {
      options.command = requireValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--command=")) {
      options.command = arg.slice("--command=".length);
    } else if (arg === "--ssh") {
      options.sshCommand = requireValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--ssh=")) {
      options.sshCommand = arg.slice("--ssh=".length);
    } else if (arg === "--reconnect-delay-ms") {
      options.reconnectDelayMs = Number(requireValue(argv, index, arg));
      index += 1;
    } else if (arg.startsWith("--reconnect-delay-ms=")) {
      options.reconnectDelayMs = Number(arg.slice("--reconnect-delay-ms=".length));
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const [host, socketPath, ...rest] = positional;
  options.host = host ?? "";
  options.socketPath = socketPath ?? "";
  if (rest.length > 0) {
    throw new Error(`unexpected argument: ${rest[0]}`);
  }
  return options;
}

/**
 * Run the bridge from the command line.
 *
 * @param {string[]} argv
 */
async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`bridge: ${error instanceof Error ? error.message : error}\n`);
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!options.host || !options.socketPath) {
    process.stderr.write("bridge: missing the ssh alias or the socket path\n");
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  if (
    options.reconnectDelayMs !== undefined &&
    (!Number.isFinite(options.reconnectDelayMs) || options.reconnectDelayMs < 0)
  ) {
    process.stderr.write("bridge: the reconnect delay must be a positive number\n");
    process.exitCode = 2;
    return;
  }

  let bridge;
  try {
    bridge = await startBridge({
      host: options.host,
      socketPath: options.socketPath,
      command: options.command,
      sshCommand: options.sshCommand,
      reconnectDelayMs: options.reconnectDelayMs,
    });
  } catch (error) {
    process.stderr.write(
      `bridge: cannot start: ${error instanceof Error ? error.message : error}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const stop = () => {
    void bridge.close().then(() => {
      process.exitCode = 0;
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
if (isMain) {
  await main(process.argv.slice(2));
}
