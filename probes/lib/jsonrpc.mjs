// probes/lib/jsonrpc.mjs
//
// Minimal JSON-RPC 2.0 peer used by the Codex (app-server) and ACP probes.
// The peer speaks over any duplex byte stream; framing is newline delimited
// JSON, which is what both protocols use.

/**
 * @typedef {Object} JsonRpcPeer
 * @property {(method: string, params?: unknown) => Promise<any>} request
 * @property {(method: string, params?: unknown) => void} notify
 * @property {(id: string|number, result: unknown) => void} respond
 * @property {(message: any) => void} handle
 * @property {string[]} pendingMethods
 */

/**
 * @param {{
 *   send: (payload: string) => void,
 *   onNotification?: (method: string, params: unknown, message: any) => void,
 *   onServerRequest?: (method: string, params: unknown, message: any) => void,
 *   onError?: (message: any) => void,
 *   defaultTimeoutMs?: number,
 * }} options
 * @returns {JsonRpcPeer}
 */
export function createJsonRpcPeer(options) {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 20_000;
  let nextId = 1;
  /** @type {Map<string|number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map();

  function respond(id, result) {
    options.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  function respondError(id, code, message) {
    options.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  function handle(message) {
    if (!message || typeof message !== "object") return;
    const hasId = message.id !== undefined && message.id !== null;
    if (hasId && message.method) {
      // server -> client request
      options.onServerRequest?.(message.method, message.params ?? {}, message);
      return;
    }
    if (hasId) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const error = new Error(message.error.message ?? "json-rpc error");
        error.code = message.error.code;
        entry.reject(error);
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      options.onNotification?.(message.method, message.params ?? {}, message);
    }
  }

  function request(method, params = {}, { timeoutMs = defaultTimeoutMs } = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for response to ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      options.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  function notify(method, params = {}) {
    options.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  return { request, notify, respond, respondError, handle };
}
