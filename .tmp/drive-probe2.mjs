// Scratch: verify thread/start accepts config.effort + developerInstructions,
// and probe getAuthStatus.
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
    console.log("OUT " + line.slice(0, 260));
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => {
  const t = c.trim();
  if (t && !t.includes("responses_websocket") && !t.includes("bubblewrap")) console.log("ERR " + t.slice(0, 200));
});

const send = (obj) => {
  console.log("IN  " + JSON.stringify(obj).slice(0, 400));
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
    params: {
      cwd: process.cwd(),
      model: "local-mock",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      config: { model_reasoning_effort: "low" },
      developerInstructions: "You are a test bot.",
    },
  });
}, 1000);

setTimeout(() => {
  send({ id: 3, method: "getAuthStatus", params: {} });
}, 2500);

setTimeout(() => {
  console.log("TIMEOUT-END");
  child.kill("SIGTERM");
  process.exit(0);
}, 7000);
