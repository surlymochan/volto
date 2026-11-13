#!/usr/bin/env node
/**
 * Fake ACP bot used by the botd end-to-end tests.
 *
 * The bot speaks a minimal ACP-like dialect: JSON-RPC 2.0 lines on stdin
 * and stdout, the way an agent client would. It can stream the chunks of a
 * turn, it can hang (stop answering without dying) and it ignores SIGINT,
 * so the escalation of a cancel can be watched end to end.
 *
 * The methods it understands:
 *
 *   session/new                 answer with the id of the provider session
 *   session/prompt              stream `chunks` chunks and end the turn
 *   session/prompt (mode hang)  stop answering and stay alive
 *   bot/exit                    leave
 *
 * Every other frame (a provider cancel for instance) is ignored, so the bot
 * looks like a provider that does not react to a cancel.
 *
 * Every received line and every signal is appended to the file named by
 * FAKE_BOT_LOG; the tests read that file to see what really reached the
 * bot. The fixture is synthetic: no host name, address or credential shows
 * up here.
 */
import fs from "node:fs";

const logFile = process.env.FAKE_BOT_LOG;
const providerSessionId = process.env.FAKE_BOT_SESSION_ID ?? "prov-fake-1";

let hanging = false;
let buffer = "";

/** Append one entry to the log of the bot. */
function log(entry) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  } catch {
    // The log is a test convenience, never a hard requirement.
  }
}

/** Write one JSON-RPC line on stdout (nothing while the bot hangs). */
function write(payload) {
  if (hanging) return;
  try {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // The daemon may be gone already.
  }
}

/** Handle one request of the daemon. */
function handle(frame) {
  const method = frame && typeof frame === "object" ? frame.method : undefined;
  const id = frame && typeof frame === "object" ? (frame.id ?? null) : null;
  const params =
    frame && typeof frame === "object" && frame.params && typeof frame.params === "object"
      ? frame.params
      : {};
  log({ event: "recv", line: JSON.stringify(frame) });

  switch (method) {
    case "session/new":
      write({ jsonrpc: "2.0", id, result: { sessionId: providerSessionId } });
      return;
    case "session/prompt": {
      if (params.mode === "hang") {
        // The bot stops answering: only a signal stops it now.
        hanging = true;
        log({ event: "hang" });
        return;
      }
      const chunks = Number(params.chunks ?? 1);
      for (let index = 1; index <= chunks; index += 1) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: providerSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `chunk ${index}` },
            },
          },
        });
      }
      write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      return;
    }
    case "bot/exit":
      log({ event: "exit" });
      process.exit(Number(params.code ?? 0));
      return;
    default:
      // A provider cancel for instance: the bot does not answer it.
      log({ event: "ignored", method: method ?? null });
      return;
  }
}

// The bot ignores SIGINT: the daemon has to escalate to the kill of the
// process group.
process.on("SIGINT", () => {
  log({ event: "sigint" });
});

process.on("SIGTERM", () => {
  log({ event: "sigterm" });
  process.exit(143);
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index === -1) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      log({ event: "invalid", line });
      continue;
    }
    handle(frame);
  }
});

// The daemon is gone: there is nothing left to answer.
process.stdin.on("end", () => {
  log({ event: "stdin-end" });
  process.exit(0);
});
