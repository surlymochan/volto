// Scratch: confirm thread/start honors config.model_reasoning_effort and
// developerInstructions (visible in thread/settings/updated after a turn).
import { spawn } from "node:child_process";

const child = spawn("/usr/local/bin/codex", ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, CODEX_HOME: process.cwd() + "/.tmp/codex-home" },
});

let threadId = null;

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
      continue;
    }
    if (m.method === "thread/settings/updated") {
      const s = m.params.threadSettings;
      console.log("SETTINGS effort=" + JSON.stringify(s.effort));
      console.log(
        "SETTINGS developer_instructions=" +
          JSON.stringify(s.collaborationMode?.settings?.developer_instructions),
      );
    }
    if (m.id !== undefined) {
      const r = m.result;
      if (r?.thread) threadId = r.thread.id;
      console.log(
        "RESP id=" + m.id +
          " reasoningEffort=" + JSON.stringify(r?.reasoningEffort) +
          " model=" + JSON.stringify(r?.model) +
          " approval=" + JSON.stringify(r?.approvalPolicy),
      );
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => {
  const t = c.trim();
  if (t && !t.includes("responses_websocket") && !t.includes("bubblewrap")) {
    console.log("ERR " + t.slice(0, 200));
  }
});

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");

child.on("exit", (code) => console.log("EXIT " + code));

send({
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "volto-botd", title: "volto botd", version: "0.0.1" },
    capabilities: { experimentalApi: true },
  },
});
send({ method: "initialized" });

setTimeout(() => {
  send({
    id: 2,
    method: "thread/start",
    params: {
      cwd: process.cwd(),
      model: "local-mock",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      config: { model_reasoning_effort: "medium" },
      developerInstructions: "You are a test bot.",
    },
  });
}, 1200);

setTimeout(() => {
  send({
    id: 3,
    method: "turn/start",
    params: { threadId, input: [{ type: "text", text: "hi", text_elements: [] }] },
  });
}, 2500);

setTimeout(() => {
  console.log("TIMEOUT-END");
  child.kill("SIGTERM");
  process.exit(0);
}, 7000);
