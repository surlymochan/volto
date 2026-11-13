#!/usr/bin/env node
// Local panel and botd bridge. --frame-log (or BOTD_FRAME_LOG) appends M0
// transcripts as NDJSON: {ts: epoch milliseconds, host: display or alias,
// kind: UI bot kind or null, dir: "c2s" | "s2c", frame: redacted wire frame}.
import { appendFileSync, chmodSync, closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { startServer } from "./serve.mjs";
import { BotdClient, spawnTransport, sshTransport } from "../botd/src/client.ts";
import { getAdapter, listAdapters } from "../botd/src/adapters/index.ts";
import { redact } from "../botd/src/redact.ts";

const wireKinds = { codex: "codex-app-server", pi: "pi-rpc", claude: "acp", dsh: "acp", agy: "acp", copilot: "acp" };
const safe = (value) => redact(value, { hostMask: true });
const bad = (status, code, message) => Object.assign(new Error(message), { status, code });

function tap(host, transport, log, sessions) {
  if (!log) return transport;
  function stream(dir) {
    let pending = "";
    return new Transform({ transform(chunk, encoding, callback) {
      pending += chunk.toString();
      let index;
      while ((index = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        try {
          const frame = JSON.parse(line);
          const kind = sessions.get(frame.sid)?.kind ?? null;
          appendFileSync(log, JSON.stringify({ ts: Date.now(), host: host.display || host.alias, kind, dir, frame: safe(frame) }) + "\n");
        } catch { /* Ignore malformed frames and logging failures. */ }
      }
      callback(null, chunk);
    } });
  }
  const input = stream("c2s");
  const output = stream("s2c");
  input.pipe(transport.stdin); transport.stdout.pipe(output);
  input.on("error", () => {}); output.on("error", () => {});
  transport.stdout.on("error", () => output.destroy());
  return { stdin: input, stdout: output, kill: (signal) => { input.destroy(); output.destroy(); transport.kill(signal); } };
}

export async function startRelay({ hosts = [], port = 0, frameLog = process.env.BOTD_FRAME_LOG } = {}) {
  if (frameLog) { closeSync(openSync(frameLog, "a", 0o600)); chmodSync(frameLog, 0o600); }
  const entries = new Map();
  const sessions = new Map();
  const permissions = new Map();
  function addHost(host) {
    if (!host || typeof host.alias !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(host.alias) || (host.label !== undefined && typeof host.label !== "string") || (host.display !== undefined && typeof host.display !== "string") || (host.command !== undefined && (!Array.isArray(host.command) || !host.command.length || !host.command.every(x => typeof x === "string")))) throw bad(400, "invalid_host", "Invalid host");
    if (entries.has(host.alias)) throw bad(409, "host_exists", `Host ${host.alias} already exists`);
    const entry = { ...host, client: null, connected: false, bots: new Map() };
    for (const row of listAdapters().filter(x => x.enabled)) entry.bots.set(row.kind, { id: `${host.alias}:${row.kind}`, host: host.alias, kind: row.kind, family: row.family, lane: "primary", status: "down", leaseExpiresAt: null, quotaUsedPct: 0, sessionId: null });
    entries.set(host.alias, entry);
    return { alias: host.alias, ...(host.label === undefined ? {} : { label: host.label }) };
  }
  for (const host of hosts) addHost(host);
  function hostFor(alias) { const host = entries.get(alias); if (!host) throw bad(404, "not_found", "Host not found"); return host; }
  function sessionFor(id) { const session = sessions.get(id); if (!session) throw bad(404, "not_found", "Session not found"); return session; }
  function emit(session, event) {
    const data = safe({ sessionId: session.id, host: session.host.alias, botId: session.bot.id, ...event });
    const item = { id: ++session.index, data }; session.events.push(item);
    if (session.events.length > 1000) session.events.shift();
    for (const response of session.listeners) response.write(`id: ${item.id}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function connect(host) {
    if (host.client) return host.client.start();
    const client = new BotdClient({ transport: () => tap(host, host.command ? spawnTransport(host.command[0], host.command.slice(1)) : sshTransport(host.alias), frameLog, sessions) });
    host.client = client;
    client.on("connected", () => { host.connected = true; for (const bot of host.bots.values()) bot.status = bot.sessionId ? "busy" : "idle"; });
    client.on("disconnected", () => { host.connected = false; for (const [id, permission] of permissions) if (permission.session.host === host) permissions.delete(id); for (const bot of host.bots.values()) bot.status = "down"; });
    client.on("event", ({ sid, payload }) => {
      const session = sessions.get(sid); if (!session) return;
      for (const event of session.adapter.parse(JSON.stringify(payload))) {
        if (event.kind === "ready") session.providerSessionId = event.providerSessionId;
        else if (event.kind === "text") emit(session, { kind: "text", text: event.delta });
        else if (event.kind === "tool") emit(session, { kind: "tool", name: event.name, status: event.status, ...(event.summary === undefined ? {} : { summary: event.summary }) });
        else if (event.kind === "permission") { const id = randomUUID(); permissions.set(id, { session, providerId: event.id }); emit(session, { kind: "permission", permissionId: id, title: "Permission requested", detail: typeof event.request === "string" ? event.request : JSON.stringify(event.request) }); }
        else if (event.kind === "turn_end") { emit(session, { kind: "turn_end", status: event.status }); session.bot.status = host.connected ? "idle" : "down"; }
        else if (event.kind === "error") emit(session, { kind: "turn_end", status: "error" });
      }
    });
    client.on("state", ({ sid, state }) => { const session = sessions.get(sid); if (state === "exited") { for (const [id, permission] of permissions) if (permission.session.id === sid) permissions.delete(id); if (session) { session.bot.sessionId = null; session.bot.status = host.connected ? "idle" : "down"; setTimeout(() => sessions.delete(sid), 60000).unref(); } } });
    return client.start().catch(async error => { await client.stop(); if (host.client === client) host.client = null; throw error; });
  }
  const panel = await startServer({ port });
  const server = panel.server;
  const staticHandler = server.listeners("request")[0]; server.removeListener("request", staticHandler);
  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) { staticHandler(req, res); return; }
    // Host/Origin guard: blocks DNS rebinding and cross-site requests against the local API.
    const allowedHosts = [`127.0.0.1:${panel.port}`, `localhost:${panel.port}`];
    const type = req.headers["content-type"];
    if (!allowedHosts.includes(req.headers.host ?? "") || (req.headers.origin !== undefined && !allowedHosts.some(h => req.headers.origin === `http://${h}`)) || (req.method === "POST" && type !== undefined && !/^application\/json\s*(;|$)/i.test(type))) {
      res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "forbidden", message: "Forbidden" } })); return;
    }
    void (async () => {
      const parts = url.pathname.split("/").slice(2).map(decodeURIComponent);
      const body = async () => { let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 1024 * 1024) throw bad(400, "invalid_body", "Invalid body"); } let value; try { value = JSON.parse(raw); } catch { throw bad(400, "invalid_body", "Invalid body"); } if (!value || typeof value !== "object" || Array.isArray(value)) throw bad(400, "invalid_body", "Invalid body"); return value; };
      const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
      const done = () => { res.writeHead(204); res.end(); };
      if (parts.length === 1 && parts[0] === "hosts" && req.method === "GET") return json([...entries.values()].map(({ alias, label }) => ({ alias, ...(label === undefined ? {} : { label }) })));
      if (parts.length === 1 && parts[0] === "hosts" && req.method === "POST") { const data = await body(); return json(addHost({ alias: data.alias, label: data.label })); }
      if (parts[0] === "hosts" && parts.length === 3) {
        const host = hostFor(parts[1]);
        if (parts[2] === "connect" && req.method === "POST") { await connect(host); return done(); }
        if (parts[2] === "disconnect" && req.method === "POST") { const client = host.client; host.client = null; host.connected = false; for (const [id, permission] of permissions) if (permission.session.host === host) permissions.delete(id); if (client) await client.stop(); for (const bot of host.bots.values()) { bot.status = "down"; bot.sessionId = null; } return done(); }
        if (parts[2] === "bots" && req.method === "GET") return json([...host.bots.values()]);
        if (parts[2] === "sessions" && req.method === "POST") {
          const data = await body(); const bot = host.bots.get(data.kind);
          if (!bot || (data.cwd !== undefined && (typeof data.cwd !== "string" || !data.cwd))) throw bad(400, "invalid_body", "Invalid session request");
          if (!host.client || !host.connected) throw bad(409, "disconnected", `Host ${host.alias} is disconnected`);
          if (bot.sessionId) throw bad(409, "busy", `Bot on ${host.alias} is busy`);
          const adapter = getAdapter(data.kind); const opts = { cwd: data.cwd ?? "." }; const spec = adapter.spawn(opts); const id = randomUUID();
          const session = { id, kind: data.kind, host, bot, adapter, index: 0, events: [], listeners: new Set(), handle: null, providerSessionId: undefined };
          sessions.set(id, session); bot.sessionId = id; bot.status = "busy";
          try { session.handle = await host.client.open({ sid: id, bot: { kind: wireKinds[data.kind], ...spec } }); for (const message of adapter.handshake(opts)) session.handle.send(message); }
          catch (error) { sessions.delete(id); bot.sessionId = null; bot.status = host.connected ? "idle" : "down"; throw error; }
          return json({ sessionId: id, botId: bot.id });
        }
      }
      if (parts[0] === "sessions" && parts.length === 3) {
        const session = sessionFor(parts[1]);
        if (parts[2] === "events" && req.method === "GET") { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); res.flushHeaders(); const last = Number(req.headers["last-event-id"] ?? 0); for (const item of session.events) if (item.id > (Number.isFinite(last) ? last : 0)) res.write(`id: ${item.id}\ndata: ${JSON.stringify(item.data)}\n\n`); session.listeners.add(res); const timer = setInterval(() => res.write(": ping\n\n"), 15000); res.on("close", () => { clearInterval(timer); session.listeners.delete(res); }); return; }
        if (parts[2] === "send" && req.method === "POST") { const data = await body(); if (typeof data.text !== "string") throw bad(400, "invalid_body", "Invalid message"); if (!session.host.connected || !session.handle || session.handle.state === "exited") throw bad(409, "session_ended", "Session is not running"); try { session.handle.send(session.adapter.prompt(data.text, { providerSessionId: session.providerSessionId })); } catch { throw bad(409, "session_ended", "Session is not running"); } session.bot.status = "busy"; return done(); }
        if (parts[2] === "cancel" && req.method === "POST") { const messages = session.adapter.cancel({ providerSessionId: session.providerSessionId }); await session.handle.cancel(messages[0]); for (const message of messages.slice(1)) session.handle.send(message); return done(); }
      }
      if (parts[0] === "permissions" && parts.length === 2 && req.method === "POST") { const permission = permissions.get(parts[1]); if (!permission) throw bad(404, "not_found", "Permission not found"); const data = await body(); if (typeof data.allow !== "boolean") throw bad(400, "invalid_body", "Invalid permission answer"); const message = permission.session.adapter.answerPermission(permission.providerId, data.allow); if (message !== null) permission.session.handle.send(message); permissions.delete(parts[1]); return done(); }
      throw bad(404, "not_found", "Not found");
    })().catch(error => { if (res.headersSent) { res.end(); return; } res.writeHead(error.status ?? 500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: error.code ?? "relay_error", message: error.status ? safe(error.message) : "Relay operation failed" } })); });
  });
  server.on("close", () => { for (const host of entries.values()) void host.client?.stop(); for (const session of sessions.values()) for (const response of session.listeners) response.end(); });
  return panel;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2); const option = name => { const i = args.indexOf(name); if (i === -1) return undefined; if (!args[i + 1]) throw new Error(`Missing ${name}`); return args[i + 1]; };
  const port = Number(option("--port") ?? 0); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
  const hostsFile = option("--hosts"); const hosts = JSON.parse(hostsFile ? await readFile(hostsFile, "utf8") : process.env.BOTD_HOSTS ?? "[]"); if (!Array.isArray(hosts)) throw new Error("Hosts must be an array");
  const relay = await startRelay({ hosts, port, frameLog: option("--frame-log") ?? process.env.BOTD_FRAME_LOG });
  process.stdout.write(`relay listening on http://127.0.0.1:${relay.port}\n`);
}
