// tools/test/readme-links.test.mjs
//
// Tests for the links, the paths and the anchors of the documentation.
//
// The documents name the files they talk about: markdown links, backticked
// repo paths and the headings their anchors point at. A name that does not
// exist any more is a dead end for the reader, so every document of the card
// is checked against the tree it lives in.
//
// The documents of the card:
//
//   README.md
//   botd/PROTOCOL.md, botd/RUNBOOK.md, botd/TROUBLESHOOTING.md, botd/DEMO.md
//   botd/e2e/README.md
//   probes/README.md, probes/REPORT.md, python/README.md
//   botd/test/conformance/DEVIATIONS.md
//
// The conformance document names the tests of the deviations: a test file or
// a test title that does not exist hides the deviation it describes.
//
// The unit tests scan a synthetic fixture tree: no host name, no address and
// no credential appears in this file.
//
// Node 24, no dependencies: only the standard library is used.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/** Directory of this file. */
const here = dirname(fileURLToPath(import.meta.url));

/** The root of the repository. */
const repoRoot = join(here, "..", "..");

/** The documents of the card. */
const DOCUMENTS = [
  "README.md",
  "botd/PROTOCOL.md",
  "botd/RUNBOOK.md",
  "botd/TROUBLESHOOTING.md",
  "botd/DEMO.md",
  "botd/e2e/README.md",
  "probes/README.md",
  "probes/REPORT.md",
  "python/README.md",
  "botd/test/conformance/DEVIATIONS.md",
];

/** The prefixes of the backticked spans that name a file of the repository. */
const REPO_PATH_PREFIXES = ["botd/", "client-ui/", "probes/", "scripts/", "tools/"];

/** The directory of the conformance tests, relative to the repository root. */
const CONFORMANCE_DIR = "botd/test/conformance";

/**
 * One finding of the document scan.
 *
 * @typedef {{ file: string, line: number, message: string }} Finding
 */

// --- the scratch space -----------------------------------------------------

// Scratch space for the fixture, inside the worktree. Every test file has
// its own directory: the suites run in parallel and must not delete the
// scratch space of another one.
const scratch = join(here, ".tmp", "readme-links");
mkdirSync(scratch, { recursive: true });

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// --- the helpers -----------------------------------------------------------

/**
 * The text of a document of the repository.
 *
 * @param {string} root
 * @param {string} doc the path of the document, relative to the root
 * @returns {string}
 */
function readDocument(root, doc) {
  return readFileSync(join(root, doc), "utf8");
}

/**
 * Blanks the fenced code blocks of a markdown text.
 *
 * A `#` inside a fence is a shell comment and not a heading, and a link
 * inside a fence is an example and not a link. The fences keep their line,
 * so the line numbers of the rest of the document do not move.
 *
 * @param {string} text
 * @returns {string}
 */
function maskFences(text) {
  let inside = false;
  let marker = "";
  return text
    .split("\n")
    .map((line) => {
      const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (!inside) {
        if (!fence) return line;
        inside = true;
        marker = fence[1][0];
        return "";
      }
      if (fence && fence[1][0] === marker) inside = false;
      return "";
    })
    .join("\n");
}

/**
 * The line of a position in a text.
 *
 * @param {string} text
 * @param {number} index
 * @returns {number} the line, counted from one
 */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/**
 * The markdown links of a text.
 *
 * @param {string} text
 * @returns {{ target: string, line: number }[]}
 */
function markdownLinks(text) {
  const links = [];
  for (const match of text.matchAll(/\[([^\]]*)\]\(([^)\s]*)\)/g)) {
    links.push({ target: match[2], line: lineOf(text, match.index) });
  }
  return links;
}

/**
 * The inline code spans of a text.
 *
 * @param {string} text
 * @returns {{ code: string, line: number }[]}
 */
function inlineCodeSpans(text) {
  const spans = [];
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    spans.push({ code: match[1].trim(), line: lineOf(text, match.index) });
  }
  return spans;
}

/**
 * The slug of a heading, the way GitHub builds the anchors of a document.
 *
 * @param {string} heading the text of the heading, without its hashes
 * @returns {string}
 */
function slugify(heading) {
  return heading
    .replace(/`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-_]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

/**
 * The slugs of the headings of a markdown text.
 *
 * @param {string} text
 * @returns {Map<string, string>} the slug of every heading and its text
 */
function headingSlugs(text) {
  const slugs = new Map();
  for (const line of maskFences(text).split("\n")) {
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const slug = slugify(heading[2]);
    if (slug !== "") slugs.set(slug, heading[2]);
  }
  return slugs;
}

/**
 * The paragraphs of a markdown text, with the line they start at.
 *
 * The lines of a paragraph are joined with a space: a title that is wrapped
 * over two lines is one title.
 *
 * @param {string} text
 * @returns {{ text: string, line: number }[]}
 */
function paragraphs(text) {
  const result = [];
  let lines = [];
  let start = 1;
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") {
      if (lines.length > 0) result.push({ text: lines.join(" "), line: start });
      lines = [];
      return;
    }
    if (lines.length === 0) start = index + 1;
    lines.push(line.trim());
  });
  if (lines.length > 0) result.push({ text: lines.join(" "), line: start });
  return result;
}

/**
 * The ignore rules of a tree: the patterns of its .gitignore files.
 *
 * Only the patterns of this repository are supported: the name of a
 * directory (with an optional wildcard) that is not committed. The trailing
 * slash of a pattern is dropped: a directory rule and a plain rule cover
 * the same names here. A negated pattern is skipped: the repository does
 * not use one.
 *
 * @param {string} root
 * @returns {{ dir: string, name: string }[]}
 */
function ignoreRules(root) {
  const rules = [];
  const walk = (directory, scope) => {
    const file = join(directory, ".gitignore");
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const pattern = line.trim();
        if (pattern === "" || pattern.startsWith("#") || pattern.startsWith("!")) continue;
        const name = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
        if (name === "") continue;
        rules.push({ dir: scope, name });
      }
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".git" || entry.name === ".tmp" || entry.name === "node_modules") continue;
      walk(join(directory, entry.name), scope === "" ? entry.name : `${scope}/${entry.name}`);
    }
  };
  walk(root, "");
  return rules;
}

/**
 * Whether a name matches a pattern of a .gitignore file.
 *
 * @param {string} pattern
 * @param {string} name
 * @returns {boolean}
 */
function matchesName(pattern, name) {
  if (pattern === name) return true;
  if (!pattern.includes("*") && !pattern.includes("?")) return false;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, "[^/]*").replace(/\?/g, ".")}$`).test(name);
}

/**
 * Whether a path of the tree is a generated artifact that is not committed.
 *
 * @param {{ dir: string, name: string }[]} rules
 * @param {string} path the path, relative to the root of the tree
 * @returns {boolean}
 */
function isIgnoredPath(rules, path) {
  const segments = path.split("/").filter((segment) => segment !== "");
  for (let i = 0; i < segments.length; i++) {
    const scope = segments.slice(0, i).join("/");
    for (const rule of rules) {
      if (rule.dir !== "" && scope !== rule.dir && !scope.startsWith(`${rule.dir}/`)) continue;
      // The last segment of the path counts as a directory as well: a
      // document names the generated directory of a suite, and that
      // directory is not in the tree.
      if (matchesName(rule.name, segments[i])) return true;
    }
  }
  return false;
}

/**
 * The findings of the markdown links of a document.
 *
 * A link that points at another file of the tree has to exist; the anchors
 * are checked by {@link collectAnchorFindings}.
 *
 * @param {string} root
 * @param {string} doc the path of the document, relative to the root
 * @param {string} text
 * @returns {Finding[]}
 */
function collectLinkFindings(root, doc, text) {
  const findings = [];
  for (const link of markdownLinks(maskFences(text))) {
    const target = link.target;
    if (target === "") continue;
    if (target.startsWith("/")) continue; // a link into the site
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http, mailto, ...
    const file = target.split("#")[0];
    if (file === "") continue; // an anchor of the document itself
    const absolute = resolve(dirname(join(root, doc)), file);
    if (!existsSync(absolute)) {
      findings.push({
        file: doc,
        line: link.line,
        message: `the link "${target}" points at a file that does not exist`,
      });
    }
  }
  return findings;
}

/**
 * The findings of the backticked paths of a document.
 *
 * A backticked path that names a file of the repository has to exist. The
 * generated artifacts (the transcripts of the probes, the scratch space of
 * the suites) are ignored: they are not committed, the documents say so.
 *
 * @param {string} root
 * @param {string} doc the path of the document, relative to the root
 * @param {string} text
 * @param {{ dir: string, name: string }[]} rules
 * @returns {Finding[]}
 */
function collectPathFindings(root, doc, text, rules) {
  const findings = [];
  for (const span of inlineCodeSpans(maskFences(text))) {
    const code = span.code;
    if (/\s/.test(code)) continue; // a sentence, not a path
    if (!REPO_PATH_PREFIXES.some((prefix) => code.startsWith(prefix))) continue;
    if (/[*?]/.test(code)) continue; // a glob, not a path
    const path = code.replace(/^\.\//, "");
    if (existsSync(join(root, path))) continue;
    if (isIgnoredPath(rules, path)) continue; // a generated artifact
    findings.push({
      file: doc,
      line: span.line,
      message: `the path "${code}" does not exist`,
    });
  }
  return findings;
}

/**
 * The findings of the anchor links of a document.
 *
 * An anchor has to match a heading of the document it points at.
 *
 * @param {string} root
 * @param {string} doc the path of the document, relative to the root
 * @param {string} text
 * @returns {Finding[]}
 */
function collectAnchorFindings(root, doc, text) {
  const findings = [];
  const own = headingSlugs(text);
  for (const link of markdownLinks(maskFences(text))) {
    const target = link.target;
    if (target === "") continue;
    if (target.startsWith("/")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const [file, anchor] = target.split("#");
    if (anchor === undefined) continue; // a link without an anchor
    if (file === "") {
      if (!own.has(anchor)) {
        findings.push({
          file: doc,
          line: link.line,
          message: `the link "${target}" points at a heading that does not exist`,
        });
      }
      continue;
    }
    const absolute = resolve(dirname(join(root, doc)), file);
    // A file that does not exist is reported by the link check.
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    if (!absolute.endsWith(".md")) continue; // only a document has headings
    const slugs = headingSlugs(readFileSync(absolute, "utf8"));
    if (!slugs.has(anchor)) {
      findings.push({
        file: doc,
        line: link.line,
        message: `the link "${target}" points at a heading that does not exist`,
      });
    }
  }
  return findings;
}

/**
 * The test file a name of the conformance document points at.
 *
 * The names of the document are relative to the botd package
 * (`test/conformance/lease.test.ts`) or to the root of the repository
 * (`botd/test/protocol-doc.test.ts`).
 *
 * @param {string} root
 * @param {string} name
 * @returns {string | null} the path of the file, relative to the root
 */
function resolveTestFile(root, name) {
  for (const candidate of [name, `botd/${name}`]) {
    const absolute = join(root, candidate);
    if (existsSync(absolute) && statSync(absolute).isFile()) return candidate;
  }
  return null;
}

/**
 * The titles of the tests of a test file.
 *
 * @param {string} file
 * @returns {Set<string>}
 */
function testTitlesOf(file) {
  const titles = new Set();
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/\btest(?:\.todo|\.skip|\.only)?\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    titles.add(match[1].replace(/\\"/g, '"'));
  }
  return titles;
}

/**
 * The entries of the conformance document: the paragraphs that name the
 * tests of the deviations.
 *
 * @param {string} root
 * @returns {{ line: number, files: string[], titles: string[] }[]}
 */
function deviationEntries(root) {
  const doc = `${CONFORMANCE_DIR}/DEVIATIONS.md`;
  const text = readDocument(root, doc);
  const entries = [];
  for (const paragraph of paragraphs(text)) {
    if (!paragraph.text.startsWith("**Test:**")) continue;
    entries.push({
      line: paragraph.line,
      files: [...paragraph.text.matchAll(/`([^`\n]*\.test\.ts)`/g)].map((match) => match[1]),
      titles: [...paragraph.text.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    });
  }
  return entries;
}

/**
 * The findings of the entries of the conformance document.
 *
 * An entry names the test file of its deviation and the titles of the tests
 * that mark it. Both have to exist: a name that does not exist hides the
 * deviation.
 *
 * @param {string} root
 * @returns {Finding[]}
 */
function collectDeviationFindings(root) {
  const doc = `${CONFORMANCE_DIR}/DEVIATIONS.md`;
  const text = readDocument(root, doc);
  const findings = [];

  for (const entry of deviationEntries(root)) {
    const { files, titles } = entry;
    for (const file of files) {
      const resolved = resolveTestFile(root, file);
      if (!resolved) {
        findings.push({
          file: doc,
          line: entry.line,
          message: `the entry names the test file "${file}", which does not exist`,
        });
        continue;
      }
      if (!resolved.startsWith(`${CONFORMANCE_DIR}/`)) {
        findings.push({
          file: doc,
          line: entry.line,
          message:
            `the entry names the test file "${file}", ` +
            `which is not below ${CONFORMANCE_DIR}/`,
        });
        continue;
      }
      const known = testTitlesOf(join(root, resolved));
      for (const title of titles) {
        if (!known.has(title)) {
          findings.push({
            file: doc,
            line: entry.line,
            message: `the entry names the test "${title}", which ${resolved} does not have`,
          });
        }
      }
    }
  }

  // Every test file the document names has to exist, not only the ones of
  // the entries.
  for (const span of inlineCodeSpans(maskFences(text))) {
    if (!/\.test\.ts$/.test(span.code)) continue;
    if (!resolveTestFile(root, span.code)) {
      findings.push({
        file: doc,
        line: span.line,
        message: `the document names the test file "${span.code}", which does not exist`,
      });
    }
  }

  return findings;
}

/**
 * The number of the names the scan of the documents looks at.
 *
 * The numbers guard the scan against a silent no-op: a scan that finds
 * nothing cannot fail.
 *
 * @param {string} root
 * @returns {{ links: number, anchors: number, paths: number }}
 */
function scanCounts(root) {
  const counts = { links: 0, anchors: 0, paths: 0 };
  for (const doc of DOCUMENTS) {
    const prose = maskFences(readDocument(root, doc));
    const links = markdownLinks(prose);
    counts.links += links.length;
    counts.anchors += links.filter((link) => link.target.includes("#")).length;
    for (const span of inlineCodeSpans(prose)) {
      if (/\s/.test(span.code)) continue;
      if (!REPO_PATH_PREFIXES.some((prefix) => span.code.startsWith(prefix))) continue;
      counts.paths++;
    }
  }
  return counts;
}

/**
 * Fails with one message that lists every finding with its file and its
 * line.
 *
 * @param {Finding[]} findings
 * @param {string} what the name of the check, for the message
 * @returns {void}
 */
function assertNoFindings(findings, what) {
  if (findings.length === 0) return;
  const lines = findings.map((finding) => `  ${finding.file}:${finding.line}: ${finding.message}`);
  assert.fail(`${findings.length} ${what}:\n${lines.join("\n")}`);
}

// --- the fixture -----------------------------------------------------------

/**
 * Writes a synthetic tree of documents.
 *
 * The tree holds a guide, a document that links at a file that does not
 * exist, a link with an anchor that matches no heading, an external link
 * and three backticked paths: one that exists, one that does not and one
 * that is a generated artifact.
 *
 * @returns {string} the root of the tree
 */
function writeFixture() {
  const root = join(scratch, "fixture");
  mkdirSync(join(root, "tools"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "out/\n");
  writeFileSync(join(root, "guide.md"), "# Guide\n\n## The rules\n\nNothing to see.\n");
  writeFileSync(join(root, "tools", "check-lock.mjs"), "// synthetic fixture\n");
  writeFileSync(
    join(root, "README.md"),
    [
      "# Fixture",
      "",
      "The [guide](guide.md) explains the rules.",
      "",
      "The [missing guide](nowhere.md) is a dead end.",
      "",
      "The [missing anchor](guide.md#no-such-heading) is a dead end too.",
      "",
      "The [external manual](https://example.invalid/manual) is not checked.",
      "",
      "The path `tools/check-lock.mjs` exists, `tools/nowhere.mjs` does not and",
      "`tools/out/report.md` is a generated artifact.",
      "",
    ].join("\n"),
  );
  return root;
}

// --- the tests -------------------------------------------------------------

test("the slug of a heading follows the rules of GitHub", () => {
  assert.equal(slugify("1. Framing"), "1-framing");
  assert.equal(slugify("The node of the host"), "the-node-of-the-host");
  assert.equal(
    slugify("Leases, acknowledgements and reconnects"),
    "leases-acknowledgements-and-reconnects",
  );
  assert.equal(slugify("Example 1 — a session that runs"), "example-1--a-session-that-runs");
  assert.equal(slugify("`hello` is the first frame"), "hello-is-the-first-frame");
  assert.equal(slugify("4. Sessions, sequence numbers, acknowledgements and the ring buffer"),
    "4-sessions-sequence-numbers-acknowledgements-and-the-ring-buffer");
});

test("a link and a path that do not exist are reported with the file and the line", () => {
  const root = writeFixture();
  const text = readDocument(root, "README.md");

  const links = collectLinkFindings(root, "README.md", text);
  assert.deepEqual(
    links.map((finding) => `${finding.file}:${finding.line}`),
    ["README.md:5"],
  );
  assert.match(links[0].message, /nowhere\.md/);

  const paths = collectPathFindings(root, "README.md", text, ignoreRules(root));
  assert.deepEqual(
    paths.map((finding) => `${finding.file}:${finding.line}`),
    ["README.md:11"],
  );
  assert.match(paths[0].message, /tools\/nowhere\.mjs/);
});

test("an anchor that matches no heading is reported with the file and the line", () => {
  const root = writeFixture();
  const text = readDocument(root, "README.md");

  const anchors = collectAnchorFindings(root, "README.md", text);

  assert.deepEqual(
    anchors.map((finding) => `${finding.file}:${finding.line}`),
    ["README.md:7"],
  );
  assert.match(anchors[0].message, /guide\.md#no-such-heading/);
});

test("a generated artifact is not a missing path", () => {
  const root = writeFixture();
  const text = readDocument(root, "README.md");

  const paths = collectPathFindings(root, "README.md", text, ignoreRules(root));

  assert.equal(paths.length, 1);
  assert.ok(!paths.some((finding) => finding.message.includes("tools/out/report.md")));
});

test("the failure message lists every finding with its file and its line", () => {
  const root = writeFixture();
  const text = readDocument(root, "README.md");
  const findings = [
    ...collectLinkFindings(root, "README.md", text),
    ...collectAnchorFindings(root, "README.md", text),
    ...collectPathFindings(root, "README.md", text, ignoreRules(root)),
  ];

  assert.throws(
    () => assertNoFindings(findings, "broken names in the fixture"),
    (error) => {
      assert.match(error.message, /3 broken names in the fixture/);
      assert.match(error.message, /README\.md:5: the link "nowhere\.md"/);
      assert.match(error.message, /README\.md:7: the link "guide\.md#no-such-heading"/);
      assert.match(error.message, /README\.md:11: the path "tools\/nowhere\.mjs"/);
      return true;
    },
  );
});

test("every document of the card exists", () => {
  for (const doc of DOCUMENTS) {
    assert.ok(existsSync(join(repoRoot, doc)), `${doc} does not exist`);
  }
});

test("every markdown link of the documents points at a file that exists", () => {
  const counts = scanCounts(repoRoot);
  assert.ok(counts.links >= 40, `the scan found only ${counts.links} links`);

  const findings = [];
  for (const doc of DOCUMENTS) {
    findings.push(...collectLinkFindings(repoRoot, doc, readDocument(repoRoot, doc)));
  }

  assertNoFindings(findings, "broken markdown links");
});

test("every backticked path of the documents exists", () => {
  const counts = scanCounts(repoRoot);
  assert.ok(counts.paths >= 80, `the scan found only ${counts.paths} paths`);

  const rules = ignoreRules(repoRoot);
  const findings = [];
  for (const doc of DOCUMENTS) {
    findings.push(...collectPathFindings(repoRoot, doc, readDocument(repoRoot, doc), rules));
  }

  assertNoFindings(findings, "backticked paths that do not exist");
});

test("every anchor link of the documents matches a heading", () => {
  const counts = scanCounts(repoRoot);
  assert.ok(counts.anchors >= 15, `the scan found only ${counts.anchors} anchors`);

  const findings = [];
  for (const doc of DOCUMENTS) {
    findings.push(...collectAnchorFindings(repoRoot, doc, readDocument(repoRoot, doc)));
  }

  assertNoFindings(findings, "anchors that match no heading");
});

test("every entry of the conformance document names a real test", () => {
  const entries = deviationEntries(repoRoot);
  assert.ok(entries.length >= 4, `the document holds only ${entries.length} entries`);
  assert.ok(
    entries.some((entry) => entry.titles.length > 0),
    "no entry names a test title",
  );

  assertNoFindings(collectDeviationFindings(repoRoot), "deviations that name no real test");
});

test("the contract of the daemon is the document the card names", () => {
  assert.ok(existsSync(join(repoRoot, "botd", "PROTOCOL.md")), "botd/PROTOCOL.md does not exist");
  assert.ok(
    existsSync(join(repoRoot, "botd", "src", "adapter-types.ts")),
    "botd/src/adapter-types.ts does not exist",
  );
  assert.ok(
    !existsSync(join(repoRoot, "docs", "CONTRACT.md")),
    "docs/CONTRACT.md exists: the contract is botd/PROTOCOL.md and botd/src/adapter-types.ts",
  );
});
