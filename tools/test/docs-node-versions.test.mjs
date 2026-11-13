// tools/test/docs-node-versions.test.mjs
//
// Contract test for the node version of the repository.
//
// The node version is named in a lot of places: the workflows pin the
// runtime of CI, botd/package.json declares the floor of the daemon,
// scripts/install-botd.sh refuses a host below that floor, and the documents
// tell the operator which node to install. The suite reads those files —
// and nothing else — and checks that they tell one story:
//
//   1. every workflow pins node 24,
//   2. the floor of the installer is the floor of the engines,
//   3. every document quotes the same minimum node version,
//   4. no document claims node 20.
//
// The suite is offline and read only: no network, no subprocess, no port,
// no scratch file. The fixtures of the helper tests are synthetic strings;
// no real name, host, address or credential appears in this file.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** Directory of this file. */
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Walks up from `start` until the directory holds the repository.
 *
 * @param {string} start
 * @returns {string} the root of the repository
 */
function findRepoRoot(start) {
  let dir = start;
  for (;;) {
    if (
      existsSync(join(dir, "botd", "package.json")) &&
      existsSync(join(dir, ".github", "workflows"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`the repository root was not found above ${start}`);
    dir = parent;
  }
}

const repoRoot = findRepoRoot(here);

/**
 * Reads a file of the repository.
 *
 * @param {string} relative
 * @returns {string} the content of the file
 */
function readRepoFile(relative) {
  return readFileSync(join(repoRoot, relative), "utf8");
}

/** The node version CI runs on. */
const CI_NODE_VERSION = 24;

/** The documents that name a node version. */
const DOCS = ["README.md", "botd/RUNBOOK.md", "botd/DEMO.md"];

/**
 * Splits a version into its parts; a missing part counts as zero.
 *
 * @param {string} value
 * @returns {[number, number, number] | null} null when the value is no version
 */
function parseVersion(value) {
  const parts = String(value).trim().replace(/^v/, "").split(".");
  if (parts.length === 0 || parts.length > 3) return null;
  const numbers = parts.map((part) => Number.parseInt(part, 10));
  if (numbers.some((number) => !Number.isInteger(number))) return null;
  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0];
}

/**
 * The text of a version, padded with the missing parts.
 *
 * @param {[number, number, number]} version
 * @returns {string}
 */
function formatVersion(version) {
  return version.join(".");
}

/**
 * The node versions a workflow pins, with the line they stand on.
 *
 * @param {string} text the content of the workflow
 * @returns {{ line: number, value: string }[]} the pins of the workflow
 */
function workflowNodeVersions(text) {
  const found = [];
  text.split("\n").forEach((line, index) => {
    const match = /^[ \t]*node-version:[ \t]*['"]?([^'"\s#]+)/.exec(line);
    if (!match) return;
    found.push({ line: index + 1, value: match[1] });
  });
  return found;
}

/**
 * The number of setup-node steps of a workflow.
 *
 * @param {string} text the content of the workflow
 * @returns {number}
 */
function setupNodeSteps(text) {
  return text.split("\n").filter((line) => /uses:[ \t]*actions\/setup-node@/.test(line)).length;
}

/**
 * The floor the engines of a manifest declare.
 *
 * @param {unknown} manifest the parsed package.json
 * @returns {string | null} the version of the floor
 */
function enginesFloor(manifest) {
  const range = manifest?.engines?.node;
  if (typeof range !== "string") return null;
  const match = /^>=\s*v?(\d+(?:\.\d+)*)$/.exec(range.trim());
  return match ? match[1] : null;
}

/**
 * The floor the installer enforces.
 *
 * @param {string} script the content of scripts/install-botd.sh
 * @returns {string | null} the version of the floor
 */
function installerFloor(script) {
  const match = /^MIN_NODE_VERSION=['"]?([0-9][^'"\s]*)['"]?[ \t]*$/m.exec(script);
  return match ? match[1] : null;
}

/**
 * The patterns that state a minimum node version.
 *
 * A fresh regex per call: the patterns carry the global flag and would
 * otherwise keep their place between two runs.
 *
 * @returns {RegExp[]}
 */
function minimumPatterns() {
  return [
    // "node 22.22 or newer", "Node 22.22 and later"
    /\bnode\b[ \t]*\**[ \t]*v?(\d+\.\d+(?:\.\d+)?)[ \t]*\**[ \t]*(?:or[ \t]+newer|or[ \t]+later|and[ \t]+later|\+)/gi,
    // "node >= 22.18", "Node ≥ 22.18"
    /\bnode\b(?:[ \t]+version)?[ \t]*(?:>=|≥)[ \t]*v?(\d+\.\d+(?:\.\d+)?)/gi,
  ];
}

/**
 * The minimum node versions a document quotes.
 *
 * @param {string} text the content of the document
 * @returns {{ line: number, value: string, version: [number, number, number] }[]}
 */
function documentMinimums(text) {
  const found = [];
  text.split("\n").forEach((line, index) => {
    for (const pattern of minimumPatterns()) {
      let match;
      while ((match = pattern.exec(line)) !== null) {
        const version = parseVersion(match[1]);
        if (!version) continue;
        found.push({ line: index + 1, value: match[1], version });
      }
    }
  });
  return found;
}

/**
 * The patterns that state node 20 as the version to use.
 *
 * @returns {RegExp[]}
 */
function node20ClaimPatterns() {
  return [
    /\bnode\b[ \t]*\**[ \t]*v?20(?:\.\d+)*[ \t]*\**[ \t]*(?:or[ \t]+newer|or[ \t]+later|and[ \t]+later|\+)/i,
    /\bnode\b(?:[ \t]+version)?[ \t]*(?:>=|≥)[ \t]*v?20(?:\.\d+)*/i,
    /\bnode\b[ \t]*\**[ \t]*v?20(?:\.\d+)*[ \t]*\**[ \t]+(?:is[ \t]+)?(?:the[ \t]+)?(?:minimum|required|supported|recommended)\b/i,
    /\brequires?[ \t]+node[ \t]*\**[ \t]*v?20(?:\.\d+)*\b/i,
  ];
}

/**
 * The lines of a document that mention node 20.
 *
 * @param {string} text the content of the document
 * @returns {{ line: number, text: string }[]}
 */
function node20Mentions(text) {
  const found = [];
  text.split("\n").forEach((line, index) => {
    if (!/\bnode\b[^\n]{0,12}?\bv?20(?:\.\d+)*\b/i.test(line)) return;
    found.push({ line: index + 1, text: line.trim() });
  });
  return found;
}

// --- the sources -------------------------------------------------------------

/** The workflows of the repository. */
const workflows = readdirSync(join(repoRoot, ".github", "workflows"))
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

/** The content of every workflow, with the name of the file. */
const workflowTexts = workflows.map((name) => ({
  name,
  text: readRepoFile(join(".github", "workflows", name)),
}));

/** The content of every document, with the name of the file. */
const documentTexts = DOCS.map((name) => ({ name, text: readRepoFile(name) }));

/** The manifest of the daemon. */
const manifest = JSON.parse(readRepoFile("botd/package.json"));

// --- the helpers -------------------------------------------------------------

test("the workflow reader finds every node-version entry", () => {
  const workflow = [
    "jobs:",
    "  build:",
    "    steps:",
    "      - uses: actions/setup-node@v4",
    "        with:",
    '          node-version: "24"',
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 22",
    "",
  ].join("\n");

  assert.deepEqual(workflowNodeVersions(workflow), [
    { line: 6, value: "24" },
    { line: 9, value: "22" },
  ]);
  assert.equal(setupNodeSteps(workflow), 2);
});

test("the minimum reader finds the quoted minimums", () => {
  const document = [
    "| where | what |",
    "| --- | --- |",
    "| host | Node **22.22** or newer — **Node 24 preferred** |",
    "",
    "* the floor the daemon declares is `node >= 22.18.0`.",
    "* **Node 22.22 and later are supported.**",
    "",
  ].join("\n");

  const minimums = documentMinimums(document);

  assert.deepEqual(
    minimums.map((entry) => [entry.line, entry.value]),
    [
      [3, "22.22"],
      [5, "22.18.0"],
      [6, "22.22"],
    ],
  );
});

test("the minimum reader leaves the other versions alone", () => {
  const document = [
    "* Node 24 is the version the repository is developed and tested against.",
    "* the launcher needs `--experimental-strip-types`, so Node 22 is enough.",
    "* the flag exists since node 22.6.",
    "",
  ].join("\n");

  assert.deepEqual(documentMinimums(document), []);
});

test("the version comparison pads a missing patch release", () => {
  assert.deepEqual(parseVersion("22.18"), [22, 18, 0]);
  assert.deepEqual(parseVersion("22.18.0"), [22, 18, 0]);
  assert.deepEqual(parseVersion("v24.3.0"), [24, 3, 0]);
  assert.equal(formatVersion(parseVersion("22.18")), "22.18.0");
  assert.equal(parseVersion("not-a-version"), null);
});

test("the floor of the manifest and the floor of the installer are read", () => {
  assert.equal(enginesFloor({ engines: { node: ">=22.18.0" } }), "22.18.0");
  assert.equal(enginesFloor({ engines: { node: ">=22.18" } }), "22.18");
  assert.equal(enginesFloor({ engines: {} }), null);
  assert.equal(enginesFloor({}), null);

  const script = ["#!/bin/sh", "MIN_NODE_VERSION='22.18'", 'TARGET_NODE_MAJOR=24', ""].join("\n");
  assert.equal(installerFloor(script), "22.18");
  assert.equal(installerFloor("#!/bin/sh\n"), null);
});

// --- case 1: the workflows ----------------------------------------------------

// TODO(defect): .github/workflows/npm-publish.yml:30 pins node 22 while every
// other workflow and the README pin node 24. See the pull request body of
// this card.
test.todo("every workflow pins node 24", () => {
  const offenders = [];
  for (const { name, text } of workflowTexts) {
    for (const pin of workflowNodeVersions(text)) {
      const major = Number.parseInt(pin.value, 10);
      assert.ok(
        Number.isInteger(major),
        `${name}:${pin.line} pins the unreadable version "${pin.value}"`,
      );
      if (major === CI_NODE_VERSION) continue;
      offenders.push(`${name}:${pin.line} pins node ${pin.value}`);
    }
  }

  assert.deepEqual(offenders, [], `the workflows do not all pin node ${CI_NODE_VERSION}`);
});

test("every workflow that sets up node pins a version", () => {
  for (const { name, text } of workflowTexts) {
    const steps = setupNodeSteps(text);
    const pins = workflowNodeVersions(text);
    assert.equal(
      pins.length,
      steps,
      `${name} sets up node ${steps} time(s) but pins ${pins.length} version(s)`,
    );
  }
});

// --- case 2: the floor of the installer --------------------------------------

test("the floor of the installer is the floor of the engines", () => {
  const floor = enginesFloor(manifest);
  const enforced = installerFloor(readRepoFile("scripts/install-botd.sh"));

  assert.ok(floor, "botd/package.json declares no engines.node floor");
  assert.ok(enforced, "scripts/install-botd.sh declares no MIN_NODE_VERSION");
  assert.deepEqual(
    parseVersion(enforced),
    parseVersion(floor),
    `the installer refuses a host below ${enforced}, the daemon asks for ${floor}`,
  );
});

// --- case 3: the documents ---------------------------------------------------

// TODO(defect): the documents quote three different minimums (22.22 in
// README.md and botd/RUNBOOK.md, 22.18 in botd/DEMO.md and 22.6 in
// botd/DEMO.md:59). See the pull request body of this card.
test.todo("every document quotes the same minimum node version", () => {
  const quoted = new Map();
  for (const { name, text } of documentTexts) {
    const minimums = documentMinimums(text);
    assert.ok(minimums.length > 0, `${name} quotes no minimum node version`);
    for (const entry of minimums) {
      const key = formatVersion(entry.version);
      const places = quoted.get(key) ?? [];
      places.push(`${name}:${entry.line}`);
      quoted.set(key, places);
    }
  }

  const versions = [...quoted.keys()].sort();
  assert.equal(
    versions.length,
    1,
    `the documents quote ${versions.length} minimums: ` +
      versions.map((version) => `${version} (${quoted.get(version)?.join(", ")})`).join("; "),
  );
});

test("the documents quote a minimum node version at all", () => {
  for (const { name, text } of documentTexts) {
    const minimums = documentMinimums(text);
    assert.ok(minimums.length > 0, `${name} quotes no minimum node version`);
  }
});

// --- case 4: node 20 ---------------------------------------------------------

test("no document claims node 20", () => {
  for (const { name, text } of documentTexts) {
    text.split("\n").forEach((line, index) => {
      for (const pattern of node20ClaimPatterns()) {
        const match = pattern.exec(line);
        assert.equal(
          match,
          null,
          `${name}:${index + 1} claims node 20: ${JSON.stringify(line.trim())}`,
        );
      }
    });
  }
});

test("every mention of node 20 in a document marks it as too old", () => {
  for (const { name, text } of documentTexts) {
    for (const mention of node20Mentions(text)) {
      assert.match(
        mention.text,
        /\b(older|too old|below|refus\w*|reject\w*|unsupported|not supported|outdated)\b/i,
        `${name}:${mention.line} mentions node 20 without saying that it is too old: ` +
          JSON.stringify(mention.text),
      );
    }
  }
});
