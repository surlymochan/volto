// probes/lib/acp.mjs
//
// Agent Client Protocol (ACP) client. ACP is JSON-RPC 2.0 over stdio with
// newline delimited JSON. The agent side pushes `session/update`
// notifications and may ask the client for permissions.

import { createJsonRpcPeer } from "./jsonrpc.mjs";

/**
 * @typedef {Object} AcpClient
 * @property {(cwd: string) => Promise<any>} initialize
 * @property {(methodId: string) => Promise<any>} authenticate
 * @property {(cwd: string) => Promise<any>} newSession
 * @property {(sessionId: string, cwd: string) => Promise<any>} loadSession
 * @property {(sessionId: string, text: string) => Promise<any>} prompt
 * @property {(sessionId: string) => void} cancel
 * @property {(id: string|number, result: unknown) => void} respond
 */

/**
 * @param {{
 *   send: (payload: string) => void,
 *   onUpdate?: (params: any) => void,
 *   onPermission?: (method: string, params: any, message: any) => void,
 *   onNotification?: (method: string, params: any) => void,
 *   defaultTimeoutMs?: number,
 * }} options
 * @returns {AcpClient}
 */
export function createAcpClient(options) {
  const peer = createJsonRpcPeer({
    send: options.send,
    defaultTimeoutMs: options.defaultTimeoutMs ?? 20_000,
    onNotification: (method, params) => {
      if (method === "session/update") options.onUpdate?.(params);
      else options.onNotification?.(method, params);
    },
    onServerRequest: (method, params, message) => {
      if (method === "session/request_permission") {
        options.onPermission?.(method, params, message);
        // Never grant a permission during a probe.
        const option = params?.options?.find((o) => /reject|deny|no/i.test(`${o.kind ?? ""} ${o.name ?? ""}`));
        peer.respond(message.id, { outcome: { outcome: "selected", optionId: option?.optionId ?? params?.options?.[0]?.optionId } });
        return;
      }
      if (method === "fs/read_text_file") {
        peer.respondError(message.id, -32601, "volto-probe has no filesystem access");
        return;
      }
      if (method === "fs/write_text_file") {
        peer.respondError(message.id, -32601, "volto-probe has no filesystem access");
        return;
      }
      peer.respondError(message.id, -32601, `volto-probe does not implement ${method}`);
    },
  });

  return {
    peer,
    initialize: (cwd) =>
      peer.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        cwd,
      }),
    authenticate: (methodId) => peer.request("authenticate", { methodId }),
    newSession: (cwd) => peer.request("session/new", { cwd, mcpServers: [] }),
    loadSession: (sessionId, cwd) => peer.request("session/load", { sessionId, cwd, mcpServers: [] }),
    prompt: (sessionId, text) => peer.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
    cancel: (sessionId) => peer.notify("session/cancel", { sessionId }),
    respond: (id, result) => peer.respond(id, result),
  };
}
