// Scratch: single script that runs the mock Responses API and the real
// `codex app-server` together, so the approval-request wire shape can be
// recorded (mock and app-server share a lifetime).
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const sse = (res, event, data) => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const respId = "resp_local_2";
    const fcId = "fc_local_1";
    const args = JSON.stringify({
      cmd: "echo hi",
      sandbox_permissions: "require_escalated",
      justification: "need escalation",
      yield_time_ms: 1000,
      max_output_tokens: 100,
    });

    sse(res, "response.created", {
      type: "response.created",
      response: { id: respId, object: "response", created_at: 0, status: "in_progress", model: "local-mock", output: [] },
    });
    sse(res, "response.in_progress", {
      type: "response.in_progress",
      response: { id: respId, object: "response", created_at: 0, status: "in_progress", model: "local-mock", output: [] },
    });
    sse(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: fcId, type: "function_call", name: "exec_command", call_id: "call_local_1", arguments: "", status: "in_progress" },
    });
    sse(res, "response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: fcId,
      output_index: 0,
      delta: args,
    });
    sse(res, "response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: fcId,
      output_index: 0,
      arguments: args,
    });
    sse(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: { id: fcId, type: "function_call", name: "exec_command", call_id: "call_local_1", arguments: args, status: "completed" },
    });
    sse(res, "response.completed", {
      type: "response.completed",
      response: {
        id: respId,
        object: "response",
        created_at: 0,
        status: "completed",
        model: "local-mock",
        output: [{ id: fcId, type: "function_call", name: "exec_command", call_id: "call_local_1", arguments: args, status: "completed" }],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      },
    });
    res.end();
  });
});

await new Promise((r) => mock.listen(8940, "127.0.0.1", r));

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
      if (m.method && m.id !== undefined) {
        console.log("SERVER-REQUEST method=" + m.method + " id=" + JSON.stringify(m.id));
        setTimeout(() => {
          const resp = { id: m.id, result: { decision: "accept" } };
          console.log("IN  " + JSON.stringify(resp));
          child.stdin.write(JSON.stringify(resp) + "\n");
        }, 1200);
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
  mock.close();
  process.exit(0);
}, 22000);
