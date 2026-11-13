// Acceptance test for botd/PROTOCOL.md.
//
// The protocol document has to stay in sync with the implementation: every
// frame op it documents has to exist in botd/src (the grep check), every op
// and every error code of the implementation has to be documented, and the
// example sessions have to consist of frames the daemon would accept.
//
// The sessions in the document use synthetic ids only.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseClientFrame } from "../src/protocol.ts";
import { SESSION_STATES } from "../src/protocol.ts";

const MAX_DOC_LINES = 200;

/** Directory of this file. */
const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from `start` until the directory holds botd/PROTOCOL.md. */
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "botd", "PROTOCOL.md"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`botd/PROTOCOL.md not found above ${start}`);
    dir = parent;
  }
}

const repoRoot = findRepoRoot(here);
const srcDir = join(repoRoot, "botd", "src");
const doc = readFileSync(join(repoRoot, "botd", "PROTOCOL.md"), "utf8");
const docLines = doc.replace(/\n$/, "").split("\n");

/** Every .ts file below `dir`, sorted by path. */
function listSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listSources(full));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found.sort();
}

const srcFiles = listSources(srcDir);
const srcText = srcFiles.map((file) => readFileSync(file, "utf8")).join("\n");

/** The lines of the section that starts with `heading`. */
function section(heading: string): string[] {
  const lines: string[] = [];
  let inside = false;
  for (const line of docLines) {
    if (line.startsWith("## ")) {
      if (inside) break;
      inside = line.startsWith(heading);
      continue;
    }
    if (inside) lines.push(line);
  }
  return lines;
}

/** The cells of every table row of a section. */
function tableRows(heading: string): string[][] {
  const rows: string[][] = [];
  for (const line of section(heading)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.every((cell) => /^-+$/.test(cell))) continue;
    rows.push(cells);
  }
  return rows;
}

/** One row of the frame catalog. */
type CatalogEntry = { op: string; direction: string };

/** The ops of the frame catalog, with their direction. */
function frameCatalog(): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const cells of tableRows("## 3.")) {
    const op = /`([a-z]+)`/.exec(cells[0] ?? "");
    if (!op) continue;
    entries.push({ op: op[1], direction: cells[1] ?? "" });
  }
  return entries;
}

/** The error codes of the error code table. */
function errorCodes(): string[] {
  const codes: string[] = [];
  for (const cells of tableRows("## 8.")) {
    const code = /`([a-z_]+)`/.exec(cells[0] ?? "");
    if (code) codes.push(code[1]);
  }
  return codes;
}

/** One frame of an example session, in document order. */
type ExampleFrame = {
  direction: string;
  op: string;
  sid: string | undefined;
  seq: number | undefined;
  fromSeq: number | undefined;
  toSeq: number | undefined;
  code: string | undefined;
  frame: Record<string, unknown>;
};

/** The frames of the example sessions. */
function exampleFrames(): ExampleFrame[] {
  const frames: ExampleFrame[] = [];
  for (const line of docLines) {
    const match = /^(→|←)\s+(\{.*\})$/.exec(line);
    if (!match) continue;
    const frame = JSON.parse(match[2]) as Record<string, unknown>;
    frames.push({
      direction: match[1] ?? "",
      op: String(frame.op ?? ""),
      sid: typeof frame.sid === "string" ? frame.sid : undefined,
      seq: typeof frame.seq === "number" ? frame.seq : undefined,
      fromSeq: typeof frame.fromSeq === "number" ? frame.fromSeq : undefined,
      toSeq: typeof frame.toSeq === "number" ? frame.toSeq : undefined,
      code: typeof frame.code === "string" ? frame.code : undefined,
      frame,
    });
  }
  return frames;
}

/** The ops of a frame union of botd/src/protocol.ts. */
function sourceOps(typeName: string, nextType: string): string[] {
  const source = readFileSync(join(srcDir, "protocol.ts"), "utf8");
  const start = source.indexOf(`export type ${typeName}`);
  const end = source.indexOf(`export type ${nextType}`);
  assert.ok(start >= 0 && end > start, `botd/src/protocol.ts has no ${typeName}`);
  return [...source.slice(start, end).matchAll(/op:\s*"([a-z]+)"/g)].map((match) => match[1] ?? "");
}

/** The error codes the implementation can emit. */
function sourceErrorCodes(): string[] {
  return [...new Set([...srcText.matchAll(/code:\s*"([a-z_]+)"/g)].map((match) => match[1] ?? ""))];
}

test("the protocol document stays inside its line budget", () => {
  assert.ok(docLines.length > 50, "botd/PROTOCOL.md looks empty");
  assert.ok(
    docLines.length <= MAX_DOC_LINES,
    `botd/PROTOCOL.md has ${docLines.length} lines, the budget is ${MAX_DOC_LINES}`,
  );
});

test("every frame op of the document appears in botd/src", () => {
  const catalog = frameCatalog();
  assert.ok(catalog.length >= 10, `the catalog holds only ${catalog.length} ops`);
  for (const entry of catalog) {
    const found = srcFiles.some((file) =>
      new RegExp(`\\b${entry.op}\\b`).test(readFileSync(file, "utf8")),
    );
    assert.ok(found, `op "${entry.op}" is documented but does not appear in botd/src`);
  }
});

test("the frame catalog documents every op of the implementation", () => {
  const catalog = frameCatalog();
  for (const op of sourceOps("ClientFrame", "ServerFrame")) {
    const entry = catalog.find((item) => item.op === op && item.direction.startsWith("client"));
    assert.ok(entry, `the client op "${op}" is not documented`);
  }
  for (const op of sourceOps("ServerFrame", "ParseResult")) {
    const entry = catalog.find((item) => item.op === op && item.direction.startsWith("botd"));
    assert.ok(entry, `the server op "${op}" is not documented`);
  }
});

test("the error code table matches the codes of the implementation", () => {
  const documented = new Set(errorCodes());
  assert.ok(documented.size >= 5, `the error code table holds only ${documented.size} codes`);
  for (const code of sourceErrorCodes()) {
    assert.ok(documented.has(code), `the error code "${code}" is not documented`);
  }
  for (const code of documented) {
    assert.ok(
      sourceErrorCodes().includes(code),
      `the error code "${code}" is documented but the daemon never emits it`,
    );
  }
});

test("every error code used in the document is listed in the error code table", () => {
  const listed = new Set(errorCodes());
  const used = new Set([...doc.matchAll(/code:"([a-z_]+)"/g)].map((match) => match[1] ?? ""));
  for (const code of used) {
    assert.ok(listed.has(code), `the error code "${code}" is not listed in the error code table`);
  }
});

test("the document has three example sessions", () => {
  const sessions = docLines.filter((line) => /^### Example \d+/.test(line));
  assert.equal(sessions.length, 3, `the document has ${sessions.length} example sessions`);
});

test("the example sessions only use documented ops and show every op", () => {
  const catalog = frameCatalog();
  const clientOps = new Set(
    catalog.filter((entry) => entry.direction.startsWith("client")).map((entry) => entry.op),
  );
  const serverOps = new Set(
    catalog.filter((entry) => entry.direction.startsWith("botd")).map((entry) => entry.op),
  );
  const used = new Set<string>();
  for (const frame of exampleFrames()) {
    const ops = frame.direction === "→" ? clientOps : serverOps;
    assert.ok(ops.has(frame.op), `an example uses the undocumented op "${frame.op}"`);
    used.add(frame.op);
  }
  for (const entry of catalog) {
    assert.ok(used.has(entry.op), `op "${entry.op}" is documented but never shown in an example`);
  }
});

test("the client frames of the examples are accepted by the daemon", () => {
  for (const frame of exampleFrames()) {
    if (frame.direction !== "→") continue;
    const result = parseClientFrame(frame.frame);
    if (!result.ok) {
      assert.fail(`the example frame ${JSON.stringify(frame.frame)} is rejected: ${result.message}`);
    }
  }
});

test("the server frames of the examples carry the documented fields", () => {
  const fields: Record<string, string[]> = {
    hello: ["botdVersion", "leaseId", "fence", "leaseTtlMs"],
    event: ["sid", "seq", "payload"],
    state: ["sid", "state", "progressAt"],
    error: ["code", "message"],
    gap: ["sid", "fromSeq", "toSeq"],
    stall: ["sid", "idleMs"],
  };
  for (const frame of exampleFrames()) {
    if (frame.direction !== "←") continue;
    const expected = fields[frame.op];
    assert.ok(expected, `the server op "${frame.op}" has no documented fields`);
    for (const field of expected) {
      assert.ok(field in frame.frame, `the ${frame.op} frame misses the field "${field}"`);
    }
    if (frame.op === "event") {
      assert.ok(
        typeof frame.seq === "number" && frame.seq >= 1,
        `bad seq: ${JSON.stringify(frame.frame)}`,
      );
    }
    if (frame.op === "state") {
      assert.ok(
        (SESSION_STATES as readonly string[]).includes(String(frame.frame.state)),
        `bad state: ${JSON.stringify(frame.frame)}`,
      );
    }
    if (frame.op === "gap") {
      assert.ok(
        typeof frame.fromSeq === "number" &&
          typeof frame.toSeq === "number" &&
          frame.fromSeq <= frame.toSeq,
        `bad gap: ${JSON.stringify(frame.frame)}`,
      );
    }
    if (frame.op === "stall") {
      assert.ok(
        typeof frame.frame.idleMs === "number",
        `bad idleMs: ${JSON.stringify(frame.frame)}`,
      );
    }
  }
});

test("the example frames honour the ordering and acknowledgement rules", () => {
  const frames = exampleFrames();
  const lastEvent = new Map<string, number>();
  const lastAck = new Map<string, number>();
  let replayAsked = false;

  for (const frame of frames) {
    if (frame.direction === "→" && frame.op === "resume") {
      replayAsked = true;
      continue;
    }
    if (frame.direction === "→" && frame.op === "ack" && frame.sid && frame.seq !== undefined) {
      const highest = lastEvent.get(frame.sid) ?? 0;
      assert.ok(
        frame.seq <= highest,
        `the ack ${frame.seq} runs ahead of the events of ${frame.sid} (last event ${highest})`,
      );
      const previous = lastAck.get(frame.sid) ?? 0;
      assert.ok(frame.seq >= previous, `the ack ${frame.seq} of ${frame.sid} goes backwards`);
      lastAck.set(frame.sid, frame.seq);
      continue;
    }
    if (frame.direction === "←" && frame.op === "event" && frame.sid && frame.seq !== undefined) {
      const previous = lastEvent.get(frame.sid);
      if (previous !== undefined && frame.seq <= previous) {
        assert.ok(replayAsked, `the event ${frame.seq} of ${frame.sid} is replayed unasked`);
      }
      lastEvent.set(frame.sid, Math.max(previous ?? 0, frame.seq));
    }
  }
});

test("the document specifies ordering, leases, cancellation, errors and versioning", () => {
  const topics = [
    "seq",
    "ack",
    "gap",
    "resume",
    "ttl",
    "renew",
    "fence",
    "cancel",
    "escalat",
    "error code",
    "version",
    "stall",
  ];
  const lower = doc.toLowerCase();
  for (const topic of topics) {
    assert.ok(lower.includes(topic), `the document does not mention "${topic}"`);
  }
});
