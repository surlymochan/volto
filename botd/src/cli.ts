#!/usr/bin/env node
/**
 * Command line entry point of the volto bot daemon.
 *
 * `botd serve` speaks NDJSON over stdin/stdout and is meant to be started
 * as a forced command on an executor host (`ssh <host> botd serve`).
 */
import { loadConfig } from "./config.ts";
import { Botd } from "./daemon.ts";
import { writeFrame } from "./frames.ts";
import { BOTD_VERSION } from "./protocol.ts";

const USAGE = `botd ${BOTD_VERSION} — remote bot daemon

Usage:
  botd serve [options]   run the daemon over stdin/stdout (default)
  botd version           print the version
  botd help              print this help

Options (environment variable in brackets):
  --home=<dir>            botd home directory [BOTD_HOME]
  --store-file=<file>     session table [BOTD_STORE_FILE]
  --lease-ttl-ms=<ms>     default lease TTL [BOTD_LEASE_TTL_MS]
  --ring-max-events=<n>   events kept per session [BOTD_RING_MAX_EVENTS]
  --ring-max-bytes=<n>    bytes kept per session [BOTD_RING_MAX_BYTES]
  --idle-ms=<ms>          silence after which a session is idle [BOTD_IDLE_MS]
  --stall-ms=<ms>         silence after which a session stalls [BOTD_STALL_MS]
  --watchdog-ms=<ms>      watchdog interval [BOTD_WATCHDOG_MS]
  --cancel-grace-ms=<ms>  time between cancel and SIGINT [BOTD_CANCEL_GRACE_MS]
  --cancel-kill-grace-ms=<ms>
                           time between SIGINT and SIGKILL [BOTD_CANCEL_KILL_GRACE_MS]
  --terminate-grace-ms=<ms>
                           time between SIGTERM and SIGKILL [BOTD_TERMINATE_GRACE_MS]
`;

function main(): void {
  const argv = process.argv.slice(2);
  const flags = argv.filter((arg) => arg.startsWith("--"));
  const command = argv.find((arg) => !arg.startsWith("-")) ?? "serve";

  if (command === "version" || flags.includes("--version")) {
    process.stdout.write(`${BOTD_VERSION}\n`);
    return;
  }
  if (command === "help" || flags.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  if (command !== "serve") {
    process.stderr.write(`botd: unknown command ${command}\n`);
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  const config = loadConfig(flags, process.env);
  const daemon = new Botd(config, {
    onFrame: (frame) => writeFrame(process.stdout, frame),
    onLog: (message) => process.stderr.write(`botd: ${message}\n`),
  });
  daemon.connect(process.stdin, process.stdout);

  const shutdown = (): void => {
    daemon.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The client is gone: stop the daemon (and with it the children).
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
}

main();
