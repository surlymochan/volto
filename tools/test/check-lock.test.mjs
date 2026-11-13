// tools/test/check-lock.test.mjs
//
// Tests for the lockfile consistency check.
//
// The fixtures are synthetic: the package names below exist nowhere and no
// hostname, address or credential appears in this file.
//
// The npm layer of the check (the `npm ci --dry-run` that proves a lockfile
// installs) needs a registry, so it is switched off for this file. The layer
// itself is covered by tools/test/check-lock-npm.test.mjs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  REPAIR_COMMAND,
  checkLockTree,
  checkManifestAgainstLock,
  checkRepository,
  formatReport,
  resolveDependency,
  satisfies,
} from "../check-lock.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "check-lock.mjs");
const fixtures = join(here, "fixtures");

// The npm layer talks to a registry: the unit tests stay offline.
process.env.CHECK_LOCK_SKIP_NPM = "1";

/**
 * Reads one of the synthetic lockfile fixtures.
 *
 * @param {string} name
 * @returns {any}
 */
function readFixture(name) {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8"));
}

/**
 * The manifest of the fixture locks below: it depends on one package that
 * pulls in a nested dependency, an optional platform package and a peer
 * dependency.
 *
 * The fixture files are the two failure cases of the review: a lock that lost
 * an entry in the middle of the tree and a lock that lost an optional
 * platform package. All the names below are synthetic.
 */
const TREE_MANIFEST = {
  name: "@example/agent-app",
  version: "0.1.0",
  dependencies: {
    "@example/agent": "^1.0.0",
  },
};

/** A lock tree that resolves completely. */
const GOOD_TREE_LOCK = readFixture("good-lock.json");
/** A lock tree that lost the entry of a dependency in the middle. */
const BAD_MISSING_DEPENDENCY_LOCK = readFixture("bad-lock-missing-dependency.json");
/** A lock tree that lost the entry of an optional platform package. */
const BAD_MISSING_PLATFORM_LOCK = readFixture("bad-lock-missing-platform-package.json");
/** A lock that resolves a version the manifest no longer accepts. */
const BAD_VERSION_OUT_OF_RANGE_LOCK = readFixture("bad-lock-version-out-of-range.json");
/** A lock that was written when the manifest asked for an older range. */
const BAD_STALE_RANGE_LOCK = readFixture("bad-lock-stale-range.json");
/** A lock that was written before the manifest gained a dependency. */
const BAD_STALE_NEW_DEPENDENCY_LOCK = readFixture("bad-lock-stale-new-dependency.json");

// Scratch space for the fixtures, inside the worktree. Every test file has
// its own directory: the suites run in parallel and must not delete the
// scratch space of another one.
const scratch = join(here, ".tmp", "lock");
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

test("a fixture with a version outside the declared range is reported", () => {
  const problems = checkManifestAgainstLock(GOOD_MANIFEST, BAD_VERSION_OUT_OF_RANGE_LOCK);

  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /resolves "@example\/core@0\.9\.0" which does not satisfy "\^1\.2\.0"/);
});

test("a lock written before the manifest changed its range is reported", () => {
  const problems = checkManifestAgainstLock(GOOD_MANIFEST, BAD_STALE_RANGE_LOCK);

  assert.equal(problems.length, 2);
  assert.match(
    problems[0].message,
    /the lock root entry records "@example\/core@\^1\.0\.0" but package\.json declares "@example\/core@\^1\.2\.0"/,
  );
  assert.match(
    problems[1].message,
    /resolves "@example\/core@1\.0\.4" which does not satisfy "\^1\.2\.0"/,
  );
});

test("a lock written before the manifest gained a dependency is reported", () => {
  const manifest = structuredClone(GOOD_MANIFEST);
  manifest.dependencies["@example/extra"] = "^3.0.0";

  const problems = checkManifestAgainstLock(manifest, BAD_STALE_NEW_DEPENDENCY_LOCK);

  assert.equal(problems.length, 1);
  assert.match(
    problems[0].message,
    /dependencies "@example\/extra@\^3\.0\.0" is not listed in the lock root entry/,
  );
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

test("a repository with a lock that predates the manifest fails", () => {
  const root = writeTree([{ manifest: GOOD_MANIFEST, lock: BAD_STALE_RANGE_LOCK, name: "app" }]);
  try {
    const result = checkRepository(root);
    assert.equal(result.problems.length, 2);

    const run = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /the lock root entry records "@example\/core@\^1\.0\.0"/);
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

// --- the lock tree ---------------------------------------------------------

test("a dependency is resolved from the closest node_modules first", () => {
  const packages = GOOD_TREE_LOCK.packages;

  assert.equal(
    resolveDependency(packages, "node_modules/@example/agent", "@example/agent-core"),
    "node_modules/@example/agent/node_modules/@example/agent-core",
  );
  assert.equal(
    resolveDependency(packages, "node_modules/@example/agent", "@example/agent-runtime"),
    "node_modules/@example/agent-runtime",
  );
  assert.equal(
    resolveDependency(packages, "node_modules/@example/agent", "@example/agent-nowhere"),
    null,
  );
});

test("a complete lock tree passes the check", () => {
  assert.deepEqual(checkLockTree(GOOD_TREE_LOCK), []);
  assert.deepEqual(checkManifestAgainstLock(TREE_MANIFEST, GOOD_TREE_LOCK), []);
});

test("a dependency missing from the middle of the tree is reported", () => {
  const problems = checkLockTree(BAD_MISSING_DEPENDENCY_LOCK);

  assert.equal(problems.length, 1);
  assert.equal(problems[0].name, "@example/agent-runtime");
  assert.equal(problems[0].section, "dependencies");
  assert.match(problems[0].message, /no entry for "@example\/agent-runtime@\^1\.0\.0"/);
  assert.match(problems[0].message, /a dependency of "@example\/agent@1\.0\.0"/);
  assert.match(problems[0].message, /Missing: @example\/agent-runtime from lock file/);
});

test("an optional platform package missing from the tree is reported", () => {
  const problems = checkLockTree(BAD_MISSING_PLATFORM_LOCK);

  assert.equal(problems.length, 1);
  assert.equal(problems[0].name, "@example/agent-linux-x64-gnu");
  assert.equal(problems[0].section, "optionalDependencies");
  assert.match(problems[0].message, /no entry for "@example\/agent-linux-x64-gnu@1\.0\.0"/);
  assert.match(problems[0].message, /an optional dependency of "@example\/agent@1\.0\.0"/);
  assert.match(problems[0].message, /Missing: @example\/agent-linux-x64-gnu from lock file/);
});

test("the broken lock trees fail the manifest check as well", () => {
  for (const lock of [BAD_MISSING_DEPENDENCY_LOCK, BAD_MISSING_PLATFORM_LOCK]) {
    const problems = checkManifestAgainstLock(TREE_MANIFEST, lock);
    assert.equal(problems.length, 1);
  }
});

test("an optional peer dependency does not have to be in the lock", () => {
  const lock = structuredClone(GOOD_TREE_LOCK);
  lock.packages["node_modules/@example/agent"].peerDependenciesMeta = {
    "@example/agent-peer": { optional: true },
  };
  delete lock.packages["node_modules/@example/agent-peer"];

  assert.deepEqual(checkLockTree(lock), []);
});

test("a missing peer dependency is reported", () => {
  const lock = structuredClone(GOOD_TREE_LOCK);
  delete lock.packages["node_modules/@example/agent-peer"];

  const problems = checkLockTree(lock);

  assert.equal(problems.length, 1);
  assert.equal(problems[0].section, "peerDependencies");
  assert.match(problems[0].message, /no entry for "@example\/agent-peer@\^3\.0\.0"/);
  assert.match(problems[0].message, /a peer dependency of "@example\/agent@1\.0\.0"/);
});

test("the report names the package that is missing from the lock tree", () => {
  const root = writeTree([
    { manifest: TREE_MANIFEST, lock: BAD_MISSING_PLATFORM_LOCK, name: "app" },
  ]);
  try {
    const result = checkRepository(root);
    assert.equal(result.problems.length, 1);

    const run = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /@example\/agent-linux-x64-gnu/);
    assert.match(run.stdout, /Missing: @example\/agent-linux-x64-gnu from lock file/);
    assert.match(run.stdout, /npm install --package-lock-only --include=optional/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the command exits with zero when the lock tree is complete", () => {
  const root = writeTree([{ manifest: TREE_MANIFEST, lock: GOOD_TREE_LOCK, name: "app" }]);
  try {
    const run = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /lock check: ok/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
