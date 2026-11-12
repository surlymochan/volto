// probes/bots/agy.mjs
//
// Antigravity ("agy"). The probe prefers the ACP mode (`agy --acp` / `agy acp`)
// because that is a machine protocol; when ACP is not available it falls back
// to the print mode (`agy -p --output-format stream-json`).

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
 * Detect whether the CLI exposes an ACP mode.
 *
 * @param {string} helpText
 */
function detectAcpMode(helpText) {
  const flag = /--acp\b/.test(helpText);
  const subcommand = /(^|\s)acp(\s|$)/m.test(helpText);
  if (flag) return { available: true, args: ["--acp"] };
  if (subcommand) return { available: true, args: ["acp"] };
  return { available: false, args: [] };
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
    id: "agy",
    label: "Antigravity",
    command: "agy",
  });
  result.protocol.name = "ACP (Agent Client Protocol)";
  result.protocol.transport = "stdio";
  result.protocol.framing = "newline-delimited JSON";
  result.protocol.sessionCreate.method = "session/new";
  result.protocol.cancel.method = "session/cancel (notification)";
  result.protocol.resume.method = "session/load";
  result.protocol.permissions.shape =
    "agent->client request: session/request_permission { sessionId, toolCall, options:[{ optionId, name, kind }] }";

  const binary = resolveBinary("agy");
  result.binary.available = Boolean(binary.path);
  if (!binary.path) {
    result.status = "skipped";
    result.reason = "binary not found on PATH";
    note(result, "Install the Antigravity CLI to run this probe.");
    markNotProbed(result);
    return result;
  }
  result.binary.path = binary.path;

  const version = await runCommand({ command: binary.path, args: ["--version"], timeoutMs: 15_000 });
  result.binary.version = (version.stdout || version.stderr).trim().split("\n")[0] || "unknown";

  const help = await runCommand({ command: binary.path, args: ["--help"], timeoutMs: 15_000 });
  const helpText = `${help.stdout}${help.stderr}`;
  const acp = detectAcpMode(helpText);
  if (!acp.available) {
    result.protocol.name = "print mode (stream-json)";
    result.protocol.sessionCreate.method = "none (one shot process)";
    result.protocol.cancel.method = "not available in print mode";
    result.protocol.resume.method = "not available in print mode";
    result.protocol.permissions.shape = "not observable in print mode";
    note(result, "The CLI does not advertise an ACP mode; falling back to `agy -p --output-format stream-json`.");
  }

  const started = Date.now();

  if (acp.available) {
    await runAcp(ctx, result, binary.path, acp.args);
  } else {
    await runPrintMode(ctx, result, binary.path);
  }

  result.timings.totalMs = Date.now() - started;
  if (result.status === "failed") result.status = "ok";
  return result;
}

/**
 * ACP mode probe.
 *
 * @param {any} ctx
 * @param {any} result
 * @param {string} command
 * @param {string[]} args
 */
async function runAcp(ctx, result, command, args) {
  /** @type {Set<string>} */
  const methods = new Set();
  let chunkCount = 0;
  let firstOutputMs = null;
  let promptSentAt = null;

  const child = spawnChild({
    command,
    args,
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
    onNotification: (method) => methods.add(method),
  });

  try {
    const t0 = Date.now();
    const init = await client.initialize(ctx.tmpDir);
    result.timings.initializeMs = Date.now() - t0;
    result.auth.state = init?.authMethods?.length ? "unknown" : "logged-in";
    result.auth.evidence = init?.authMethods?.length
      ? `agent offers ${init.authMethods.length} auth method(s)`
      : "initialize accepted without authentication";
    result.protocol.resume.supported = init?.agentCapabilities?.loadSession ?? null;

    const t1 = Date.now();
    const session = await client.newSession(ctx.tmpDir);
    result.timings.sessionCreateMs = Date.now() - t1;
    const sessionId = session?.sessionId ?? null;
    result.protocol.sessionCreate.supported = Boolean(sessionId);
    result.protocol.sessionCreate.detail = sessionId ? "session/new returned a session id" : "session/new returned no session id";
    if (!sessionId) {
      result.status = "failed";
      result.reason = "session/new returned no session id";
      return;
    }

    const t2 = Date.now();
    promptSentAt = Date.now();
    const promptResult = await client.prompt(sessionId, PROMPT);
    result.timings.promptMs = Date.now() - t2;
    result.timings.firstOutputMs = firstOutputMs;
    result.protocol.streaming.granularity = chunkCount > 0 ? "chunk" : "none";
    result.protocol.streaming.samples = chunkCount;
    result.protocol.streaming.detail = chunkCount > 0 ? `${chunkCount} agent_message_chunk updates` : "no agent_message_chunk update observed";
    if (promptResult?.stopReason) note(result, `session/prompt ended with stopReason '${promptResult.stopReason}'.`);

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
  }
}

/**
 * Print mode probe: one prompt per process, no session, no cancel.
 *
 * @param {any} ctx
 * @param {any} result
 * @param {string} command
 */
async function runPrintMode(ctx, result, command) {
  /** @type {Set<string>} */
  const eventTypes = new Set();
  let chunkCount = 0;

  /**
   * @param {string} prompt
   */
  async function oneShot(prompt) {
    const started = Date.now();
    const child = spawnChild({
      command,
      args: ["-p", "--output-format", "stream-json", prompt],
      cwd: ctx.tmpDir,
      onStdoutLine: (line) => {
        ctx.transcript.record("out", "line", line);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof message.type === "string") eventTypes.add(message.type);
        if (message.type === "stream_event" || message.type === "content_block_delta") chunkCount += 1;
      },
      onStderrLine: (line) => ctx.transcript.record("err", "line", line),
    });
    ctx.onChild?.(child);
    await child.exited;
    return Date.now() - started;
  }

  try {
    result.timings.promptMs = await oneShot(PROMPT);
    result.timings.sessionCreateMs = 0;
    result.timings.initializeMs = 0;
    result.protocol.sessionCreate.supported = false;
    result.protocol.sessionCreate.detail = "print mode is one shot: no session is created";
    result.protocol.streaming.granularity = chunkCount > 0 ? "token-delta" : "message";
    result.protocol.streaming.samples = chunkCount;
    result.protocol.streaming.detail = chunkCount > 0 ? `${chunkCount} stream events` : "only complete messages";
    result.protocol.cancel.works = false;
    result.protocol.cancel.detail = "print mode has no cancel channel (the process is killed instead)";
    result.protocol.resume.supported = false;
    result.protocol.resume.detail = "print mode has no session to resume";
    result.auth.state = "unknown";
    result.auth.evidence = "print mode does not report an auth state";
    result.methods.notifications = [...eventTypes].sort();
  } catch (error) {
    result.status = "failed";
    result.reason = error.message;
  }
}

export const probe = {
  id: "agy",
  label: "Antigravity",
  command: "agy",
  args: ["--acp"],
  protocol: "ACP (Agent Client Protocol) over stdio, print mode as fallback",
  run,
};
