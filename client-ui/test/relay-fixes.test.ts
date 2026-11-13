import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startRelay } from "../relay.mjs";
import { daemonCommand } from "../../botd/src/client.ts";

async function setup() {
  await mkdir(resolve(".tmp"), { recursive: true });
  const dir = await mkdtemp(resolve(".tmp/relay-fixes-"));
  const binary = join(dir, "codex");
  await writeFile(binary, `#!${process.execPath}
import readline from 'node:readline';
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({input: process.stdin}).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.method !== 'turn/start') return;
  const mode = frame.params.input[0].text;
  if (mode === 'error') emit({method:'error',params:{error:{message:'provider failed sk-abcdefghijklmnopqrstuv'}}});
  else {
    const count = mode === 'many' ? 1001 : 1;
    for (let i = 0; i < count; i++) emit({id:i+100,method:'item/commandExecution/requestApproval',params:{command:'test'}});
    if (mode === 'exit') setTimeout(() => process.exit(0), 300);
  }
});
`);
  await chmod(binary, 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${dir}:${oldPath}`;
  const relay = await startRelay({ hosts: [{ alias: "test", command: daemonCommand({ home: join(dir, "home") }) }] });
  const base = relay.url.replace(/\/$/, "");
  const post = (path: string, data?: unknown) => fetch(base + path, { method: "POST", ...(data === undefined ? {} : { body: JSON.stringify(data), headers: { "content-type": "application/json" } }) });
  assert.equal((await post("/api/hosts/test/connect")).status, 204);
  const { sessionId } = await (await post("/api/hosts/test/sessions", { kind: "codex", cwd: process.cwd() })).json();
  const abort = new AbortController();
  const response = await fetch(base + `/api/sessions/${sessionId}/events`, { signal: abort.signal });
  const reader = response.body!.getReader();
  let buffer = "";
  const events: any[] = [];
  async function readEvents(count: number) {
    const timeout = setTimeout(() => abort.abort(), 10000);
    try {
      while (events.length < count) {
        const part = await reader.read();
        if (part.done) throw new Error("event stream ended");
        buffer += new TextDecoder().decode(part.value);
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const line = block.split("\n").find(x => x.startsWith("data: "));
          if (line) events.push(JSON.parse(line.slice(6)));
        }
      }
      return events;
    } finally { clearTimeout(timeout); }
  }
  return { post, sessionId, readEvents, async close() {
    abort.abort(); relay.server.closeAllConnections(); await new Promise<void>(done => relay.server.close(() => done()));
    process.env.PATH = oldPath; await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } };
}

async function waitFor(predicate: () => Promise<boolean>) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error("timed out");
}

async function send(ctx: Awaited<ReturnType<typeof setup>>, text: string) {
  assert.equal((await ctx.post(`/api/sessions/${ctx.sessionId}/send`, { text })).status, 204);
}

// todo: relay.mjs keeps the permission after the provider exits, the answer returns 204 instead of 404
test("pending permission is removed when the provider exits", { todo: "relay.mjs keeps the permission after the provider exits, the answer returns 204 instead of 404" }, async () => {
  const ctx = await setup();
  try {
    await send(ctx, "exit"); const [permission] = await ctx.readEvents(1);
    await waitFor(async () => (await ctx.post(`/api/sessions/${ctx.sessionId}/send`, { text: "late" })).status === 409);
    assert.equal((await ctx.post(`/api/permissions/${permission.permissionId}`, { allow: true })).status, 404);
  } finally { await ctx.close(); }
});

// todo: relay.mjs keeps the permission after host disconnect, the answer returns 204 instead of 404
test("pending permission is removed on host disconnect", { todo: "relay.mjs keeps the permission after host disconnect, the answer returns 204 instead of 404" }, async () => {
  const ctx = await setup();
  try {
    await send(ctx, "permission"); const [permission] = await ctx.readEvents(1);
    assert.equal((await ctx.post("/api/hosts/test/disconnect")).status, 204);
    assert.equal((await ctx.post(`/api/permissions/${permission.permissionId}`, { allow: false })).status, 404);
  } finally { await ctx.close(); }
});

// todo: relay.mjs has no capacity limit, the oldest permission is still answerable
test("permission capacity evicts the oldest request", { todo: "relay.mjs has no capacity limit, the oldest permission is still answerable" }, async () => {
  const ctx = await setup();
  try {
    await send(ctx, "many"); const events = await ctx.readEvents(1001);
    assert.equal((await ctx.post(`/api/permissions/${events[0].permissionId}`, { allow: true })).status, 404);
    assert.equal((await ctx.post(`/api/permissions/${events[1000].permissionId}`, { allow: true })).status, 204);
  } finally { await ctx.close(); }
});

// todo: relay.mjs does not emit a redacted error event before turn_end
test("provider error is redacted and precedes turn end", { todo: "relay.mjs does not emit a redacted error event before turn_end" }, async () => {
  const ctx = await setup();
  try {
    await send(ctx, "error"); const events = await ctx.readEvents(2);
    assert.equal(events[0].kind, "error"); assert.equal(events[0].message, "provider failed <redacted>");
    assert.equal(events[1].kind, "turn_end"); assert.equal(events[1].status, "error");
  } finally { await ctx.close(); }
});

test("a live permission can be answered only once", async () => {
  const ctx = await setup();
  try {
    await send(ctx, "permission"); const [permission] = await ctx.readEvents(1);
    assert.equal((await ctx.post(`/api/permissions/${permission.permissionId}`, { allow: true })).status, 204);
    assert.equal((await ctx.post(`/api/permissions/${permission.permissionId}`, { allow: true })).status, 404);
  } finally { await ctx.close(); }
});
