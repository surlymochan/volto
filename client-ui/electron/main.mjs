import { app, BrowserWindow, shell } from "electron";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startRelay } from "../relay.mjs";
import { ensureHostsFile, parseHosts } from "./paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let relay;

function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") void shell.openExternal(parsed.href);
  } catch { /* Ignore invalid URLs. */ }
}

async function createWindow() {
  const hostsFile = ensureHostsFile(fs, app.getPath("userData"));
  const hosts = parseHosts(fs.readFileSync(hostsFile, "utf8"));
  relay = await startRelay({ hosts, port: 0 });
  const origin = new URL(relay.url).origin;
  const window = new BrowserWindow({
    webPreferences: {
      preload: join(here, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const guardNavigation = (event, url) => {
    let allowed = false;
    try { allowed = new URL(url).origin === origin; } catch { /* Block invalid URLs. */ }
    if (!allowed) { event.preventDefault(); openExternal(url); }
  };
  window.webContents.on("will-frame-navigate", guardNavigation);
  window.webContents.on("will-redirect", guardNavigation);
  window.webContents.setWindowOpenHandler(({ url }) => {
    try { if (new URL(url).origin !== origin) openExternal(url); } catch { /* Block invalid URLs. */ }
    return { action: "deny" };
  });
  await window.loadURL(relay.url);
}

app.whenReady().then(createWindow).catch(error => {
  console.error("Unable to start the panel:", error);
  app.quit();
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  if (relay) {
    relay.server.closeAllConnections();
    relay.server.close();
    relay = undefined;
  }
});
