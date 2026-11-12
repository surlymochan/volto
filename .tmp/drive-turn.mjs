// Scratch driver: full turn over `codex app-server`, dump raw stdout lines.
import { spawn } from "node:child_process";

const child = spawn("/usr/local/bin/codex", ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, CODEX_HOME: process.cwd() + "/.tmp/codex-home" },
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
      if (m.id === 2 && m.result && m.result.thread) threadId = m.result.thread.id;
    } catch {}
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => console.log("ERR " + c.trim()));

const send = (obj) => {
  console.log("IN  " + JSON.stringify(obj));
  child.stdin.write(JSON.stringify(obj) + "\n");
};

let threadId = null;

child.on("exit", (code) => console.log("EXIT " + code));

// No "jsonrpc" field this time: match the vendor JSONRPCRequest schema exactly.
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
    params: {
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
    },
  });
}, 1200);

setTimeout(() => {
  if (!threadId) {
    console.log("NO-THREAD");
    child.kill("SIGTERM");
    process.exit(0);
  }
  send({
    id: 3,
    method: "turn/start",
    params: {
      threadId,
      input: [{ type: "text", text: "reply PONG" }],
      effort: "low",
    },
  });
}, 2500);

setTimeout(() => {
  console.log("TIMEOUT-END");
  child.kill("SIGTERM");
  process.exit(0);
}, 45000);
