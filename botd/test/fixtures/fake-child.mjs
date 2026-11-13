#!/usr/bin/env node
/**
 * Fake bot child used by the botd tests.
 *
 * It speaks NDJSON on stdin/stdout and understands a couple of commands:
 *
 *   {"cmd":"echo","text":"x"}   one JSON line on stdout
 *   {"cmd":"emit","count":3}    three JSON lines on stdout
 *   {"cmd":"hang"}              stop answering but stay alive
 *   {"cmd":"ignore-sigint"}     ignore SIGINT (cancel escalation)
 *   {"cmd":"stderr","text":"x"}  write to stderr
 *   {"cmd":"exit","code":0}     exit
 *
 * Unknown frames (a provider cancel message for instance) are ignored
 * silently, so the child looks like a provider that does not react.
 *
 * Every received line is appended to the file named by FAKE_CHILD_LOG.
 */
import fs from "node:fs";

const logFile = process.env.FAKE_CHILD_LOG;
let ignoreSigint = false;
let hanging = false;
let counter = 0;
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
  if (hanging) return;
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
    case "echo":
      write({ jsonrpc: "2.0", id: frame.id ?? null, result: { echo: frame.text ?? null, seq: counter++ } });
      break;
    case "emit": {
      const count = Number(frame.count ?? 1);
      for (let index = 0; index < count; index += 1) {
        write({ jsonrpc: "2.0", id: frame.id ?? null, result: { seq: counter++ } });
      }
      break;
    }
    case "hang":
      hanging = true;
      log({ event: "hang" });
      break;
    case "ignore-sigint":
      ignoreSigint = true;
      log({ event: "ignore-sigint" });
      break;
    case "stderr":
      process.stderr.write(`${String(frame.text ?? "boom")}\n`);
      break;
    case "exit":
      process.exit(Number(frame.code ?? 0));
      break;
    default:
      // Unknown frame: a provider message the child does not answer.
      log({ event: "ignored" });
      break;
  }
}

process.on("SIGINT", () => {
  log({ event: "sigint" });
  if (!ignoreSigint) process.exit(130);
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
