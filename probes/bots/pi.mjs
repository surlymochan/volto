// probes/bots/pi.mjs
//
// pi machine protocol: `pi --mode rpc` speaks JSON lines on stdin/stdout.
// Commands are requests (`{"type":"prompt"}`), answers are
// `{"type":"response"}` and the agent streams `{"type":"message_update"}`
// events with text deltas.

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
    id: "pi",
    label: "pi",
    command: "pi",
  });
  result.protocol.name = "pi RPC (JSON lines)";
  result.protocol.transport = "stdio";
  result.protocol.framing = "newline-delimited JSON";

  const binary = resolveBinary("pi");
  result.binary.available = Boolean(binary.path);
  if (!binary.path) {
    result.status = "skipped";
    result.reason = "binary not found on PATH";
    note(result, "Install the pi CLI (`pi --mode rpc`) to run this probe.");
    markNotProbed(result);
    return result;
  }
  result.binary.path = binary.path;

  const version = await runCommand({ command: binary.path, args: ["--version"], timeoutMs: 15_000 });
  result.binary.version = (version.stdout || version.stderr).trim().split("\n")[0] || "unknown";

  const sessionDir = `${ctx.tmpDir}/sessions`;
  const started = Date.now();

  /** @type {Map<string, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map();
  /** @type {Map<string, number>} */
  const eventCounts = new Map();
  /** @type {Set<string>} */
  const sentTypes = new Set();
  /** @type {any} */
  let lastAgentEnd = null;
  let requestId = 0;
  let deltaCount = 0;
  let firstOutputMs = null;
  let promptSentAt = null;
  /** @type {any[]} */
  const uiRequests = [];

  /**
   * @param {string} type
   * @param {Record<string, unknown>} [extra]
   */
  function send(type, extra = {}) {
    const id = `probe-${++requestId}`;
    const payload = { id, type, ...extra };
    sentTypes.add(type);
    ctx.transcript.record("in", "line", JSON.stringify(payload));
    try {
      child.child.stdin.write(JSON.stringify(payload) + "\n");
    } catch {
      /* stdin closed */
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for response to ${type}`));
      }, Math.min(30_000, ctx.timeoutMs));
      pending.set(id, { resolve, reject, timer });
    });
  }

  const child = spawnChild({
    command: binary.path,
    args: ["--mode", "rpc", "--no-tools", "--session-dir", sessionDir],
    cwd: ctx.tmpDir,
    onStdoutLine: (line) => {
      ctx.transcript.record("out", "line", line);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.type === "response" && message.id && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(entry.timer);
        entry.resolve(message);
        return;
      }
      if (typeof message.type === "string") {
        eventCounts.set(message.type, (eventCounts.get(message.type) ?? 0) + 1);
        if (message.type === "agent_end") lastAgentEnd = message;
      }
      if (message.type === "message_update" && message.assistantMessageEvent?.type === "text_delta") {
        deltaCount += 1;
        if (firstOutputMs === null && promptSentAt !== null) firstOutputMs = Date.now() - promptSentAt;
      }
      if (message.type === "extension_ui_request") uiRequests.push(message);
    },
    onStderrLine: (line) => ctx.transcript.record("err", "line", line),
  });
  ctx.onChild?.(child);

  try {
    // --- handshake / state ----------------------------------------------
    const t0 = Date.now();
    const state = await send("get_state");
    result.timings.initializeMs = Date.now() - t0;
    if (!state.success) {
      result.status = "failed";
      result.reason = `get_state failed: ${state.error ?? "unknown error"}`;
      return result;
    }
    const model = state.data?.model;
    if (!model) {
      result.status = "skipped";
      result.reason = "not logged in";
      result.auth.state = "not-logged-in";
      result.auth.evidence = "get_state reported no model (no provider credentials configured)";
      return result;
    }
    result.auth.state = "logged-in";
    result.auth.evidence = `provider ${model.provider} / model ${model.id} available`;
    result.protocol.sessionCreate.method = "new_session";
    result.protocol.cancel.method = "abort";
    result.protocol.resume.method = "switch_session (also fork / clone)";
    result.protocol.permissions.shape =
      "client<-server: { type: 'extension_ui_request', id, method: 'select'|'confirm'|'input'|'editor'|'notify', title, ... }; client->server answer: { type: 'extension_ui_response', id, value|confirmed|cancelled }";

    // --- new session ------------------------------------------------------
    const t1 = Date.now();
    const session = await send("new_session");
    result.timings.sessionCreateMs = Date.now() - t1;
    result.protocol.sessionCreate.supported = Boolean(session.success);
    result.protocol.sessionCreate.detail = session.success
      ? "new_session accepted (session id + file reported by get_state)"
      : `new_session rejected: ${session.error ?? "unknown error"}`;

    const state2 = await send("get_state");
    const sessionFile = state2.data?.sessionFile ?? null;
    const sessionId = state2.data?.sessionId ?? null;
    if (sessionFile) note(result, `Session persisted to ${sessionFile}.`);

    // --- first prompt -----------------------------------------------------
    const t2 = Date.now();
    promptSentAt = Date.now();
    const prompt = await send("prompt", { message: PROMPT });
    if (!prompt.success) {
      result.status = "failed";
      result.reason = `prompt rejected: ${prompt.error ?? "unknown error"}`;
      return result;
    }
    const ended = await waitForEvent(eventCounts, "agent_end", 60_000, (eventCounts.get("agent_end") ?? 0) + 1);
    result.timings.promptMs = Date.now() - t2;
    result.timings.firstOutputMs = firstOutputMs;
    result.protocol.streaming.granularity = deltaCount > 0 ? "token-delta" : "none";
    result.protocol.streaming.samples = deltaCount;
    result.protocol.streaming.detail =
      deltaCount > 0
        ? `${deltaCount} message_update/text_delta events`
        : ended
          ? "agent finished without text deltas"
          : "no output observed";
    if (!ended) note(result, "agent_end did not arrive within the probe budget.");

    // --- cancel test on a second prompt ------------------------------------
    const t3 = Date.now();
    const baselineEnds = eventCounts.get("agent_end") ?? 0;
    promptSentAt = Date.now();
    const prompt2 = await send("prompt", { message: CANCEL_PROMPT });
    if (prompt2.success) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const abort = await send("abort");
      const aborted = await waitForEvent(eventCounts, "agent_end", 20_000, baselineEnds + 1);
      const stopReason = lastAgentEnd?.messages?.at?.(-1)?.stopReason ?? null;
      result.timings.cancelMs = Date.now() - t3;
      if (stopReason === "aborted") {
        result.protocol.cancel.works = true;
        result.protocol.cancel.detail = "abort acknowledged; the run ended with stopReason 'aborted'";
      } else if (stopReason === "stop") {
        result.protocol.cancel.works = null;
        result.protocol.cancel.detail =
          "inconclusive: the second prompt finished before the abort arrived (stopReason 'stop')";
      } else {
        result.protocol.cancel.works = false;
        result.protocol.cancel.detail = `abort acknowledged but the run ended with stopReason '${stopReason ?? "unknown"}'`;
      }
    } else {
      result.timings.cancelMs = Date.now() - t3;
      result.protocol.cancel.works = false;
      result.protocol.cancel.detail = `second prompt rejected: ${prompt2.error ?? "unknown error"}`;
    }

    // --- resume / load ------------------------------------------------------
    if (sessionFile) {
      try {
        const loaded = await send("switch_session", { sessionPath: sessionFile });
        result.protocol.resume.supported = Boolean(loaded.success);
        result.protocol.resume.detail = loaded.success
          ? "switch_session reloaded the session file created by the probe"
          : `switch_session rejected: ${loaded.error ?? "unknown error"}`;
      } catch (error) {
        result.protocol.resume.supported = null;
        result.protocol.resume.detail = `switch_session failed: ${error.message}`;
      }
    } else {
      result.protocol.resume.supported = null;
      result.protocol.resume.detail = "no session file was created (session persistence disabled?)";
    }
    if (sessionId) note(result, `Session id ${sessionId}.`);

    result.protocol.permissions.observed = uiRequests.map((r) => r.method);
  } catch (error) {
    result.status = "failed";
    result.reason = error.message;
  } finally {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    child.kill("SIGTERM");
    await child.exited;
    result.timings.totalMs = Date.now() - started;
    result.methods.requests = [...sentTypes].sort();
    result.methods.notifications = [...eventCounts.keys()].sort();
  }

  if (result.status === "failed" && result.auth.state === "not-logged-in") {
    result.status = "skipped";
    result.reason = "not logged in";
  } else if (result.status === "failed") {
    result.status = "ok";
  }
  return result;
}

/**
 * Wait until an event type has been seen at least `minCount` times.
 *
 * @param {Map<string, number>} counts
 * @param {string} type
 * @param {number} ms
 * @param {number} minCount
 */
async function waitForEvent(counts, type, ms, minCount = 1) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((counts.get(type) ?? 0) >= minCount) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return (counts.get(type) ?? 0) >= minCount;
}

export const probe = {
  id: "pi",
  label: "pi",
  command: "pi",
  args: ["--mode", "rpc"],
  protocol: "pi RPC (JSON lines over stdio)",
  run,
};
