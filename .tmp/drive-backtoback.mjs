// Scratch: verify that initialize + thread/start can be sent back-to-back
// without waiting for the initialize response, and that thread/resume works.
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
    if (line) console.log("OUT " + line.slice(0, 220));
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => {
  const t = c.trim();
  if (t && !t.includes("responses_websocket") && !t.includes("bubblewrap")) console.log("ERR " + t.slice(0, 200));
});

const send = (obj) => {
  console.log("IN  " + JSON.stringify(obj).slice(0, 220));
  child.stdin.write(JSON.stringify(obj) + "\n");
};

child.on("exit", (code) => console.log("EXIT " + code));

// Back-to-back, no waiting for the initialize response.
send({
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "volto-botd", title: "volto botd", version: "0.0.1" },
    capabilities: { experimentalApi: true },
  },
});
send({
  id: 2,
  method: "thread/start",
  params: { cwd: process.cwd(), approvalPolicy: "on-request", sandbox: "workspace-write", ephemeral: true },
});

setTimeout(() => {
  console.log("TIMEOUT-END");
  child.kill("SIGTERM");
  process.exit(0);
}, 6000);
