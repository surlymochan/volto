#!/usr/bin/env node
/**
 * Fake bot child that answers every message it receives.
 *
 * It speaks NDJSON on stdin/stdout like the other fake child, but it
 * answers each received line with one JSON line on stdout. It is used by
 * the cancel tests: a provider that answers the cancel message ends the
 * escalation of botd, a provider that stays silent does not.
 *
 *   {"cmd":"echo","text":"x"}   one answer line on stdout
 *   {"cmd":"silent"}            stop answering but stay alive
 *   {"cmd":"exit","code":0}     exit
 *
 * The answer carries the id and the text of the request, so a test can
 * tell the answers apart.
 *
 * Every received line is appended to the file named by FAKE_CHILD_LOG; the
 * signals the child receives are logged there as well.
 */
import fs from "node:fs";

const logFile = process.env.FAKE_CHILD_LOG;
let answering = true;
let buffer = "";

function log(entry) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  } catch {
    // The log is a test convenience, never a hard requirement.
  }
}

function write(payload) {
  if (!answering) return;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function handle(line) {
  log({ event: "recv", line });
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  const command = frame && typeof frame === "object" ? frame.cmd : undefined;
  switch (command) {
    case "silent":
      answering = false;
      log({ event: "silent" });
      return;
    case "exit":
      process.exit(Number(frame.code ?? 0));
      return;
    default:
      break;
  }
  const id = frame && typeof frame === "object" && "id" in frame ? frame.id : null;
  const text = frame && typeof frame === "object" && "text" in frame ? frame.text : null;
  write({ jsonrpc: "2.0", id, result: { ack: true, echo: text } });
}

process.on("SIGINT", () => {
  // The child survives the signal: the test wants to see that botd did not
  // escalate a cancel that was answered.
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
    handle(line);
  }
});
