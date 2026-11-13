import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const botd = join(dirname(fileURLToPath(import.meta.url)), "..");
const doc = readFileSync(join(botd, "ADAPTERS.md"), "utf8");
const dir = join(botd, "src", "adapters");
const files = readdirSync(dir).filter((name) => name.endsWith(".ts")).sort();
const sources = Object.fromEntries(files.map((name) => [name, readFileSync(join(dir, name), "utf8")]));
const allSource = Object.values(sources).join("\n");

function docEnv(text: string): string[] {
  // Environment names are formatted as inline code, optionally with an assignment.
  return [...new Set([...text.matchAll(/`([A-Z][A-Z0-9_]*)(?:=[^`]*)?`/g)]
    .map((m) => m[1]!).filter((name) => name !== "ADAPTER_CAPABILITIES"))].sort();
}
function reads(text: string): string[] {
  return [...new Set([...text.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1]!))].sort();
}
function missing(needed: string[], available: string[]): string[] {
  const known = new Set(available);
  return needed.filter((name) => !known.has(name));
}
function tokens(text: string): string[] {
  return [...new Set([...text.matchAll(/\b[A-Z][A-Z0-9_]*\b/g)].map((m) => m[0]))];
}
function paths(text: string): string[] {
  return [...new Set([...text.matchAll(/`botd\/src\/adapters\/([^`/]+\.ts)`/g)].map((m) => m[1]!))].sort();
}
function command(text: string, kind: string): string {
  const row = text.split("\n").find((line) => line.startsWith(`| \`${kind}\` |`));
  assert.ok(row, `missing row for ${kind}`);
  const cell = row.split("|")[3]!.trim();
  const match = /^`([^`]+)`$/.exec(cell);
  assert.ok(match, `invalid command cell for ${kind}`);
  return match[1]!;
}
function scalar(text: string, name: string): string {
  const match = new RegExp(`(?:export )?const ${name} = "([^"]+)";`).exec(text);
  assert.ok(match, `missing ${name}`);
  return match[1]!;
}
function arrayCommand(text: string, name: string): string {
  const match = new RegExp(`export const ${name}: readonly string\\[\\] = \\[([^\\]]+)\\];`).exec(text);
  assert.ok(match, `missing ${name}`);
  return match[1]!.split(",").map((part) => {
    const value = part.trim();
    return /^"[^"]+"$/.test(value) ? value.slice(1, -1) : scalar(text, value);
  }).join(" ");
}

test("documented environment variables occur in adapter sources", () => {
  assert.deepEqual(docEnv(doc), ["COPILOT_ENABLED", "PATH", "VOLTO_AGY_PROTOCOL"]);
  assert.deepEqual(missing(docEnv(doc), tokens(allSource)), []);
  assert.deepEqual(missing(docEnv("`SYNTHETIC_EXTRA`"), tokens(allSource)), ["SYNTHETIC_EXTRA"]);
});

test("direct environment reads are documented", () => {
  assert.deepEqual(reads(allSource), []);
  assert.deepEqual(missing(reads(allSource), docEnv(doc)), []);
  const mutated = `${allSource}\nprocess.env.SYNTHETIC_EXTRA; env.ANOTHER_EXTRA;`;
  assert.deepEqual(missing(reads(mutated), docEnv(doc)), ["ANOTHER_EXTRA", "SYNTHETIC_EXTRA"]);
});

test("every adapter file is named by its full source path", () => {
  assert.deepEqual(missing(files, paths(doc)), []);
  assert.deepEqual(missing(["synthetic.ts"], paths(doc)), ["synthetic.ts"]);
});

test("documented commands equal adapter constants", () => {
  const expected: Record<string, string> = {
    codex: `${scalar(sources["codex.ts"]!, "CODEX_COMMAND")} ${scalar(sources["codex.ts"]!, "APP_SERVER_SUBCOMMAND")}`,
    pi: arrayCommand(sources["pi.ts"]!, "PI_COMMAND"),
    dsh: arrayCommand(sources["dsh.ts"]!, "DSH_COMMAND"),
    copilot: arrayCommand(sources["copilot.ts"]!, "COPILOT_COMMAND"),
  };
  for (const [kind, value] of Object.entries(expected)) assert.equal(command(doc, kind), value);
  assert.notEqual(command("| `pi` | `rpc` | `pi --wrong` |", "pi"), expected.pi);
});

// DEFECT: codex's command constants are not exported, unlike the other command constants.
test.todo("codex exports its command constants");
