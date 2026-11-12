// Scratch driver: capture the true approval-request wire shape from the real
// `codex app-server`, and answer the approval with a JSON-RPC response.
import { spawn } from "node:child_process";

const child = spawn("/usr/local/bin/codex", ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, CODEX_HOME: process.cwd() + "/.tmp/codex-home-approve" },
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
    console.log("OUT " + line);
    try {
      const m = JSON.parse(line);
      if (m.id === 2 && m.result?.thread) threadId = m.result.thread.id;
      if (m.method === "turn/started") turnId = m.params.turn.id;
      // Server-initiated request (has id + method) => approval flow.
      if (m.method && m.id !== undefined) {
        console.log("SERVER-REQUEST " + m.method + " id=" + JSON.stringify(m.id));
        setTimeout(() => {
          const resp = { id: m.id, result: { decision: "accept" } };
          console.log("IN  " + JSON.stringify(resp));
          child.stdin.write(JSON.stringify(resp) + "\n");
        }, 1500);
      }
    } catch {}
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => {
  const t = c.trim();
  if (t && !t.includes("responses_websocket") && !t.includes("bubblewrap")) console.log("ERR " + t);
});

let threadId = null;
let turnId = null;

const send = (obj) => {
  console.log("IN  " + JSON.stringify(obj));
  child.stdin.write(JSON.stringify(obj) + "\n");
};

child.on("exit", (code) => console.log("EXIT " + code));

send({
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "volto-botd", title: "volto botd", version: "0.0.1" },
    capabilities: { experimentalApi: true },
  },
});

setTimeout(() => {
  send({
    id: 2,
    method: "thread/start",
    params: { cwd: process.cwd(), approvalPolicy: "on-request", sandbox: "workspace-write", ephemeral: true },
  });
}, 1200);

setTimeout(() => {
  send({
    id: 3,
    method: "turn/start",
    params: { threadId, input: [{ type: "text", text: "run echo hi" }] },
  });
}, 2400);

setTimeout(() => {
  console.log("TIMEOUT-END");
  child.kill("SIGTERM");
  process.exit(0);
}, 25000);
