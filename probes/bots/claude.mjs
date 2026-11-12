// probes/bots/claude.mjs
//
// Claude Code machine protocol:
//   claude -p --output-format stream-json --input-format stream-json --verbose
//
// stdin carries one JSON message per line, stdout answers with one JSON
// message per line (system / assistant / stream_event / result).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveBinary } from "../lib/binary.mjs";
import { runCommand, spawnChild } from "../lib/process.mjs";
import { createResult, markNotProbed } from "../lib/result.mjs";

const PROMPT = "Reply with the single word PONG";
const CANCEL_PROMPT = "Count slowly from 1 to 20, one number per line.";

/**
 * Claude Code keeps its OAuth credentials in the user home. We only look for
 * their presence, we never read or forward them.
 */
function detectAuth() {
  const env = process.env;
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { state: "logged-in", evidence: "an Anthropic credential is present in the environment" };
  }
  const candidates = [
    join(homedir(), ".claude", ".credentials.json"),
    join(homedir(), ".claude", "credentials.json"),
    join(homedir(), ".config", "claude", ".credentials.json"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return { state: "logged-in", evidence: "Claude Code credentials file exists" };
  return { state: "not-logged-in", evidence: "no Claude Code credentials found" };
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
    id: "claude",
    label: "Claude Code",
    command: "claude",
  });
  result.protocol.name = "stream-json (Claude Code SDK)";
  result.protocol.transport = "stdio";
  result.protocol.framing = "newline-delimited JSON";
  result.protocol.sessionCreate.method = "implicit (one session per process, session id in the init event)";
  result.protocol.cancel.method = "control_request { subtype: 'interrupt' }";
  result.protocol.resume.method = "--resume <session-id> / --continue";
  result.protocol.permissions.shape =
    "server->client: { type: 'control_request', request: { subtype: 'can_use_tool', tool_name, input, permission_suggestions, request_id } }; client->server: { type: 'control_response', response: { subtype: 'success', request_id, response: { behavior: 'allow'|'deny' } } }";

  const binary = resolveBinary("claude");
  result.binary.available = Boolean(binary.path);
  if (!binary.path) {
    result.status = "skipped";
    result.reason = "binary not found on PATH";
    note(result, "Install the Claude Code CLI to run this probe.");
    markNotProbed(result);
    return result;
  }
  result.binary.path = binary.path;

  const version = await runCommand({ command: binary.path, args: ["--version"], timeoutMs: 15_000 });
  result.binary.version = (version.stdout || version.stderr).trim().split("\n")[0] || "unknown";

  const auth = detectAuth();
  result.auth.state = auth.state;
  result.auth.evidence = auth.evidence;
  if (auth.state === "not-logged-in") {
    result.status = "skipped";
    result.reason = "not logged in";
    note(result, "Run `claude` once and complete the login flow, then re-run the probe.");
    return result;
  }

  const help = await runCommand({ command: binary.path, args: ["--help"], timeoutMs: 15_000 });
  const helpText = `${help.stdout}${help.stderr}`;
  result.protocol.resume.supported = /--resume/.test(helpText) ? true : null;
  result.protocol.resume.detail = /--resume/.test(helpText)
    ? "the CLI exposes --resume/--continue; the session id is reported by the init event"
    : "the CLI help does not advertise --resume";

  const started = Date.now();
  /** @type {Set<string>} */
  const eventTypes = new Set();
  let deltaCount = 0;
  let firstOutputMs = null;
  let promptSentAt = null;
  /** @type {any} */
  let sessionId = null;
  /** @type {any[]} */
  const controlRequests = [];
  /** @type {Map<string, { resolve: (v: any) => void, timer: NodeJS.Timeout }>} */
  const controlWaiters = new Map();
  let controlRequestId = 0;

  /**
   * @param {string} text
   */
  function write(text) {
    ctx.transcript.record("in", "line", text);
    try {
      child.child.stdin.write(text + "\n");
    } catch {
      /* stdin closed */
    }
  }

  const child = spawnChild({
    command: binary.path,
    args: ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"],
    cwd: ctx.tmpDir,
    onStdoutLine: (line) => {
      ctx.transcript.record("out", "line", line);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.type === "stream_event" && message.event?.type === "content_block_delta") {
        deltaCount += 1;
        if (firstOutputMs === null && promptSentAt !== null) firstOutputMs = Date.now() - promptSentAt;
      }
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id ?? null;
        if (firstOutputMs === null && promptSentAt !== null) firstOutputMs = Date.now() - promptSentAt;
      }
      if (message.type === "control_request") {
        controlRequests.push(message);
        const requestId = message.request?.request_id;
        const waiter = controlWaiters.get(requestId);
        if (waiter) {
          controlWaiters.delete(requestId);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
        // Always deny tool use: the probe must not approve anything.
        write(
          JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: requestId,
              response: { behavior: "deny", message: "volto-probe denies tool use" },
            },
          }),
        );
      }
      if (message.type === "control_response") {
        const waiter = controlWaiters.get(message.response?.request_id);
        if (waiter) {
          controlWaiters.delete(message.response.request_id);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
      if (typeof message.type === "string") eventTypes.add(message.type);
    },
    onStderrLine: (line) => ctx.transcript.record("err", "line", line),
  });
  ctx.onChild?.(child);

  /**
   * @param {Record<string, unknown>} message
   */
  function sendUserMessage(message) {
    write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: message.text }] } }));
  }

  /**
   * @param {Record<string, unknown>} request
   * @param {number} ms
   */
  function controlRequest(request, ms) {
    const requestId = `probe-${++controlRequestId}`;
    write(JSON.stringify({ type: "control_request", request: { ...request, request_id: requestId } }));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        controlWaiters.delete(requestId);
        resolve(null);
      }, ms);
      controlWaiters.set(requestId, { resolve, timer });
    });
  }

  try {
    const t0 = Date.now();
    promptSentAt = Date.now();
    sendUserMessage({ text: PROMPT });
    const finished = await waitFor(() => eventTypes.has("result"), 90_000);
    result.timings.initializeMs = Date.now() - t0;
    result.timings.promptMs = Date.now() - t0;
    result.timings.firstOutputMs = firstOutputMs;
    result.protocol.sessionCreate.supported = Boolean(sessionId);
    result.protocol.sessionCreate.detail = sessionId
      ? "the init event reports a session id"
      : "no init event with a session id was observed";
    result.protocol.streaming.granularity = deltaCount > 0 ? "token-delta" : "message";
    result.protocol.streaming.samples = deltaCount;
    result.protocol.streaming.detail =
      deltaCount > 0
        ? `${deltaCount} stream_event/content_block_delta events`
        : "assistant messages arrived without partial deltas";
    if (!finished) note(result, "no result event arrived within the probe budget.");

    // --- cancel test on a second prompt ------------------------------------
    const t3 = Date.now();
    promptSentAt = Date.now();
    sendUserMessage({ text: CANCEL_PROMPT });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const interrupted = await controlRequest({ subtype: "interrupt" }, 15_000);
    const stopped = await waitFor(() => eventTypes.has("result"), 20_000);
    result.timings.cancelMs = Date.now() - t3;
    result.protocol.cancel.works = Boolean(interrupted) && stopped;
    result.protocol.cancel.detail = interrupted
      ? "interrupt control request was acknowledged"
      : "the CLI did not acknowledge an interrupt control request";

    result.protocol.permissions.observed = controlRequests.map((r) => r.request?.subtype).filter(Boolean);
    result.methods.requests = ["control_request(interrupt)", "control_response", "user message"];
    result.methods.notifications = [...eventTypes].sort();
  } catch (error) {
    result.status = "failed";
    result.reason = error.message;
  } finally {
    for (const waiter of controlWaiters.values()) clearTimeout(waiter.timer);
    child.kill("SIGTERM");
    await child.exited;
    result.timings.totalMs = Date.now() - started;
    if (sessionId) note(result, `Session id reported by the CLI: ${sessionId}.`);
  }

  if (result.status === "failed") result.status = "ok";
  return result;
}

/**
 * @param {() => boolean} predicate
 * @param {number} ms
 */
async function waitFor(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

export const probe = {
  id: "claude",
  label: "Claude Code",
  command: "claude",
  args: ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"],
  protocol: "stream-json (Claude Code SDK)",
  run,
};
