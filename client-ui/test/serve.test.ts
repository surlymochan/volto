// Tests for the static server of the panel.
//
// The server turns the TypeScript modules into plain JavaScript on the fly,
// so the browser can load them without a bundler.

import assert from "node:assert/strict";
import test from "node:test";

import { createTranspiler, rewriteSpecifiers } from "../transpile.mjs";

const transpiler = createTranspiler();

/** Fetches a path from the server under test. */
async function get(url: string, path: string): Promise<{ status: number; type: string; body: string }> {
  const response = await fetch(new URL(path, url));
  return {
    status: response.status,
    type: response.headers.get("content-type") ?? "",
    body: await response.text(),
  };
}

/** Starts the server, runs `body` and stops the server again. */
async function withServer(body: (url: string) => Promise<void>): Promise<void> {
  const { startServer } = await import("../serve.mjs");
  const { server, url } = await startServer();
  try {
    await body(url);
  } finally {
    server.close();
  }
}

test("the import specifiers are rewritten to .js", () => {
  const rewritten = rewriteSpecifiers('import { a } from "./state.ts";\nimport "./b.ts";');
  assert.match(rewritten, /from "\.\/state\.js"/);
  assert.match(rewritten, /import "\.\/b\.js"/);
});

test("only relative specifiers are rewritten", () => {
  const source = 'const pattern = /from "\\.\\/x\\.ts"/;\nimport "node:fs";';
  assert.equal(rewriteSpecifiers(source), source);
});

test("a runtime without type stripping is detected", () => {
  // The helper either finds a working transpiler or reports none; both are
  // valid, but it must never throw.
  const found = createTranspiler();
  assert.ok(found === null || typeof found === "function");
});

test("the page is served", { skip: transpiler ? false : "no TypeScript stripping available" }, async () => {
  await withServer(async (url) => {
    const page = await get(url, "/");
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.body, /data-testid="host-add"/);
    assert.match(page.body, /Remote bots/);
  });
});

test("the stylesheet is served", { skip: transpiler ? false : "no TypeScript stripping available" }, async () => {
  await withServer(async (url) => {
    const css = await get(url, "/styles.css");
    assert.equal(css.status, 200);
    assert.match(css.type, /text\/css/);
    assert.match(css.body, /prefers-color-scheme/);
  });
});

test("the modules are served as JavaScript", { skip: transpiler ? false : "no TypeScript stripping available" }, async () => {
  await withServer(async (url) => {
    const app = await get(url, "/src/app.js");
    assert.equal(app.status, 200);
    assert.match(app.type, /javascript/);
    assert.doesNotMatch(app.body, /:\s*BotdClient/, "the types are stripped");
    assert.doesNotMatch(app.body, /from "\.\/[\w-]+\.ts"/, "the specifiers point at .js");

    const state = await get(url, "/src/state.js");
    assert.equal(state.status, 200);
    assert.match(state.body, /export function reduce/);
  });
});

test("unknown paths are not found", { skip: transpiler ? false : "no TypeScript stripping available" }, async () => {
  await withServer(async (url) => {
    const missing = await get(url, "/nope");
    assert.equal(missing.status, 404);
  });
});
