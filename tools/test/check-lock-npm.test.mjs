// tools/test/check-lock-npm.test.mjs
//
// Tests for the npm layer of the lockfile check.
//
// The static comparison of manifest and lockfile is not the last word: npm
// itself has to accept the pair, so the check also runs
//
//   npm ci --dry-run --ignore-scripts --no-audit --no-fund
//
// in the directory of every pair.
//
// The suite stays offline. The npm command is replaced by a stub runner that
// records what it was asked to do; the one test that runs the real npm uses a
// package without dependencies, which installs without contacting a registry.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, delimiter } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  NPM_CI_ARGS,
  NPM_CI_COMMAND,
  checkNpmCi,
  checkRepository,
  extractNpmError,
  formatReport,
  npmLayerDisabled,
} from "../check-lock.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "check-lock.mjs");

// Scratch space for the fixtures, inside the worktree. Every test file has
// its own directory: the suites run in parallel and must not delete the
// scratch space of another one.
const scratch = join(here, ".tmp", "npm");
mkdirSync(scratch, { recursive: true });

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A manifest without dependencies: npm installs it without a registry. */
const OFFLINE_MANIFEST = {
  name: "@example/offline-app",
  version: "0.1.0",
  license: "MIT",
};

/** The lockfile that belongs to {@link OFFLINE_MANIFEST}. */
const OFFLINE_LOCK = {
  name: "@example/offline-app",
  version: "0.1.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {
      name: "@example/offline-app",
      version: "0.1.0",
      license: "MIT",
    },
  },
};

/**
 * Writes a package tree below a fresh directory.
 *
 * @param {{ manifest: unknown, lock: unknown, name?: string }[]} packages
 * @returns {string} the root of the tree
 */
function writeTree(packages) {
  const root = mkdtempSync(join(scratch, "check-lock-npm-"));
  for (const entry of packages) {
    const directory = join(root, entry.name ?? ".");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), `${JSON.stringify(entry.manifest, null, 2)}\n`);
    writeFileSync(
      join(directory, "package-lock.json"),
      `${JSON.stringify(entry.lock, null, 2)}\n`,
    );
  }
  return root;
}

/**
 * A runner that records the directories it was asked about and answers with
 * a fixed result.
 *
 * @param {{ status: number | null, output: string }} result
 * @returns {{ runner: (directory: string) => { status: number | null, output: string }, calls: string[] }}
 */
function stubRunner(result) {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    runner: (directory) => {
      calls.push(directory);
      return result;
    },
  };
}

test("the npm layer runs the documented command", () => {
  assert.deepEqual(NPM_CI_ARGS, [
    "ci",
    "--dry-run",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
  assert.equal(NPM_CI_COMMAND, "npm ci --dry-run --ignore-scripts --no-audit --no-fund");
});

test("a dry run that succeeds reports nothing", () => {
  const problems = checkNpmCi("/nowhere", () => ({ status: 0, output: "up to date in 42ms" }));

  assert.deepEqual(problems, []);
});

test("a failing dry run surfaces the message of npm 11", () => {
  const output = [
    "npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.",
    "npm error",
    "npm error Missing: @example/widget-linux-x64@1.2.0 from lock file",
  ].join("\n");

  const problems = checkNpmCi("/nowhere", () => ({ status: 1, output }));

  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /npm ci --dry-run --ignore-scripts --no-audit --no-fund failed/);
  assert.match(problems[0].message, /npm error/);
  assert.match(problems[0].message, /Missing: @example\/widget-linux-x64@1\.2\.0 from lock file/);
});

test("a failing dry run surfaces the message of npm 10 and older", () => {
  const output = [
    "npm ERR! code EUSAGE",
    "npm ERR! `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.",
    "npm ERR! Missing: @example/widget-linux-x64@1.2.0 from lock file",
  ].join("\n");

  const problems = checkNpmCi("/nowhere", () => ({ status: 1, output }));

  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /npm ERR!/);
  assert.match(problems[0].message, /Missing: @example\/widget-linux-x64@1\.2\.0 from lock file/);
});

test("the error of npm is recognised in both spellings", () => {
  assert.match(extractNpmError("npm error something went wrong"), /npm error something went wrong/);
  assert.match(extractNpmError("npm ERR! something went wrong"), /npm ERR! something went wrong/);
});

test("output without a marker is still reported", () => {
  const problems = checkNpmCi("/nowhere", () => ({ status: 1, output: "something went wrong" }));

  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /something went wrong/);
});

test("the check runs npm in the directory of every pair", () => {
  const root = writeTree([
    { manifest: OFFLINE_MANIFEST, lock: OFFLINE_LOCK, name: "app" },
    { manifest: OFFLINE_MANIFEST, lock: OFFLINE_LOCK, name: "server" },
  ]);
  try {
    const stub = stubRunner({ status: 0, output: "up to date" });
    const result = checkRepository(root, { skipNpm: false, runner: stub.runner });

    assert.deepEqual(result.problems, []);
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0], join(root, "app"));
    assert.equal(stub.calls[1], join(root, "server"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the check fails when npm refuses the lockfile", () => {
  const root = writeTree([{ manifest: OFFLINE_MANIFEST, lock: OFFLINE_LOCK, name: "app" }]);
  try {
    const stub = stubRunner({ status: 1, output: "npm error Missing: @example/extra@1.0.0 from lock file" });
    const result = checkRepository(root, { skipNpm: false, runner: stub.runner });

    assert.equal(result.problems.length, 1);
    assert.equal(result.problems[0].label, "app");
    assert.match(result.problems[0].message, /npm error Missing: @example\/extra@1\.0\.0 from lock file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CHECK_LOCK_SKIP_NPM=1 switches the npm layer off", () => {
  const previous = process.env.CHECK_LOCK_SKIP_NPM;
  process.env.CHECK_LOCK_SKIP_NPM = "1";
  try {
    assert.equal(npmLayerDisabled(), true);

    const root = writeTree([{ manifest: OFFLINE_MANIFEST, lock: OFFLINE_LOCK, name: "app" }]);
    try {
      const stub = stubRunner({ status: 1, output: "npm error the lock file is broken" });
      const result = checkRepository(root, { runner: stub.runner });

      assert.deepEqual(result.problems, []);
      assert.deepEqual(stub.calls, []);
      assert.equal(result.npmSkipped, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    if (previous === undefined) delete process.env.CHECK_LOCK_SKIP_NPM;
    else process.env.CHECK_LOCK_SKIP_NPM = previous;
  }
});

test("the npm layer runs when the switch is not set", () => {
  assert.equal(npmLayerDisabled({}), false);
  assert.equal(npmLayerDisabled({ CHECK_LOCK_SKIP_NPM: "" }), false);
  assert.equal(npmLayerDisabled({ CHECK_LOCK_SKIP_NPM: "0" }), false);
  assert.equal(npmLayerDisabled({ CHECK_LOCK_SKIP_NPM: "false" }), false);
  assert.equal(npmLayerDisabled({ CHECK_LOCK_SKIP_NPM: "1" }), true);
  assert.equal(npmLayerDisabled({ CHECK_LOCK_SKIP_NPM: "yes" }), true);
});

test("the report names the npm command that failed", () => {
  const report = formatReport({
    pairs: [{ directory: "app" }],
    problems: [
      {
        label: "app",
        message:
          "npm ci --dry-run --ignore-scripts --no-audit --no-fund failed with exit code 1:\n" +
          "npm error Missing: @example/extra@1.0.0 from lock file",
      },
    ],
  });

  assert.match(report, /npm ci --dry-run --ignore-scripts --no-audit --no-fund failed/);
  assert.match(report, /npm error Missing: @example\/extra@1\.0\.0 from lock file/);
});

test("the command fails when npm refuses the lockfile", (t) => {
  if (process.platform === "win32") {
    t.skip("the stub npm needs a POSIX shell");
    return;
  }

  const root = writeTree([{ manifest: OFFLINE_MANIFEST, lock: OFFLINE_LOCK, name: "app" }]);
  try {
    // A stub npm on the PATH: the check has to run it and report what it
    // said, without a registry.
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const stub = join(bin, "npm");
    writeFileSync(
      stub,
      [
        "#!/bin/sh",
        "echo 'npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.' >&2",
        "echo 'npm error Missing: @example/extra@1.0.0 from lock file' >&2",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);

    const run = spawnSync(process.execPath, [script, "--root", root], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        CHECK_LOCK_SKIP_NPM: "0",
      },
    });

    assert.equal(run.status, 1);
    assert.match(run.stdout, /npm ci --dry-run --ignore-scripts --no-audit --no-fund failed/);
    assert.match(run.stdout, /npm error Missing: @example\/extra@1\.0\.0 from lock file/);
    assert.match(run.stdout, /npm install --package-lock-only --include=optional/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real npm accepts a lockfile without dependencies", (t) => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const probe = spawnSync(npm, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("npm is not available");
    return;
  }

  const root = writeTree([{ manifest: OFFLINE_MANIFEST, lock: OFFLINE_LOCK, name: "app" }]);
  try {
    // npm itself has to accept the pair ...
    const direct = spawnSync(npm, NPM_CI_ARGS, {
      cwd: join(root, "app"),
      encoding: "utf8",
    });
    if (direct.error || direct.status !== 0) {
      t.skip(`npm cannot install the fixture here: ${direct.stderr ?? direct.error?.message}`);
      return;
    }

    // ... and the check has to agree with npm.
    const run = spawnSync(process.execPath, [script, "--root", root], {
      encoding: "utf8",
      env: { ...process.env, CHECK_LOCK_SKIP_NPM: "0" },
    });

    assert.equal(run.status, 0);
    assert.match(run.stdout, /lock check: ok/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
