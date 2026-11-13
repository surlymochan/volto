// Acceptance test for botd/ADAPTERS.md.
//
// The adapter document has to stay in sync with the code: every kind of the
// capability table (botd/src/adapters/index.ts) needs a row in the table of
// the document and a section of its own, the protocol of the row has to be
// the protocol of the capability, and the document must not talk about a
// kind the registry does not know.
//
// The document describes the machine protocols of the bot CLIs, so it must
// stay free of the details of a host: no hostname, no IP address and no
// credential.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ADAPTER_CAPABILITIES, listAdapters } from "../src/adapters/index.ts";

/** Directory of this file. */
const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from `start` until the directory holds botd/ADAPTERS.md. */
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "botd", "ADAPTERS.md"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`botd/ADAPTERS.md not found above ${start}`);
    dir = parent;
  }
}

const repoRoot = findRepoRoot(here);
const doc = readFileSync(join(repoRoot, "botd", "ADAPTERS.md"), "utf8");
const docLines = doc.replace(/\n$/, "").split("\n");

const srcDir = join(repoRoot, "botd", "src");
const adaptersDir = join(srcDir, "adapters");

/** The columns the capability table of the document has to carry. */
const EXPECTED_COLUMNS = [
  "kind",
  "protocol",
  "binary/command",
  "resume support",
  "cancel method",
  "permission support",
  "known limits",
];

/** The cells of a markdown table row. */
function cells(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/** The rows of the capability table of the document. */
function capabilityRows(): { header: string[]; rows: string[][] } {
  for (let index = 0; index < docLines.length; index += 1) {
    const line = docLines[index] as string;
    if (!line.startsWith("|")) continue;
    const header = cells(line);
    if (header[0]?.toLowerCase() !== "kind") continue;
    if (!header[1]?.toLowerCase().startsWith("protocol")) continue;

    const rows: string[][] = [];
    for (let next = index + 1; next < docLines.length; next += 1) {
      const row = docLines[next] as string;
      if (!row.startsWith("|")) break;
      const values = cells(row);
      if (values.every((value) => /^-+$/.test(value))) continue; // the separator
      rows.push(values);
    }
    return { header, rows };
  }
  throw new Error("botd/ADAPTERS.md has no capability table");
}

/** The body of the section with the given heading. */
function sectionBody(heading: string): string[] {
  const lines: string[] = [];
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  let inside = false;
  for (const line of docLines) {
    const match = /^(#+)\s/.exec(line);
    if (match) {
      if (inside) {
        // A heading of the same or of a higher level ends the section.
        if (match[1].length <= level) break;
        continue;
      }
      if (line.trim() === heading) inside = true;
      continue;
    }
    if (inside) lines.push(line);
  }
  return lines;
}

/** The heading of the section of one kind, if the document has one. */
function kindHeading(kind: string): string | undefined {
  const pattern = new RegExp(`^##\\s+(?:\\d+\\.\\s*)?\`?${kind}\`?\\s*$`);
  return docLines.find((line) => pattern.test(line));
}

/** The kinds the code knows: the BotKind union plus the adapter modules. */
function knownKinds(): string[] {
  const types = readFileSync(join(srcDir, "adapter-types.ts"), "utf8");
  const union = /export type BotKind =([^;]+);/.exec(types)?.[1] ?? "";
  const fromUnion = [...union.matchAll(/"([a-z][a-z0-9-]*)"/g)].map((match) => match[1] as string);

  const fromModules = readdirSync(adaptersDir)
    .filter((name) => name.endsWith(".ts") && name !== "index.ts")
    .map((name) => name.replace(/\.ts$/, ""));

  return [...new Set([...fromUnion, ...fromModules])].sort();
}

/** The kinds the registry knows. */
function registeredKinds(): string[] {
  return listAdapters()
    .map((row) => row.kind)
    .sort();
}

const table = capabilityRows();

// --- the capability table ----------------------------------------------------

test("every registered kind has a row in the capability table", () => {
  assert.deepEqual(
    table.header.map((cell) => cell.toLowerCase()),
    EXPECTED_COLUMNS,
    "the capability table does not carry the documented columns",
  );

  const kinds = table.rows.map((row) => (row[0] ?? "").replace(/`/g, "").trim());
  for (const kind of registeredKinds()) {
    assert.equal(
      kinds.filter((entry) => entry === kind).length,
      1,
      `the capability table has no row (or more than one) for "${kind}"`,
    );
  }
});

test("the protocol column of every row is the protocol of the capability", () => {
  for (const row of ADAPTER_CAPABILITIES) {
    const line = table.rows.find(
      (entry) => (entry[0] ?? "").replace(/`/g, "").trim() === row.kind,
    );
    assert.ok(line, `the capability table has no row for "${row.kind}"`);

    const protocol = (line[1] ?? "").replace(/`/g, "").trim();
    assert.equal(
      protocol,
      row.protocol,
      `the row of "${row.kind}" documents the protocol "${protocol}", ` +
        `the capability says "${row.protocol}"`,
    );
  }
});

// --- the sections ------------------------------------------------------------

test("every registered kind has a section of its own", () => {
  for (const kind of registeredKinds()) {
    const heading = kindHeading(kind);
    assert.ok(heading, `botd/ADAPTERS.md has no section for "${kind}"`);

    const body = sectionBody(heading).join("\n").trim();
    assert.ok(body.length > 0, `the section of "${kind}" is empty`);

    // The section has to answer the four questions of the document.
    for (const topic of ["turn", "event", "cancel", "resume"]) {
      assert.match(
        body,
        new RegExp(topic, "i"),
        `the section of "${kind}" does not mention the "${topic}"`,
      );
    }
  }
});

test("the document mentions no kind that is not registered", () => {
  const registered = new Set(registeredKinds());

  // Every kind the code knows has to be registered when the document talks
  // about it.
  for (const kind of knownKinds()) {
    if (!new RegExp(`\\b${kind}\\b`, "i").test(doc)) continue;
    assert.ok(
      registered.has(kind),
      `botd/ADAPTERS.md talks about the kind "${kind}", which is not registered`,
    );
  }

  // A name the document calls a kind has to be registered as well.
  for (const match of doc.matchAll(/`([a-z][a-z0-9-]*)`\s+(?:kind|adapter|CLI)\b/gi)) {
    const kind = (match[1] as string).toLowerCase();
    assert.ok(
      registered.has(kind),
      `botd/ADAPTERS.md calls "${kind}" a kind, which is not registered`,
    );
  }

  // The kinds of the table rows and of the section headings have to be
  // registered as well.
  for (const row of table.rows) {
    const kind = (row[0] ?? "").replace(/`/g, "").trim();
    assert.ok(
      registered.has(kind),
      `the capability table has a row for the unregistered kind "${kind}"`,
    );
  }
  for (const line of docLines) {
    const match = /^##\s+(?:\d+\.\s*)?`?([a-z][a-z0-9-]*)`?\s*$/.exec(line);
    if (!match) continue;
    const kind = match[1] as string;
    assert.ok(
      registered.has(kind),
      `botd/ADAPTERS.md has a section for the unregistered kind "${kind}"`,
    );
  }
});

// --- no host details ---------------------------------------------------------

test("the document holds no hostname, no IP address and no token", () => {
  const forbidden: { name: string; pattern: RegExp }[] = [
    { name: "an IP address", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
    {
      name: "a hostname",
      pattern:
        /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|ai|app|cloud|sh|co|xyz|test|local|localhost)\b/i,
    },
    { name: "the loopback name", pattern: /\blocalhost\b/i },
    { name: "a home directory", pattern: /\/(?:home|Users|root)\// },
    { name: "a GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
    {
      name: "a GitHub fine grained token",
      pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    },
    { name: "an API key", pattern: /\bsk-[A-Za-z0-9]{16,}\b/ },
    { name: "a bearer header", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/ },
    { name: "a JSON web token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
    {
      name: "an assigned secret",
      pattern:
        /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|token)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i,
    },
    { name: "a long hex secret", pattern: /\b[0-9a-f]{32,}\b/i },
  ];

  for (const { name, pattern } of forbidden) {
    const hit = doc.match(pattern);
    assert.equal(
      hit,
      null,
      `botd/ADAPTERS.md contains ${name}: ${hit ? JSON.stringify(hit[0]) : ""}`,
    );
  }
});
