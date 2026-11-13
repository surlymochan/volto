// Tests for the permission answers and the reconnect of the relay.
//
// The relay is driven the way the panel drives it: a command host that runs
// the real bot daemon (botd/src/client.ts#daemonCommand), a fake provider
// binary named "codex" on the PATH that speaks the app-server protocol of
// botd/src/adapters/codex.ts, and plain fetch calls against the local API.
//
// The fake provider logs every line it receives, so a test can check that an
// answer of the panel really reached the provider. It also writes its own
// pid and the pid of its parent (the daemon) to a file, so a test can kill
// the daemon of a host.
//
// Every test starts its own relay with its own daemon and its own provider;
// the tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startRelay } from "../relay.mjs";
import { daemonCommand } from "../../botd/src/client.ts";

/** Scratch directory of the tests; client-ui/.gitignore ignores it. */
const SCRATCH = fileURLToPath(new URL("../.tmp/", import.meta.url));

/** The deadline of every wait of the tests. */
const DEADLINE_MS = 10_000;

/** The id of the approval the fake provider asks for. */
const PERMISSION_ID = 77;

/**
 * The fake provider of the tests.
 *
 * It speaks the app-server protocol of the codex adapter: it answers
 * `initialize` and `thread/start` and asks for one approval right after the
 * thread was started. Every line it receives is logged, so a test can see
 * that an answer of the relay reached the provider.
 */
const PROVIDER_SOURCE = `import fs from "node:fs";

const logFile = process.env.VOLTO_PROVIDER_LOG;
const pidFile = process.env.VOLTO_PROVIDER_PID;
const permissionId = Number(process.env.VOLTO_PROVIDER_PERMISSION || "${PERMISSION_ID}");

function log(entry) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, JSON.stringify(entry) + "\\n");
  } catch {
    // The log is a convenience of the tests, never a requirement.
  }
}

function write(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}

const pids = { pid: process.pid, ppid: process.ppid };
log({ event: "start", pid: pids.pid, ppid: pids.ppid });
try {
  if (pidFile) fs.appendFileSync(pidFile, JSON.stringify(pids) + "\\n");
} catch {
  // The pid file is a convenience of the tests, never a requirement.
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index === -1) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    log({ event: "recv", line });
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    const method = frame && typeof frame === "object" ? frame.method : undefined;
    const id = frame && typeof frame === "object" && frame.id !== undefined ? frame.id : null;
    if (method === "initialize") {
      write({ id: id, result: {} });
    } else if (method === "thread/start" || method === "thread/resume") {
      write({ id: id, result: { thread: { id: "thread-1" } } });
      write({
        id: permissionId,
        method: "item/commandExecution/requestApproval",
        params: { command: ["ls"] },
      });
    }
  }
});
`;

/** A bot of a host as the relay reports it. */
type Bot = { id: string; kind: string; status: string; sessionId: string | null };

/** An event of the stream of a session. */
type SessionEvent = { kind: string; permissionId?: string; [key: string]: unknown };

/** The pids of a provider: its own and the one of its parent. */
type Pids = { pid: number; ppid: number };

/** Waits until `predicate` returns a value; the deadline is ten seconds. */
const waitFor = async <T>(
  predicate: () => Promise<T | false | null | undefined>,
  message = "timed out waiting for the relay",
): Promise<T> => {
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Posts a JSON body to the relay. */
const post = (base: string, path: string, data?: unknown) =>
  fetch(base + path, {
    method: "POST",
    ...(data === undefined
      ? {}
      : { body: JSON.stringify(data), headers: { "content-type": "application/json" } }),
  });

/** The bots of a host. */
const botsOf = async (base: string, alias: string): Promise<Bot[]> =>
  (await (await fetch(`${base}/api/hosts/${alias}/bots`)).json()) as Bot[];

/** The lines the fake provider logged so far. */
const providerLines = async (file: string): Promise<string[]> => {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").filter((line) => line.trim().length > 0);
};

/** The frames the fake provider received, oldest first. */
const providerFrames = async (file: string): Promise<Record<string, unknown>[]> => {
  const frames: Record<string, unknown>[] = [];
  for (const line of await providerLines(file)) {
    const entry = JSON.parse(line) as { event?: string; line?: string };
    if (entry.event !== "recv") continue;
    try {
      frames.push(JSON.parse(entry.line ?? "") as Record<string, unknown>);
    } catch {
      // A line that is no JSON is not a frame of the provider.
    }
  }
  return frames;
};

/** The pids every provider of the tests wrote down. */
const providerPids = async (file: string): Promise<Pids[]> => {
  const pids: Pids[] = [];
  for (const line of await providerLines(file)) {
    try {
      pids.push(JSON.parse(line) as Pids);
    } catch {
      // A line that is no JSON is not a pid of a provider.
    }
  }
  return pids;
};

/** Reads the events of a session until one of them matches. */
const nextEvent = async (
  base: string,
  sessionId: string,
  match: (event: SessionEvent) => boolean,
): Promise<SessionEvent> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  try {
    const response = await fetch(`${base}/api/sessions/${sessionId}/events`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index !== -1) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const line = chunk.split("\n").find((entry) => entry.startsWith("data: "));
        if (line) {
          const event = JSON.parse(line.slice("data: ".length)) as SessionEvent;
          if (match(event)) return event;
        }
        index = buffer.indexOf("\n\n");
      }
    }
    throw new Error("the event stream ended before the event arrived");
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      throw new Error("timed out waiting for the event of the session");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
};

/**
 * Removes the scratch directory of a test.
 *
 * A daemon that is still shutting down writes its session table and creates
 * its home directory again, so the directory is removed until it stays gone.
 */
const removeDir = async (dir: string): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const gone = await stat(dir).then(
      () => false,
      () => true,
    );
    if (gone) return;
  }
  throw new Error(`the scratch directory ${dir} is still there`);
};

/** A relay with one host that runs a real daemon and a fake provider. */
type Harness = {
  base: string;
  providerLog: string;
  providerPidFile: string;
  cleanup: () => Promise<void>;
};

/** Starts a relay with a command host that runs the real daemon. */
const startHarness = async (alias = "test"): Promise<Harness> => {
  await mkdir(SCRATCH, { recursive: true });
  const dir = await mkdtemp(join(SCRATCH, "relay-permission-"));
  const provider = join(dir, "provider.mjs");
  await writeFile(provider, PROVIDER_SOURCE);
  const binary = join(dir, "codex");
  await writeFile(binary, `#!${process.execPath}\nimport ${JSON.stringify(provider)};\n`);
  await chmod(binary, 0o755);
  const providerLog = join(dir, "provider.ndjson");
  const providerPidFile = join(dir, "provider.pid");
  const oldPath = process.env.PATH;
  const oldLog = process.env.VOLTO_PROVIDER_LOG;
  const oldPid = process.env.VOLTO_PROVIDER_PID;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  process.env.VOLTO_PROVIDER_LOG = providerLog;
  process.env.VOLTO_PROVIDER_PID = providerPidFile;
  const relay = await startRelay({
    hosts: [
      {
        alias,
        command: [
          ...daemonCommand({ home: join(dir, "home") }),
          "--cancel-grace-ms=100",
          "--cancel-kill-grace-ms=100",
        ],
      },
    ],
  });
  const base = relay.url.replace(/\/$/, "");
  const cleanup = async () => {
    relay.server.closeAllConnections();
    await new Promise<void>((resolveClose) => relay.server.close(() => resolveClose()));
    // A provider of a daemon that was killed outlives it: it is stopped here.
    for (const pids of await providerPids(providerPidFile)) {
      try {
        process.kill(pids.pid, "SIGKILL");
      } catch {
        // The provider is gone already.
      }
    }
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldLog === undefined) delete process.env.VOLTO_PROVIDER_LOG;
    else process.env.VOLTO_PROVIDER_LOG = oldLog;
    if (oldPid === undefined) delete process.env.VOLTO_PROVIDER_PID;
    else process.env.VOLTO_PROVIDER_PID = oldPid;
    await removeDir(dir);
  };
  return { base, providerLog, providerPidFile, cleanup };
};

/** Connects the host and opens a session on its codex bot. */
const openSession = async (base: string, alias = "test"): Promise<string> => {
  assert.equal((await post(base, `/api/hosts/${alias}/connect`)).status, 204);
  const opened = await post(base, `/api/hosts/${alias}/sessions`, {
    kind: "codex",
    cwd: process.cwd(),
  });
  assert.equal(opened.status, 200);
  const { sessionId } = (await opened.json()) as { sessionId: string };
  return sessionId;
};

/** Waits for the permission the fake provider asks for. */
const permissionOf = async (base: string, sessionId: string): Promise<string> => {
  const event = await nextEvent(base, sessionId, (entry) => entry.kind === "permission");
  assert.ok(event.permissionId, "the permission event carries an id");
  return String(event.permissionId);
};

/** Kills the daemon of the host and waits until the relay noticed. */
const killDaemon = async (harness: Harness): Promise<void> => {
  const pids = await waitFor(
    async () => (await providerPids(harness.providerPidFile)).at(-1) ?? false,
    "the fake provider did not start",
  );
  process.kill(pids.ppid, "SIGKILL");
  await waitFor(
    async () => (await botsOf(harness.base, "test")).every((bot) => bot.status === "down"),
    "the bots of the host did not go down",
  );
};

test("an unknown permission id is answered with 404", async () => {
  const harness = await startHarness();
  try {
    const response = await post(harness.base, "/api/permissions/does-not-exist", { allow: true });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "not_found");
  } finally {
    await harness.cleanup();
  }
});

test("a permission answer without a boolean allow is refused with 400", async () => {
  const harness = await startHarness();
  try {
    const sessionId = await openSession(harness.base);
    const permissionId = await permissionOf(harness.base, sessionId);
    const missing = await post(harness.base, `/api/permissions/${permissionId}`, {});
    assert.equal(missing.status, 400);
    assert.equal(((await missing.json()) as { error: { code: string } }).error.code, "invalid_body");
    const wrong = await post(harness.base, `/api/permissions/${permissionId}`, { allow: "yes" });
    assert.equal(wrong.status, 400);
    assert.equal(((await wrong.json()) as { error: { code: string } }).error.code, "invalid_body");
    // The permission is still open: a refused answer does not consume it.
    assert.equal((await post(harness.base, `/api/permissions/${permissionId}`, { allow: true })).status, 204);
  } finally {
    await harness.cleanup();
  }
});

test("the answer of a permission reaches the provider", async () => {
  const harness = await startHarness();
  try {
    const sessionId = await openSession(harness.base);
    const permissionId = await permissionOf(harness.base, sessionId);
    assert.equal((await post(harness.base, `/api/permissions/${permissionId}`, { allow: true })).status, 204);
    const answer = await waitFor(
      async () =>
        (await providerFrames(harness.providerLog)).find(
          (frame) =>
            frame.id === PERMISSION_ID &&
            (frame.result as { decision?: string } | undefined)?.decision === "accept",
        ) ?? false,
      "the provider did not receive the answer of the permission",
    );
    assert.deepEqual(answer, { id: PERMISSION_ID, result: { decision: "accept" } });
  } finally {
    await harness.cleanup();
  }
});

test("a denied permission reaches the provider as a decline", async () => {
  const harness = await startHarness();
  try {
    const sessionId = await openSession(harness.base);
    const permissionId = await permissionOf(harness.base, sessionId);
    assert.equal((await post(harness.base, `/api/permissions/${permissionId}`, { allow: false })).status, 204);
    const answer = await waitFor(
      async () =>
        (await providerFrames(harness.providerLog)).find(
          (frame) =>
            frame.id === PERMISSION_ID &&
            (frame.result as { decision?: string } | undefined)?.decision === "decline",
        ) ?? false,
      "the provider did not receive the denial of the permission",
    );
    assert.deepEqual(answer, { id: PERMISSION_ID, result: { decision: "decline" } });
  } finally {
    await harness.cleanup();
  }
});

test("a permission can be answered only once", async () => {
  const harness = await startHarness();
  try {
    const sessionId = await openSession(harness.base);
    const permissionId = await permissionOf(harness.base, sessionId);
    assert.equal((await post(harness.base, `/api/permissions/${permissionId}`, { allow: true })).status, 204);
    const again = await post(harness.base, `/api/permissions/${permissionId}`, { allow: true });
    assert.equal(again.status, 404);
    assert.equal(((await again.json()) as { error: { code: string } }).error.code, "not_found");
  } finally {
    await harness.cleanup();
  }
});

test("the bots of a host go down when its daemon dies", async () => {
  const harness = await startHarness();
  try {
    await openSession(harness.base);
    await killDaemon(harness);
    const bots = await botsOf(harness.base, "test");
    assert.ok(bots.length > 0);
    assert.ok(bots.every((bot) => bot.status === "down"));
  } finally {
    await harness.cleanup();
  }
});

test(
  "the bots of a host stay down until the host is connected again",
  {
    todo: "the relay connects the host on its own: the client of botd/src/client.ts retries after a broken transport, so the bots are idle again a moment after the daemon died",
  },
  async () => {
    const harness = await startHarness();
    try {
      await openSession(harness.base);
      await killDaemon(harness);
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        const bots = await botsOf(harness.base, "test");
        assert.ok(
          bots.every((bot) => bot.status === "down"),
          "the bots of the host left the down state without a connect",
        );
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await harness.cleanup();
    }
  },
);

test("a session of a dead daemon cannot be used any more", async () => {
  const harness = await startHarness();
  try {
    const sessionId = await openSession(harness.base);
    await killDaemon(harness);
    const response = await post(harness.base, `/api/sessions/${sessionId}/send`, { text: "hello" });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { error: { code: string } };
    assert.ok(["session_ended", "disconnected"].includes(body.error.code));
  } finally {
    await harness.cleanup();
  }
});

test("a host can be connected again after its daemon died", async () => {
  const harness = await startHarness();
  try {
    await openSession(harness.base);
    await killDaemon(harness);
    assert.equal((await post(harness.base, "/api/hosts/test/connect")).status, 204);
    await waitFor(
      async () => (await botsOf(harness.base, "test")).every((bot) => bot.status === "idle"),
      "the bots of the host did not become idle",
    );
    const opened = await post(harness.base, "/api/hosts/test/sessions", {
      kind: "codex",
      cwd: process.cwd(),
    });
    assert.equal(opened.status, 200);
  } finally {
    await harness.cleanup();
  }
});

test("a session of a disconnected host cannot be used any more", async () => {
  const harness = await startHarness();
  try {
    const sessionId = await openSession(harness.base);
    assert.equal((await post(harness.base, "/api/hosts/test/disconnect")).status, 204);
    const response = await post(harness.base, `/api/sessions/${sessionId}/send`, { text: "hello" });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { error: { code: string } };
    assert.ok(["session_ended", "disconnected"].includes(body.error.code));
  } finally {
    await harness.cleanup();
  }
});
