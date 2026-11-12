// Scratch: mock Responses API that asks the real `codex app-server` to run a
// shell command, so the approval request flow can be recorded.
import { createServer } from "node:http";

const sse = (res, event, data) => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body || "{}");
    } catch {}
    console.error("REQ tools=" + JSON.stringify((parsed.tools || []).map((t) => t.name || t.type)));
    if (!globalThis.__logged) {
      globalThis.__logged = true;
      for (const t of parsed.tools || []) {
        console.error("SCHEMA " + JSON.stringify(t).slice(0, 900));
      }
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const respId = "resp_local_2";
    const fcId = "fc_local_1";
    const args = JSON.stringify({ cmd: "echo hi", sandbox_permissions: "require_escalated", justification: "need escalation", yield_time_ms: 1000, max_output_tokens: 100 });

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
        output: [
          { id: fcId, type: "function_call", name: "exec_command", call_id: "call_local_1", arguments: args, status: "completed" },
        ],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      },
    });

    res.end();
  });
});

server.listen(8933, "127.0.0.1", () => console.error("mock tool-call api on 8933"));
