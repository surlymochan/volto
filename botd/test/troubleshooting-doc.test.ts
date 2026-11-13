// Conformance checks for the operator guides against the current sources.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const botd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docs = ["TROUBLESHOOTING.md", "RUNBOOK.md"].map((name) => ({
  name,
  text: readFileSync(join(botd, name), "utf8"),
}));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}
const src = sources(join(botd, "src")).map((file) => readFileSync(file, "utf8")).join("\n");
const cli = readFileSync(join(botd, "src", "cli.ts"), "utf8");
const config = readFileSync(join(botd, "src", "config.ts"), "utf8");

function section(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}\n`);
  assert.ok(start >= 0, `missing section ${heading}`);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

test("troubleshooting protocol error codes occur in the sources", () => {
  const table = section(docs[0].text, "Protocol errors");
  const codes = [...table.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]);
  assert.ok(codes.length >= 10, "protocol error table is missing codes");
  for (const code of codes) assert.ok(src.includes(`"${code}"`), `unknown error code ${code}`);
});

test("runbook error codes and quoted reasons occur in the sources", () => {
  const failures = section(docs[1].text, "Common failures");
  const rows = failures.split("\n").filter((line) => /^\| error `/.test(line));
  assert.ok(rows.length >= 10, "common failures are missing error rows");
  for (const row of rows) {
    const symptom = row.split("|")[1];
    for (const match of symptom.matchAll(/`([a-z_]+)`/g)) {
      assert.ok(src.includes(`"${match[1]}"`), `unknown error code ${match[1]}`);
    }
    for (const match of symptom.matchAll(/"([^"]+)"/g)) {
      const reason = match[1].replace(/\s*…$/, "");
      assert.ok(src.includes(reason), `unknown error reason ${match[1]}`);
    }
  }
});

test("documented botd flags are handled by the CLI and configuration", () => {
  // These flags belong to the installer, Node, or provider CLIs, not botd.
  const otherFlags = new Set(["prefix", "ensure-node", "dry-run", "experimental-strip-types", "input-format", "output-format", "verbose", "profile", "acp", "mode", "model", "resume", "append-system-prompt", "reasoning-effort"]);
  const flags = new Set(docs.flatMap(({ text }) => [...text.matchAll(/--([a-z][a-z-]*)/g)].map((match) => match[1])));
  assert.ok(flags.size >= 20, "too few documented flags found");
  for (const flag of flags) {
    if (otherFlags.has(flag)) continue;
    const handled = cli.includes(`flags.includes("--${flag}")`) ||
      (cli.includes("loadConfig(flags, process.env)") && config.includes(`flags.get("${flag}")`));
    assert.ok(handled, `documented botd flag --${flag} is not handled`);
  }
});

test("relative links in both guides resolve to files", () => {
  for (const doc of docs) {
    const links = [...doc.text.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
    assert.ok(links.length > 0, `${doc.name} has no links`);
    for (const link of links) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link)) continue;
      const path = decodeURIComponent(link.split(/[?#]/, 1)[0]);
      const target = path ? resolve(botd, path) : join(botd, doc.name);
      assert.ok(existsSync(target) && statSync(target).isFile(), `${doc.name}: broken link ${link}`);
    }
  }
});
