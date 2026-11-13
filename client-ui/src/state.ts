// volto client UI: the pure state of the "Remote bots" panel.
//
// Everything in this file is a plain function of (state, action) or
// (state, selector input). No clocks, no randomness, no I/O: the view feeds
// actions in and renders the result, which keeps the panel logic testable
// without a DOM.

import type { BotEvent, RemoteBot, RemoteHost } from "./client.ts";

/** Connection state of a host as shown in the sidebar. */
export type HostStatus = "disconnected" | "connecting" | "connected" | "error";

/** A host row in the sidebar. */
export interface HostState {
  alias: string;
  label: string;
  status: HostStatus;
  error: string | null;
}

/** A permission request waiting for an Allow/Deny answer. */
export interface PendingPermission {
  id: string;
  sessionId: string;
  title: string;
  detail: string | null;
}

/** Lifecycle of a session as shown in the event stream. */
export type SessionStatus = "running" | "ended" | "cancelled";

/** One session and the events it produced. */
export interface SessionState {
  id: string;
  /** Insertion index assigned when the session is first started. */
  order?: number;
  /** Sequence of the most recently observed activity. */
  activityOrder?: number;
  host: string;
  botId: string;
  status: SessionStatus;
  events: BotEvent[];
  pendingPermissions: PendingPermission[];
}

/** The whole panel state. */
export interface UiState {
  hosts: HostState[];
  /** Alias of the host whose bots are shown, or null when nothing is picked. */
  selectedHost: string | null;
  /** Id of the session whose events are shown, or null when nothing is picked. */
  selectedSession: string | null;
  /** Bots of every known host, keyed by host alias. */
  bots: Record<string, RemoteBot[]>;
  /** Sessions keyed by session id. */
  sessions: Record<string, SessionState>;
  /** Wall clock of the last tick, in epoch milliseconds. */
  now: number;
  /** Last error shown to the user, or null. */
  error: string | null;
}

/** The empty panel state. */
export function initialState(): UiState {
  return {
    hosts: [],
    selectedHost: null,
    selectedSession: null,
    bots: {},
    sessions: {},
    now: 0,
    error: null,
  };
}

/** Everything that can change the panel state. */
export type UiAction =
  | { type: "hosts/loaded"; hosts: RemoteHost[] }
  | { type: "host/added"; host: RemoteHost }
  | { type: "host/selected"; alias: string | null }
  | { type: "session/selected"; sessionId: string | null }
  | { type: "host/status"; alias: string; status: HostStatus; error?: string | null }
  | { type: "bots/loaded"; host: string; bots: RemoteBot[] }
  | { type: "session/started"; sessionId: string; host: string; botId: string }
  | { type: "event/received"; event: BotEvent }
  | { type: "permission/answered"; permissionId: string; allow: boolean }
  | { type: "session/cancelled"; sessionId: string }
  | { type: "clock/tick"; now: number }
  | { type: "error/set"; message: string | null };

/** Host status with the given alias, or null when the host is unknown. */
export function findHost(state: UiState, alias: string): HostState | null {
  return state.hosts.find((host) => host.alias === alias) ?? null;
}

/** Bots of one host, in the order the daemon reported them. */
export function selectBots(state: UiState, alias: string | null): RemoteBot[] {
  if (alias === null) return [];
  return state.bots[alias] ?? [];
}

/** One session, or null when it is unknown. */
export function selectSession(state: UiState, sessionId: string): SessionState | null {
  return state.sessions[sessionId] ?? null;
}

/** Sessions of one host, most recently active first. */
export function selectHostSessions(state: UiState, alias: string | null): SessionState[] {
  if (alias === null) return [];
  return Object.values(state.sessions)
    .filter((session) => session.host === alias)
    .sort((a, b) => (b.activityOrder ?? b.order ?? -1) - (a.activityOrder ?? a.order ?? -1));
}

function nextActivityOrder(state: UiState): number {
  return Object.values(state.sessions).reduce(
    (max, session) => Math.max(max, session.activityOrder ?? session.order ?? -1), -1,
  ) + 1;
}

/** Permission requests that still wait for an answer, across all sessions. */
export function selectPendingPermissions(state: UiState): PendingPermission[] {
  const pending: PendingPermission[] = [];
  for (const session of Object.values(state.sessions)) {
    pending.push(...session.pendingPermissions);
  }
  return pending;
}

/**
 * Milliseconds left on the lease of a bot.
 *
 * Returns null when the bot holds no lease, and 0 once the lease expired.
 */
export function leaseRemainingMs(bot: RemoteBot, now: number): number | null {
  if (bot.leaseExpiresAt === null) return null;
  return Math.max(0, bot.leaseExpiresAt - now);
}

/** Lease remaining as a compact "m:ss" string, or null when there is no lease. */
export function formatLease(bot: RemoteBot, now: number): string | null {
  const remaining = leaseRemainingMs(bot, now);
  if (remaining === null) return null;
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Quota use of a bot as a short label, e.g. "42%". */
export function formatQuota(bot: RemoteBot): string {
  return `${Math.round(bot.quotaUsedPct)}%`;
}

/**
 * Apply an action to the state.
 *
 * The input state is never modified; a new state is returned instead.
 */
export function reduce(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "hosts/loaded": {
      const hosts = action.hosts.map((host) => toHostState(host, findHost(state, host.alias)));
      return { ...state, hosts };
    }

    case "host/added": {
      if (findHost(state, action.host.alias) !== null) return state;
      const hosts = [...state.hosts, toHostState(action.host, null)];
      const selectedHost = state.selectedHost ?? action.host.alias;
      return { ...state, hosts, selectedHost };
    }

    case "host/selected":
      return { ...state, selectedHost: action.alias, selectedSession: null };

    case "session/selected":
      return { ...state, selectedSession: action.sessionId };

    case "host/status": {
      const hosts = state.hosts.map((host) =>
        host.alias === action.alias
          ? { ...host, status: action.status, error: action.error ?? null }
          : host,
      );
      return { ...state, hosts };
    }

    case "bots/loaded":
      return { ...state, bots: { ...state.bots, [action.host]: action.bots } };

    case "session/started": {
      if (state.sessions[action.sessionId]) return state;
      const session: SessionState = {
        id: action.sessionId,
        order: Object.values(state.sessions).reduce((max, entry) => Math.max(max, entry.order ?? -1), -1) + 1,
        activityOrder: nextActivityOrder(state),
        host: action.host,
        botId: action.botId,
        status: "running",
        events: [],
        pendingPermissions: [],
      };
      return {
        ...state,
        sessions: { ...state.sessions, [action.sessionId]: session },
        selectedSession: state.selectedSession ?? action.sessionId,
      };
    }

    case "event/received":
      return applyEvent(state, action.event);

    case "permission/answered":
      return answerPermission(state, action.permissionId);

    case "session/cancelled": {
      const session = state.sessions[action.sessionId];
      if (!session) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.id]: { ...session, status: "cancelled", pendingPermissions: [], activityOrder: nextActivityOrder(state) },
        },
      };
    }

    case "clock/tick":
      return { ...state, now: action.now };

    case "error/set":
      return { ...state, error: action.message };

    default:
      return state;
  }
}

function toHostState(host: RemoteHost, previous: HostState | null): HostState {
  return {
    alias: host.alias,
    label: host.label ?? "",
    status: previous?.status ?? "disconnected",
    error: previous?.error ?? null,
  };
}

function applyEvent(state: UiState, event: BotEvent): UiState {
  const session = state.sessions[event.sessionId];
  if (!session) return state;

  const events = [...session.events, event];
  let pendingPermissions = session.pendingPermissions;
  let status = session.status;

  if (event.kind === "permission") {
    pendingPermissions = [
      ...pendingPermissions,
      { id: event.permissionId, sessionId: event.sessionId, title: event.title, detail: event.detail ?? null },
    ];
  } else if (event.kind === "turn_end") {
    status = event.status === "cancelled" ? "cancelled" : "ended";
    pendingPermissions = [];
  }

  return {
    ...state,
    sessions: {
      ...state.sessions,
      [session.id]: { ...session, events, pendingPermissions, status, activityOrder: nextActivityOrder(state) },
    },
  };
}

function answerPermission(state: UiState, permissionId: string): UiState {
  const sessions: Record<string, SessionState> = {};
  let changed = false;
  for (const [id, session] of Object.entries(state.sessions)) {
    if (!session.pendingPermissions.some((permission) => permission.id === permissionId)) {
      sessions[id] = session;
      continue;
    }
    changed = true;
    sessions[id] = {
      ...session,
      pendingPermissions: session.pendingPermissions.filter((permission) => permission.id !== permissionId),
      activityOrder: nextActivityOrder(state),
    };
  }
  if (!changed) return state;
  return { ...state, sessions };
}
