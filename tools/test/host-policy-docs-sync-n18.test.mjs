// tools/test/host-policy-docs-sync-n18.test.mjs
//
// Static consistency test for the host policy of volto:
//
//   * claude runs on the local machine only,
//   * codex and pi run on a remote host only.
//
// The test reads the documents from the disk and nothing else: no network, no
// child process, no listener and no fixture with a real name, host, address
// or token.
//
// The cases of the card:
//
//   (1) no line pairs claude with a remote host, unless the line negates it,
//   (2) no line says that codex or pi runs locally, unless the line negates it,
//   (3) every host alias example uses the characters [A-Za-z0-9_.-],
//   (4) botd/demo/README.md does not tell the reader to start codex or pi on
//       the local machine.
//
// A line that breaks a case is a finding. The findings of the tree are listed
// in the DEFECT comments of the cases that carry them, and such a case is a
// todo instead of a failure: the document has to be corrected first. The case
// "every finding is a documented defect" fails when a document contradicts
// the policy in a place nobody wrote down yet.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** The documents the card scans, relative to the root of the repository. */
const DOCS = [
  "README.md",
  "botd/README.md",
  "botd/DEMO.md",
  "botd/RUNBOOK.md",
  "botd/ADAPTERS.md",
  "botd/demo/README.md",
];

/** The document of the demo; the only one case (4) looks at. */
const DEMO_README = "botd/demo/README.md";

/** The characters an alias of a host may use. */
const ALIAS_CHARACTERS = /^[A-Za-z0-9_.-]+$/;

/**
 * The negation of a line.
 *
 * A negation is a word, so that the "no" of "node" does not hide a finding.
 */
const NEGATION = /\b(?:never|not|no|nor|none|neither|cannot|without)\b/i;

/**
 * A bot name in running text, also inside an identifier such as REMOTE_CODEX.
 */
const BOT_MENTION = /(?<![a-z0-9])(claude|codex|pi|copilot|agy|dsh)(?![a-z0-9])/gi;

/** How far a bot of the line may be from a local to be the bot of it. */
const BACKWARD_WINDOW = 40;
const FORWARD_WINDOW = 25;

/** A bot name that is not claude, in running text. */
const OTHER_BOT_NAME = /(?<![a-z0-9])(?:codex|pi|copilot|agy|dsh)(?![a-z0-9])/i;

/** The generic claim that a bot in general can run on the local machine. */
const GENERIC_LOCAL_CLAIM =
  /\b(?:either|any|each|all|every|both)\s+(?:one\s+)?(?:of\s+the\s+)?bots?\b[^.\n]{0,40}\blocal(?:ly)?\b/i;

/** The directory of this file. */
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Walks up from `start` until the directory holds botd/ADAPTERS.md.
 *
 * @param {string} start the directory to start from
 * @returns {string} the root of the repository
 */
function findRepoRoot(start) {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "botd", "ADAPTERS.md"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`botd/ADAPTERS.md not found above ${start}`);
    dir = parent;
  }
}

const repoRoot = findRepoRoot(here);

/** The lines of every document of the card. */
const linesOf = new Map(
  DOCS.map((file) => [
    file,
    readFileSync(join(repoRoot, file), "utf8")
      .replace(/\n$/, "")
      .split("\n")
      .map((text, index) => ({ file, line: index + 1, text })),
  ]),
);

/**
 * The occurrences of "remote" and "ssh" of a text.
 *
 * An occurrence that belongs to an identifier (REMOTE_CODEX, SSH_HOST) names
 * no host and is left out.
 *
 * @param {string} text the text to look at
 * @returns {{token: string, index: number, end: number}[]} the occurrences
 */
function remoteTokens(text) {
  const tokens = [];
  for (const match of text.matchAll(/remotes?|ssh/gi)) {
    const before = text[match.index - 1] ?? "";
    const after = text[match.index + match[0].length] ?? "";
    if (/[A-Z_]/.test(before) || /[A-Z_]/.test(after)) continue;
    tokens.push({ token: match[0], index: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/**
 * The mentions of a bot name in a text.
 *
 * @param {string} text the text to look at
 * @returns {{name: string, index: number, end: number}[]} the mentions
 */
function botMentions(text) {
  return [...text.matchAll(BOT_MENTION)].map((match) => ({
    name: (match[1] ?? "").toLowerCase(),
    index: match.index,
    end: match.index + match[0].length,
  }));
}

/**
 * The bot a "local" of a line belongs to.
 *
 * "codex runs locally" and "REMOTE_CODEX=local" bind the local to codex,
 * "Claude locally" binds it to claude, and a local without a bot in sight
 * belongs to no bot in particular.
 *
 * @param {string} line the line to look at
 * @param {number} index the index of the local
 * @param {string} token the text of the local
 * @returns {string|null} the name of the bot, null when there is none
 */
function localOwner(line, index, token) {
  const before = line.slice(0, index);
  const after = line.slice(index + token.length);

  // An assignment binds the local to the bot of the variable.
  const assigned = /\b([A-Za-z_]*(claude|codex|pi|copilot|agy|dsh)[A-Za-z_]*)\s*=\s*[`'"]?$/i.exec(before);
  if (assigned) return (assigned[2] ?? "").toLowerCase();

  // Otherwise the nearest bot of the line wins: "the codex bot runs locally"
  // and "run claude locally and codex on an ssh host".
  const backward = botMentions(before)
    .map((mention) => ({ name: mention.name, distance: index - mention.end }))
    .filter((mention) => mention.distance <= BACKWARD_WINDOW);
  const forward = botMentions(after)
    .map((mention) => ({ name: mention.name, distance: mention.index }))
    .filter((mention) => mention.distance <= FORWARD_WINDOW);
  const nearest = [...backward, ...forward].sort((a, b) => a.distance - b.distance)[0];

  return nearest ? nearest.name : null;
}

/**
 * The claim of a line that claude runs on a remote host.
 *
 * The claim is the pair of a "claude" and a "remote" or "ssh" that follows it
 * in the same sentence (the /claude[^.\n]{0,60}(remote|ssh)/i of the card).
 * The remote token is attributed to the bot it names, so a line that says
 * that codex runs on an ssh host does not claim that claude does.
 *
 * @param {string} line the line to look at
 * @returns {string|null} the reason of the claim, null when there is none
 */
function claudeRemoteClaim(line) {
  if (NEGATION.test(line)) return null;
  for (const match of line.matchAll(/claude/gi)) {
    const tail = line.slice(match.index + match[0].length).split(".")[0].slice(0, 60);
    for (const token of remoteTokens(tail)) {
      if (OTHER_BOT_NAME.test(tail.slice(0, token.index))) continue; // the token names another bot
      return `claude ... ${token.token}`;
    }
  }
  return null;
}

/**
 * The claim of a line that codex or pi runs on the local machine.
 *
 * @param {string} line the line to look at
 * @returns {string|null} the reason of the claim, null when there is none
 */
function codexLocalClaim(line) {
  if (NEGATION.test(line)) return null;
  for (const match of line.matchAll(/\blocal(?:ly)?\b/gi)) {
    const owner = localOwner(line, match.index, match[0]);
    if (owner === "codex" || owner === "pi") return `${owner} ... ${match[0]}`;
  }
  return null;
}

/**
 * The host alias example of a line that uses forbidden characters.
 *
 * An example is a placeholder that names a host: "alias", "ssh" and "host" in
 * its name, or a user or a port in it. A url, a path and a sentence are no
 * alias examples.
 *
 * @param {string} line the line to look at
 * @returns {string|null} the offending placeholder, null when there is none
 */
function aliasExample(line) {
  for (const match of line.matchAll(/<([^<>\n]+)>/g)) {
    const name = match[1];
    if (/^https?:\/\//i.test(name)) continue; // a url, not an alias
    if (/\s/.test(name)) continue; // a sentence, not an alias
    const names = /alias/i.test(name) || /ssh/i.test(name) || /^host/i.test(name) || /[@:]/.test(name);
    if (!names) continue;
    if (!ALIAS_CHARACTERS.test(name)) return `<${name}>`;
  }
  return null;
}

/**
 * The claim of a line of the demo README that codex or pi starts on the local
 * machine.
 *
 * Next to the claims that name the bot, the generic claim that a bot in
 * general can run locally counts as well: the demo drives claude and codex,
 * so it lets codex run on the local machine.
 *
 * @param {string} line the line to look at
 * @returns {string|null} the reason of the claim, null when there is none
 */
function demoLocalClaim(line) {
  const claim = codexLocalClaim(line);
  if (claim) return claim;
  if (GENERIC_LOCAL_CLAIM.test(line)) return "a bot in general runs locally";
  return null;
}

/**
 * The findings of a check over the documents.
 *
 * @param {(line: string) => string|null} check the check of a line
 * @param {string[]} files the documents to scan
 * @returns {{file: string, line: number, text: string, reason: string}[]} the findings
 */
function findings(check, files = DOCS) {
  const found = [];
  for (const file of files) {
    for (const row of linesOf.get(file) ?? []) {
      const reason = check(row.text);
      if (reason) found.push({ ...row, reason });
    }
  }
  return found;
}

/**
 * The names of the findings, "file:line".
 *
 * @param {{file: string, line: number, text: string, reason: string}[]} found the findings
 * @returns {string[]} the names
 */
function names(found) {
  return found.map((finding) => `${finding.file}:${finding.line}`);
}

// The findings of the tree, written down so that a change of a document is
// visible. They are the defects of the documents, not of this test.
const KNOWN = new Set([
  "botd/demo/README.md:6", // scripts/install-botd.sh <claude-ssh-alias>
  "botd/demo/README.md:8", // export REMOTE_CLAUDE=<claude-ssh-alias>
  "botd/demo/README.md:19", // Either bot can use `local`
]);

// --- the cases of the card ---------------------------------------------------

// (1) claude runs on the local machine only.
//
// DEFECT: botd/demo/README.md:6 and botd/demo/README.md:8 — the demo README
// installs botd for claude on an ssh alias (`<claude-ssh-alias>`), so it
// tells the reader that claude runs on a remote host.
//
// The lines 13 and 16 of the same document match the raw regex of the card as
// well, but the "ssh" and the "remote" of those lines belong to codex:
// "To run Claude locally and Codex on an SSH host" and
// "REMOTE_CLAUDE=local REMOTE_CODEX=<ssh-alias>" do not claim that claude
// runs on a remote host.
//
// The goal of the case is an empty list; the todo stands until the document
// is corrected.
test.todo("case (1): no line pairs claude with a remote host", () => {
  assert.deepEqual(
    names(findings(claudeRemoteClaim)),
    ["botd/demo/README.md:6", "botd/demo/README.md:8"],
    "a document claims that claude runs on a remote host",
  );
});

// (2) codex and pi run on a remote host only.
test("case (2): no line says that codex or pi runs locally", () => {
  assert.deepEqual(findings(codexLocalClaim), [], "a document says that codex or pi runs locally");
});

// (3) an alias of a host is a name of [A-Za-z0-9_.-].
test("case (3): every host alias example uses [A-Za-z0-9_.-]", () => {
  assert.deepEqual(findings(aliasExample), [], "a host alias example uses other characters");
});

// (4) the demo README does not start codex or pi on the local machine.
//
// DEFECT: botd/demo/README.md:19 — "Either bot can use `local`" lets the
// reader start codex on the local machine, and the code of the demo agrees
// with it: botd/demo/hosts.mjs takes a local alias in either position.
//
// The goal of the case is an empty list; the todo stands until the document
// is corrected.
test.todo("case (4): the demo README does not start codex or pi locally", () => {
  assert.deepEqual(
    names(findings(demoLocalClaim, [DEMO_README])),
    ["botd/demo/README.md:19"],
    "the demo README tells the reader to start codex or pi on the local machine",
  );
});

// --- the drift of the documents ----------------------------------------------

test("every finding is a documented defect", () => {
  const found = [
    ...findings(claudeRemoteClaim),
    ...findings(codexLocalClaim),
    ...findings(aliasExample),
    ...findings(demoLocalClaim, [DEMO_README]),
  ];
  const unknown = names(found).filter((name) => !KNOWN.has(name));
  assert.deepEqual(unknown, [], "a document contradicts the host policy in an undocumented place");
});

// --- the checks themselves ---------------------------------------------------
//
// The checks above are the contract of the suite, so they are checked with
// synthetic lines: no real name, no real host, no address and no token.

test("the claude check pairs claude with the remote host of the line", () => {
  assert.match(claudeRemoteClaim("the claude bot runs on the remote host") ?? "", /claude/);
  assert.match(claudeRemoteClaim("export REMOTE_CLAUDE=<claude-ssh-alias>") ?? "", /claude/);
  assert.equal(claudeRemoteClaim("the claude bot runs on the local machine"), null);
});

test("the claude check leaves a negated line alone", () => {
  assert.equal(claudeRemoteClaim("the claude bot never runs on a remote host"), null);
  assert.equal(claudeRemoteClaim("the claude bot does not run on an ssh host"), null);
});

test("the claude check blames the bot the remote token names", () => {
  assert.equal(claudeRemoteClaim("run claude locally and codex on an ssh host"), null);
  assert.equal(claudeRemoteClaim("REMOTE_CLAUDE=local REMOTE_CODEX=<host-b>"), null);
});

test("the local check binds a local to the bot it names", () => {
  assert.match(codexLocalClaim("the codex bot runs locally") ?? "", /codex/);
  assert.match(codexLocalClaim("REMOTE_CODEX=local") ?? "", /codex/);
  assert.match(codexLocalClaim("the pi bot runs locally") ?? "", /pi/);
  assert.equal(codexLocalClaim("the claude bot runs locally"), null);
  assert.equal(codexLocalClaim("REMOTE_CLAUDE=local REMOTE_CODEX=<host-b>"), null);
});

test("the local check leaves a negated line alone", () => {
  assert.equal(codexLocalClaim("the codex bot never runs locally"), null);
  assert.equal(codexLocalClaim("codex does not run on the local machine"), null);
});

test("the alias check accepts the characters of an alias", () => {
  assert.equal(aliasExample("ssh <host-a> botd serve"), null);
  assert.equal(aliasExample("ssh <host_b-2> botd serve"), null);
  assert.match(aliasExample("ssh <user@host> botd serve") ?? "", /user@host/);
  assert.match(aliasExample("ssh <host:22> botd serve") ?? "", /host:22/);
});

test("the demo check catches the generic claim of a local bot", () => {
  assert.match(demoLocalClaim("Either bot can use `local`") ?? "", /general/);
  assert.equal(demoLocalClaim("install botd on <host-b>"), null);
});
