#!/usr/bin/env node
// client-ui/smoke.mjs
//
// Browser smoke test of the "Remote bots" panel: it adds a host, connects
// to it, waits for events to stream in and cancels the running task.
//
// Playwright is optional. When it is not installed the script says so and
// exits successfully, so the rest of the suite is not blocked by it.
//
// Usage: node client-ui/smoke.mjs

import { startServer } from "./serve.mjs";

/** Loads Playwright, or returns null when it is not installed. */
async function loadPlaywright() {
  try {
    const module = await import("playwright");
    return module.chromium ? module : null;
  } catch {
    return null;
  }
}

const playwright = await loadPlaywright();
if (!playwright) {
  process.stdout.write("smoke: playwright is not installed — skipping the browser smoke test\n");
  process.exit(0);
}

const { chromium } = playwright;
const { server, url } = await startServer();
const browser = await chromium.launch();
let failures = 0;

function check(condition, description) {
  if (condition) {
    process.stdout.write(`smoke: ok — ${description}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`smoke: FAILED — ${description}\n`);
}

try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "load" });

  // The panel starts with one seeded host.
  await page.waitForSelector('[data-testid="host-workstation"]');

  // Add a host through the dialog.
  await page.click('[data-testid="host-add"]');
  await page.fill('[data-testid="host-alias-input"]', "alpha");
  await page.fill('[data-testid="host-label-input"]', "smoke box");
  await page.click('[data-testid="host-add-submit"]');
  await page.waitForSelector('[data-testid="host-alpha"]');
  check(true, "the host was added");

  // Connect to it.
  await page.click('[data-testid="connect-alpha"]');
  await page.waitForSelector('[data-testid^="bot-alpha-bot-"]');
  check(true, "the bots of the host are listed");

  // The busy bot shows up with its status.
  await page.waitForSelector('[data-testid="bot-status-alpha-bot-1"]');
  const status = await page.textContent('[data-testid="bot-status-alpha-bot-1"]');
  check(status === "busy", `the busy bot reports its status (${status})`);

  // Events stream in.
  await page.waitForSelector('[data-testid^="event-"]', { timeout: 5000 });
  check(true, "events arrive");

  // A permission request shows up with Allow and Deny.
  await page.waitForSelector('[data-testid^="perm-allow-"]', { timeout: 5000 });
  check(true, "a permission request can be answered");

  // Cancelling the task ends the turn.
  const cancel = await page.$('[data-testid^="cancel-"]');
  check(cancel !== null, "the running task can be cancelled");
  if (cancel) {
    await cancel.click();
    await page.waitForSelector('[data-testid^="event-"][class*="event-turn"]', { timeout: 5000 });
    const turn = await page.textContent('[data-testid^="event-"][class*="event-turn"]');
    check((turn ?? "").includes("cancelled"), `the turn ends as cancelled (${turn})`);
  }
} catch (error) {
  failures += 1;
  process.stdout.write(`smoke: FAILED — ${error instanceof Error ? error.message : error}\n`);
} finally {
  await browser.close();
  server.close();
}

process.exit(failures === 0 ? 0 : 1);
