#!/usr/bin/env node
/**
 * Entry point of the volto bot daemon.
 *
 * The launcher that scripts/install-botd.sh puts on the executor host runs
 *
 *   node --experimental-strip-types <prefix>/app/src/main.ts "$@"
 *
 * so this file is the process entry point of the daemon: `--version` prints
 * the version, `serve` speaks NDJSON over stdin/stdout.
 *
 * The command line itself lives in cli.ts; importing it runs the daemon
 * with the arguments of the process.
 */
import "./cli.ts";
