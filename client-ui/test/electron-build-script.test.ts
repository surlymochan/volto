// Tests of scripts/electron-build.sh: the argument check, the Node check, the
// signing identity and the notarization credential validation.
//
// Nothing is signed, notarized or installed here. The script is copied into a
// scratch tree and runs with a PATH that holds a fake node, a fake npm and (the
// fake npm creates it) a fake electron-builder. The fakes record every call in
// a log, so the tests can tell what the script would have handed to the
// builder. The environment is built from scratch: no credential of the
// developer reaches the script, and the credentials below are made up.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const script = path.join(repoRoot, "scripts", "electron-build.sh");
const skip = process.platform === "win32" ? "the build script needs bash" : false;

const IDENTITY = "Developer ID Application: Test Org (TEST000000)";
const CREDENTIALS = {
  VOLTO_MAC_IDENTITY: IDENTITY,
  APPLE_ID: "builder@example.test",
  APPLE_APP_SPECIFIC_PASSWORD: "test-app-specific-password-0000",
  APPLE_TEAM_ID: "TEST000000",
};

const scratch = mkdtempSync(path.join(os.tmpdir(), "electron-build-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A scratch tree with a copy of the script, a fake shell entry point and the fakes on PATH. */
function makeTree(name: string, options: { mainJs?: boolean } = {}) {
  const root = path.join(scratch, name);
  const bin = path.join(root, "bin");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "client-ui", "electron"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(script, path.join(root, "scripts", "electron-build.sh"));
  if (options.mainJs !== false) writeFileSync(path.join(root, "client-ui", "electron", "main.js"), "");
  const log = path.join(root, "calls.log");
  writeFileSync(log, "");

  writeFileSync(
    path.join(bin, "node"),
    [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) echo "$STUB_NODE_VERSION" ;;',
      "  -p) echo 33.0.0 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(bin, "npm"),
    [
      "#!/bin/sh",
      'echo "npm $*" >> "$STUB_LOG"',
      'prefix=""',
      'while [ "$#" -gt 0 ]; do [ "$1" = --prefix ] && prefix=$2; shift; done',
      'mkdir -p "$prefix/node_modules/.bin"',
      "cat > \"$prefix/node_modules/.bin/electron-builder\" <<'EOF'",
      "#!/bin/sh",
      'echo "builder $*" >> "$STUB_LOG"',
      'echo "csc=${CSC_IDENTITY_AUTO_DISCOVERY-unset}" >> "$STUB_LOG"',
      "EOF",
      'chmod +x "$prefix/node_modules/.bin/electron-builder"',
      "",
    ].join("\n"),
  );
  chmodSync(path.join(bin, "node"), 0o755);
  chmodSync(path.join(bin, "npm"), 0o755);
  return { root, bin, log, script: path.join(root, "scripts", "electron-build.sh") };
}

/** Runs the copy of the script with only the fakes, the system tools and the given variables. */
function run(
  tree: ReturnType<typeof makeTree>,
  args: string[],
  env: Record<string, string> = {},
  nodeVersion = "v24.1.0",
) {
  const result = spawnSync("bash", [tree.script, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${tree.bin}:/usr/bin:/bin`,
      HOME: tree.root,
      STUB_LOG: tree.log,
      STUB_NODE_VERSION: nodeVersion,
      ...env,
    },
  });
  const calls = readFileSync(tree.log, "utf8").split("\n").filter((line) => line !== "");
  const builder = calls.find((line) => line.startsWith("builder ")) ?? null;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    calls,
    builder,
    csc: calls.find((line) => line.startsWith("csc=")) ?? null,
  };
}

test("the script needs exactly one of --dir and --dmg", { skip }, () => {
  const tree = makeTree("args");
  for (const args of [[], ["--zip"], ["--dir", "--dmg"]]) {
    const result = run(tree, args);
    assert.equal(result.status, 1, `arguments ${JSON.stringify(args)}`);
    assert.match(result.stderr, /Usage:/);
    assert.deepEqual(result.calls, [], "nothing is installed or built");
  }
});

test("a Node older than 24 is refused before anything is installed", { skip }, () => {
  const tree = makeTree("node-old");
  const result = run(tree, ["--dir"], {}, "v22.11.0");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Node >= 24 is required/);
  assert.deepEqual(result.calls, []);
});

test("a missing Electron entry point is refused before anything is installed", { skip }, () => {
  const tree = makeTree("no-main", { mainJs: false });
  const result = run(tree, ["--dir"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing Electron entry point/);
  assert.deepEqual(result.calls, []);
});

test("--dir builds an unpacked arm64 app, --dmg builds an arm64 dmg", { skip }, () => {
  const dir = run(makeTree("mode-dir"), ["--dir"]);
  assert.equal(dir.status, 0, dir.stderr);
  assert.ok(dir.builder?.includes("--mac --arm64 --dir"), `builder arguments: ${dir.builder}`);
  assert.ok(dir.builder?.includes("--config.electronVersion=33.0.0"), "the installed Electron version is pinned");

  const dmg = run(makeTree("mode-dmg"), ["--dmg"]);
  assert.equal(dmg.status, 0, dmg.stderr);
  assert.ok(dmg.builder?.includes("--mac dmg --arm64"), `builder arguments: ${dmg.builder}`);
});

test("without an identity the build is unsigned and says how to open it", { skip }, () => {
  for (const env of [{}, { VOLTO_NOTARIZE: "0" }]) {
    const result = run(makeTree("unsigned"), ["--dir"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.builder?.includes("--config.mac.identity"), "no identity is handed to the builder");
    assert.ok(!result.builder?.includes("notarize"), "no notarization");
    assert.equal(result.csc, "csc=false", "the identity auto discovery is switched off");
    assert.match(result.stdout, /right-click the app, choose Open/);
  }
});

test("an identity signs the build and keeps the auto discovery of the builder untouched", { skip }, () => {
  const result = run(makeTree("signed"), ["--dmg"], { VOLTO_MAC_IDENTITY: IDENTITY });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.builder?.includes(`--config.mac.identity=${IDENTITY}`), `builder arguments: ${result.builder}`);
  assert.ok(!result.builder?.includes("notarize"), "no notarization without VOLTO_NOTARIZE");
  assert.equal(result.csc, "csc=unset", "the auto discovery variable is not set for a signed build");
  assert.doesNotMatch(result.stdout, /right-click the app/, "a signed build needs no first open hint");
});

test("VOLTO_NOTARIZE=1 without any credential is refused before anything is installed", { skip }, () => {
  const result = run(makeTree("notarize-none"), ["--dmg"], { VOLTO_NOTARIZE: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Notarization requires VOLTO_MAC_IDENTITY, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID/);
  assert.deepEqual(result.calls, [], "neither npm nor the builder ran");
});

test("VOLTO_NOTARIZE=1 is refused when any one of the four credentials is missing", { skip }, () => {
  for (const missing of Object.keys(CREDENTIALS)) {
    const env: Record<string, string> = { ...CREDENTIALS, VOLTO_NOTARIZE: "1" };
    delete env[missing];
    const result = run(makeTree(`notarize-no-${missing}`), ["--dmg"], env);
    assert.equal(result.status, 1, `without ${missing}`);
    assert.match(result.stderr, /Notarization requires/, `without ${missing}`);
    assert.deepEqual(result.calls, [], `without ${missing}: neither npm nor the builder ran`);

    // an empty value is as good as a missing one
    const empty = run(makeTree(`notarize-empty-${missing}`), ["--dmg"], { ...env, [missing]: "" });
    assert.equal(empty.status, 1, `with an empty ${missing}`);
    assert.deepEqual(empty.calls, []);
  }
});

test("VOLTO_NOTARIZE=1 with every credential notarizes and never prints the password", { skip }, () => {
  const result = run(makeTree("notarize-ok"), ["--dmg"], { ...CREDENTIALS, VOLTO_NOTARIZE: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.builder?.includes("--config.mac.notarize=true"), `builder arguments: ${result.builder}`);
  assert.ok(result.builder?.includes(`--config.mac.identity=${IDENTITY}`));
  const everything = [result.stdout, result.stderr, ...result.calls].join("\n");
  assert.ok(!everything.includes(CREDENTIALS.APPLE_APP_SPECIFIC_PASSWORD), "the password stays in the environment");
  assert.ok(!everything.includes(CREDENTIALS.APPLE_ID), "the Apple ID stays in the environment");
});

test("VOLTO_NOTARIZE accepts only 0 and 1", { skip }, () => {
  for (const value of ["2", "true", "yes", "-1", " 1"]) {
    const result = run(makeTree("notarize-bad"), ["--dmg"], { ...CREDENTIALS, VOLTO_NOTARIZE: value });
    assert.equal(result.status, 1, `VOLTO_NOTARIZE=${JSON.stringify(value)}`);
    assert.match(result.stderr, /VOLTO_NOTARIZE must be 0 or 1/);
    assert.deepEqual(result.calls, [], "neither npm nor the builder ran");
  }
});

test("the temporary build directory is removed again", { skip }, () => {
  const tree = makeTree("cleanup");
  const result = run(tree, ["--dir"]);
  assert.equal(result.status, 0, result.stderr);
  const install = result.calls.find((line) => line.startsWith("npm install"));
  assert.ok(install, "the fake npm saw the install");
  const prefix = /--prefix (\S+)/.exec(install)?.[1];
  assert.ok(prefix?.startsWith("/tmp/volto-electron-build."), `the build directory is below /tmp: ${prefix}`);
  assert.ok(!existsSync(prefix), "the build directory is gone after the run");
});
