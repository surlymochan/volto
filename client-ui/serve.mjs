#!/usr/bin/env node
// client-ui/serve.mjs
//
// Serves the "Remote bots" panel on a random local port.
//
// The panel is a single HTML page plus the TypeScript modules under src/.
// There is no bundler: every module is transpiled to plain JavaScript on
// request and served on its own, so the browser loads exactly the modules the
// sources mention.
//
// Usage: node client-ui/serve.mjs [--port <port>]

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTranspiler, rewriteSpecifiers } from "./transpile.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
]);

/** Parses --port <port>; the default is a random free port. */
function parsePort(argv) {
  const index = argv.indexOf("--port");
  if (index === -1) return 0;
  const port = Number(argv[index + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port: ${argv[index + 1]}`);
  }
  return port;
}

/**
 * Resolves a request path to a file of the panel.
 *
 * Returns null when the path does not belong to the panel.
 */
function resolveFile(pathname) {
  if (pathname === "/" || pathname === "/index.html") {
    return { path: join(here, "index.html"), type: ".html" };
  }
  if (pathname === "/styles.css") {
    return { path: join(here, "styles.css"), type: ".css" };
  }
  const match = /^\/src\/([A-Za-z0-9_-]+)\.js$/.exec(pathname);
  if (match) {
    // The sources are TypeScript; the browser asks for the .js name.
    return { path: join(here, "src", `${match[1]}.ts`), type: ".js" };
  }
  return null;
}

/** Starts the panel server. */
export async function startServer({ port = 0, host = "127.0.0.1" } = {}) {
  const transpile = createTranspiler();
  if (!transpile) {
    throw new Error(
      "this runtime cannot strip TypeScript types; use Node 24 (or install bun) to serve the panel",
    );
  }

  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const file = resolveFile(pathname);
      if (!file) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("not found\n");
        return;
      }
      try {
        let body;
        if (file.type === ".js") {
          const source = await readFile(file.path, "utf8");
          body = rewriteSpecifiers(transpile(source));
        } else {
          body = await readFile(file.path, "utf8");
        }
        response.writeHead(200, {
          "content-type": CONTENT_TYPES.get(file.type) ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        response.end(body);
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end(`cannot serve ${pathname}: ${error instanceof Error ? error.message : error}\n`);
      }
    })();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  return { server, port: boundPort, url: `http://${host}:${boundPort}/` };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { url } = await startServer({ port: parsePort(process.argv.slice(2)) });
  process.stdout.write(`remote bots panel: ${url}\n`);
}
