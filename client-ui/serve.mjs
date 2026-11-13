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

/** The methods the panel answers to. */
const ALLOWED_METHODS = "GET, HEAD";

/**
 * Parses --port <port>; the default is a random free port.
 *
 * Throws when the value is not a port number, so the caller can report it
 * and stop with a clear message.
 */
export function parsePort(argv) {
  const index = argv.indexOf("--port");
  if (index === -1) return 0;
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error("--port needs a port number");
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`invalid port: ${value}`);
  }
  const port = Number(value);
  if (port > 65535) {
    throw new Error(`invalid port: ${value} (the highest port is 65535)`);
  }
  return port;
}

/**
 * Turns the request target into the path of the panel.
 *
 * Returns null when the target is malformed or tries to leave the panel: a
 * path with a NUL byte, a backslash or a ".." segment is not a path of the
 * panel at all.
 */
function decodePath(target) {
  const raw = target.split("#")[0].split("?")[0];
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  if (decoded.split("/").some((segment) => segment === "..")) return null;
  return decoded;
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

/** True when the file of the panel is not there. */
function isMissing(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Removes the file system paths from a message that goes to the browser.
 *
 * The panel is a local dev server, but a path of the machine is of no use
 * to the browser and does not belong in a response.
 */
function sanitize(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .split(here)
    .join("<panel>")
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"]+/g, "<path>");
}

/** Answers with a plain text body. */
function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(body);
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
      const method = request.method ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        send(response, 405, "method not allowed\n", { allow: ALLOWED_METHODS });
        return;
      }

      const pathname = decodePath(request.url ?? "/");
      if (pathname === null) {
        send(response, 400, "bad request\n");
        return;
      }

      const file = resolveFile(pathname);
      if (!file) {
        send(response, 404, "not found\n");
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
        if (isMissing(error)) {
          send(response, 404, "not found\n");
          return;
        }
        send(response, 500, `cannot serve ${pathname}: ${sanitize(error)}\n`);
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
  let port;
  try {
    port = parsePort(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `remote bots panel: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  }
  const { url } = await startServer({ port });
  process.stdout.write(`remote bots panel: ${url}\n`);
}
