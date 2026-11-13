// Cross-check the error table and the actual NDJSON error frames.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Botd } from "../../src/daemon.ts";
import { FAKE_CHILD } from "../helpers.ts";
import { RawClient, type RawFrame } from "./raw-client.ts";

const root = new URL("../../", import.meta.url);
const src = new URL("src/", root);
const doc = readFileSync(new URL("PROTOCOL.md", root), "utf8");
const section = doc.split(/^## 7\..*$/m)[1]?.split(/^## 8\..*$/m)[0];
assert.ok(section, "missing error table");
const rows = [...section.matchAll(/^\|\s*`([^`]+)`\s*\|([^\n]*)/gm)];
const documented = new Set(rows.map((row) => row[1]));
const reserved = new Set(rows.filter((row) => /\breserved\b/i.test(row[2])).map((row) => row[1]));

// Error frames can carry literal codes or forward LeaseManager's failures.
// Client event errors are local API events, not daemon-to-client frames.
function sourceFiles(dir: URL): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    return entry.isDirectory() ? sourceFiles(url) : entry.name.endsWith(".ts") ? [url] : [];
  });
}
const emitted = new Set<string>();
for (const file of sourceFiles(src)) {
  const text = readFileSync(file, "utf8");
  // Property order is irrelevant: inspect every flat object literal for op "error" plus a code.
  for (const match of text.replace(/\$\{[^{}]*\}/g, "").matchAll(/\{([^{}]*)\}/g)) {
    if (!/\bop:\s*["']error["']/.test(match[1])) continue;
    const code = /\bcode:\s*["']([^"']+)["']/.exec(match[1]);
    if (code) emitted.add(code[1]);
  }
  if (file.pathname.endsWith("/lease.ts")) {
    for (const match of text.matchAll(/\{\s*ok:\s*false\s*,\s*code:\s*["']([^"']+)["']/g)) emitted.add(match[1]);
  }
}

function harness(t: import("node:test").TestContext, now?: () => number) {
  mkdirSync(".tmp", { recursive: true });
  const home = mkdtempSync(join(".tmp", "error-codes-"));
  const daemon = new Botd({ home, storeFile: join(home, "sessions.json"), ...(now ? { now } : {}) }, { onFrame: () => {} });
  t.after(async () => {
    daemon.close();
    // Child exit callbacks may persist once more after close.
    await new Promise((resolve) => setTimeout(resolve, 100));
    rmSync(home, { recursive: true, force: true });
  });
  return { daemon, client: new RawClient(daemon) };
}
async function hello(client: RawClient) {
  client.send({ op: "hello", clientId: "client-a", leaseTtlMs: 60_000 });
  return client.waitForOp("hello");
}
async function error(client: RawClient, code: string, sid?: string) {
  const frame = await client.waitForError(code);
  assert.deepEqual(Object.keys(frame).sort(), (sid === undefined ? ["op", "code", "message"] : ["op", "code", "message", "sid"]).sort());
  assert.equal(frame.op, "error");
  assert.equal(frame.code, code);
  assert.equal(typeof frame.message, "string");
  assert.ok((frame.message as string).length > 0);
  if (sid !== undefined) assert.equal(frame.sid, sid);
  return frame;
}
async function open(client: RawClient) {
  client.send({ op: "open", sid: "s1", bot: { kind: "acp", command: [process.execPath, FAKE_CHILD] } });
  await client.waitFor((frame: RawFrame) => frame.op === "state" && frame.sid === "s1" && frame.state === "running");
}

test("all daemon error codes are listed in the error table", () => {
  assert.ok(emitted.size >= 13, `incomplete extraction: ${[...emitted]}`);
  assert.deepEqual([...emitted].filter((code) => !documented.has(code)).sort(), []);
});
test("each documented error code is emitted or explicitly reserved", () => {
  assert.ok(documented.size >= 13);
  assert.deepEqual([...documented].filter((code) => !emitted.has(code) && !reserved.has(code)).sort(), []);
});
test("error codes use lower snake case and the table has no duplicates", () => {
  assert.equal(rows.length, documented.size);
  for (const code of new Set([...emitted, ...documented])) assert.match(code, /^[a-z]+(?:_[a-z]+)*$/);
});

test("invalid JSON produces an exact bad_json error frame", async (t) => {
  const { client } = harness(t); client.writeLine("{broken"); await error(client, "bad_json");
});
test("invalid frames and frames before hello produce exact errors", async (t) => {
  const { client } = harness(t);
  client.send({ op: "hello" }); await error(client, "bad_frame");
  client.send({ op: "ack", sid: "s1", seq: 1 }); await error(client, "no_lease");
});
test("lease conflicts and invalid renewals produce exact errors", async (t) => {
  const clock = { value: 1000 }; const { daemon, client } = harness(t, () => clock.value);
  const lease = await hello(client);
  const other = new RawClient(daemon);
  other.send({ op: "hello", clientId: "client-b" }); await error(other, "lease_conflict");
  client.send({ op: "renew", leaseId: lease.leaseId, fence: lease.fence + 1 }); await error(client, "stale_fence");
  client.send({ op: "renew", leaseId: "unknown", fence: lease.fence }); await error(client, "stale_lease");
  clock.value += 60_000;
  client.send({ op: "renew", leaseId: lease.leaseId, fence: lease.fence }); await error(client, "lease_expired");
});
test("unknown and duplicate sessions produce exact errors", async (t) => {
  const { client } = harness(t); await hello(client);
  client.send({ op: "send", sid: "missing", payload: {} }); await error(client, "unknown_session", "missing");
  await open(client);
  client.send({ op: "open", sid: "s1", bot: { kind: "acp", command: [process.execPath, FAKE_CHILD] } });
  await error(client, "session_exists", "s1");
});
test("a paused lease produces an exact session error", async (t) => {
  const clock = { value: 1000 }; const { client } = harness(t, () => clock.value);
  await hello(client); await open(client); clock.value += 60_000;
  client.send({ op: "send", sid: "s1", payload: {} }); await error(client, "lease_paused", "s1");
});
test("a pending cancellation produces an exact session error", async (t) => {
  const { client } = harness(t); await hello(client); await open(client);
  client.send({ op: "cancel", sid: "s1" });
  client.send({ op: "send", sid: "s1", payload: {} }); await error(client, "session_cancelling", "s1");
});
test("an exited child produces an exact session error", async (t) => {
  const { client } = harness(t); await hello(client); await open(client);
  client.send({ op: "send", sid: "s1", payload: { cmd: "exit", code: 0 } });
  await client.waitFor((frame) => frame.op === "state" && frame.sid === "s1" && frame.state === "exited");
  client.send({ op: "send", sid: "s1", payload: {} }); await error(client, "session_exited", "s1");
});
test("a child start failure produces an exact child_error frame", async (t) => {
  const { client } = harness(t); await hello(client);
  client.send({ op: "open", sid: "s1", bot: { kind: "acp", command: [".tmp/nonexistent-child"] } });
  await error(client, "child_error", "s1");
});
