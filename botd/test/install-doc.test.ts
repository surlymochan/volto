// Drift test for botd/INSTALL.md.
//
// The installation document has to stay in sync with the installer:
// every option the parser of scripts/install-botd.sh accepts has to be
// documented, every option the document lists has to exist in that parser,
// the usage text of the installer has to mention every option the document
// advertises, and the dry run walkthrough of the document has to be the
// output the installer really prints.
//
// The document names no host: it uses the placeholder <ssh-alias> and holds
// no address and no credential.
//
// The installer is run with --help and with --dry-run only: both paths
// return before the installer opens an ssh connection, so the test needs no
// host and no network.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory of this file. */
const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from `start` until the directory holds botd/INSTALL.md. */
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "botd", "INSTALL.md"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`botd/INSTALL.md not found above ${start}`);
    dir = parent;
  }
}

const repoRoot = findRepoRoot(here);
const doc = readFileSync(join(repoRoot, "botd", "INSTALL.md"), "utf8");
const docLines = doc.replace(/\n$/, "").split("\n");
const installer = join(repoRoot, "scripts", "install-botd.sh");
const script = readFileSync(installer, "utf8");

/** The lines of the section that starts with the given heading. */
function section(heading: string): string[] {
  const lines: string[] = [];
  const level = /^#+/.exec(heading)?.[0].length ?? 1;
  let inside = false;
  for (const line of docLines) {
    const match = /^(#+)\s/.exec(line);
    if (match) {
      if (inside) {
        // A heading of the same or of a higher level ends the section.
        if (match[1].length <= level) break;
        continue;
      }
      if (line.startsWith(heading)) inside = true;
      continue;
    }
    if (inside) lines.push(line);
  }
  return lines;
}

/** The cells of every data row of the tables in `lines`. */
function tableRows(lines: string[]): string[][] {
  const rows: string[][] = [];
  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^-+$/.test(cell))) continue; // the separator
    rows.push(cells);
  }
  // The first row of a table is its header.
  return rows.slice(1);
}

/** The option tokens of one table cell: `--prefix <dir>`, `-h`, `--help`. */
function cellOptions(cell: string): string[] {
  const options: string[] = [];
  for (const part of cell.split(",")) {
    const token = part.trim().replace(/`/g, "");
    if (!token.startsWith("-")) continue;
    options.push(token.split(/\s+/)[0] ?? "");
  }
  return options;
}

/** The family of an option: `--prefix=<dir>` and `--prefix` are one option. */
function family(option: string): string {
  return option.split("=")[0] ?? "";
}

/** One branch of the option case statement of the installer. */
type Branch = { pattern: string; body: string };

/** The branches of the option case statement of the installer. */
function caseBranches(): Branch[] {
  const start = script.indexOf("case $1 in");
  assert.ok(start >= 0, "scripts/install-botd.sh has no option case statement");
  const rest = script.slice(start + "case $1 in".length);
  const end = /\n\s*esac\b/.exec(rest);
  assert.ok(end, "scripts/install-botd.sh has no closed option case statement");
  const branches: Branch[] = [];
  let current: { pattern: string; body: string[] } | null = null;
  let expectPattern = true;
  for (const line of rest.slice(0, end.index).split("\n")) {
    if (expectPattern) {
      if (line.trim().length === 0) continue;
      const match = /^\s*([^\s)]*)\)\s*$/.exec(line);
      assert.ok(match, `unexpected line in the option case statement: ${line}`);
      current = { pattern: match[1] ?? "", body: [] };
      expectPattern = false;
      continue;
    }
    if (line.trim() === ";;") {
      branches.push({ pattern: current?.pattern ?? "", body: current?.body.join("\n") ?? "" });
      current = null;
      expectPattern = true;
      continue;
    }
    current?.body.push(line);
  }
  assert.equal(expectPattern, true, "the option case statement of scripts/install-botd.sh is not closed");
  return branches;
}

const branches = caseBranches();

/** The options the parser of the installer accepts. */
const scriptOptions = new Set<string>();
/** The exact spellings the parser of the installer accepts. */
const scriptAlternatives = new Set<string>();
/** The positional argument of the installer, if it takes one. */
let positional = "";

for (const branch of branches) {
  if (branch.pattern === "-*") {
    // The catch-all of the unknown options.
    assert.match(branch.body, /unknown option/, "the catch-all of the installer does not reject the option");
    continue;
  }
  if (branch.pattern === "*") {
    // The catch-all of the arguments: the host of the install.
    assert.match(branch.body, /alias=\$1/, "the installer takes no host as an argument");
    positional = "<ssh-alias>";
    continue;
  }
  for (const alternative of branch.pattern.split("|")) {
    scriptOptions.add(family(alternative));
    scriptAlternatives.add(alternative);
  }
}

/** The options the document lists: the advertised ones and the arguments. */
const optionsRows = tableRows(section("## Options"));
const argumentRows = tableRows(section("## Other arguments"));
const docOptions = new Set<string>();
for (const row of [...optionsRows, ...argumentRows]) {
  for (const option of cellOptions(row[0] ?? "")) docOptions.add(family(option));
}

/** The code of the document: the fenced blocks and the inline code spans. */
function codeOf(text: string): string[] {
  const blocks: string[] = [];
  const fenced = /```[^\n]*\n([\s\S]*?)```/g;
  for (const match of text.matchAll(fenced)) blocks.push(match[1] ?? "");
  const withoutFences = text.replace(fenced, "\n");
  for (const match of withoutFences.matchAll(/`([^`\n]+)`/g)) blocks.push(match[1] ?? "");
  return blocks;
}

test("every option of the installer is documented", () => {
  assert.ok(scriptOptions.size >= 5, `the installer accepts only ${scriptOptions.size} options`);
  for (const option of scriptOptions) {
    assert.ok(
      docOptions.has(option),
      `the installer accepts "${option}" but botd/INSTALL.md does not document it`,
    );
  }
});

test("every documented option exists in the installer", () => {
  assert.ok(docOptions.size >= 5, `botd/INSTALL.md lists only ${docOptions.size} options`);
  for (const option of docOptions) {
    assert.ok(
      scriptOptions.has(option),
      `botd/INSTALL.md documents "${option}" but scripts/install-botd.sh does not accept it`,
    );
    // The document names a spelling; the parser has to know that spelling.
    assert.ok(
      scriptAlternatives.has(option),
      `botd/INSTALL.md documents "${option}" but scripts/install-botd.sh does not accept that spelling`,
    );
  }
});

test("the document names the host argument of the installer", () => {
  assert.equal(positional, "<ssh-alias>", "the installer takes no host as an argument");
  assert.ok(
    doc.includes("`<ssh-alias>`"),
    "botd/INSTALL.md does not use the placeholder of the host",
  );
});

test("the usage text of the installer mentions every option the document lists", () => {
  const help = spawnSync("bash", [installer, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, `the installer --help failed: ${help.stderr}`);
  const usage = help.stdout;
  assert.ok(usage.includes("<ssh-alias>"), "the usage text does not name the host argument");
  for (const row of optionsRows) {
    for (const option of cellOptions(row[0] ?? "")) {
      assert.ok(usage.includes(option), `the usage text does not mention "${option}"`);
    }
  }
  // The help path has to run before the installer opens a connection.
  const helpBranch = script.indexOf("-h|--help)");
  const firstSsh = script.indexOf('ssh "$alias"');
  assert.ok(helpBranch > 0, "the installer has no help branch");
  assert.ok(
    firstSsh > helpBranch,
    "the help path of the installer runs after it connected to a host",
  );
});

test("the dry run walkthrough of the document is the output of the installer", () => {
  const runs: string[][] = [
    ["<ssh-alias>", "--dry-run"],
    ["<ssh-alias>", "--ensure-node", "--dry-run"],
  ];
  for (const args of runs) {
    const run = spawnSync("bash", [installer, ...args], { encoding: "utf8" });
    assert.equal(run.status, 0, `the dry run failed: ${run.stderr}`);
    const lines = run.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    assert.ok(lines.length >= 6, "the dry run printed no plan");
    for (const line of lines) {
      assert.ok(doc.includes(line), `botd/INSTALL.md does not show the dry run line: ${line}`);
    }
  }
});

test("the document describes the layout the installer creates", () => {
  const defaultPrefix = /DEFAULT_PREFIX='([^']*)'/.exec(script)?.[1];
  assert.ok(defaultPrefix, "scripts/install-botd.sh has no DEFAULT_PREFIX");
  const paths = [
    `${defaultPrefix}/app/`,
    `${defaultPrefix}/app/src/main.ts`,
    `${defaultPrefix}/bin/botd`,
    `${defaultPrefix}/node/`,
    `${defaultPrefix}/.node-tmp/`,
    "~/.local/bin/botd",
  ];
  const layout = tableRows(section("## What is installed where")).map(
    (row) => (row[0] ?? "").replace(/`/g, ""),
  );
  assert.ok(layout.length >= paths.length, "the document has no table of the layout");
  for (const path of paths) {
    assert.ok(layout.includes(path), `botd/INSTALL.md does not list ${path} in the layout`);
  }
  assert.ok(
    doc.includes("`--ensure-node`") && doc.includes("`--dry-run`"),
    "botd/INSTALL.md does not document the options of the installer",
  );
});

test("the document names no host, no address and no credential", () => {
  const addresses = [...doc.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)].map((match) => match[0]);
  assert.deepEqual(addresses, [], `the document holds an address: ${addresses.join(", ")}`);

  // The extensions of the files the document links to are not host names.
  const extensions = new Set(["md", "sh", "ts", "mjs", "js", "json", "txt", "yml", "yaml"]);
  const hosts: string[] = [];
  for (const match of doc.matchAll(/\b([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)\b/gi)) {
    const name = match[1] ?? "";
    const suffix = name.split(".").pop()?.toLowerCase() ?? "";
    if (extensions.has(suffix)) continue; // a file name
    if (/^v?\d+(\.\d+){1,3}$/i.test(name)) continue; // a version
    hosts.push(name);
  }
  assert.deepEqual(hosts, [], `the document holds a host name: ${hosts.join(", ")}`);

  const credentials = [
    /\bsk-[A-Za-z0-9_-]{8,}/,
    /\bgh[pousr]_[A-Za-z0-9]{8,}/,
    /\bAKIA[0-9A-Z]{8,}/,
    /\bBearer\s+\S{8,}/i,
    /\b[A-Fa-f0-9]{40,}\b/,
  ];
  for (const pattern of credentials) {
    assert.ok(!pattern.test(doc), `the document holds a credential: ${pattern}`);
  }

  // Every host the document connects to is a placeholder.
  for (const block of codeOf(doc)) {
    for (const match of block.matchAll(/\bssh\s+(\S+)/g)) {
      const target = match[1] ?? "";
      assert.ok(
        target.startsWith("<"),
        `the document connects to "${target}" instead of a placeholder`,
      );
    }
  }
});
