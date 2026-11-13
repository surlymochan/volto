// tools/test/check-lock.test.mjs
//
// Tests for the lockfile consistency check.
//
// The fixtures are synthetic: the package names below exist nowhere and no
// hostname, address or credential appears in this file.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  REPAIR_COMMAND,
  checkManifestAgainstLock,
  checkRepository,
  formatReport,
  satisfies,
} from "../check-lock.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "check-lock.mjs");

// Scratch space for the fixtures, inside the worktree.
const scratch = join(here, ".tmp");
mkdirSync(scratch, { recursive: true });

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A manifest whose dependencies are all present in the lockfile. */
const GOOD_MANIFEST = {
  name: "@example/widget-app",
  version: "0.1.0",
  dependencies: {
    "@example/core": "^1.2.0",
  },
  devDependencies: {
    "@example/test-kit": "~2.0.1",
  },
  optionalDependencies: {
    "@example/widget-linux-x64": "1.2.0",
  },
};

/** The lockfile that belongs to {@link GOOD_MANIFEST}. */
const GOOD_LOCK = {
  name: "@example/widget-app",
  version: "0.1.0",
  lockfileVersion: 3,
  packages: {
    "": {
      name: "@example/widget-app",
      version: "0.1.0",
      dependencies: {
        "@example/core": "^1.2.0",
      },
      devDependencies: {
        "@example/test-kit": "~2.0.1",
      },
      optionalDependencies: {
        "@example/widget-linux-x64": "1.2.0",
      },
    },
    "node_modules/@example/core": {
      version: "1.2.3",
    },
    "node_modules/@example/test-kit": {
      version: "2.0.1",
    },
    "node_modules/@example/widget-linux-x64": {
      version: "1.2.0",
    },
  },
};

/**
 * The lockfile of a machine that never installed the optional platform
 * dependency: the root cause of the recurring `npm ci` failures.
 */
const BAD_LOCK = {
  ...GOOD_LOCK,
  packages: {
    "": {
      name: GOOD_MANIFEST.name,
      version: GOOD_MANIFEST.version,
      dependencies: {
        "@example/core": "^1.2.0",
      },
      devDependencies: {
        "@example/test-kit": "~2.0.1",
      },
      // The optional platform dependency is missing entirely.
    },
    "node_modules/@example/core": {
      version: "1.2.3",
    },
    "node_modules/@example/test-kit": {
      version: "2.0.1",
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
  const root = mkdtempSync(join(scratch, "check-lock-"));
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

test("a manifest and a lockfile that agree pass the check", () => {
  assert.deepEqual(checkManifestAgainstLock(GOOD_MANIFEST, GOOD_LOCK), []);
});

test("an optional platform dependency missing from the lock is reported", () => {
  const problems = checkManifestAgainstLock(GOOD_MANIFEST, BAD_LOCK);

  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /optionalDependencies "@example\/widget-linux-x64@1\.2\.0"/);
  assert.match(problems[0].message, /not listed in the lock root entry/);
});

test("a dependency without a resolved entry is reported", () => {
  const lock = structuredClone(GOOD_LOCK);
  delete lock.packages["node_modules/@example/widget-linux-x64"];

  const problems = checkManifestAgainstLock(GOOD_MANIFEST, lock);

  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /no resolved entry for "@example\/widget-linux-x64"/);
  assert.match(problems[0].message, /Missing: @example\/widget-linux-x64 from lock file/);
});

test("a locked version that no longer satisfies the range is reported", () => {
  const lock = structuredClone(GOOD_LOCK);
  lock.packages["node_modules/@example/core"] = { version: "0.9.0" };

  const problems = checkManifestAgainstLock(GOOD_MANIFEST, lock);

  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /resolves "@example\/core@0\.9\.0" which does not satisfy "\^1\.2\.0"/);
});

test("a dependency the manifest dropped is reported", () => {
  const manifest = structuredClone(GOOD_MANIFEST);
  delete manifest.dependencies["@example/core"];

  const problems = checkManifestAgainstLock(manifest, GOOD_LOCK);

  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /lists "@example\/core" but package.json does not declare it/);
});

test("a lockfile without a root entry is reported", () => {
  const problems = checkManifestAgainstLock(GOOD_MANIFEST, { lockfileVersion: 3, packages: {} });

  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /no root entry/);
});

test("the report names the command that repairs a lockfile", () => {
  const report = formatReport({
    pairs: [{ directory: "app" }],
    problems: [{ label: "app", message: "something is off" }],
  });

  assert.match(report, /package-lock\.json is out of sync with package\.json/);
  assert.match(report, new RegExp(REPAIR_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("the range check understands the usual semver ranges", () => {
  assert.equal(satisfies("1.2.3", "^1.2.0"), true);
  assert.equal(satisfies("1.9.9", "^1.2.0"), true);
  assert.equal(satisfies("2.0.0", "^1.2.0"), false);
  assert.equal(satisfies("1.2.3", "~1.2.0"), true);
  assert.equal(satisfies("1.3.0", "~1.2.0"), false);
  assert.equal(satisfies("1.2.3", ">=1.0.0 <2.0.0"), true);
  assert.equal(satisfies("2.0.0", ">=1.0.0 <2.0.0"), false);
  assert.equal(satisfies("1.5.0", "1.x"), true);
  assert.equal(satisfies("1.5.0", "1.2.x"), false);
  assert.equal(satisfies("1.5.0", "1.2.3 || 2.0.0"), false);
  assert.equal(satisfies("2.0.0", "1.2.3 || 2.0.0"), true);
  assert.equal(satisfies("1.2.3-beta.1", "^1.2.3"), false);
  assert.equal(satisfies("1.2.3-beta.2", ">=1.2.3-beta.1 <2.0.0"), true);
  assert.equal(satisfies("1.2.3", "file:../vendor/core"), null);
});

test("a repository with matching lockfiles passes", () => {
  const root = writeTree([
    { manifest: GOOD_MANIFEST, lock: GOOD_LOCK, name: "app" },
    { manifest: GOOD_MANIFEST, lock: GOOD_LOCK, name: "server" },
  ]);
  try {
    const result = checkRepository(root);
    assert.deepEqual(result.problems, []);
    assert.equal(result.pairs.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a package.json without a sibling lockfile is not checked", () => {
  const root = mkdtempSync(join(scratch, "check-lock-"));
  try {
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(join(root, "app", "package.json"), JSON.stringify(GOOD_MANIFEST));

    const result = checkRepository(root);
    assert.deepEqual(result.pairs, []);
    assert.deepEqual(result.problems, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repository with a stale lockfile fails and names the repair command", () => {
  const root = writeTree([{ manifest: GOOD_MANIFEST, lock: BAD_LOCK, name: "app" }]);
  try {
    const result = checkRepository(root);
    assert.equal(result.problems.length, 1);

    const run = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /optionalDependencies "@example\/widget-linux-x64@1\.2\.0"/);
    assert.match(run.stdout, /npm install --package-lock-only --include=optional/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the command exits with zero when every lockfile is in sync", () => {
  const root = writeTree([{ manifest: GOOD_MANIFEST, lock: GOOD_LOCK, name: "app" }]);
  try {
    const run = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /lock check: ok/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
