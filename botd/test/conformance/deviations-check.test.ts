import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startHarness } from "../helpers.ts";
import { RawClient } from "./raw-client.ts";

const directory = fileURLToPath(new URL("./", import.meta.url));

type Deviation = { id: string; title: string };

function deviations(markdown: string): Deviation[] {
  const found = new Map<string, Deviation>();
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = line.match(/^#{1,6}\s+(D\d+)\s*[-–—:]\s*(.+?)\s*#*\s*$/i);
    const row = line.match(/^\s*\|\s*(D\d+)\s*\|\s*[^|]*\|\s*([^|]+?)\s*\|/i);
    const match = heading ?? row;
    if (match) {
      const id = match[1].toUpperCase();
      // A detailed heading is preferable to the shorter table description.
      if (heading || !found.has(id)) found.set(id, { id, title: match[2].trim() });
    }
  }
  return [...found.values()];
}

function normalize(text: string): string {
  return text.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function unreferenced(items: Deviation[], sources: string[]): Deviation[] {
  // Only comments and literal test names count, not arbitrary source strings.
  const references = sources.flatMap((source) => [
    ...source.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g),
    ...source.matchAll(/\b(?:test|it)(?:\.(?:todo|skip|only))?\s*\(\s*["'`]([^"'`\n]+)["'`]/g),
  ]).map((match) => normalize(match[1] ?? match[0]));
  return items.filter(({ id, title }) => !references.some((reference) =>
    new RegExp(`\\b${id.toLowerCase()}\\b`).test(reference) ||
    (normalize(title).length > 0 && reference.includes(normalize(title))),
  ));
}

function harness(t: { after: (fn: () => void | Promise<void>) => void }) {
  mkdirSync(".tmp", { recursive: true });
  const home = mkdtempSync(path.join(".tmp", "deviations-"));
  const result = startHarness({ home });
  t.after(async () => {
    await result.daemon.close();
    rmSync(home, { recursive: true, force: true });
  });
  return result.daemon;
}

test("parses numbered headings and table rows without counting fenced examples twice", () => {
  assert.deepEqual(deviations("| D1 | §1 | short | state |\n## D1 — Full title\n| D2 | §2 | Other title | state |\n```\n## D3 — Example\n```"), [
    { id: "D1", title: "Full title" },
    { id: "D2", title: "Other title" },
  ]);
});

test("finds references in comments and test names, but not ordinary strings or partial ids", () => {
  const items = [{ id: "D1", title: "First case" }, { id: "D2", title: "Second case" }, { id: "D3", title: "Third case" }];
  assert.deepEqual(unreferenced(items, ['// D1\ntest("Second case", () => {});\nconst x = "D3"; // D30']), [items[2]]);
});

test("every documented deviation is referenced by a conformance test", () => {
  const items = deviations(readFileSync(path.join(directory, "DEVIATIONS.md"), "utf8"));
  assert.ok(items.length > 0, "no numbered deviations found");
  const sources = readdirSync(directory).filter((name) => name.endsWith(".test.ts"))
    .map((name) => readFileSync(path.join(directory, name), "utf8"));
  const missing = unreferenced(items, sources);
  assert.deepEqual(missing, [], `unreferenced deviations: ${missing.map(({ id, title }) => `${id}: ${title}`).join(", ")}`);
});

test("D1: a second connection before hello receives no_lease", async (t) => {
  const daemon = harness(t);
  const first = new RawClient(daemon);
  const second = new RawClient(daemon);
  first.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000 });
  await first.waitForOp("hello");
  second.send({ op: "ack", sid: "s1", seq: 1 });
  const frame = await second.waitForOp("error");
  // Fixed on main (N9, no_lease before hello): the pre-hello frame of a second
  // connection is answered with no_lease as PROTOCOL.md §3 says, not stale_fence.
  assert.equal(frame.code, "no_lease");
});

test("D2: hello has no envelope fields", async (t) => {
  const client = new RawClient(harness(t));
  client.send({ op: "hello", clientId: "client-a", v: 1, seq: 2, ack: 1 });
  const frame = await client.waitForOp("hello");
  assert.deepEqual(Object.keys(frame).sort(), ["botdVersion", "fence", "leaseId", "leaseTtlMs", "op"]);
});

test("D3: a frame larger than the retired limit is accepted", async (t) => {
  const client = new RawClient(harness(t));
  client.send({ op: "hello", clientId: "x".repeat(2 * 1024 * 1024) });
  assert.equal((await client.waitForOp("hello", { timeoutMs: 10_000 })).op, "hello");
});

test("D4: malformed JSON and invalid frames use current error codes", async (t) => {
  const client = new RawClient(harness(t));
  client.writeLine("{");
  assert.equal((await client.waitForOp("error")).code, "bad_json");
  const mark = client.mark();
  client.send({ op: "hello" });
  const frame = await client.waitFor((item) => client.sinceMark(mark).includes(item) && item.op === "error");
  assert.equal(frame.code, "bad_frame");
});

test("D5: retired client ops are rejected as bad_frame", async (t) => {
  const client = new RawClient(harness(t));
  for (const op of ["handshake", "ready", "prompt"]) {
    const mark = client.mark();
    client.send({ op });
    const frame = await client.waitFor((item) => client.sinceMark(mark).includes(item) && item.op === "error");
    assert.equal(frame.code, "bad_frame", op);
    assert.match(String(frame.message), /unknown op/);
  }
});
