// volto client UI: the contract between the panel and a botd daemon.
//
// The UI never talks to a daemon directly. It talks to a `BotdClient`, so the
// panel can be developed against the mock (see mock-client.ts) and later
// pointed at a real daemon without touching the view code.
//
// The vocabulary mirrors the botd adapter contract (botd/src/adapter-types.ts):
// every provider line arrives as a normalized event, and a session is the
// unit of work a bot runs for the control plane.

/** Bot kinds the control plane can drive. */
export type BotKind = "codex" | "claude" | "dsh" | "pi" | "agy" | "copilot";

/** Model family a bot belongs to. */
export type ModelFamily = "gpt" | "claude" | "deepseek" | "minimax" | "gemini" | "other";

/** Lifecycle of a bot as reported by the daemon. */
export type BotStatus = "idle" | "busy" | "down";

/** A remote machine, addressed by its SSH alias. */
export interface RemoteHost {
  /** SSH alias, e.g. the name used in the user's ssh config. */
  alias: string;
  /** Optional human readable label shown next to the alias. */
  label?: string;
}

/** One bot running on a remote host. */
export interface RemoteBot {
  /** Stable id of the bot, unique across hosts. */
  id: string;
  /** SSH alias of the host the bot runs on. */
  host: string;
  kind: BotKind;
  family: ModelFamily;
  /** Logical lane the bot works in, e.g. "primary" or "review". */
  lane: string;
  status: BotStatus;
  /** Epoch milliseconds when the current lease expires; null when the bot holds none. */
  leaseExpiresAt: number | null;
  /** Share of the bot's quota already consumed, in percent. */
  quotaUsedPct: number;
  /** Session currently running on the bot, if any. */
  sessionId: string | null;
}

/** Fields every normalized event carries. */
export interface BotEventBase {
  sessionId: string;
  /** SSH alias of the host the session runs on. */
  host: string;
  /** Id of the bot running the session. */
  botId: string;
}

/** Events of a session, normalized for display. */
export type BotEvent =
  | (BotEventBase & { kind: "text"; text: string })
  | (BotEventBase & { kind: "tool"; name: string; status: "start" | "end" | "error"; summary?: string })
  | (BotEventBase & { kind: "permission"; permissionId: string; title: string; detail?: string })
  | (BotEventBase & { kind: "turn_end"; status: "ok" | "error" | "cancelled" });

/** Removes a subscription. Calling it twice must be harmless. */
export type Unsubscribe = () => void;

/** Everything the panel needs from a daemon. */
export interface BotdClient {
  /** All hosts known to the daemon. */
  listHosts(): Promise<RemoteHost[]>;
  /** Registers a new host; the alias must be unique. */
  addHost(input: { alias: string; label?: string }): Promise<RemoteHost>;
  /** Opens a connection to a host and starts its bots. */
  connect(alias: string): Promise<void>;
  /** Closes the connection to a host and stops its bots. */
  disconnect(alias: string): Promise<void>;
  /** Bots running on a host, with their status, lease and quota. */
  listBots(alias: string): Promise<RemoteBot[]>;
  /** Streams the events of a session; replays what already happened. */
  subscribe(sessionId: string, onEvent: (event: BotEvent) => void): Unsubscribe;
  /** Cancels the task a session is running. */
  cancel(sessionId: string): Promise<void>;
  /** Answers a pending permission request. */
  answerPermission(permissionId: string, allow: boolean): Promise<void>;
}
