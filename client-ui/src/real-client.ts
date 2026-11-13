// volto client UI: the BotdClient that talks to the real relay.
//
// The panel never talks to a daemon: it talks to the relay (client-ui/relay.mjs)
// that runs next to the panel, and the relay bridges to the daemon over ssh.
// This module is the browser side of that conversation:
//
//   GET  /api/hosts                     -> RemoteHost[]
//   POST /api/hosts                     -> RemoteHost
//   POST /api/hosts/:alias/connect      -> 204
//   POST /api/hosts/:alias/disconnect   -> 204
//   GET  /api/hosts/:alias/bots         -> RemoteBot[]
//   POST /api/hosts/:alias/sessions     -> {sessionId, botId}
//   POST /api/sessions/:id/send         -> 204
//   GET  /api/sessions/:id/events       -> text/event-stream
//   POST /api/sessions/:id/cancel       -> 204
//   POST /api/permissions/:id           -> 204
//
// The events of a session arrive as server-sent events: one `data:` line per
// event, the `id:` of the line is the index of the event. The stream is read
// with fetch and a small parser of its own, so the panel works in every
// browser (EventSource cannot send a Last-Event-ID header on the first
// request) and the parser can be unit tested.
//
// The relay normalizes the provider lines before it writes them: the daemon
// hands out the raw JSON of a provider (botd/src/session.ts), the relay runs
// it through the adapter of the bot (botd/src/adapters/index.ts) and writes
// the normalized event as a BotEvent. The client therefore only has to read
// JSON.
//
// Only web APIs are used here: the panel runs in a browser, without a
// bundler, and its modules are transpiled on request.

import type {
  BotEvent,
  BotKind,
  BotdClient,
  RemoteBot,
  RemoteHost,
  Unsubscribe,
} from "./client.ts";

/** Delay before a dropped event stream is opened again, in milliseconds. */
const DEFAULT_RECONNECT_DELAY_MS = 250;

/* ------------------------------------------------------------- transport */

/** One chunk of a byte stream. */
export interface StreamChunk {
  /** The bytes of the chunk; missing on the last read. */
  value?: Uint8Array;
  /** True when the stream ended. */
  done: boolean;
}

/** The reader of a byte stream; the part of ReadableStream the client uses. */
export interface ByteStreamReader {
  /** Reads the next chunk of the stream. */
  read(): Promise<StreamChunk>;
  /** Releases the lock on the stream. */
  releaseLock?(): void;
}

/** A stream of bytes; the part of ReadableStream the client uses. */
export interface ByteStream {
  /** Takes a reader from the stream. */
  getReader(): ByteStreamReader;
}

/** The part of a fetch answer the client uses. */
export interface FetchResponse {
  /** True when the relay answered with a 2xx status. */
  ok: boolean;
  /** The status of the answer. */
  status: number;
  /** The body of the answer; null when the answer carried none. */
  body: ByteStream | null;
  /** The body of the answer, as text. */
  text(): Promise<string>;
}

/** The options of a fetch call. */
export interface FetchInit {
  /** The method of the call. */
  method?: string;
  /** The headers of the call. */
  headers?: Record<string, string>;
  /** The body of the call. */
  body?: string;
  /** The signal that aborts the call. */
  signal?: AbortSignal;
}

/** The fetch implementation the client uses. */
export type FetchLike = (input: string, init?: FetchInit) => Promise<FetchResponse>;

/* ---------------------------------------------------------------- errors */

/** An error the relay reported, or a malformed answer of the relay. */
export class RelayError extends Error {
  /** The code of the error, e.g. "host_exists". */
  readonly code: string;
  /** The status the relay answered with; 0 when it did not answer at all. */
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------------------------------------ event stream */

/** One message of an event stream. */
export interface SseMessage {
  /** The id of the message; the index of the event on the wire. */
  id: string | null;
  /** The type of the message; the relay does not use one. */
  event: string | null;
  /** The data of the message. */
  data: string;
}

/** A parser of server-sent events. */
export interface SseParser {
  /** Feeds a chunk of the stream; returns the messages the chunk completed. */
  push(chunk: string): SseMessage[];
  /** Ends the stream; returns the message that was still open. */
  flush(): SseMessage[];
}

/**
 * Creates a parser of server-sent events.
 *
 * The parser follows the event stream format of the WHATWG: a message is a
 * list of `field: value` lines that ends with an empty line, a line that
 * starts with a colon is a comment (the relay pings with one every 15
 * seconds) and a message may be split over several chunks. The id of a
 * message is the last id the stream carried, so a client that lost the
 * connection can ask for the rest with a Last-Event-ID header.
 */
export function createSseParser(): SseParser {
  let buffer = "";
  let dataLines: string[] = [];
  let eventType: string | null = null;
  let lastEventId: string | null = null;

  function dispatch(): SseMessage[] {
    if (dataLines.length === 0) {
      eventType = null;
      return [];
    }
    const message: SseMessage = { id: lastEventId, event: eventType, data: dataLines.join("\n") };
    dataLines = [];
    eventType = null;
    return [message];
  }

  function handleLine(line: string): SseMessage[] {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return [];
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      dataLines.push(value);
      return [];
    }
    if (field === "event") {
      eventType = value;
      return [];
    }
    if (field === "id" && !value.includes("\0")) lastEventId = value;
    return [];
  }

  return {
    push(chunk: string): SseMessage[] {
      buffer += chunk;
      const messages: SseMessage[] = [];
      for (;;) {
        const line = takeLine(buffer);
        if (line === null) break;
        buffer = line.rest;
        messages.push(...handleLine(line.line));
      }
      return messages;
    },
    flush(): SseMessage[] {
      const messages: SseMessage[] = [];
      let rest = buffer;
      buffer = "";
      if (rest.endsWith("\r")) rest = rest.slice(0, -1);
      if (rest !== "") messages.push(...handleLine(rest));
      messages.push(...dispatch());
      return messages;
    },
  };
}

/**
 * Reads the messages of an event stream.
 *
 * The stream is read chunk by chunk, so a message that is split over several
 * chunks is only handed out once it is complete.
 */
export async function* readSseStream(stream: ByteStream): AsyncGenerator<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!chunk.value) continue;
      for (const message of parser.push(decoder.decode(chunk.value, { stream: true }))) {
        yield message;
      }
    }
    const tail = decoder.decode();
    if (tail !== "") {
      for (const message of parser.push(tail)) yield message;
    }
    for (const message of parser.flush()) yield message;
  } finally {
    if (reader.releaseLock) reader.releaseLock();
  }
}

/* ----------------------------------------------------------------- client */

/** Options of the real client. */
export interface RealClientOptions {
  /** Base URL of the relay; defaults to the origin of the page. */
  base?: string;
  /** The fetch implementation; defaults to the one of the browser. */
  fetch?: FetchLike;
  /** Query string the `relay` parameter is read from; defaults to `location.search`. */
  search?: string;
  /** Delay before a dropped event stream is opened again, in milliseconds. */
  reconnectDelayMs?: number;
  /** Called when the event stream breaks; the panel has no channel for it. */
  onError?: (error: Error) => void;
}

/** A session the relay opened. */
export interface OpenSession {
  /** Id of the session; the relay uses it for the events and the commands. */
  sessionId: string;
  /** Id of the bot that runs the session. */
  botId: string;
}

/**
 * The base URL of the relay.
 *
 * The `relay` parameter of the page wins over the origin of the page: it
 * names the relay the panel talks to when it does not sit next to it.
 */
export function relayBase(search: string, fallback: string): string {
  const relay = new URLSearchParams(search).get("relay");
  if (relay === null || relay.trim() === "") return normalizeBase(fallback);
  return normalizeBase(relay.trim());
}

/**
 * A BotdClient that talks to the relay of the panel.
 *
 * The client is the browser side of the relay: it reads the hosts and the
 * bots of the relay, opens the sessions and streams their events. It knows
 * nothing about ssh or about the daemon: the relay owns that.
 */
export class RealBotdClient implements BotdClient {
  #base: string;
  #fetch: FetchLike;
  #reconnectDelayMs: number;
  #onError: (error: Error) => void;

  constructor(options: RealClientOptions = {}) {
    this.#base = normalizeBase(
      options.base ?? relayBase(options.search ?? currentSearch(), currentOrigin()),
    );
    this.#fetch = options.fetch ?? defaultFetch;
    this.#reconnectDelayMs = Math.max(0, options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS);
    this.#onError = options.onError ?? ((error: Error) => console.error(error.message));
  }

  /** The base URL the client talks to. */
  get base(): string {
    return this.#base;
  }

  async listHosts(): Promise<RemoteHost[]> {
    const answer = await this.#request("GET", "/api/hosts");
    if (!Array.isArray(answer)) {
      throw new RelayError("the relay did not answer with a list of hosts", "bad_answer", 200);
    }
    return answer.map((entry) => toHost(entry));
  }

  async addHost(input: { alias: string; label?: string }): Promise<RemoteHost> {
    const alias = input.alias.trim();
    if (alias.length === 0) throw new Error("an ssh alias is required");
    const label = input.label?.trim();
    const answer = await this.#request("POST", "/api/hosts", {
      alias,
      ...(label ? { label } : {}),
    });
    return toHost(answer);
  }

  async connect(alias: string): Promise<void> {
    await this.#request("POST", `/api/hosts/${encodeURIComponent(alias)}/connect`);
  }

  async disconnect(alias: string): Promise<void> {
    await this.#request("POST", `/api/hosts/${encodeURIComponent(alias)}/disconnect`);
  }

  async listBots(alias: string): Promise<RemoteBot[]> {
    const answer = await this.#request("GET", `/api/hosts/${encodeURIComponent(alias)}/bots`);
    if (!Array.isArray(answer)) {
      throw new RelayError("the relay did not answer with a list of bots", "bad_answer", 200);
    }
    return answer.map((entry) => toBot(entry));
  }

  /**
   * Streams the events of a session.
   *
   * The relay replays the events that already happened, so a subscription
   * that starts late still sees the whole session. When the stream breaks,
   * the client opens it again and asks for the events it did not see yet
   * with a Last-Event-ID header.
   */
  subscribe(sessionId: string, onEvent: (event: BotEvent) => void): Unsubscribe {
    const controller = new AbortController();
    let stopped = false;
    let lastEventId: string | null = null;

    const run = async (): Promise<void> => {
      while (!stopped) {
        try {
          const headers: Record<string, string> = { accept: "text/event-stream" };
          if (lastEventId !== null) headers["last-event-id"] = lastEventId;
          const response = await this.#fetch(
            `${this.#base}/api/sessions/${encodeURIComponent(sessionId)}/events`,
            { headers, signal: controller.signal },
          );
          if (!response.ok) {
            const error = await this.#toError(response);
            // The relay refused the session: asking again would not help.
            if (error.status >= 400 && error.status < 500) {
              this.#onError(error);
              return;
            }
            throw error;
          }
          if (!response.body) {
            throw new RelayError("the relay sent no event stream", "bad_answer", response.status);
          }
          for await (const message of readSseStream(response.body)) {
            if (message.id !== null) lastEventId = message.id;
            const event = toBotEvent(message.data);
            if (event) onEvent(event);
          }
        } catch (error) {
          if (stopped) return;
          this.#onError(error instanceof Error ? error : new Error(String(error)));
        }
        if (stopped) return;
        await delay(this.#reconnectDelayMs, controller.signal);
      }
    };

    void run();

    return () => {
      stopped = true;
      controller.abort();
    };
  }

  async cancel(sessionId: string): Promise<void> {
    await this.#request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/cancel`);
  }

  async answerPermission(permissionId: string, allow: boolean): Promise<void> {
    await this.#request("POST", `/api/permissions/${encodeURIComponent(permissionId)}`, { allow });
  }

  /**
   * Opens a session on a host.
   *
   * This is beyond the BotdClient interface: the panel does not start
   * sessions by itself, but the demo does.
   */
  async openSession(alias: string, options: { kind: BotKind; cwd?: string }): Promise<OpenSession> {
    const answer = await this.#request("POST", `/api/hosts/${encodeURIComponent(alias)}/sessions`, {
      kind: options.kind,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    const record = asRecord(answer);
    if (!record || typeof record.sessionId !== "string" || typeof record.botId !== "string") {
      throw new RelayError("the relay did not answer with a session", "bad_answer", 200);
    }
    return { sessionId: record.sessionId, botId: record.botId };
  }

  /**
   * Sends a prompt to a session.
   *
   * This is beyond the BotdClient interface: the panel does not prompt a
   * session by itself, but the demo does.
   */
  async send(sessionId: string, text: string): Promise<void> {
    await this.#request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/send`, { text });
  }

  /* ------------------------------------------------------------- requests */

  async #request(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: FetchResponse;
    try {
      response = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new RelayError(
        `relay unreachable: ${messageOf(error)}`,
        "unreachable",
        0,
      );
    }
    if (!response.ok) throw await this.#toError(response);
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (text.trim() === "") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new RelayError("the relay answered with something that is not JSON", "bad_answer", response.status);
    }
  }

  /** Turns an answer of the relay into an error. */
  async #toError(response: FetchResponse): Promise<RelayError> {
    let code = "relay_error";
    let message = `the relay answered with ${response.status}`;
    try {
      const parsed = asRecord(JSON.parse(await response.text()));
      const error = parsed ? asRecord(parsed.error) : null;
      if (error && typeof error.code === "string") code = error.code;
      if (error && typeof error.message === "string") message = error.message;
    } catch {
      // The body is not JSON: the status has to do.
    }
    return new RelayError(message, code, response.status);
  }
}

/* ---------------------------------------------------------------- helpers */

/** Removes the trailing slashes of a base URL. */
function normalizeBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/** The fetch of the runtime; the browser and node both have one. */
const defaultFetch: FetchLike = (input, init) => fetch(input, init as RequestInit);

/** The query string of the page, when there is one. */
function currentSearch(): string {
  return typeof location === "undefined" ? "" : location.search;
}

/** The origin of the page, when there is one. */
function currentOrigin(): string {
  return typeof location === "undefined" ? "" : location.origin;
}

/** True when the value is an object that is not an array. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** The message of an error, whatever it is. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Turns the answer of the relay into a host. */
function toHost(value: unknown): RemoteHost {
  const record = asRecord(value);
  if (!record || typeof record.alias !== "string") {
    throw new RelayError("the relay did not answer with a host", "bad_answer", 200);
  }
  return {
    alias: record.alias,
    ...(typeof record.label === "string" ? { label: record.label } : {}),
  };
}

/** Turns the answer of the relay into a bot. */
function toBot(value: unknown): RemoteBot {
  const record = asRecord(value);
  if (!record || typeof record.id !== "string" || typeof record.host !== "string") {
    throw new RelayError("the relay did not answer with a bot", "bad_answer", 200);
  }
  return { ...(record as unknown as RemoteBot) };
}

/** Turns the data of an event into a BotEvent; null when it is not one. */
function toBotEvent(data: string): BotEvent | null {
  if (data.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (!record) return null;
  const kind = record.kind;
  if (kind !== "text" && kind !== "tool" && kind !== "permission" && kind !== "turn_end") {
    return null;
  }
  if (
    typeof record.sessionId !== "string" ||
    typeof record.host !== "string" ||
    typeof record.botId !== "string"
  ) {
    return null;
  }
  return record as unknown as BotEvent;
}

/** Takes the next line of a buffer; null when the line is not complete yet. */
function takeLine(buffer: string): { line: string; rest: string } | null {
  const match = /\r\n|\n|\r/.exec(buffer);
  if (!match) return null;
  const index = match.index;
  const terminator = match[0];
  // A CR at the end of the buffer may be the first half of a CRLF pair.
  if (terminator === "\r" && index + 1 === buffer.length) return null;
  return { line: buffer.slice(0, index), rest: buffer.slice(index + terminator.length) };
}

/** Waits for a moment; the wait ends early when the signal aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
