#!/usr/bin/env node
// probes/run.mjs
//
// Runs the protocol probes for the five supported bots and writes
// probes/REPORT.md. The probes are read only: they never pass credentials and
// they never touch anything outside probes/.tmp and probes/out.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createRedactor } from "./lib/redact.mjs";
import { createTranscript } from "./lib/transcript.mjs";
import { renderReport } from "./lib/report.mjs";
import { createResult } from "./lib/result.mjs";
import { resolveBinary } from "./lib/binary.mjs";

import { probe as codex } from "./bots/codex.mjs";
import { probe as claude } from "./bots/claude.mjs";
import { probe as dsh } from "./bots/dsh.mjs";
import { probe as pi } from "./bots/pi.mjs";
import { probe as agy } from "./bots/agy.mjs";

const PROBES = [codex, claude, dsh, pi, agy];
const PROMPT = "Reply with the single word PONG";
const DEFAULT_TIMEOUT_MS = 120_000;

const here = dirname(fileURLToPath(import.meta.url));
const worktree = resolve(here, "..");

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = {
    dryRun: false,
    bots: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    outDir: join(here, "out"),
    reportFile: join(here, "REPORT.md"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--bot") options.bots.push(argv[++index]);
    else if (arg === "--timeout") options.timeoutMs = Math.max(1, Number(argv[++index]) || DEFAULT_TIMEOUT_MS) * 1000;
    else if (arg === "--out") options.outDir = resolve(argv[++index]);
    else if (arg === "--report") options.reportFile = resolve(argv[++index]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage: node probes/run.mjs [options]",
    "",
    "Options:",
    "  --dry-run          list the probes and exit without running anything",
    "  --bot <id>         run only the given probe (repeatable: codex, claude, dsh, pi, agy)",
    "  --timeout <sec>    hard timeout per probe in seconds (default 120)",
    "  --out <dir>        directory for the raw transcripts (default probes/out)",
    "  --report <file>    report file (default probes/REPORT.md)",
    "  --help             show this help",
  ].join("\n");
}

/**
 * @param {import("./lib/result.mjs").ProbeResult} result
 */
function statusLabel(result) {
  return result.status === "ok" ? "ok" : `${result.status}${result.reason ? ` (${result.reason})` : ""}`;
}

/**
 * Run one probe with a hard timeout.
 *
 * @param {typeof PROBES[number]} probe
 * @param {{ timeoutMs: number, outDir: string, tmpRoot: string, runId: string, redactor: ReturnType<typeof createRedactor>, children: any[] }} ctx
 */
async function runProbe(probe, ctx) {
  const result = createResult({ id: probe.id, label: probe.label, command: probe.command });
  const tmpDir = join(ctx.tmpRoot, `${probe.id}-${ctx.runId}`);
  const transcriptFile = join(ctx.outDir, `${probe.id}.jsonl`);
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(ctx.outDir, { recursive: true });

  const transcript = createTranscript({ file: transcriptFile, redactor: ctx.redactor });
  transcript.note(`probe ${probe.id} start`);
  result.transcript = relative(worktree, transcriptFile);

  let timeoutHandle;
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve(null), ctx.timeoutMs);
  });

  try {
    const outcome = await Promise.race([
      probe.run({
        tmpDir,
        outDir: ctx.outDir,
        timeoutMs: ctx.timeoutMs,
        transcript,
        redactor: ctx.redactor,
        worktree,
        onChild: (child) => ctx.children.push(child),
      }),
      timeoutPromise,
    ]);
    if (outcome) {
      outcome.transcript = result.transcript;
      Object.assign(result, outcome);
    } else {
      result.status = "timeout";
      result.reason = `hard timeout of ${Math.round(ctx.timeoutMs / 1000)} s exceeded`;
    }
  } catch (error) {
    result.status = "failed";
    result.reason = error?.message ?? String(error);
  } finally {
    clearTimeout(timeoutHandle);
    transcript.close();
  }

  if (result.status === "timeout") {
    result.reason = `hard timeout of ${Math.round(ctx.timeoutMs / 1000)} s exceeded`;
    for (const child of ctx.children) child.kill("SIGKILL");
  }
  return result;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exit(2);
    return;
  }

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
    return;
  }

  const selected = options.bots.length
    ? PROBES.filter((probe) => options.bots.includes(probe.id))
    : PROBES;
  if (selected.length === 0) {
    process.stderr.write(`no probe matches ${options.bots.join(", ")}\nknown probes: ${PROBES.map((p) => p.id).join(", ")}\n`);
    process.exit(2);
    return;
  }

  if (options.dryRun) {
    const rows = selected.map((probe) => {
      const binary = resolveBinary(probe.command);
      return [
        probe.id,
        probe.label,
        probe.command,
        probe.args.join(" "),
        probe.protocol,
        binary.path ? "available" : "missing (probe would skip)",
      ];
    });
    const widths = ["id", "bot", "binary", "args", "protocol", "availability"].map((header, column) =>
      Math.max(header.length, ...rows.map((row) => row[column].length)),
    );
    process.stdout.write(`${widths.map((w, i) => ["id", "bot", "binary", "args", "protocol", "availability"][i].padEnd(w)).join("  ")}\n`);
    for (const row of rows) {
      process.stdout.write(`${row.map((value, column) => value.padEnd(widths[column])).join("  ")}\n`);
    }
    process.stdout.write(`\n${selected.length} probe(s) ready. Re-run without --dry-run to execute them.\n`);
    process.exit(0);
    return;
  }

  const redactor = createRedactor({ worktree });
  const runId = `${Date.now().toString(36)}`;
  const tmpRoot = join(here, ".tmp");
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(options.outDir, { recursive: true });

  const results = [];
  for (const probe of selected) {
    process.stdout.write(`\n== ${probe.label} (${probe.id})\n`);
    const result = await runProbe(probe, {
      timeoutMs: options.timeoutMs,
      outDir: options.outDir,
      tmpRoot,
      runId,
      redactor,
      children: [],
    });
    results.push(result);
    process.stdout.write(`   status: ${statusLabel(result)}\n`);
    for (const note of result.notes) process.stdout.write(`   - ${note}\n`);
  }

  const report = renderReport({
    results,
    generatedAt: new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC",
    timeoutMs: options.timeoutMs,
    prompt: PROMPT,
    redactor,
  });
  mkdirSync(dirname(options.reportFile), { recursive: true });
  writeFileSync(options.reportFile, report + "\n");
  writeFileSync(
    join(options.outDir, "summary.json"),
    JSON.stringify(redactor.value({ generatedAt: new Date().toISOString(), results }), null, 2) + "\n",
  );

  process.stdout.write(`\nreport: ${relative(worktree, options.reportFile)}\n`);
  process.stdout.write(`transcripts: ${relative(worktree, options.outDir)}\n`);

  // Remove the scratch directories of this run, keep the transcripts.
  for (const entry of selected) {
    rmSync(join(tmpRoot, `${entry.id}-${runId}`), { recursive: true, force: true });
  }

  const failed = results.filter((result) => result.status === "failed" || result.status === "timeout");
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
process.exit(process.exitCode ?? 0);
