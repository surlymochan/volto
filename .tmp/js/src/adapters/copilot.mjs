export const enabled = false;
export const COPILOT_COMMAND = ["copilot", "--acp"];
export const COPILOT_ENABLED_ENV = "COPILOT_ENABLED";
export const ACP_PROTOCOL_VERSION = 1;
export function copilotUnavailableReason(env = process.env) {
  if (env[COPILOT_ENABLED_ENV] === "1")
    return;
  return `the copilot adapter is disabled: set ${COPILOT_ENABLED_ENV}=1 to ` + "enable the GitHub Copilot CLI adapter (it requires a paid Copilot seat)";
}
export function assertCopilotEnabled(env = process.env) {
  const reason = copilotUnavailableReason(env);
  if (reason)
    throw new Error(reason);
}

export class CopilotAdapter {
  kind = "copilot";
  family = "other";
  #nextId = 0;
  #sessionId;
  #pending = new Map;
  #permissions = new Map;
  #toolNames = new Map;
  get sessionId() {
    return this.#sessionId;
  }
  spawn(opts) {
    assertCopilotEnabled();
    const command = [...COPILOT_COMMAND];
    if (opts.model)
      command.push("--model", opts.model);
    if (opts.effort)
      command.push("--reasoning-effort", opts.effort);
    return {
      command,
      env: inheritedEnv(),
      cwd: opts.cwd
    };
  }
  handshake(opts) {
    const initialize = this.#request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      }
    });
    const session = opts.resumeProviderSessionId ? this.#request("session/load", {
      sessionId: opts.resumeProviderSessionId,
      cwd: opts.cwd,
      mcpServers: []
    }) : this.#request("session/new", {
      cwd: opts.cwd,
      mcpServers: []
    });
    const messages = [initialize, session];
    if (opts.systemPrompt) {
      const params = session.params;
      const meta = asRecord(params._meta) ?? {};
      meta.systemPrompt = opts.systemPrompt;
      params._meta = meta;
    }
    return messages;
  }
  prompt(text, ctx) {
    const sessionId = ctx.providerSessionId ?? this.#sessionId ?? "";
    return this.#request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }]
    });
  }
  cancel(ctx) {
    const sessionId = ctx.providerSessionId ?? this.#sessionId;
    if (!sessionId)
      return [];
    return [
      {
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId }
      }
    ];
  }
  answerPermission(id, allow) {
    const request = this.#permissions.get(id);
    if (!request)
      return null;
    this.#permissions.delete(id);
    const optionId = pickOption(request.options, allow);
    if (!optionId) {
      return {
        jsonrpc: "2.0",
        id: request.rpcId,
        result: { outcome: { outcome: "cancelled" } }
      };
    }
    return {
      jsonrpc: "2.0",
      id: request.rpcId,
      result: { outcome: { outcome: "selected", optionId } }
    };
  }
  parse(line) {
    try {
      const trimmed = line.trim();
      if (!trimmed)
        return [];
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return [{ kind: "raw", payload: line }];
      }
      const record = asRecord(message);
      if (!record)
        return [{ kind: "raw", payload: message }];
      return this.#mapMessage(record);
    } catch {
      return [{ kind: "raw", payload: line }];
    }
  }
  #request(method, params) {
    const id = this.#nextId++;
    this.#pending.set(String(id), method);
    return { jsonrpc: "2.0", id, method, params };
  }
  #mapMessage(message) {
    const method = message.method;
    if (typeof method === "string") {
      if (method === "session/update")
        return this.#mapUpdate(message);
      if (method === "session/request_permission")
        return this.#mapPermission(message);
      return [{ kind: "raw", payload: message }];
    }
    if (message.error !== undefined)
      return this.#mapError(message.error);
    if (message.result !== undefined)
      return this.#mapResult(message);
    return [{ kind: "raw", payload: message }];
  }
  #mapResult(message) {
    const result = asRecord(message.result) ?? {};
    const id = message.id;
    const method = typeof id === "number" || typeof id === "string" ? this.#pending.get(String(id)) : undefined;
    if (typeof result.sessionId === "string") {
      this.#sessionId = result.sessionId;
      return [{ kind: "ready", providerSessionId: result.sessionId }];
    }
    if (result.stopReason !== undefined) {
      return [turnEnd(result.stopReason, usageOf(result))];
    }
    if (result.protocolVersion !== undefined) {
      return [{ kind: "ready" }];
    }
    if (method === "session/prompt")
      return [{ kind: "turn_end", status: "ok" }];
    if (method === "session/new" || method === "session/load" || method === "initialize") {
      return [{ kind: "ready" }];
    }
    return [{ kind: "raw", payload: message }];
  }
  #mapError(error) {
    const record = asRecord(error);
    if (record && typeof record.message === "string" && record.message) {
      return [{ kind: "error", message: record.message }];
    }
    if (error === null || error === undefined) {
      return [{ kind: "error", message: "unknown error" }];
    }
    return [{ kind: "error", message: String(error) }];
  }
  #mapUpdate(message) {
    const params = asRecord(message.params);
    const update = params ? asRecord(params.update) : undefined;
    if (!update)
      return [{ kind: "raw", payload: message }];
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk") {
      const delta = textOf(update.content);
      if (!delta)
        return [{ kind: "raw", payload: message }];
      return [{ kind: "text", delta }];
    }
    if (kind === "tool_call") {
      return [
        {
          kind: "tool",
          name: this.#toolName(update),
          status: toolStatus(update.status),
          summary: toolSummary(update)
        }
      ];
    }
    if (kind === "tool_call_update") {
      return [
        {
          kind: "tool",
          name: this.#toolName(update),
          status: toolStatus(update.status),
          summary: toolSummary(update)
        }
      ];
    }
    return [{ kind: "raw", payload: message }];
  }
  #toolName(update) {
    const callId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
    let name;
    if (typeof update.title === "string" && update.title)
      name = update.title;
    else if (callId)
      name = this.#toolNames.get(callId);
    if (!name && typeof update.kind === "string" && update.kind)
      name = update.kind;
    if (!name && callId)
      name = callId;
    if (!name)
      name = "tool";
    if (callId)
      this.#toolNames.set(callId, name);
    return name;
  }
  #mapPermission(message) {
    const id = message.id;
    if (typeof id !== "number" && typeof id !== "string") {
      return [{ kind: "raw", payload: message }];
    }
    const params = asRecord(message.params) ?? {};
    const rawOptions = Array.isArray(params.options) ? params.options : [];
    const options = [];
    for (const raw of rawOptions) {
      const option = asRecord(raw);
      if (!option)
        continue;
      options.push({
        optionId: typeof option.optionId === "string" ? option.optionId : undefined,
        name: typeof option.name === "string" ? option.name : undefined,
        kind: typeof option.kind === "string" ? option.kind : undefined
      });
    }
    this.#permissions.set(String(id), { rpcId: id, options });
    return [{ kind: "permission", id: String(id), request: params }];
  }
}
function inheritedEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string")
      env[key] = value;
  }
  return env;
}
function asRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return;
}
function textOf(content) {
  if (Array.isArray(content)) {
    return content.map((entry) => textOf(entry)).filter((text) => text.length > 0).join(`
`);
  }
  const block = asRecord(content);
  if (!block)
    return "";
  if (typeof block.text === "string")
    return block.text;
  const inner = asRecord(block.content);
  if (inner && typeof inner.text === "string")
    return inner.text;
  return "";
}
function toolSummary(update) {
  const text = textOf(update.content);
  if (text)
    return text;
  const output = asRecord(update.rawOutput);
  if (output && typeof output.output === "string")
    return output.output;
  return;
}
function toolStatus(status) {
  if (status === "completed")
    return "end";
  if (status === "failed")
    return "error";
  return "start";
}
function turnEnd(stopReason, usage) {
  let status = "ok";
  if (stopReason === "cancelled")
    status = "cancelled";
  else if (stopReason === "refusal")
    status = "error";
  return usage ? { kind: "turn_end", status, usage } : { kind: "turn_end", status };
}
function usageOf(result) {
  const usage = asRecord(result.usage);
  if (!usage)
    return;
  const inputTokens = firstNumber(usage.inputTokens, usage.input_tokens);
  const outputTokens = firstNumber(usage.outputTokens, usage.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined)
    return;
  return { inputTokens, outputTokens };
}
function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value))
      return value;
  }
  return;
}
function pickOption(options, allow) {
  const kinds = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of kinds) {
    for (const option of options) {
      if (option.kind === kind && typeof option.optionId === "string") {
        return option.optionId;
      }
    }
  }
  const words = allow ? ["allow", "approve", "yes"] : ["reject", "deny", "no"];
  for (const word of words) {
    for (const option of options) {
      const name = (option.name ?? "").toLowerCase();
      if (name.includes(word) && typeof option.optionId === "string") {
        return option.optionId;
      }
    }
  }
  return;
}
export const copilotAdapter = new CopilotAdapter;
export default copilotAdapter;
