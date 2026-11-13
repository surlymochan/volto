// volto client UI: the browser entry point of the "Remote bots" panel.
//
// The panel itself lives in panel.ts and knows nothing about which client it
// talks to. Here the real client (src/real-client.ts) talks to the relay
// that runs next to the panel; the mock client (src/mock-client.ts) stands in
// for the relay when the page is opened with `?mock=1`, so the view can be
// worked on without a daemon.
//
// The page is loaded by index.html, which imports `boot` from this module.

import { MockBotdClient } from "./mock-client.ts";
import { RealBotdClient } from "./real-client.ts";
import { createPanel } from "./panel.ts";
import { initialState, reduce } from "./state.ts";
import type { BotdClient } from "./client.ts";
import type { Panel } from "./panel.ts";

/** The message shown when the relay does not answer. */
export const RELAY_UNREACHABLE = "relay unreachable";

/**
 * Picks the client the query string asks for.
 *
 * The relay is the default: the panel talks to a real daemon unless the
 * page is opened with `?mock=1`. The `relay` parameter names the relay the
 * panel talks to when it does not sit next to the page.
 */
export function selectClient(search: string): BotdClient {
  if (new URLSearchParams(search).get("mock") === "1") {
    return new MockBotdClient({ hosts: [{ alias: "workstation", label: "main box" }] });
  }
  return new RealBotdClient({ search });
}

/**
 * Boots the panel.
 *
 * The panel is mounted with the client the query string asks for. When the
 * relay does not answer, the page says so instead of showing an empty
 * panel: the relay is the one thing the panel needs to work.
 */
export async function boot(search: string = currentSearch()): Promise<Panel | null> {
  const client = selectClient(search);
  const panel = createPanel({ client });
  try {
    await panel.mount();
  } catch (error) {
    showRelayUnreachable(error);
    return panel;
  }
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => {
      panel.destroy();
    });
  }
  return panel;
}

/**
 * Shows that the relay does not answer.
 *
 * The state of the panel knows an error line (the `error/set` action of
 * state.ts), so the message is built with the same reducer the panel uses
 * and written into the status line of the page.
 */
export function showRelayUnreachable(error: unknown): string {
  const message = unreachableMessage(error);
  const state = reduce(initialState(), { type: "error/set", message });
  const line = document.getElementById("status-line");
  if (line) {
    line.textContent = state.error ?? message;
    line.className = "sidebar-sub sidebar-sub-error";
  }
  const bots = document.getElementById("bots-panel");
  if (bots) bots.textContent = message;
  return message;
}

/** The message of an error, whatever it is. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The message that names the relay as the thing that is missing. */
function unreachableMessage(error: unknown): string {
  const detail = messageOf(error);
  return detail.includes(RELAY_UNREACHABLE) ? detail : `${RELAY_UNREACHABLE} — ${detail}`;
}

/** The query string of the page, when there is one. */
function currentSearch(): string {
  return typeof location === "undefined" ? "" : location.search;
}
