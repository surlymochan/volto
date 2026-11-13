// Acceptance test for botd/PROTOCOL.md.
//
// The protocol document has to stay in sync with the implementation: every
// op and every error code it documents must exist in botd/src, every op of
// the source has to be documented, the example frames have to be valid
// frames of the protocol, both directions have to be covered and the
// document has to stay inside its line budget.
//
// The sessions in the document use synthetic ids only.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BOTD_VERSION, BOT_KINDS, SESSION_STATES, parseClientFrame } from "../src/protocol.ts";
import { MAX_FRAME_BYTES } from "../src/frames.ts";

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
const doc = readFileSync(join(repoRoot, "botd", "PROTOCOL.md"), "utf8");
const docLines = doc.replace(/\n$/, "").split("\n");

const srcDir = join(repoRoot, "botd", "src");

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
const protocolSrc = readFileSync(join(srcDir, "protocol.ts"), "utf8");

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

/** The rows of the op catalog: the op, the direction, the fields. */
function catalogRows(): { op: string; direction: string; fields: string[] }[] {
  return tableRows(section("## 2."))
    .filter((row) => /^`[a-z_]+`$/.test(row[0] ?? ""))
    .map((row) => ({
      op: (row[0] as string).replace(/`/g, ""),
      direction: row[1] ?? "",
      fields: (row[2] ?? "")
        .split(",")
        .map((field) => field.trim().replace(/`/g, ""))
        .filter((field) => field.length > 0),
    }));
}

/** The ops the catalog documents for one direction. */
function documentedOps(direction: string): string[] {
  return catalogRows()
    .filter((row) => row.direction.startsWith(direction))
    .map((row) => row.op);
}

/** The error codes of the error code table (§7). */
function documentedErrorCodes(): string[] {
  return tableRows(section("## 7."))
    .filter((row) => /^`[a-z_]+`$/.test(row[0] ?? ""))
    .map((row) => (row[0] as string).replace(/`/g, ""));
}

/** The block of a frame union of botd/src/protocol.ts. */
function sourceBlock(typeName: string, nextType: string): string {
  const start = protocolSrc.indexOf(`export type ${typeName}`);
  const end = protocolSrc.indexOf(`export type ${nextType}`, start);
  assert.ok(start >= 0 && end > start, `botd/src/protocol.ts has no ${typeName}`);
  return protocolSrc.slice(start, end);
}

/** The ops of a frame union of botd/src/protocol.ts. */
function sourceOps(typeName: string, nextType: string): string[] {
  return [...sourceBlock(typeName, nextType).matchAll(/\{\s*op:\s*"([a-z_]+)"/g)].map(
    (match) => match[1] as string,
  );
}

/** One field of a frame of botd/src/protocol.ts. */
type FrameField = { name: string; optional: boolean; type: string };

/** The fields of every op of a frame union of botd/src/protocol.ts. */
function sourceShape(typeName: string, nextType: string): Map<string, FrameField[]> {
  const shape = new Map<string, FrameField[]>();
  for (const member of sourceBlock(typeName, nextType).matchAll(/\{\s*op:\s*"([a-z_]+)"([^}]*)\}/g)) {
    const fields: FrameField[] = [];
    for (const field of member[2].matchAll(/([A-Za-z][A-Za-z0-9]*)([?]?)\s*:\s*([A-Za-z][A-Za-z0-9]*)/g)) {
      fields.push({
        name: field[1] as string,
        optional: field[2] === "?",
        type: field[3] as string,
      });
    }
    shape.set(member[1] as string, fields);
  }
  return shape;
}

const clientSourceOps = sourceOps("ClientFrame", "ServerFrame");
const serverSourceOps = sourceOps("ServerFrame", "ParseResult");
const clientShape = sourceShape("ClientFrame", "ServerFrame");
const serverShape = sourceShape("ServerFrame", "ParseResult");

/** The error codes the daemon emits. */
function emittedErrorCodes(): string[] {
  const codes = new Set<string>();
  for (const file of ["daemon.ts", "lease.ts"]) {
    const text = readFileSync(join(srcDir, file), "utf8");
    for (const match of text.matchAll(/code:\s*"([a-z_]+)"/g)) codes.add(match[1] as string);
  }
  return [...codes].sort();
}

/** One frame of an example session, in document order. */
interface ExampleFrame {
  direction: "client" | "daemon";
  op: string;
  raw: Record<string, unknown>;
}

/** The frames of the example sessions (§9). */
function exampleFrames(): ExampleFrame[] {
  const frames: ExampleFrame[] = [];
  for (const line of docLines) {
    const match = /^(→|←)\s+(\{.*\})$/.exec(line);
    if (!match) continue;
    const raw = JSON.parse(match[2] as string) as Record<string, unknown>;
    frames.push({
      direction: match[1] === "→" ? "client" : "daemon",
      op: String(raw.op ?? ""),
      raw,
    });
  }
  return frames;
}

/** Check a frame of the daemon against the ServerFrame of the source. */
function checkServerFrame(frame: ExampleFrame): void {
  const shape = serverShape.get(frame.op);
  assert.ok(shape, `the op "${frame.op}" is not a daemon frame of botd/src/protocol.ts`);
  const fields = shape;
  const allowed = new Set(["op", ...fields.map((field) => field.name)]);
  for (const key of Object.keys(frame.raw)) {
    assert.ok(
      allowed.has(key),
      `the frame ${JSON.stringify(frame.raw)} carries the unknown field "${key}"`,
    );
  }
  for (const field of fields) {
    const value = frame.raw[field.name];
    if (value === undefined) {
      assert.ok(
        field.optional,
        `the frame ${JSON.stringify(frame.raw)} misses the field "${field.name}"`,
      );
      continue;
    }
    if (field.type === "number") {
      assert.equal(typeof value, "number", `the field "${field.name}" is not a number`);
      assert.ok(Number.isFinite(value as number), `the field "${field.name}" is not finite`);
    } else if (field.type === "string") {
      assert.equal(typeof value, "string", `the field "${field.name}" is not a string`);
      assert.ok((value as string).length > 0, `the field "${field.name}" is empty`);
    } else if (field.type === "SessionState") {
      assert.ok(
        SESSION_STATES.includes(value as (typeof SESSION_STATES)[number]),
        `the field "${field.name}" is not a session state of botd/src/protocol.ts`,
      );
    }
  }
}

/** Check a frame of the control plane against the ClientFrame of the source. */
function checkClientFrame(frame: ExampleFrame): void {
  const parsed = parseClientFrame(frame.raw);
  assert.ok(
    parsed.ok,
    `the frame ${JSON.stringify(frame.raw)} is not a valid client frame: ${
      parsed.ok ? "" : parsed.message
    }`,
  );
  const shape = clientShape.get(frame.op);
  assert.ok(shape, `the op "${frame.op}" is not a client frame of botd/src/protocol.ts`);
  const allowed = new Set(["op", ...shape.map((field) => field.name)]);
  for (const key of Object.keys(frame.raw)) {
    assert.ok(
      allowed.has(key),
      `the frame ${JSON.stringify(frame.raw)} carries the unknown field "${key}"`,
    );
  }
}

test("the protocol document stays inside its line budget", () => {
  assert.ok(docLines.length > 50, "botd/PROTOCOL.md looks empty");
  assert.ok(
    docLines.length <= MAX_DOC_LINES,
    `botd/PROTOCOL.md has ${docLines.length} lines, the budget is ${MAX_DOC_LINES}`,
  );
});

test("the op catalog lists the ops of both directions", () => {
  const clientOps = documentedOps("client");
  const daemonOps = documentedOps("daemon");
  assert.ok(clientOps.length >= 5, `the catalog holds only ${clientOps.length} client ops`);
  assert.ok(daemonOps.length >= 5, `the catalog holds only ${daemonOps.length} daemon ops`);
  assert.equal(
    new Set(clientOps).size,
    clientOps.length,
    `duplicate op in the client catalog: ${clientOps.join(", ")}`,
  );
  assert.equal(
    new Set(daemonOps).size,
    daemonOps.length,
    `duplicate op in the daemon catalog: ${daemonOps.join(", ")}`,
  );
});

test("every documented op exists in botd/src", () => {
  for (const op of documentedOps("client")) {
    assert.ok(
      clientSourceOps.includes(op),
      `the op "${op}" is documented but is not a ClientFrame of botd/src`,
    );
  }
  for (const op of documentedOps("daemon")) {
    assert.ok(
      serverSourceOps.includes(op),
      `the op "${op}" is documented but is not a ServerFrame of botd/src`,
    );
  }
  for (const op of [...documentedOps("client"), ...documentedOps("daemon")]) {
    const found = srcFiles.some((file) => new RegExp(`\\b${op}\\b`).test(readFileSync(file, "utf8")));
    assert.ok(found, `the op "${op}" is documented but does not appear in botd/src`);
  }
});

test("every op of botd/src is documented", () => {
  for (const op of clientSourceOps) {
    assert.ok(
      documentedOps("client").includes(op),
      `the client op "${op}" of botd/src is not documented`,
    );
  }
  for (const op of serverSourceOps) {
    assert.ok(
      documentedOps("daemon").includes(op),
      `the daemon op "${op}" of botd/src is not documented`,
    );
  }
});

test("the catalog lists the fields of every op", () => {
  for (const row of catalogRows()) {
    const shape = row.direction.startsWith("client") ? clientShape : serverShape;
    const fields = shape.get(row.op);
    assert.ok(fields, `the op "${row.op}" is not a frame of botd/src/protocol.ts`);
    const documented = row.fields.map((field) => field.replace("?", ""));
    for (const field of fields) {
      assert.ok(
        documented.includes(field.name),
        `the op "${row.op}" does not document the field "${field.name}" of botd/src`,
      );
    }
    for (const field of documented) {
      assert.ok(
        fields.some((known) => known.name === field),
        `the op "${row.op}" documents the field "${field}", which botd/src does not know`,
      );
    }
  }
});

test("every documented error code exists in botd/src", () => {
  const codes = documentedErrorCodes();
  assert.ok(codes.length >= 5, `the error code table holds only ${codes.length} codes`);
  for (const code of codes) {
    assert.ok(
      srcText.includes(`"${code}"`),
      `the error code "${code}" is documented but does not appear in botd/src`,
    );
  }
});

test("every error code the daemon emits is documented", () => {
  const codes = documentedErrorCodes();
  for (const code of emittedErrorCodes()) {
    assert.ok(
      codes.includes(code),
      `the daemon emits the error code "${code}" but the document does not list it`,
    );
  }
});

test("the example frames are valid frames of the protocol", () => {
  const frames = exampleFrames();
  assert.ok(frames.length >= 10, `only ${frames.length} frames in the examples`);
  for (const frame of frames) {
    if (frame.direction === "client") checkClientFrame(frame);
    else checkServerFrame(frame);
  }
});

test("the examples cover both directions and every op", () => {
  const frames = exampleFrames();
  assert.ok(
    frames.some((frame) => frame.direction === "client"),
    "the examples hold no frame of the control plane",
  );
  assert.ok(
    frames.some((frame) => frame.direction === "daemon"),
    "the examples hold no frame of the daemon",
  );
  const used = new Set(frames.map((frame) => frame.op));
  for (const op of [...documentedOps("client"), ...documentedOps("daemon")]) {
    assert.ok(used.has(op), `the op "${op}" is documented but never shown in an example`);
  }
});

test("the document has example sessions", () => {
  const sessions = docLines.filter((line) => /^### Example \d+/.test(line));
  assert.ok(sessions.length >= 3, `the document has ${sessions.length} example sessions`);
});

test("the ops of the old protocol are gone", () => {
  const ops = [...documentedOps("client"), ...documentedOps("daemon")];
  const used = new Set(exampleFrames().map((frame) => frame.op));
  for (const op of ["handshake", "ready", "prompt"]) {
    assert.ok(!ops.includes(op), `the op "${op}" is not part of the protocol any more`);
    assert.ok(!used.has(op), `an example still uses the op "${op}"`);
  }
});

test("the document specifies the topics of the protocol", () => {
  const topics = [
    "lease",
    "fence",
    "renew",
    "ttl",
    "seq",
    "ack",
    "ring",
    "gap",
    "resume",
    "cancel",
    "escalat",
    "stall",
    "state",
    "error code",
    "version",
  ];
  const lower = doc.toLowerCase();
  for (const topic of topics) {
    assert.ok(lower.includes(topic), `the document does not mention "${topic}"`);
  }
});

test("the document states the constants of the implementation", () => {
  assert.ok(doc.includes(BOTD_VERSION), `the document does not mention ${BOTD_VERSION}`);
  assert.ok(
    doc.includes(`${MAX_FRAME_BYTES / (1024 * 1024)} MiB`),
    `the document does not mention the frame size of ${MAX_FRAME_BYTES} bytes`,
  );
  for (const kind of BOT_KINDS) {
    assert.ok(doc.includes(kind), `the document does not mention the bot kind "${kind}"`);
  }
  for (const state of SESSION_STATES) {
    assert.ok(doc.includes(state), `the document does not mention the state "${state}"`);
  }
});

test("the document keeps the adapter vocabulary out of the wire", () => {
  assert.ok(
    doc.includes("botd/src/adapter-types.ts"),
    "the document does not point at the adapter contract",
  );
  assert.ok(
    doc.includes("NormalizedEvent"),
    "the document does not mention the normalized events of the adapters",
  );
  assert.ok(
    /raw provider line/.test(doc),
    "the document does not say that the events carry raw provider lines",
  );
});
