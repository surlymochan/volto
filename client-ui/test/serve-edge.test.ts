// Edge tests for the dev server of the panel and for its transpiler.
//
// serve.test.ts covers the happy path of the server. The tests here cover
// the edges: paths that try to leave the panel, methods that are not
// allowed, sources that do not compile, the command line of the server and
// the specifier rewriting of the transpiler.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createTranspiler, rewriteSpecifiers } from "../transpile.mjs";

const transpiler = createTranspiler();
const skip = transpiler ? false : "no TypeScript stripping available";

const panelDir = path.resolve(import.meta.dirname, "..");
const serveScript = path.join(panelDir, "serve.mjs");

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Sends a request with the path exactly as it is written.
 *
 * `fetch` normalizes a path before it leaves the process, so the traversal
 * attempts have to go out raw.
 */
function rawRequest(port: number, target: string, method = "GET"): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: target, method }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

/** Starts the panel server on a free port. */
async function startPanel(): Promise<{ port: number; close: () => Promise<void> }> {
  const { startServer } = await import("../serve.mjs");
  const { server, port } = await startServer({ port: 0 });
  return {
    port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Starts the panel server, runs `body` and stops the server again. */
async function withPanel(body: (port: number) => Promise<void>): Promise<void> {
  const panel = await startPanel();
  try {
    await body(panel.port);
  } finally {
    await panel.close();
  }
}

/** True when something listens on the address. */
function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(1500, () => done(false));
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}

/** Runs the server as a child process and collects its output. */
function runServer(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serveScript, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("a path that climbs out of the panel is refused", async () => {
  await withPanel(async (port) => {
    const response = await rawRequest(port, "/../package.json");
    assert.ok(response.status === 400 || response.status === 404, `status ${response.status}`);
    assert.doesNotMatch(response.body, /surlymochan/);
  });
});

test("an encoded climb out of the panel is refused", async () => {
  await withPanel(async (port) => {
    const response = await rawRequest(port, "/%2e%2e/package.json");
    assert.ok(response.status === 400 || response.status === 404, `status ${response.status}`);
    assert.doesNotMatch(response.body, /surlymochan/);
  });
});

test("an encoded climb that ends in a slash is refused", async () => {
  await withPanel(async (port) => {
    const response = await rawRequest(port, "/%2e%2e/");
    assert.ok(response.status === 400 || response.status === 404, `status ${response.status}`);
    assert.doesNotMatch(response.body, /<html/i);
  });
});

test("a climb out of the module directory is refused", async () => {
  await withPanel(async (port) => {
    const response = await rawRequest(port, "/src/../../package.json");
    assert.ok(response.status === 400 || response.status === 404, `status ${response.status}`);
    assert.doesNotMatch(response.body, /surlymochan/);
  });
});

test("an encoded slash does not open a hole", async () => {
  await withPanel(async (port) => {
    const response = await rawRequest(port, "/src%2f..%2f..%2fpackage.json");
    assert.ok(response.status === 400 || response.status === 404, `status ${response.status}`);
    assert.doesNotMatch(response.body, /surlymochan/);
  });
});

test("an encoded NUL byte is refused", async () => {
  await withPanel(async (port) => {
    const response = await rawRequest(port, "/src/app.js%00.png");
    assert.ok(response.status === 400 || response.status === 404, `status ${response.status}`);
    assert.doesNotMatch(response.body, /volto client UI/);
  });
});

test("a backslash is refused", async () => {
  await withPanel(async (port) => {
    const response = await rawRequest(port, "/..\\package.json");
    assert.ok(response.status === 400 || response.status === 404, `status ${response.status}`);
    assert.doesNotMatch(response.body, /surlymochan/);
  });
});

test("a malformed escape is refused", async () => {
  await withPanel(async (port) => {
    const response = await rawRequest(port, "/src/%zz.js");
    assert.ok(response.status === 400 || response.status === 404, `status ${response.status}`);
  });
});

test("the files outside the panel are never served", async () => {
  await withPanel(async (port) => {
    const response = await rawRequest(port, "/../botd/PROTOCOL.md");
    assert.ok(response.status === 400 || response.status === 404, `status ${response.status}`);
    assert.doesNotMatch(response.body, /NDJSON/);
    assert.doesNotMatch(response.body, /duplex byte stream/);
  });
});

test("only GET and HEAD are allowed", async () => {
  await withPanel(async (port) => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const response = await rawRequest(port, "/", method);
      assert.equal(response.status, 405, `${method} is refused`);
      assert.match(String(response.headers.allow ?? ""), /GET/);
      assert.match(String(response.headers.allow ?? ""), /HEAD/);
    }
  });
});

test("a HEAD request answers with the headers but without a body", async () => {
  await withPanel(async (port) => {
    const response = await rawRequest(port, "/src/app.js", "HEAD");
    assert.equal(response.status, 200);
    assert.equal(response.body, "");
    assert.match(String(response.headers["content-type"] ?? ""), /javascript/);
  });
});

test("a missing module is not found", async () => {
  await withPanel(async (port) => {
    const response = await rawRequest(port, "/src/missing.js");
    assert.equal(response.status, 404);
    assert.doesNotMatch(response.body, /ENOENT/);
    assert.doesNotMatch(response.body, new RegExp(panelDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("a source file is not served as it is", async () => {
  await withPanel(async (port) => {
    for (const target of ["/src/app.ts", "/src/missing.ts"]) {
      const response = await rawRequest(port, target);
      assert.equal(response.status, 404, `${target} is not served`);
      assert.doesNotMatch(response.body, /volto client UI/);
    }
  });
});

test("a module that does not compile is reported without file system paths", { skip }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "volto-panel-"));
  try {
    await copyFile(serveScript, path.join(dir, "serve.mjs"));
    await copyFile(path.join(panelDir, "transpile.mjs"), path.join(dir, "transpile.mjs"));
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "broken.ts"), "export const value: = ;\n");

    const { startServer } = await import(pathToFileURL(path.join(dir, "serve.mjs")).href);
    const { server, port } = await startServer({ port: 0 });
    try {
      const response = await rawRequest(port, "/src/broken.js");
      assert.equal(response.status, 500);
      assert.match(String(response.headers["content-type"] ?? ""), /text\/plain/);
      assert.doesNotMatch(response.body, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(response.body, /\/(?:tmp|root|home|var)\//);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the modules are served as JavaScript and are never cached", { skip }, async () => {
  await withPanel(async (port) => {
    const response = await rawRequest(port, "/src/app.js");
    assert.equal(response.status, 200);
    assert.match(String(response.headers["content-type"] ?? ""), /javascript/);
    assert.equal(response.headers["cache-control"], "no-store");
  });
});

test("the page and the stylesheet are served with their own type", async () => {
  await withPanel(async (port) => {
    const page = await rawRequest(port, "/");
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-type"] ?? ""), /text\/html/);
    assert.equal(page.headers["cache-control"], "no-store");

    const css = await rawRequest(port, "/styles.css");
    assert.equal(css.status, 200);
    assert.match(String(css.headers["content-type"] ?? ""), /text\/css/);
    assert.equal(css.headers["cache-control"], "no-store");
  });
});

test("the server listens on the loopback interface only", async () => {
  const { startServer } = await import("../serve.mjs");
  const { server, port } = await startServer({ port: 0 });
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.equal(address?.address, "127.0.0.1");
    assert.equal(address?.family, "IPv4");

    const outside = Object.values(os.networkInterfaces())
      .flat()
      .filter((entry) => entry && entry.family === "IPv4" && !entry.internal);
    for (const entry of outside) {
      assert.equal(await canConnect(entry.address, port), false, `${entry.address} is not reachable`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("--port with a value that is not a number exits with 2", async () => {
  const result = await runServer(["--port", "abc"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /port/i);
  assert.doesNotMatch(result.stderr, /at parsePort/);
});

test("--port without a value exits with 2", async () => {
  const result = await runServer(["--port"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--port/);
});

test("--port above the maximum exits with 2", async () => {
  const result = await runServer(["--port", "65536"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /port/i);
});

test("--port below zero exits with 2", async () => {
  const result = await runServer(["--port", "-1"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /port/i);
});

test("--port 0 starts the panel on a free port", async () => {
  const child = spawn(process.execPath, [serveScript, "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(() => reject(new Error("the server did not report a url")), 10_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(stdout);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      child.on("error", reject);
    });
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    await response.text();
  } finally {
    child.kill("SIGTERM");
  }
});

test("a side effect import is rewritten", () => {
  assert.equal(rewriteSpecifiers('import "./side.ts";'), 'import "./side.js";');
});

test("an export star is rewritten", () => {
  assert.equal(rewriteSpecifiers('export * from "./star.ts";'), 'export * from "./star.js";');
});

test("a dynamic import is rewritten", () => {
  assert.equal(
    rewriteSpecifiers('const module = await import("./dynamic.ts");'),
    'const module = await import("./dynamic.js");',
  );
});

test("an import in a string is left alone", () => {
  const source = 'const text = "import \\"./string.ts\\"";';
  assert.equal(rewriteSpecifiers(source), source);
});

test("an import in a comment is left alone", () => {
  const source = '// import "./comment.ts"\n/* from "./block.ts" */\n';
  assert.equal(rewriteSpecifiers(source), source);
});

test("an import in a regular expression is left alone", () => {
  const source = 'const pattern = /from "\\.\\/x\\.ts"/;\n';
  assert.equal(rewriteSpecifiers(source), source);
});

test("a specifier that already points at .js is left alone", () => {
  const source = 'import "./already.js";\nimport { a } from "./other.js";\n';
  assert.equal(rewriteSpecifiers(source), source);
});

test("a bare specifier is left alone", () => {
  const source = 'import "node:fs";\nimport "https://example.com/x.ts";\n';
  assert.equal(rewriteSpecifiers(source), source);
});
