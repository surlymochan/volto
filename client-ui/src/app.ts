// volto client UI: the browser entry point of the "Remote bots" panel.
//
// The panel itself lives in panel.ts and knows nothing about which client it
// talks to. Here the mock client stands in for the daemon; the real daemon
// client replaces this one line later.

import { MockBotdClient } from "./mock-client.ts";
import { createPanel } from "./panel.ts";

const client = new MockBotdClient({ hosts: [{ alias: "workstation", label: "main box" }] });

const panel = createPanel({ client });

void panel.mount();

window.addEventListener("beforeunload", () => {
  panel.destroy();
});
