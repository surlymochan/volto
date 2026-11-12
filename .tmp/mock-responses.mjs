// Scratch: minimal mock of the OpenAI Responses streaming API so the real
// `codex app-server` can complete a turn locally. Used only to record true
// app-server wire output; not part of the shipped adapter.
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
    console.error("REQ " + req.method + " " + req.url + " tools=" +
      JSON.stringify((parsed.tools || []).map((t) => t.name || t.type)));

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const respId = "resp_local_1";
    const itemId = "msg_local_1";
    const text = "PONG";

    sse(res, "response.created", {
      type: "response.created",
      response: {
        id: respId,
        object: "response",
        created_at: 0,
        status: "in_progress",
        model: "local-mock",
        output: [],
      },
    });

    sse(res, "response.in_progress", {
      type: "response.in_progress",
      response: {
        id: respId,
        object: "response",
        created_at: 0,
        status: "in_progress",
        model: "local-mock",
        output: [],
      },
    });

    sse(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: itemId,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    });

    sse(res, "response.content_part.added", {
      type: "response.content_part.added",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });

    sse(res, "response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: text,
    });

    sse(res, "response.output_text.done", {
      type: "response.output_text.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text,
    });

    sse(res, "response.content_part.done", {
      type: "response.content_part.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    });

    sse(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: itemId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
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
          {
            id: itemId,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 3,
          total_tokens: 14,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });

    res.end();
  });
});

server.listen(8931, "127.0.0.1", () => console.error("mock responses api on 8931"));
