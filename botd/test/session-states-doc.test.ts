// Acceptance test for botd/SESSION-STATES.md.
//
// The document describes the state machine of a bot session: it has to list
// exactly the states of the SessionState union, every state of the
// transition table has to be known to botd/PROTOCOL.md (or to be marked as
// internal), the diagram has to mention every state, every state has to say
// what the client may do with it and the document must not leak a host name
// or an address.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory of this file. */
const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from `start` until the directory holds botd/SESSION-STATES.md. */
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "botd", "SESSION-STATES.md"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`botd/SESSION-STATES.md not found above ${start}`);
    dir = parent;
  }
}

const repoRoot = findRepoRoot(here);
const doc = readFileSync(join(repoRoot, "botd", "SESSION-STATES.md"), "utf8");
const docLines = doc.replace(/\n$/, "").split("\n");
const protocolDoc = readFileSync(join(repoRoot, "botd", "PROTOCOL.md"), "utf8");
const protocolSrc = readFileSync(join(repoRoot, "botd", "src", "protocol.ts"), "utf8");
const sessionSrc = readFileSync(join(repoRoot, "botd", "src", "session.ts"), "utf8");

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
  return rows;
}

/** The rows of a table without its header. */
function dataRows(lines: string[]): string[][] {
  return tableRows(lines).slice(1);
}

/** The paragraphs of a block of lines. */
function paragraphs(lines: string[]): string[][] {
  const parts: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) {
      if (current.length > 0) parts.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/** The states of the SessionState union of botd/src/protocol.ts. */
function sourceStates(): string[] {
  const match = /export const SESSION_STATES = \[([^\]]*)\] as const;/.exec(protocolSrc);
  assert.ok(match, "botd/src/protocol.ts has no SESSION_STATES");
  assert.match(
    protocolSrc,
    /export type SessionState = \(typeof SESSION_STATES\)\[number\];/,
    "botd/src/protocol.ts has no SessionState union",
  );
  return [...(match[1] as string).matchAll(/"([a-z_]+)"/g)].map((entry) => entry[1] as string);
}

/** The states botd/src/session.ts sets. */
function sessionStates(): string[] {
  return [...sessionSrc.matchAll(/setState\("([a-z_]+)"\)/g)].map((entry) => entry[1] as string);
}

/** The states the document lists in its state table. */
function documentedStates(): string[] {
  return dataRows(section("## The states"))
    .map((row) => (row[0] ?? "").replace(/`/g, "").trim())
    .filter((state) => state.length > 0);
}

/** The states of the transition table of the document. */
function transitionStates(): string[] {
  const states = new Set<string>();
  for (const row of dataRows(section("## The transitions"))) {
    for (const cell of [row[0] ?? "", row[2] ?? ""]) {
      for (const part of cell.split(",")) {
        const state = part.replace(/`/g, "").trim();
        if (state.length === 0 || state === "—" || state === "-") continue;
        states.add(state);
      }
    }
  }
  return [...states];
}

/** The states the document marks as internal. */
function internalStates(): string[] {
  const states: string[] = [];
  for (const line of section("## Internal states")) {
    const match = /^\s*[-*]\s+`([a-z_]+)`/.exec(line);
    if (match) states.push(match[1] as string);
  }
  return states;
}

/** The fenced code blocks of the document with the given info string. */
function codeBlocks(info: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of docLines) {
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      if (current === null) {
        if (fence[1] === info) current = [];
      } else {
        if (fence[1] === "") blocks.push(current.join("\n"));
        current = null;
      }
      continue;
    }
    if (current !== null) current.push(line);
  }
  return blocks;
}

test("the document lists exactly the states of the SessionState union", () => {
  const states = sourceStates();
  assert.ok(states.length >= 3, `botd/src/protocol.ts holds only ${states.length} states`);
  assert.equal(
    new Set(states).size,
    states.length,
    `botd/src/protocol.ts repeats a state: ${states.join(", ")}`,
  );

  const documented = documentedStates();
  assert.ok(documented.length > 0, "the document lists no state");
  assert.deepEqual(
    [...documented].sort(),
    [...states].sort(),
    `the document lists ${documented.join(", ")} but the union holds ${states.join(", ")}`,
  );

  // The states the session sets have to be states of the union.
  for (const state of sessionStates()) {
    assert.ok(
      states.includes(state),
      `botd/src/session.ts sets the state "${state}", which is not in the union`,
    );
    assert.ok(
      documented.includes(state),
      `botd/src/session.ts sets the state "${state}", which the document does not list`,
    );
  }
});

test("every state of the transition table is documented in PROTOCOL.md or internal", () => {
  const states = transitionStates();
  assert.ok(states.length >= 3, `the transition table holds only ${states.length} states`);
  const internal = internalStates();
  for (const state of states) {
    const known = protocolDoc.includes(`\`${state}\``);
    assert.ok(
      known || internal.includes(state),
      `the state "${state}" of the transition table is neither in botd/PROTOCOL.md nor internal`,
    );
  }
});

test("the diagram mentions every state", () => {
  const mermaid = codeBlocks("mermaid");
  const ascii = codeBlocks("ascii");
  assert.ok(mermaid.length >= 1, "the document has no mermaid diagram");
  assert.ok(ascii.length >= 1, "the document has no ASCII diagram");
  for (const state of sourceStates()) {
    for (const block of [...mermaid, ...ascii]) {
      assert.ok(
        new RegExp(`\\b${state}\\b`).test(block),
        `the diagram does not mention the state "${state}"`,
      );
    }
  }
});

test("the transition table names the trigger and the frame of every transition", () => {
  const rows = dataRows(section("## The transitions"));
  assert.ok(rows.length >= 5, `the transition table holds only ${rows.length} rows`);
  const ops = ["state", "event", "error", "gap", "stall", "none"];
  for (const row of rows) {
    assert.equal(row.length, 4, `the row ${JSON.stringify(row)} does not have four cells`);
    assert.ok((row[1] ?? "").length > 0, `the row ${JSON.stringify(row)} has no trigger`);
    assert.ok(
      new RegExp(`^(?:${ops.join("|")})\\b`).test((row[3] ?? "").replace(/`/g, "").trim()),
      `the row ${JSON.stringify(row)} does not name a frame`,
    );
    for (const cell of [row[0] ?? "", row[2] ?? ""]) {
      for (const part of cell.split(",")) {
        const state = part.replace(/`/g, "").trim();
        if (state.length === 0 || state === "—" || state === "-") continue;
        assert.ok(
          sourceStates().includes(state),
          `the transition table names the unknown state "${state}"`,
        );
      }
    }
  }
});

test("the document states the rules of the cancelling flag, the lease and the exit", () => {
  const rules = section("## The rules");
  const text = rules.join("\n");
  const headings = [
    "### The cancelling flag",
    "### Paused by the lease",
    "### The exited session",
  ];
  for (const heading of headings) {
    assert.ok(
      docLines.some((line) => line.startsWith(heading)),
      `the rules have no section "${heading}"`,
    );
  }
  for (const code of ["session_cancelling", "lease_paused", "session_exited"]) {
    assert.ok(text.includes(code), `the rules do not mention the error code "${code}"`);
  }
  // The cancelling flag is not a state of the union.
  assert.ok(
    /cancelling`?\s+is\s+\*\*not\*\*\s+a\s+state/i.test(text),
    "the rules do not say that the cancelling flag is not a state",
  );
});

test("the document tells the client what it may do in every state", () => {
  const rows = dataRows(section("## What a state means for the client"));
  const states = sourceStates();
  assert.ok(rows.length >= states.length, "the client table is too short");
  for (const state of states) {
    const row = rows.find((candidate) => (candidate[0] ?? "").replace(/`/g, "") === state);
    assert.ok(row, `the client table has no row for the state "${state}"`);
    for (const cell of [row[1] ?? "", row[2] ?? ""]) {
      assert.match(
        cell.replace(/`/g, "").trim(),
        /^(yes|no)\b/i,
        `the row of the state "${state}" does not answer with yes or no: ${JSON.stringify(row)}`,
      );
    }
  }
});

test("the points that the code does not decide are marked unverified", () => {
  const parts = paragraphs(section("## What is not verified"));
  assert.ok(parts.length >= 2, "the section lists no unverified point");
  const blocks: string[][] = [];
  for (const part of parts.slice(1)) {
    let current: string[] | null = null;
    for (const line of part) {
      if (/^\s*[-*]\s/.test(line)) {
        current = [line];
        blocks.push(current);
        continue;
      }
      assert.ok(
        current !== null,
        `the line "${line}" of the section is not part of a bullet point`,
      );
      assert.ok(
        /^\s+\S/.test(line),
        `the line "${line}" of the section is not part of a bullet point`,
      );
      current!.push(line);
    }
  }
  assert.ok(blocks.length >= 1, "the section lists no unverified point");
  for (const block of blocks) {
    const text = block.join(" ");
    assert.ok(text.includes("unverified"), `the point "${text}" is not marked as unverified`);
    assert.equal(
      text.match(/unverified/g)?.length ?? 0,
      1,
      `the point "${text}" carries more than one unverified marker`,
    );
  }
});

test("the document leaks no host name and no address", () => {
  const patterns: [string, RegExp][] = [
    ["an IPv4 address", /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
    ["an IPv6 address", /\b(?:::1|fe80:[0-9a-f]*)\b/i],
    ["a credential", /[\w.+-]+@[\w-]+\.[a-z]{2,}/i],
  ];
  const hostName = /\b(?:localhost|[a-z0-9-]+\.(?:com|net|org|io|dev|app|cloud|invalid))\b/i;
  for (const [what, pattern] of patterns) {
    const match = pattern.exec(doc);
    assert.equal(match, null, `the document mentions ${what}: "${match?.[0]}"`);
  }
  const host = hostName.exec(doc);
  assert.equal(host, null, `the document mentions a host name: "${host?.[0]}"`);
  for (const match of doc.matchAll(/https?:\/\/[^\s)]+/g)) {
    assert.fail(`the document links to ${match[0]}`);
  }
});
