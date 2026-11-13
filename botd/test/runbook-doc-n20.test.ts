// Static cross references in the operator runbook.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const botd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(botd, "..");
const read = (path: string) => readFileSync(path, "utf8");
const runbook = read(resolve(botd, "RUNBOOK.md"));
const cli = read(resolve(botd, "src/cli.ts"));
const protocol = read(resolve(botd, "PROTOCOL.md"));
const metrics = read(resolve(botd, "METRICS.md")) + read(resolve(botd, "src/metrics.ts"));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}
const sources = sourceFiles(resolve(botd, "src")).map(read).join("\n");
const unique = (values: string[]) => [...new Set(values)].sort();
const tokens = (text: string, pattern: RegExp) => unique([...text.matchAll(pattern)].map((m) => m[1]));
const missing = (names: string[], known: string[]) => names.filter((name) => !new Set(known).has(name));

function paths(text: string): string[] {
  const links = [...text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)]
    .map((m) => resolve(botd, decodeURIComponent(m[1])));
  const scripts = [...text.matchAll(/\bbash (scripts\/[a-z0-9-]+\.sh)\b/g)]
    .map((m) => resolve(root, m[1]));
  return unique([...links, ...scripts]);
}
function missingPaths(text: string): string[] {
  return paths(text).filter((path) => !existsSync(path));
}
function metricNames(text: string): string[] {
  return tokens(text, /`(botd_[a-z0-9_]+)`/g);
}
function errorNames(text: string): string[] {
  const rows = text.split("\n").filter((line) => /^\| error `/.test(line));
  const rowCodes = rows.flatMap((row) => tokens(row.split("|")[1], /`([a-z]+(?:_[a-z]+)+)`/g));
  const lease = /\*\*The lease is renewed\*\*[\s\S]*?\*\*When the TTL runs out/.exec(text)?.[0] ?? "";
  const paused = /\*\*When the TTL runs out, the sessions are paused\*\*[\s\S]*?\*\*A reconnect/.exec(text)?.[0] ?? "";
  return unique([...rowCodes, ...tokens(lease + paused, /`([a-z]+(?:_[a-z]+)+)`/g)]);
}
function flags(text: string): string[] {
  return tokens(text, /(?<![\w-])(--[a-z][a-z0-9-]*)(?![\w-])/g);
}

// These flags belong to the installer, Node, and the adapter binaries.
const otherFlags = ["--acp", "--append-system-prompt", "--dry-run", "--ensure-node", "--experimental-strip-types", "--input-format", "--mode", "--model", "--output-format", "--prefix", "--profile", "--reasoning-effort", "--resume", "--verbose"];
function unknownFlags(text: string): string[] {
  return missing(flags(text), [...flags(cli), ...otherFlags]);
}

function isolated(name: string, fn: () => void): void {
  test(name, (t) => {
    const original = process.env;
    process.env = {};
    t.after(() => { process.env = original; });
    fn();
  });
}

isolated("runbook repository links and scripts exist", () => {
  assert.deepEqual(missingPaths(runbook), []);
  assert.deepEqual(missingPaths("[missing](missing-synthetic.md)\nbash scripts/missing-synthetic.sh"), [resolve(botd, "missing-synthetic.md"), resolve(root, "scripts/missing-synthetic.sh")].sort());
  assert.deepEqual(missingPaths("[protocol](PROTOCOL.md)"), []);
});

isolated("quoted runbook metrics exist in the metric catalog or registry", () => {
  const known = tokens(metrics, /\b(botd_[a-z0-9_]+)\b/g);
  assert.deepEqual(metricNames(runbook), ["botd_cancel_escalations_total", "botd_event_latency_seconds", "botd_events_total", "botd_reconnects_total", "botd_sessions_active", "botd_sessions_total"]);
  assert.deepEqual(missing(metricNames(runbook), known), []);
  assert.deepEqual(missing(metricNames("`botd_synthetic_missing`"), known), ["botd_synthetic_missing"]);
});

isolated("runbook error codes exist in the protocol or source", () => {
  const known = tokens(protocol + "\n" + sources, /\b([a-z]+(?:_[a-z]+)+)\b/g);
  assert.deepEqual(errorNames(runbook), ["bad_frame", "bad_json", "child_error", "lease_paused", "no_lease", "session_cancelling", "session_exists", "session_exited", "stale_fence", "stale_lease", "unknown_session"]);
  assert.deepEqual(missing(errorNames(runbook), known), []);
  assert.deepEqual(missing(errorNames("| error `synthetic_missing` | example |"), known), ["synthetic_missing"]);
});

isolated("runbook botd flags appear in the CLI", () => {
  assert.deepEqual(flags(runbook).filter((flag) => otherFlags.includes(flag)), otherFlags);
  assert.deepEqual(unknownFlags(runbook), []);
  assert.deepEqual(unknownFlags("botd --synthetic-unknown"), ["--synthetic-unknown"]);
  assert.deepEqual(unknownFlags("botd --home=<dir>"), []);
});
