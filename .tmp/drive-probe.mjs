// Scratch: probe app-server behaviors the adapter depends on:
//  1. is the `initialized` notification accepted?
//  2. does turn/interrupt work without a turnId?
//  3. does thread/resume work for a persisted thread?
import { spawn } from "node:child_process";

const cwd = process.cwd();
const home = process.cwd() + "/.tmp/codex-home-resume";

const child = spawn("/usr/local/bin/codex", ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, CODEX_HOME: home },
});

let buf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      console.log("OUT(raw) " + line.slice(0, 160));
      continue;
    }
    console.log("OUT " + JSON.stringify(m).slice(0, 300));
    if (m.id === 2 && m.result?.thread) threadId = m.result.thread.id;
    if (m.method === "turn/started") turnId = m.params.turn.id;
    if (m.id !== undefined && m.error) console.log("!!! ERROR-RESPONSE " + JSON.stringify(m));
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => {
  const t = c.trim();
  if (t && !t.includes("responses_websocket") && !t.includes("bubblewrap")) console.log("ERR " + t.slice(0, 160));
});

let threadId = null;
let turnId = null;

const send = (obj) => {
  console.log("IN  " + JSON.stringify(obj).slice(0, 300));
  child.stdin.write(JSON.stringify(obj) + "\n");
};

child.on("exit", (code) => console.log("EXIT " + code));

// 1. initialize + initialized notification.
send({
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "volto-botd", title: "volto botd", version: "0.0.1" },
    capabilities: { experimentalApi: true },
  },
});
send({ method: "initialized" });

// 2. thread/start (non-ephemeral so it persists for a later resume).
setTimeout(() => {
  send({
    id: 2,
    method: "thread/start",
    params: { cwd, approvalPolicy: "never", sandbox: "read-only" },
  });
}, 1000);

// 3. turn/start, then interrupt WITHOUT a turnId (probe tolerance).
setTimeout(() => {
  send({
    id: 3,
    method: "turn/start",
    params: { threadId, input: [{ type: "text", text: "reply PONG", text_elements: [] }] },
  });
}, 2000);

setTimeout(() => {
  console.log("--- interrupting without turnId");
  send({ id: 4, method: "turn/interrupt", params: { threadId } });
}, 3500);

// 4. thread/resume on the same (running) thread.
setTimeout(() => {
  console.log("--- resuming thread " + threadId);
  send({ id: 5, method: "thread/resume", params: { threadId, cwd } });
}, 5000);

setTimeout(() => {
  console.log("TIMEOUT-END");
  child.kill("SIGTERM");
  process.exit(0);
}, 9000);
