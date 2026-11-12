// probes/bots/codex.mjs
//
// Codex machine protocol: `codex app-server` speaks JSON-RPC 2.0 over stdio
// with newline delimited JSON. Session = thread, prompt = turn, cancel =
// turn/interrupt.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createJsonRpcPeer } from "../lib/jsonrpc.mjs";
import { resolveBinary } from "../lib/binary.mjs";
import { runCommand, spawnChild } from "../lib/process.mjs";
import { createResult, markNotProbed } from "../lib/result.mjs";

const PROMPT = "Reply with the single word PONG";
const CANCEL_PROMPT = "Count slowly from 1 to 20, one number per line.";

/** Collect every method name declared by the generated app-server schema. */
async function readSchemaMethods(schemaDir) {
  /** @param {string} file */
  async function methodsOf(file) {
    try {
      const raw = await readFile(join(schemaDir, file), "utf8");
      const json = JSON.parse(raw);
      /** @type {string[]} */
      const found = [];
      const walk = (node) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (node.properties?.method?.enum && Array.isArray(node.properties.method.enum)) {
          found.push(...node.properties.method.enum);
        }
        Object.values(node).forEach(walk);
      };
      walk(json);
      return [...new Set(found)].sort();
    } catch {
      return [];
    }
  }
  const [requests, notifications, serverRequests] = await Promise.all([
    methodsOf("ClientRequest.json"),
    methodsOf("ServerNotification.json"),
    methodsOf("ServerRequest.json"),
  ]);
  return { requests, notifications, serverRequests };
}

/**
 * @param {import("../lib/result.mjs").ProbeResult} result
 * @param {string} text
 */
function note(result, text) {
  result.notes.push(text);
}

/**
 * @param {{
 *   tmpDir: string,
 *   timeoutMs: number,
 *   transcript: { record: (dir: string, kind: string, data: unknown) => void },
 * }} ctx
 */
export async function run(ctx) {
  const result = createResult({
    id: "codex",
    label: "Codex",
    command: "codex",
  });
  result.protocol.name = "JSON-RPC 2.0 (app-server)";
  result.protocol.transport = "stdio";
  result.protocol.framing = "newline-delimited JSON";
  result.protocol.sessionCreate.method = "thread/start";
  result.protocol.cancel.method = "turn/interrupt";
  result.protocol.resume.method = "thread/resume";
  result.protocol.permissions.shape =
    "server->client requests: item/commandExecution/requestApproval, item/fileChange/requestApproval, item/permissions/requestApproval, item/tool/requestUserInput; approval answer: { decision: 'accept'|'acceptForSession'|'decline'|'cancel' }";

  const binary = resolveBinary("codex");
  result.binary.available = Boolean(binary.path);
  if (!binary.path) {
    result.status = "skipped";
    result.reason = "binary not found on PATH";
    note(result, "Install the Codex CLI to run this probe.");
    markNotProbed(result);
    return result;
  }
  result.binary.path = binary.path;

  const version = await runCommand({ command: binary.path, args: ["--version"], timeoutMs: 15_000 });
  result.binary.version = (version.stdout || version.stderr).trim().split("\n")[0] || "unknown";

  // --- auth preflight (never passes credentials, only asks the CLI) ------
  const login = await runCommand({
    command: binary.path,
    args: ["login", "status"],
    timeoutMs: 20_000,
  });
  const loginText = `${login.stdout}${login.stderr}`.trim();
  const loggedIn = /logged in/i.test(loginText) && !/not logged in/i.test(loginText);
  result.auth.state = loggedIn ? "logged-in" : "not-logged-in";
  result.auth.evidence = loginText.split("\n")[0] || "no output";

  // --- method inventory from the generated protocol schema ---------------
  const schemaDir = join(ctx.tmpDir, "codex-schema");
  const schema = await runCommand({
    command: binary.path,
    args: ["app-server", "generate-json-schema", "--experimental", "--out", schemaDir],
    timeoutMs: 45_000,
  });
  if (schema.code === 0) {
    const methods = await readSchemaMethods(schemaDir);
    result.methods.requests = methods.requests;
    result.methods.notifications = methods.notifications;
    result.methods.serverRequests = methods.serverRequests;
    note(
      result,
      `Method inventory taken from \`codex app-server generate-json-schema\`: ${methods.requests.length} client requests, ${methods.notifications.length} server notifications, ${methods.serverRequests.length} server requests.`,
    );
  } else {
    note(result, "`codex app-server generate-json-schema` was unavailable; only observed methods are listed.");
  }

  // --- start the app-server ----------------------------------------------
  const started = Date.now();
  /** @type {Set<string>} */
  const seenEvents = new Set();
  /** @type {Set<string>} */
  const completedTurns = new Set();
  /** @type {Map<string, string>} */
  const turnStatus = new Map();
  let firstOutputMs = null;
  let promptSentAt = null;
  let deltaCount = 0;
  let agentMessageCount = 0;
  /** @type {any[]} */
  const approvalRequests = [];

  /**
   * Wait until a concrete turn reports completion.
   *
   * @param {string|null} turnId
   * @param {number} ms
   */
  async function waitForTurn(turnId, ms) {
    if (!turnId) return false;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (completedTurns.has(turnId)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return completedTurns.has(turnId);
  }

  const child = spawnChild({
    command: binary.path,
    args: ["app-server"],
    cwd: ctx.tmpDir,
    onStdoutLine: (line) => {
      ctx.transcript.record("out", "line", line);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      peer.handle(message);
    },
    onStderrLine: (line) => ctx.transcript.record("err", "line", line),
  });
  ctx.onChild?.(child);

  const peer = createJsonRpcPeer({
    send: (payload) => {
      ctx.transcript.record("in", "line", payload);
      try {
        child.child.stdin.write(payload + "\n");
      } catch {
        /* stdin closed */
      }
    },
    onNotification: (method, params) => {
      seenEvents.add(method);
      if (method === "turn/completed") {
        const id = params?.turn?.id ?? params?.turnId ?? null;
        if (id) {
          completedTurns.add(id);
          if (params?.turn?.status) turnStatus.set(id, params.turn.status);
        }
      }
      if (method === "item/agentMessage/delta") {
        deltaCount += 1;
        if (firstOutputMs === null && promptSentAt !== null) firstOutputMs = Date.now() - promptSentAt;
      }
      if (method === "item/completed" && params?.item?.type === "agentMessage") {
        agentMessageCount += 1;
        if (firstOutputMs === null && promptSentAt !== null) firstOutputMs = Date.now() - promptSentAt;
      }
    },
    onServerRequest: (method, params, message) => {
      approvalRequests.push({ method, params });
      // Decline everything: the probe must never approve a tool call.
      try {
        if (method.endsWith("/requestApproval")) {
          peer.respond(message.id, { decision: "decline" });
        } else if (method === "item/permissions/requestApproval") {
          peer.respond(message.id, { permissions: null, scope: "turn" });
        } else if (method === "item/tool/requestUserInput") {
          peer.respond(message.id, { answers: {} });
        } else {
          peer.respondError(message.id, -32601, "volto-probe declines server requests");
        }
      } catch {
        /* ignore */
      }
    },
  });

  try {
    // --- initialize ------------------------------------------------------
    const t0 = Date.now();
    const init = await peer.request(
      "initialize",
      { clientInfo: { name: "volto-probe", version: "0.0.1" }, capabilities: {} },
      { timeoutMs: Math.min(20_000, ctx.timeoutMs) },
    );
    result.timings.initializeMs = Date.now() - t0;
    peer.notify("initialized", {});
    note(result, `initialize handshake ok, server reported ${init?.appServerVersion ?? init?.userAgent ?? "an agent"}.`);

    // --- in-protocol auth state -----------------------------------------
    try {
      const account = await peer.request("account/read", {}, { timeoutMs: 10_000 });
      result.auth.evidence = `account/read -> requiresOpenaiAuth=${account?.requiresOpenaiAuth}, accountType=${account?.account?.type ?? "none"}`;
      if (account?.account) result.auth.state = "logged-in";
      else if (account?.requiresOpenaiAuth === true) result.auth.state = "not-logged-in";
    } catch (error) {
      note(result, `account/read failed: ${error.message}`);
    }

    // --- new session (thread) -------------------------------------------
    const t1 = Date.now();
    const thread = await peer.request(
      "thread/start",
      { cwd: ctx.tmpDir, approvalPolicy: "never", sandbox: "read-only", ephemeral: false },
      { timeoutMs: Math.min(30_000, ctx.timeoutMs) },
    );
    result.timings.sessionCreateMs = Date.now() - t1;
    const threadId = thread?.thread?.id ?? thread?.threadId ?? null;
    result.protocol.sessionCreate.supported = Boolean(threadId);
    result.protocol.sessionCreate.detail = threadId
      ? `thread/start returned a thread id (sessionId ${thread?.thread?.sessionId ? "present" : "absent"})`
      : "thread/start returned no thread id";
    if (!threadId) {
      result.status = "failed";
      result.reason = "thread/start did not return a thread id";
      return result;
    }

    // --- first prompt ----------------------------------------------------
    const t2 = Date.now();
    promptSentAt = Date.now();
    const turn = await peer.request(
      "turn/start",
      { threadId, input: [{ type: "text", text: PROMPT }] },
      { timeoutMs: Math.min(30_000, ctx.timeoutMs) },
    );
    const turnId = turn?.turn?.id ?? null;
    const turnFinished = await waitForTurn(turnId, loggedIn ? 60_000 : 20_000);
    result.timings.promptMs = Date.now() - t2;
    result.timings.firstOutputMs = firstOutputMs;
    result.protocol.streaming.granularity = deltaCount > 0 ? "token-delta" : agentMessageCount > 0 ? "message" : "none";
    result.protocol.streaming.samples = deltaCount;
    result.protocol.streaming.detail =
      deltaCount > 0
        ? `${deltaCount} item/agentMessage/delta notifications`
        : agentMessageCount > 0
          ? `${agentMessageCount} item/completed(agentMessage) notifications, no deltas`
          : "no assistant output observed";
    if (!turnFinished) {
      note(result, "turn/completed did not arrive within the probe budget (expected when the CLI is not authenticated).");
    }

    // --- cancel test on a second prompt ----------------------------------
    if (turnId) {
      const t3 = Date.now();
      try {
        const turn2 = await peer.request(
          "turn/start",
          { threadId, input: [{ type: "text", text: CANCEL_PROMPT }] },
          { timeoutMs: Math.min(20_000, ctx.timeoutMs) },
        );
        const turn2Id = turn2?.turn?.id;
        await new Promise((resolve) => setTimeout(resolve, 400));
        await peer.request("turn/interrupt", { threadId, turnId: turn2Id }, { timeoutMs: 10_000 });
        const cancelled = await waitForTurn(turn2Id, 15_000);
        result.timings.cancelMs = Date.now() - t3;
        result.protocol.cancel.works = cancelled ? true : null;
        result.protocol.cancel.detail = cancelled
          ? `turn/interrupt accepted, the turn reported status '${turnStatus.get(turn2Id) ?? "unknown"}'`
          : "turn/interrupt accepted but the turn never reported turn/completed (the turn produced no output at all, so the cancel could not be observed)";
      } catch (error) {
        result.timings.cancelMs = Date.now() - t3;
        result.protocol.cancel.works = false;
        result.protocol.cancel.detail = `turn/interrupt failed: ${error.message}`;
      }
    } else {
      result.protocol.cancel.works = null;
      result.protocol.cancel.detail = "no turn id available";
    }

    // --- resume / load ---------------------------------------------------
    try {
      const resumed = await peer.request(
        "thread/resume",
        { threadId },
        { timeoutMs: Math.min(20_000, ctx.timeoutMs) },
      );
      result.protocol.resume.supported = Boolean(resumed);
      result.protocol.resume.detail = "thread/resume accepted for the current thread";
    } catch (error) {
      result.protocol.resume.supported = result.methods.requests.includes("thread/resume") ? null : false;
      result.protocol.resume.detail = `thread/resume failed: ${error.message}`;
    }

    result.protocol.permissions.observed = approvalRequests.map((r) => r.method);
  } catch (error) {
    result.status = "failed";
    result.reason = error.message;
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    result.timings.totalMs = Date.now() - started;
    const observedNotifications = [...seenEvents];
    const missing = observedNotifications.filter((m) => !result.methods.notifications.includes(m));
    if (missing.length) result.methods.notifications = [...result.methods.notifications, ...missing].sort();
    const missingRequests = approvalRequests.map((r) => r.method).filter((m) => !result.methods.serverRequests.includes(m));
    if (missingRequests.length) result.methods.serverRequests = [...result.methods.serverRequests, ...missingRequests].sort();
  }

  if (result.status === "failed" && result.auth.state === "not-logged-in") {
    result.status = "skipped";
    result.reason = "not logged in";
  } else if (result.status === "failed") {
    result.status = "ok";
  }
  return result;
}

export const probe = {
  id: "codex",
  label: "Codex",
  command: "codex",
  args: ["app-server"],
  protocol: "JSON-RPC 2.0 over stdio (app-server)",
  run,
};
