// volto client UI: the "Remote bots" panel.
//
// The panel is a thin shell around the pure state machine in state.ts: every
// daemon event becomes an action, the reducer produces the next state, and
// the DOM is redrawn from that state. The client is injected, so the panel
// can be driven by the mock or by a real daemon client.

import type { BotEvent, BotdClient, RemoteBot, RemoteHost } from "./client.ts";
import {
  formatLease,
  formatQuota,
  initialState,
  reduce,
  selectBots,
  selectHostSessions,
  selectSession,
} from "./state.ts";
import type { PendingPermission, UiAction, UiState } from "./state.ts";

/** How often the panel refreshes bots and lease countdowns, in milliseconds. */
export const POLL_MS = 1000;

/** A mounted panel. */
export interface Panel {
  /** Renders the panel into the document and loads the hosts. */
  mount(): Promise<void>;
  /** The current state, for tests and for the host of the panel. */
  readonly state: UiState;
  /** Runs one refresh cycle: the clock, then the bots of the selected host. */
  tick(): Promise<void>;
  /** Stops the timers and the subscriptions. */
  destroy(): void;
}

/** Options for the panel. */
export interface PanelOptions {
  /** The client the panel talks to. */
  client: BotdClient;
  /** How often the panel refreshes, in milliseconds. 0 disables the timer. */
  pollMs?: number;
}

export function createPanel(options: PanelOptions): Panel {
  const { client } = options;
  const pollMs = options.pollMs ?? POLL_MS;

  let state: UiState = initialState();

  /** Unsubscribe callbacks of the sessions we listen to. */
  const subscriptions = new Map<string, () => void>();

  let timer: ReturnType<typeof setInterval> | null = null;

  function dispatch(action: UiAction): void {
    state = reduce(state, action);
    render();
  }

  /* ------------------------------------------------------------ data flow */

  async function loadHosts(): Promise<void> {
    const hosts = await client.listHosts();
    dispatch({ type: "hosts/loaded", hosts });
    const first = state.hosts[0];
    if (first && state.selectedHost === null) await selectHost(first.alias);
  }

  async function selectHost(alias: string): Promise<void> {
    dispatch({ type: "host/selected", alias });
    await refreshBots(alias);
  }

  async function refreshBots(alias: string): Promise<void> {
    const bots = await client.listBots(alias);
    dispatch({ type: "bots/loaded", host: alias, bots });
    for (const bot of bots) {
      if (!bot.sessionId) continue;
      dispatch({ type: "session/started", sessionId: bot.sessionId, host: bot.host, botId: bot.id });
      subscribe(bot.sessionId);
    }
  }

  function subscribe(sessionId: string): void {
    if (subscriptions.has(sessionId)) return;
    const unsubscribe = client.subscribe(sessionId, (event: BotEvent) => {
      dispatch({ type: "event/received", event });
    });
    subscriptions.set(sessionId, unsubscribe);
  }

  async function toggleConnection(host: RemoteHost): Promise<void> {
    const current = state.hosts.find((entry) => entry.alias === host.alias);
    if (current?.status === "connected") {
      dispatch({ type: "host/status", alias: host.alias, status: "disconnected" });
      await client.disconnect(host.alias);
      return;
    }
    dispatch({ type: "host/status", alias: host.alias, status: "connecting" });
    try {
      await client.connect(host.alias);
      dispatch({ type: "host/status", alias: host.alias, status: "connected" });
      await refreshBots(host.alias);
    } catch (error) {
      dispatch({ type: "host/status", alias: host.alias, status: "error", error: messageOf(error) });
    }
  }

  async function cancelSession(sessionId: string): Promise<void> {
    await client.cancel(sessionId);
    dispatch({ type: "session/cancelled", sessionId });
  }

  async function answerPermission(permissionId: string, allow: boolean): Promise<void> {
    await client.answerPermission(permissionId, allow);
    dispatch({ type: "permission/answered", permissionId, allow });
  }

  function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /* --------------------------------------------------------------- render */

  function render(): void {
    renderStatus();
    renderHosts();
    renderBots();
    renderStream();
  }

  function renderStatus(): void {
    const line = document.getElementById("status-line");
    if (!line) return;
    if (state.error) {
      line.textContent = state.error;
      line.className = "sidebar-sub sidebar-sub-error";
      return;
    }
    const host = state.hosts.find((entry) => entry.alias === state.selectedHost);
    line.className = "sidebar-sub";
    line.textContent = host ? `${host.alias} — ${host.status}` : "no host selected";
  }

  function renderHosts(): void {
    const list = document.getElementById("host-list");
    if (!list) return;
    list.replaceChildren(
      ...state.hosts.map((host) => {
        const selected = host.alias === state.selectedHost;
        const label = host.label ? `${host.alias} · ${host.label}` : host.alias;
        return element("li", { className: selected ? "host host-selected" : "host" }, [
          element("button", {
            className: "host-name",
            text: label,
            testId: `host-${host.alias}`,
            title: host.alias,
            onClick: () => {
              void selectHost(host.alias);
            },
          }),
          element("span", {
            className: `dot dot-${host.status}`,
            text: host.status,
            testId: `host-status-${host.alias}`,
          }),
          element("button", {
            className: "button button-small",
            text: host.status === "connected" ? "Disconnect" : "Connect",
            testId: `connect-${host.alias}`,
            onClick: () => {
              void toggleConnection(host);
            },
          }),
        ]);
      }),
    );
  }

  function renderBots(): void {
    const panel = document.getElementById("bots-panel");
    if (!panel) return;
    const alias = state.selectedHost;
    const bots = selectBots(state, alias);
    if (alias === null || bots.length === 0) {
      panel.replaceChildren(
        element("h2", { className: "panel-title", text: "Bots" }),
        element("p", {
          className: "empty",
          text: alias === null ? "Pick a host to see its bots." : "This host reports no bots.",
        }),
      );
      return;
    }
    panel.replaceChildren(
      element("h2", { className: "panel-title", text: `Bots on ${alias}` }),
      element(
        "ul",
        { className: "bot-list" },
        bots.map((bot) => renderBot(bot)),
      ),
    );
  }

  function renderBot(bot: RemoteBot): HTMLElement {
    const lease = formatLease(bot, state.now);
    const selected = bot.sessionId !== null && bot.sessionId === state.selectedSession;
    return element("li", { className: selected ? "bot bot-selected" : "bot", testId: `bot-${bot.id}` }, [
      element("div", { className: "bot-head" }, [
        element("span", { className: "bot-kind", text: bot.kind }),
        element("span", { className: "bot-family", text: bot.family }),
        element("span", { className: "bot-lane", text: bot.lane }),
      ]),
      element("div", { className: "bot-meta" }, [
        element("span", {
          className: `badge badge-${bot.status}`,
          text: bot.status,
          testId: `bot-status-${bot.id}`,
        }),
        element("span", { className: "bot-lease", text: lease === null ? "no lease" : `lease ${lease}` }),
        element("span", { className: "bot-quota", text: `quota ${formatQuota(bot)}` }),
      ]),
      element("div", { className: "quota-bar" }, [
        element("span", {
          className: "quota-fill",
          text: "",
          style: `width: ${Math.min(100, Math.max(0, bot.quotaUsedPct))}%`,
        }),
      ]),
      bot.sessionId === null
        ? element("span", {})
        : element("button", {
            className: "button button-small",
            text: "Show session",
            testId: `session-${bot.sessionId}`,
            onClick: () => {
              dispatch({ type: "session/selected", sessionId: bot.sessionId as string });
            },
          }),
    ]);
  }

  function renderStream(): void {
    const panel = document.getElementById("stream-panel");
    if (!panel) return;
    const alias = state.selectedHost;
    const sessions = selectHostSessions(state, alias);
    const session = state.selectedSession ? selectSession(state, state.selectedSession) : null;

    const children: Array<Node> = [element("h2", { className: "panel-title", text: "Session" })];
    if (sessions.length > 0) {
      children.push(
        element(
          "ul",
          { className: "session-list" },
          sessions.map((entry) =>
            element("li", {}, [
              element("button", {
                className: entry.id === state.selectedSession ? "chip chip-active" : "chip",
                text: entry.id,
                testId: `session-chip-${entry.id}`,
                onClick: () => {
                  dispatch({ type: "session/selected", sessionId: entry.id });
                },
              }),
            ]),
          ),
        ),
      );
    }

    if (!session) {
      children.push(element("p", { className: "empty", text: "No session yet. Connect a host to start one." }));
      panel.replaceChildren(...children);
      return;
    }

    children.push(
      element("div", { className: "stream-head" }, [
        element("span", { className: "stream-id", text: session.id }),
        element("span", { className: `badge badge-${session.status}`, text: session.status }),
        session.status === "running"
          ? element("button", {
              className: "button button-small button-danger",
              text: "Cancel task",
              testId: `cancel-${session.id}`,
              onClick: () => {
                void cancelSession(session.id);
              },
            })
          : element("span", {}),
      ]),
    );

    children.push(
      element(
        "ol",
        { className: "event-list" },
        session.events.map((event, index) => renderEvent(event, index, session.pendingPermissions)),
      ),
    );
    panel.replaceChildren(...children);
  }

  function renderEvent(event: BotEvent, index: number, pendingPermissions: PendingPermission[]): HTMLElement {
    const testId = `event-${index}`;
    if (event.kind === "text") {
      return element("li", { className: "event event-text", text: event.text, testId });
    }
    if (event.kind === "tool") {
      const summary = event.summary ? ` — ${event.summary}` : "";
      return element("li", {
        className: `event event-tool event-tool-${event.status}`,
        text: `${event.name} (${event.status})${summary}`,
        testId,
      });
    }
    if (event.kind === "permission") {
      const pending = pendingPermissions.some((entry) => entry.id === event.permissionId);
      return element("li", { className: "event event-permission", testId }, [
        element("span", { className: "event-title", text: event.title }),
        event.detail ? element("span", { className: "event-detail", text: event.detail }) : element("span", {}),
        pending
          ? element("div", { className: "event-actions" }, [
              element("button", {
                className: "button button-small button-primary",
                text: "Allow",
                testId: `perm-allow-${event.permissionId}`,
                onClick: () => {
                  void answerPermission(event.permissionId, true);
                },
              }),
              element("button", {
                className: "button button-small button-danger",
                text: "Deny",
                testId: `perm-deny-${event.permissionId}`,
                onClick: () => {
                  void answerPermission(event.permissionId, false);
                },
              }),
            ])
          : element("span", { className: "event-detail", text: "answered" }),
      ]);
    }
    return element("li", { className: "event event-turn", text: `turn ${event.status}`, testId });
  }

  /* ---------------------------------------------------------------- forms */

  function wireAddHost(): void {
    const button = document.getElementById("host-add");
    const dialog = document.getElementById("add-host-dialog") as HTMLDialogElement | null;
    const form = document.getElementById("add-host-form") as HTMLFormElement | null;
    const aliasInput = document.getElementById("host-alias") as HTMLInputElement | null;
    const labelInput = document.getElementById("host-label") as HTMLInputElement | null;
    const error = document.getElementById("host-add-error");
    if (!button || !dialog || !form || !aliasInput || !labelInput) return;

    button.addEventListener("click", () => {
      if (error) {
        error.hidden = true;
        error.textContent = "";
      }
      aliasInput.value = "";
      labelInput.value = "";
      dialog.showModal();
      aliasInput.focus();
    });

    form.addEventListener("submit", () => {
      const alias = aliasInput.value.trim();
      const label = labelInput.value.trim();
      void (async () => {
        try {
          const host = await client.addHost({ alias, label: label || undefined });
          dispatch({ type: "host/added", host });
          dispatch({ type: "host/selected", alias: host.alias });
          dialog.close();
          await refreshBots(host.alias);
        } catch (addError) {
          if (!error) return;
          error.hidden = false;
          error.textContent = messageOf(addError);
        }
      })();
    });
  }

  /* ----------------------------------------------------------------- boot */

  async function tick(): Promise<void> {
    dispatch({ type: "clock/tick", now: Date.now() });
    const alias = state.selectedHost;
    if (alias === null) return;
    const host = state.hosts.find((entry) => entry.alias === alias);
    if (!host || host.status !== "connected") return;
    await refreshBots(alias);
  }

  return {
    async mount(): Promise<void> {
      wireAddHost();
      dispatch({ type: "clock/tick", now: Date.now() });
      await loadHosts();
      if (pollMs > 0) {
        timer = setInterval(() => {
          void tick();
        }, pollMs);
      }
    },
    get state(): UiState {
      return state;
    },
    tick,
    destroy(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
    },
  };
}

/* -------------------------------------------------------------- DOM sugar */

interface ElementOptions {
  className?: string;
  text?: string;
  testId?: string;
  title?: string;
  style?: string;
  onClick?: () => void;
}

function element(
  tag: string,
  options: ElementOptions = {},
  children: Array<Node | string> = [],
): HTMLElement {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.testId) node.setAttribute("data-testid", options.testId);
  if (options.title) node.title = options.title;
  if (options.style) node.setAttribute("style", options.style);
  if (options.onClick) node.addEventListener("click", options.onClick);
  for (const child of children) node.append(child);
  return node;
}
