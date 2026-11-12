// probes/bots/dsh.mjs
//
// dsh machine protocol: `dsh --profile acp` speaks the Agent Client Protocol
// (ACP): JSON-RPC 2.0 over stdio, session/new + session/prompt.

import { createAcpClient } from "../lib/acp.mjs";
import { resolveBinary } from "../lib/binary.mjs";
import { runCommand, spawnChild } from "../lib/process.mjs";
import { createResult, markNotProbed } from "../lib/result.mjs";

const PROMPT = "Reply with the single word PONG";
const CANCEL_PROMPT = "Count slowly from 1 to 20, one number per line.";

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
    id: "dsh",
    label: "dsh",
    command: "dsh",
  });
  result.protocol.name = "ACP (Agent Client Protocol)";
  result.protocol.transport = "stdio";
  result.protocol.framing = "newline-delimited JSON";
  result.protocol.sessionCreate.method = "session/new";
  result.protocol.cancel.method = "session/cancel (notification)";
  result.protocol.resume.method = "session/load";
  result.protocol.permissions.shape =
    "agent->client request: session/request_permission { sessionId, toolCall, options:[{ optionId, name, kind }] }; answer: { outcome: { outcome: 'selected', optionId } }";

  const binary = resolveBinary("dsh");
  result.binary.available = Boolean(binary.path);
  if (!binary.path) {
    result.status = "skipped";
    result.reason = "binary not found on PATH";
    note(result, "Install the dsh CLI to run this probe.");
    markNotProbed(result);
    return result;
  }
  result.binary.path = binary.path;

  const version = await runCommand({ command: binary.path, args: ["--version"], timeoutMs: 15_000 });
  result.binary.version = (version.stdout || version.stderr).trim().split("\n")[0] || "unknown";

  const help = await runCommand({ command: binary.path, args: ["--help"], timeoutMs: 15_000 });
  const helpText = `${help.stdout}${help.stderr}`;
  if (!/acp/i.test(helpText)) {
    result.status = "skipped";
    result.reason = "the CLI does not advertise an ACP profile";
    note(result, "`dsh --help` does not mention ACP, so `dsh --profile acp` was not started.");
    markNotProbed(result, "not probed (no ACP profile)");
    return result;
  }

  const started = Date.now();
  /** @type {Set<string>} */
  const methods = new Set();
  let chunkCount = 0;
  let firstOutputMs = null;
  let promptSentAt = null;
  /** @type {any[]} */
  const permissionRequests = [];

  const child = spawnChild({
    command: binary.path,
    args: ["--profile", "acp"],
    cwd: ctx.tmpDir,
    onStdoutLine: (line) => {
      ctx.transcript.record("out", "line", line);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      client.peer.handle(message);
    },
    onStderrLine: (line) => ctx.transcript.record("err", "line", line),
  });
  ctx.onChild?.(child);

  const client = createAcpClient({
    send: (payload) => {
      ctx.transcript.record("in", "line", payload);
      try {
        child.child.stdin.write(payload + "\n");
      } catch {
        /* stdin closed */
      }
    },
    onUpdate: (params) => {
      const kind = params?.update?.sessionUpdate;
      methods.add(`session/update:${kind ?? "unknown"}`);
      if (kind === "agent_message_chunk") {
        chunkCount += 1;
        if (firstOutputMs === null && promptSentAt !== null) firstOutputMs = Date.now() - promptSentAt;
      }
    },
    onPermission: (method, params) => permissionRequests.push({ method, params }),
    onNotification: (method) => methods.add(method),
  });

  try {
    // --- initialize -------------------------------------------------------
    const t0 = Date.now();
    const init = await client.initialize(ctx.tmpDir);
    result.timings.initializeMs = Date.now() - t0;
    result.protocol.sessionCreate.supported = true;
    result.auth.state = "logged-in";
    result.auth.evidence = `initialize accepted (protocol version ${init?.protocolVersion ?? "?"})`;
    const authMethods = init?.authMethods ?? [];
    if (authMethods.length > 0) {
      result.auth.state = "unknown";
      result.auth.evidence = `agent offers ${authMethods.length} auth method(s): ${authMethods.map((m) => m.id).join(", ")}`;
      note(result, "The agent advertises authentication methods; run `authenticate` with the right method id before prompting.");
    }
    result.protocol.resume.supported = init?.agentCapabilities?.loadSession ?? null;
    result.protocol.resume.detail = init?.agentCapabilities?.loadSession
      ? "agent advertises the loadSession capability"
      : "agent does not advertise loadSession";

    // --- new session ------------------------------------------------------
    const t1 = Date.now();
    const session = await client.newSession(ctx.tmpDir);
    result.timings.sessionCreateMs = Date.now() - t1;
    const sessionId = session?.sessionId ?? null;
    result.protocol.sessionCreate.detail = sessionId ? "session/new returned a session id" : "session/new returned no session id";
    if (!sessionId) {
      result.status = "failed";
      result.reason = "session/new returned no session id";
      return result;
    }

    // --- first prompt -----------------------------------------------------
    const t2 = Date.now();
    promptSentAt = Date.now();
    const promptResult = await client.prompt(sessionId, PROMPT);
    result.timings.promptMs = Date.now() - t2;
    result.timings.firstOutputMs = firstOutputMs;
    result.protocol.streaming.granularity = chunkCount > 0 ? "chunk" : "none";
    result.protocol.streaming.samples = chunkCount;
    result.protocol.streaming.detail =
      chunkCount > 0 ? `${chunkCount} agent_message_chunk updates` : "no agent_message_chunk update observed";
    if (promptResult?.stopReason) note(result, `session/prompt ended with stopReason '${promptResult.stopReason}'.`);

    // --- cancel test on a second prompt ------------------------------------
    const t3 = Date.now();
    promptSentAt = Date.now();
    const second = client.prompt(sessionId, CANCEL_PROMPT).catch((error) => ({ error: error.message }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    client.cancel(sessionId);
    const outcome = await second;
    result.timings.cancelMs = Date.now() - t3;
    result.protocol.cancel.works = outcome?.stopReason === "cancelled" ? true : outcome?.stopReason ? false : null;
    result.protocol.cancel.detail = outcome?.stopReason
      ? `session/cancel -> stopReason '${outcome.stopReason}'`
      : "no stopReason reported for the cancelled prompt";

    // --- resume / load ------------------------------------------------------
    try {
      await client.loadSession(sessionId, ctx.tmpDir);
      result.protocol.resume.supported = true;
      result.protocol.resume.detail = "session/load accepted the session id";
    } catch (error) {
      result.protocol.resume.detail = `session/load failed: ${error.message}`;
    }

    result.protocol.permissions.observed = permissionRequests.map((r) => r.method);
    result.methods.requests = [
      "initialize",
      "authenticate",
      "session/new",
      "session/load",
      "session/prompt",
      "session/cancel",
    ];
    result.methods.notifications = [...methods].sort();
  } catch (error) {
    result.status = "failed";
    result.reason = error.message;
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    result.timings.totalMs = Date.now() - started;
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
  id: "dsh",
  label: "dsh",
  command: "dsh",
  args: ["--profile", "acp"],
  protocol: "ACP (Agent Client Protocol) over stdio",
  run,
};
