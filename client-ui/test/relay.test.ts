import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod, rm, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { startRelay } from "../relay.mjs";
import { daemonCommand } from "../../botd/src/client.ts";

const waitFor = async (predicate: () => Promise<boolean>) => {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error("timed out waiting for relay");
};

test("relay bridges a real daemon, replays redacted events and logs frames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-"));
  const fixture = resolve("botd/test/fixtures/fake-child.mjs");
  const binary = join(dir, "codex");
  await writeFile(binary, `#!${process.execPath}\nimport ${JSON.stringify(fixture)};\nprocess.stdin.on('data', () => process.stdout.write(JSON.stringify({method:'item/agentMessage/delta',params:{delta:'secret sk-abcdefghijklmnopqrstuv'}})+'\\n'));\n`);
  await chmod(binary, 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${dir}:${oldPath}`;
  const log = join(dir, "frames.ndjson");
  const relay = await startRelay({ hosts: [{ alias: "test", command: [...daemonCommand({ home: join(dir, "home") }), "--cancel-grace-ms=100", "--cancel-kill-grace-ms=100"] }], frameLog: log });
  const base = relay.url.replace(/\/$/, "");
  const post = (path: string, data?: unknown) => fetch(base + path, { method: "POST", ...(data === undefined ? {} : { body: JSON.stringify(data), headers: { "content-type": "application/json" } }) });
  try {
    assert.deepEqual(await (await fetch(base + "/api/hosts")).json(), [{ alias: "test" }]);
    assert.equal((await post("/api/hosts", { alias: "second", label: "Second" })).status, 200);
    assert.equal((await post("/api/hosts", { alias: "test" })).status, 409);
    assert.equal((await fetch(base + "/api/hosts", { method: "POST", body: "{", headers: { "content-type": "application/json" } })).status, 400);
    assert.equal((await post("/api/sessions/missing/send", { text: "x" })).status, 404);
    assert.equal((await post("/api/hosts/test/connect")).status, 204);
    const opened = await post("/api/hosts/test/sessions", { kind: "codex", cwd: process.cwd() });
    assert.equal(opened.status, 200); const { sessionId } = await opened.json();
    assert.equal((await post(`/api/sessions/${sessionId}/send`, { text: "hello" })).status, 204);
    const controller = new AbortController();
    const response = await fetch(base + `/api/sessions/${sessionId}/events`, { signal: controller.signal });
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let output = "";
    await waitFor(async () => { const part = await reader.read(); output += decoder.decode(part.value); return output.includes("data:"); });
    assert.match(output, /<redacted>/); assert.doesNotMatch(output, /sk-abcdefghijklmnopqrstuv/);
    const id = Number(/id: (\d+)/.exec(output)![1]); controller.abort();
    const replayAbort = new AbortController();
    const replay = await fetch(base + `/api/sessions/${sessionId}/events`, { headers: { "Last-Event-ID": String(id - 1) }, signal: replayAbort.signal });
    const replayData = new TextDecoder().decode((await replay.body!.getReader().read()).value);
    assert.match(replayData, new RegExp(`id: ${id}\\n`)); replayAbort.abort();
    // Two further turns give >= 2 events; Last-Event-ID must filter the earlier ones.
    assert.equal((await post(`/api/sessions/${sessionId}/send`, { text: "again" })).status, 204);
    const readIds = async (headers: Record<string, string>, want: number) => {
      const ac = new AbortController(); const res = await fetch(base + `/api/sessions/${sessionId}/events`, { headers, signal: ac.signal });
      const rd = res.body!.getReader(); const dec = new TextDecoder(); let text = ""; let ids: number[] = [];
      await waitFor(async () => { const part = await rd.read(); text += dec.decode(part.value); ids = [...text.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1])); return ids.length >= want; });
      ac.abort(); return ids;
    };
    const all = await readIds({}, 2); const first = all[0];
    assert.ok(all.length >= 2);
    const later = await readIds({ "Last-Event-ID": String(first) }, all.length - 1);
    assert.ok(!later.includes(first)); assert.deepEqual(later.slice(0, all.length - 1), all.slice(1));
    // Guard: foreign Host/Origin and non-JSON POST are rejected; same-origin works.
    const raw = (path: string, init: { method?: string; headers: Record<string, string>; body?: string }) => new Promise<number>((ok, fail) => {
      const u = new URL(base + path);
      const r = httpRequest({ host: "127.0.0.1", port: u.port, path, method: init.method ?? "GET", headers: init.headers }, res => { res.resume(); ok(res.statusCode!); });
      r.on("error", fail); r.end(init.body);
    });
    assert.equal(await raw("/api/hosts", { headers: { host: "evil.example" } }), 403);
    assert.equal(await raw("/api/hosts", { headers: { host: `127.0.0.1:${new URL(base).port}`, origin: "http://evil.example" } }), 403);
    assert.equal((await fetch(base + "/api/hosts", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ alias: "evil" }) })).status, 403);
    assert.equal((await fetch(base + "/api/hosts", { headers: { origin: base } })).status, 200);
    assert.equal((await fetch(base + "/api/hosts", { headers: { origin: `http://localhost:${new URL(base).port}` } })).status, 200);
    assert.equal((await post("/api/hosts", { alias: "third" })).status, 200);
    assert.equal((await stat(log)).mode & 0o777, 0o600);
    assert.equal((await post(`/api/sessions/${sessionId}/cancel`)).status, 204);
    const lines = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(lines.some(line => line.dir === "c2s" && line.frame.op === "open" && line.kind === "codex"));
    assert.ok(lines.some(line => line.dir === "s2c" && line.frame.op === "event"));
    assert.ok(lines.every(line => typeof line.ts === "number" && line.host === "test" && ["c2s", "s2c"].includes(line.dir) && "kind" in line && typeof line.frame === "object"));
    assert.doesNotMatch(JSON.stringify(lines), /sk-abcdefghijklmnopqrstuv/);
    assert.equal((await post("/api/hosts/test/disconnect")).status, 204);
    assert.equal((await post(`/api/sessions/${sessionId}/send`, { text: "late" })).status, 409);
  } finally {
    relay.server.closeAllConnections(); await new Promise<void>(resolveClose => relay.server.close(() => resolveClose()));
    process.env.PATH = oldPath; await rm(dir, { recursive: true, force: true });
  }
});
