// probes/test/readme-commands.test.mjs
//
// Documentation conformance for probes/README.md.
//
// The suite only reads files and imports the probe metadata: it never runs a
// probe, never spawns a process, never opens a socket and never executes one
// of the commands the README documents.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { probe as agy } from "../bots/agy.mjs";
import { probe as claude } from "../bots/claude.mjs";
import { probe as codex } from "../bots/codex.mjs";
import { probe as dsh } from "../bots/dsh.mjs";
import { probe as pi } from "../bots/pi.mjs";

const PROBES = [codex, claude, dsh, pi, agy];

const here = dirname(fileURLToPath(import.meta.url));
const probesDir = join(here, "..");
const repoRoot = join(probesDir, "..");
const readme = readFileSync(join(probesDir, "README.md"), "utf8");

/**
 * Every fenced code block of a markdown text.
 *
 * @param {string} markdown
 * @returns {{ language: string, code: string }[]}
 */
function codeBlocks(markdown) {
  const blocks = [];
  const pattern = /```([^\n]*)\n([\s\S]*?)```/g;
  let match = pattern.exec(markdown);
  while (match) {
    blocks.push({ language: match[1].trim(), code: match[2] });
    match = pattern.exec(markdown);
  }
  return blocks;
}

/**
 * The entries of the layout tree of the README.
 *
 * @param {string} code the code of the layout block
 * @returns {{ name: string, comment: string }[]}
 */
function layoutEntries(code) {
  const entries = [];
  for (const line of code.split("\n")) {
    const match = line.match(/^[│\s]*[├└]──\s+(\S+?)\s*(?:#\s*(.*))?$/);
    if (match) entries.push({ name: match[1], comment: match[2] ?? "" });
  }
  return entries;
}

/**
 * The rows of the bot table of the README.
 *
 * @param {string} markdown
 * @returns {{ bot: string, protocol: string, startedAs: string }[]}
 */
function botRows(markdown) {
  const rows = [];
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .slice(1, trimmed.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length < 3) continue;
    if (cells[0] === "bot" || /^-+$/.test(cells[0])) continue;
    rows.push({ bot: cells[0], protocol: cells[1], startedAs: cells[2] });
  }
  return rows;
}

/**
 * The inline code spans of a markdown text.
 *
 * @param {string} text
 * @returns {string[]}
 */
function inlineCode(text) {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

/**
 * The flags the README documents for the runner.
 *
 * Only the flags of the runner itself count: `node --test` is a flag of node,
 * not of probes/run.mjs.
 *
 * @returns {Set<string>}
 */
function runnerFlags() {
  const flags = new Set();
  for (const block of codeBlocks(readme)) {
    for (const line of block.code.split("\n")) {
      const command = line.trim().match(/^node\s+(\S+)(.*)$/);
      if (!command || !command[1].startsWith("probes/")) continue;
      for (const match of command[2].matchAll(/(--[a-z][a-z-]*)/g)) flags.add(match[1]);
    }
  }
  // The layout block documents the flags of the CLI next to run.mjs.
  const layout = codeBlocks(readme).find((candidate) => candidate.code.trim().startsWith("probes/"));
  const entry = layoutEntries(layout?.code ?? "").find((candidate) => candidate.name === "run.mjs");
  for (const match of (entry?.comment ?? "").matchAll(/(--[a-z][a-z-]*)/g)) flags.add(match[1]);
  return flags;
}

/**
 * The first words of a protocol description, without the details in
 * parentheses, so that "ACP (Agent Client Protocol) over stdio" and
 * "ACP, print mode as fallback" describe the same protocol family.
 *
 * @param {string} text
 * @returns {string}
 */
function protocolHead(text) {
  return text
    .split(/[(,]/)[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Translate a glob into a regular expression.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  const source = pattern
    .split(/(\*\*\/|\*\*|\*)/)
    .map((part) => {
      if (part === "**/") return "(?:[^/]+/)*";
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      return part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`);
}

/**
 * The files of the repository that match a glob.
 *
 * @param {string} pattern a glob relative to the repository root
 * @returns {string[]} the matching paths, relative to the repository root
 */
function globMatches(pattern) {
  const regex = globToRegExp(pattern);
  const base = join(repoRoot, pattern.split(/[*?]/)[0].replace(/[^/]*$/, ""));
  const matches = [];
  if (!existsSync(base)) return matches;

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const path = relative(repoRoot, full).split(sep).join("/");
        if (regex.test(path)) matches.push(path);
      }
    }
  };
  walk(base);
  return matches;
}

/**
 * Every probe source below probes/ as one text.
 *
 * @returns {string}
 */
function probeSources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".mjs")) files.push(full);
    }
  };
  walk(probesDir);
  return files.map((file) => readFileSync(file, "utf8")).join("\n");
}

test("every file path named in a README code block exists", () => {
  const blocks = codeBlocks(readme).filter((candidate) => /^(?:sh|bash|shell)$/.test(candidate.language));
  assert.ok(blocks.length > 0, "the README has no sh code block");
  const paths = [...blocks.map((block) => block.code).join("\n").matchAll(/\bprobes\/[A-Za-z0-9_.*/-]+/g)].map((match) =>
    match[0].replace(/\/+$/, ""),
  );
  assert.ok(paths.length >= 3, "the usage block names no path");
  for (const path of paths) {
    if (path.includes("*")) {
      const matches = globMatches(path);
      assert.ok(matches.length > 0, `the glob ${path} matches no file`);
      continue;
    }
    assert.ok(existsSync(join(repoRoot, path)), `${path} does not exist`);
  }
});

test("the layout block matches the files below probes/", () => {
  const block = codeBlocks(readme).find((candidate) => candidate.code.trim().startsWith("probes/"));
  assert.ok(block, "the README has no layout block");
  const entries = layoutEntries(block.code);
  assert.ok(entries.length >= 5, "the layout block lists almost nothing");
  const runner = readFileSync(join(probesDir, "run.mjs"), "utf8");

  for (const entry of entries) {
    const target = join(probesDir, entry.name);
    if (existsSync(target)) continue;
    // Only the git ignored runtime directories may be missing from a checkout.
    assert.match(entry.comment, /git ignored/i, `${entry.name} is missing but not documented as git ignored`);
    const created = new RegExp(`["'\`]${entry.name.replace(/\/$/, "")}/?["'\`]`);
    assert.ok(created.test(runner), `the runner does not create ${entry.name}`);
  }
});

test("the layout block lists every top level entry of probes/", () => {
  const block = codeBlocks(readme).find((candidate) => candidate.code.trim().startsWith("probes/"));
  assert.ok(block, "the README has no layout block");
  const listed = new Set(layoutEntries(block.code).map((entry) => entry.name.replace(/\/$/, "")));

  const entries = readdirSync(probesDir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => entry.name !== "README.md")
    .map((entry) => entry.name);
  assert.ok(entries.length >= 5, "probes/ is nearly empty");

  for (const name of entries) {
    assert.ok(listed.has(name), `probes/${name} is not listed in the layout block`);
  }
});

test("every node command of the README points at an existing script", () => {
  const scripts = [...readme.matchAll(/\bnode\s+(probes\/[^\s"'`]+)/g)].map((match) => match[1]);
  assert.ok(scripts.length >= 3, "the README names no node command");
  for (const script of scripts) {
    const target = join(repoRoot, script);
    assert.ok(existsSync(target), `${script} does not exist`);
    assert.ok(statSync(target).isFile(), `${script} is not a file`);
  }
});

test("every bot of the README table has a probe module below probes/bots/", () => {
  const rows = botRows(readme);
  assert.ok(rows.length >= 5, "the README table lists less than five bots");
  for (const row of rows) {
    const probe = PROBES.find((candidate) => candidate.label === row.bot);
    assert.ok(probe, `no probe module implements the documented bot ${row.bot}`);
    const module = join(probesDir, "bots", `${probe.id}.mjs`);
    assert.ok(existsSync(module), `probes/bots/${probe.id}.mjs does not exist`);
  }
});

test("every probe module below probes/bots/ is documented in the README table", () => {
  const rows = botRows(readme);
  const files = readdirSync(join(probesDir, "bots")).filter((name) => name.endsWith(".mjs"));
  assert.ok(files.length >= 5, "probes/bots/ holds less than five modules");
  for (const file of files) {
    const id = file.replace(/\.mjs$/, "");
    const probe = PROBES.find((candidate) => candidate.id === id);
    assert.ok(probe, `probes/bots/${file} exports no probe`);
    assert.ok(
      rows.some((row) => row.bot === probe.label),
      `the bot ${probe.label} is not documented in the README table`,
    );
  }
});

test("the started-as command of every documented bot is used by its probe module", () => {
  for (const row of botRows(readme)) {
    const probe = PROBES.find((candidate) => candidate.label === row.bot);
    const commands = inlineCode(row.startedAs);
    assert.ok(commands.length >= 1, `the row of ${row.bot} names no command`);
    assert.equal(
      commands[0],
      `${probe.command} ${probe.args.join(" ")}`,
      `the README starts ${row.bot} differently than probes/bots/${probe.id}.mjs`,
    );
    const source = readFileSync(join(probesDir, "bots", `${probe.id}.mjs`), "utf8");
    for (const command of commands) {
      assert.ok(source.includes(command), `the command ${command} is not used by probes/bots/${probe.id}.mjs`);
    }
  }
});

test("the documented machine protocol matches the probe module", () => {
  for (const row of botRows(readme)) {
    const probe = PROBES.find((candidate) => candidate.label === row.bot);
    assert.equal(
      protocolHead(row.protocol),
      protocolHead(probe.protocol),
      `the protocol of ${row.bot} does not match probes/bots/${probe.id}.mjs`,
    );
  }
});

test("every environment variable named in the README is read by the probes", () => {
  const sources = probeSources();
  const named = [...new Set(readme.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])];
  for (const name of named) {
    assert.ok(sources.includes(name), `the README names ${name} but no probe source reads it`);
  }
  // The probes honour a VOLTO_PROBE_<BOT>_BIN override, so the family is known.
  assert.ok(sources.includes("VOLTO_PROBE_"), "the probe sources lost the binary override");
  assert.ok(sources.includes("process.env"), "the probe sources do not read the ambient environment");
});

test("the safety rules of the README hold in the probe sources", () => {
  const codexSource = readFileSync(join(probesDir, "bots", "codex.mjs"), "utf8");
  assert.match(codexSource, /approvalPolicy:\s*"never"/, "the codex probe does not decline the approvals");
  assert.match(codexSource, /sandbox:\s*"read-only"/, "the codex probe does not run read only");

  for (const file of readdirSync(join(probesDir, "bots")).filter((name) => name.endsWith(".mjs"))) {
    const source = readFileSync(join(probesDir, "bots", file), "utf8");
    assert.ok(!source.includes("--api-key"), `probes/bots/${file} passes an api key flag`);
    assert.match(source, /status = "skipped"/, `probes/bots/${file} does not skip cleanly`);
  }
});

test("the documented timeout matches the default of the runner", () => {
  const runner = readFileSync(join(probesDir, "run.mjs"), "utf8");
  assert.match(runner, /DEFAULT_TIMEOUT_MS = 120_000/, "the runner does not use a timeout of 120 s");
  assert.match(runner, /arg === "--timeout"/, "the runner does not accept --timeout");
  assert.match(readme, /hard timeout of 120 s/, "the README does not mention the timeout of 120 s");
});

test("every flag the README documents for the runner is accepted by the runner", () => {
  const runner = readFileSync(join(probesDir, "run.mjs"), "utf8");
  const flags = runnerFlags();
  assert.ok(flags.size >= 3, "the README documents no flag of the runner");
  for (const flag of flags) {
    assert.ok(runner.includes(`"${flag}"`), `the runner does not accept ${flag}`);
  }
});

// DEFECT: probes/README.md never mentions the VOLTO_PROBE_<BOT>_BIN override
// that probes/lib/binary.mjs honours, so the documented environment is incomplete.
test.todo("the README documents the binary override of the probes", () => {
  assert.ok(readme.includes("VOLTO_PROBE_"), "the README does not mention the binary override");
});

// DEFECT: the layout block of probes/README.md omits the helpers
// lib/binary.mjs, lib/result.mjs and lib/transcript.mjs.
test.todo("the layout block lists every helper below lib/", () => {
  const block = codeBlocks(readme).find((candidate) => candidate.code.trim().startsWith("probes/"));
  assert.ok(block, "the README has no layout block");
  const comment = layoutEntries(block.code).find((entry) => entry.name === "lib/")?.comment ?? "";
  const files = readdirSync(join(probesDir, "lib")).filter((name) => name.endsWith(".mjs"));
  for (const file of files) {
    assert.ok(comment.includes(file.replace(/\.mjs$/, "")), `lib/${file} is not listed in the layout block`);
  }
});

// DEFECT: probes/run.mjs accepts --help but the README does not document it.
test.todo("every flag of the runner is documented in the README", () => {
  const runner = readFileSync(join(probesDir, "run.mjs"), "utf8");
  for (const match of runner.matchAll(/arg === "(--[a-z-]+)"/g)) {
    assert.ok(readme.includes(match[1]), `the README does not mention ${match[1]}`);
  }
});
