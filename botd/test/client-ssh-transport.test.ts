import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { spawnTransport, sshArgs, sshTransport } from "../src/client.ts";

function fakeSsh(t: import("node:test").TestContext) {
  mkdirSync(".tmp", { recursive: true });
  const dir = mkdtempSync(path.join(".tmp", "ssh-transport-"));
  writeFileSync(path.join(dir, "ssh"), `#!${process.execPath}
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => process.stdout.write(chunk));
`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${path.resolve(dir)}${path.delimiter}${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("sshArgs preserves an alias containing spaces as one argument", () => {
  assert.deepEqual(sshArgs("alias with spaces"), [
    "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15",
    "alias with spaces", "botd", "serve",
  ]);
});

test("sshArgs preserves a leading dash in one argument", () => {
  assert.equal(sshArgs("-alias")[4], "-alias");
  assert.equal(sshArgs("-alias").length, 7);
});

test("sshArgs protects a leading-dash alias from SSH option parsing", { todo: "sshArgs places the alias where ssh can parse it as an option" }, () => {
  assert.ok(sshArgs("-alias").includes("--"));
});

test("sshTransport passes the exact arguments to ssh", async (t) => {
  fakeSsh(t);
  const transport = sshTransport("alias with spaces");
  t.after(() => transport.kill());
  const lines = createInterface({ input: transport.stdout })[Symbol.asyncIterator]();
  assert.deepEqual(JSON.parse((await lines.next()).value), {
    argv: ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "alias with spaces", "botd", "serve"],
  });
});

test("sshTransport exchanges multiple frames over stdin and stdout", async (t) => {
  fakeSsh(t);
  const transport = sshTransport("alias-a");
  t.after(() => transport.kill());
  const lines = createInterface({ input: transport.stdout })[Symbol.asyncIterator]();
  await lines.next();
  const frames = [{ op: "first", value: 1 }, { op: "second", value: "sample" }];
  for (const frame of frames) transport.stdin.write(`${JSON.stringify(frame)}\n`);
  assert.deepEqual(JSON.parse((await lines.next()).value), frames[0]);
  assert.deepEqual(JSON.parse((await lines.next()).value), frames[1]);
});

test("sshTransport kill ends stdin and terminates the child", { timeout: 5000 }, async (t) => {
  fakeSsh(t);
  const transport = sshTransport("alias-a");
  t.after(() => transport.kill());
  const lines = createInterface({ input: transport.stdout })[Symbol.asyncIterator]();
  assert.deepEqual(JSON.parse((await lines.next()).value).argv, sshArgs("alias-a"));
  const closed = new Promise<void>((resolve) => transport.stdout.once("close", resolve));
  transport.kill();
  assert.equal(transport.stdin.writableEnded, true);
  await closed;
});

test("spawnTransport installs handlers on its exposed streams", async () => {
  const transport = spawnTransport(process.execPath, ["-e", "process.stdin.resume()"]);
  assert.ok(transport.stdin.listenerCount("error") > 0);
  assert.ok(transport.stdout.listenerCount("error") > 0);
  const closed = new Promise<void>((resolve) => transport.stdout.once("close", resolve));
  transport.kill();
  await closed;
});

test("spawnTransport kill can be called twice", async () => {
  const transport = spawnTransport(process.execPath, ["-e", "process.stdin.resume()"]);
  const closed = new Promise<void>((resolve) => transport.stdout.once("close", resolve));
  assert.doesNotThrow(() => { transport.kill(); transport.kill(); });
  await closed;
});

test("spawnTransport handles a nonexistent command without an unhandled error", { todo: "the ChildProcess error event has no handler" }, () => {
  const client = pathToFileURL(path.resolve("botd/src/client.ts")).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { spawnTransport } from ${JSON.stringify(client)}; spawnTransport('.tmp/nonexistent-command', []);`,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
