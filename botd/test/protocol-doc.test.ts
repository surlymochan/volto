// Acceptance test for botd/PROTOCOL.md.
//
// The protocol document has to stay in sync with the implementation: every
// frame op it documents must exist in botd/src (the grep check), the
// document must stay inside its line budget and it must keep covering the
// topics the protocol has to specify.
//
// The sessions in the document use synthetic ids only.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const srcFiles = listSources(join(repoRoot, "botd", "src"));

/** The backticked names of the first column of the table below `heading`. */
function tableNames(heading: string): string[] {
  const names: string[] = [];
  let inTable = false;
  for (const line of docLines) {
    if (line.startsWith("## ")) inTable = line.startsWith(heading);
    if (!inTable) continue;
    const cell = /^\|\s*`([A-Za-z_]+)`\s*\|/.exec(line);
    if (cell) names.push(cell[1]);
  }
  return names;
}

/** The op names of the frame catalog (§3). */
function catalogOps(): string[] {
  return tableNames("## 3.");
}

/** The error codes of the error code table (§8). */
function errorCodes(): string[] {
  return tableNames("## 8.");
}

/** One frame of an example session, in document order. */
interface ExampleFrame {
  direction: string;
  v: number;
  op: string;
  seq: number;
  ack: number;
  session: string;
  code?: string;
  resume?: unknown;
}

/** The frames of the example sessions (§10). */
function exampleFrames(): ExampleFrame[] {
  const frames: ExampleFrame[] = [];
  for (const line of docLines) {
    const match = /^(→|←)\s+(\{.*\})$/.exec(line);
    if (!match) continue;
    frames.push(JSON.parse(match[2]) as ExampleFrame);
    frames[frames.length - 1].direction = match[1];
  }
  return frames;
}

test("the protocol document stays inside its line budget", () => {
  assert.ok(docLines.length > 50, "botd/PROTOCOL.md looks empty");
  assert.ok(
    docLines.length <= MAX_DOC_LINES,
    `botd/PROTOCOL.md has ${docLines.length} lines, the budget is ${MAX_DOC_LINES}`,
  );
});

test("the frame catalog lists the ops of the protocol", () => {
  const ops = catalogOps();
  assert.ok(ops.length >= 5, `the catalog holds only ${ops.length} ops`);
  assert.equal(new Set(ops).size, ops.length, `duplicate op in the catalog: ${ops.join(", ")}`);
});

test("every documented frame op exists in botd/src", () => {
  for (const op of catalogOps()) {
    const found = srcFiles.some((file) => new RegExp(`\\b${op}\\b`).test(readFileSync(file, "utf8")));
    assert.ok(found, `op "${op}" is documented but does not appear in botd/src`);
  }
});

test("the example sessions only use documented ops", () => {
  const ops = new Set(catalogOps());
  const used = new Set<string>();
  for (const frame of exampleFrames()) {
    assert.ok(ops.has(frame.op), `an example uses the undocumented op "${frame.op}"`);
    used.add(frame.op);
  }
  for (const op of ops) {
    assert.ok(used.has(op), `op "${op}" is documented but never shown in an example`);
  }
});

test("the document has three example sessions", () => {
  const sessions = docLines.filter((line) => /^### Example \d+/.test(line));
  assert.equal(sessions.length, 3, `the document has ${sessions.length} example sessions`);
});

test("the example frames are well formed", () => {
  const frames = exampleFrames();
  assert.ok(frames.length >= 10, `only ${frames.length} frames in the examples`);
  for (const frame of frames) {
    assert.equal(frame.v, 1, `frame with an unexpected version: ${JSON.stringify(frame)}`);
    assert.ok(Number.isInteger(frame.seq) && frame.seq >= 1, `bad seq: ${JSON.stringify(frame)}`);
    assert.ok(Number.isInteger(frame.ack) && frame.ack >= 0, `bad ack: ${JSON.stringify(frame)}`);
    assert.ok(
      typeof frame.session === "string" && frame.session.length > 0,
      `bad session: ${JSON.stringify(frame)}`,
    );
  }
});

test("the example frames honour the ordering and acknowledgement rules", () => {
  const lastSeq: Record<string, number> = { "→": 0, "←": 0 };
  const lastAck: Record<string, number> = { "→": 0, "←": 0 };
  const peerSeq: Record<string, number> = { "→": 0, "←": 0 };
  const lastPeerFrame: Record<string, ExampleFrame | undefined> = { "→": undefined, "←": undefined };
  let session = "";

  for (const frame of exampleFrames()) {
    if (frame.session !== session) {
      session = frame.session;
      lastSeq["→"] = 0;
      lastSeq["←"] = 0;
      lastAck["→"] = 0;
      lastAck["←"] = 0;
      peerSeq["→"] = 0;
      peerSeq["←"] = 0;
    }
    const peer = frame.direction === "→" ? "←" : "→";
    assert.ok(
      frame.ack <= peerSeq[peer],
      `ack ${frame.ack} runs ahead of the frames sent by ${peer}`,
    );
    assert.ok(frame.ack >= lastAck[frame.direction], `ack ${frame.ack} goes backwards`);
    if (frame.seq <= lastSeq[frame.direction]) {
      // A replay repeats an older seq: the peer has to have asked for it.
      const asked = lastPeerFrame[peer];
      const wanted =
        asked !== undefined &&
        (asked.op === "handshake" ? asked.resume !== undefined : asked.code === "seq_gap");
      assert.ok(wanted, `frame ${frame.seq} of ${frame.direction} replays without being asked for`);
    }
    lastSeq[frame.direction] = Math.max(lastSeq[frame.direction], frame.seq);
    lastAck[frame.direction] = frame.ack;
    peerSeq[frame.direction] = Math.max(peerSeq[frame.direction], frame.seq);
    lastPeerFrame[frame.direction] = frame;
  }
});

test("the document specifies ordering, leases, cancellation, errors and versioning", () => {
  const topics = [
    "seq",
    "ack",
    "gap",
    "resume",
    "ttlms",
    "renew",
    "epoch",
    "fenc",
    "cancel",
    "escalat",
    "error code",
    "version",
  ];
  const lower = doc.toLowerCase();
  for (const topic of topics) {
    assert.ok(lower.includes(topic), `the document does not mention "${topic}"`);
  }
});

test("every error code of the document is listed in the error code table", () => {
  const listed = new Set(errorCodes());
  assert.ok(listed.size >= 5, `the error code table holds only ${listed.size} codes`);
  const used = new Set([...doc.matchAll(/code:"([a-z_]+)"/g)].map((match) => match[1]));
  for (const code of used) {
    assert.ok(listed.has(code), `the error code "${code}" is not listed in the error code table`);
  }
});
