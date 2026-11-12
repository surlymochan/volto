// Scratch driver: capture true output for turn/interrupt and a failed turn.
import { spawn } from "node:child_process";

const child = spawn("/usr/local/bin/codex", ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
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
      if (m.id === 3 && m.result?.turn) turnId = m.result.turn.id;
      if (m.method === "turn/started") turnId = m.params.turn.id;
    } catch {}
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => {
  const t = c.trim();
  if (t && !t.includes("responses_websocket")) console.log("ERR " + t);
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
    params: { cwd: process.cwd(), approvalPolicy: "never", sandbox: "read-only", ephemeral: true },
  });
}, 1200);

setTimeout(() => {
  send({
    id: 3,
    method: "turn/start",
    params: { threadId, input: [{ type: "text", text: "reply PONG" }] },
  });
}, 2400);

// Interrupt the turn a couple of seconds in.
setTimeout(() => {
  send({ id: 4, method: "turn/interrupt", params: { threadId, turnId } });
}, 6000);

setTimeout(() => {
  console.log("TIMEOUT-END");
  child.kill("SIGTERM");
  process.exit(0);
}, 30000);
