// Scratch driver: talk to `codex app-server` over stdio and dump raw stdout lines.
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
    if (line) console.log("OUT " + line);
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => console.log("ERR " + c.trim()));

const send = (obj) => {
  console.log("IN  " + JSON.stringify(obj));
  child.stdin.write(JSON.stringify(obj) + "\n");
};

child.on("exit", (code) => {
  console.log("EXIT " + code);
});

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "volto-botd", title: "volto botd", version: "0.0.1" },
    capabilities: { experimentalApi: true },
  },
});

setTimeout(() => {
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "thread/start",
    params: {
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
    },
  });
}, 1500);

setTimeout(() => {
  console.log("TIMEOUT-END");
  child.kill("SIGTERM");
  process.exit(0);
}, 20000);
