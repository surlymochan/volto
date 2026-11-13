#!/usr/bin/env node
// tools/check-lock.mjs
//
// Fails the build when a package-lock.json is out of sync with its
// package.json.
//
// `npm ci` refuses to install from a lockfile that does not match the
// manifest. It aborts with
//
//   npm error `npm ci` can only install packages when your package.json and
//   package-lock.json ... are in sync ... npm error Missing: <pkg> from lock file
//
// The recurring root cause is a lockfile that was generated without the
// optional platform dependencies (`--include=optional`): the lock then lacks
// the Linux or macOS build of a dependency and every clean install fails.
//
// For every package.json in the repository that has a sibling
// package-lock.json this script checks that
//
//   * every dependency / devDependency / optionalDependency of package.json is
//     listed in the lock root entry (packages[""]) with a matching range;
//   * the lock root entry declares exactly the same dependencies;
//   * every declared dependency has a resolved entry in the lock tree whose
//     version satisfies the declared range;
//   * every entry of the lock tree ("packages") can resolve the packages it
//     depends on: its dependencies, its peer dependencies (the ones that are
//     not optional) and its optional dependencies.
//
// The last point matters as much as the first three: a lockfile that lost an
// entry in the middle of the tree - typically an optional platform package -
// still describes the root correctly and still passes a root-only check, yet
// `npm ci` refuses to install from it:
//
//   npm error Missing: <pkg> from lock file
//
// A mismatch is reported together with the command that repairs it:
//
//   run: npm install --package-lock-only --include=optional
//
// Node 24, no dependencies: only the standard library is used.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The manifest sections that npm installs from. */
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];

/** Directories that never hold a package of their own. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "out", "coverage"]);

/** The command that brings a lockfile back in sync with its manifest. */
export const REPAIR_COMMAND = "run: npm install --package-lock-only --include=optional";

// --- semver ----------------------------------------------------------------
//
// A small, dependency free subset of the semver range grammar: enough to
// tell whether the version a lockfile pins still satisfies the range a
// manifest declares. Anything that is not a plain semver range (a file: or
// git: spec, a tag, an alias) is reported as unknown and never fails a
// check on its own.

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const PARTIAL_PATTERN =
  /^(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * @typedef {{ major: number, minor: number, patch: number, prerelease: string[] }} Version
 * @typedef {{ op: string, version: Version }} Comparator
 */

/**
 * Parses a full version string.
 *
 * @param {unknown} text
 * @returns {Version | null}
 */
export function parseVersion(text) {
  if (typeof text !== "string") return null;
  const match = VERSION_PATTERN.exec(text.trim().replace(/^v/, ""));
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split(".") : [],
  };
}

/**
 * Parses a possibly partial version such as "1", "1.2" or "1.x".
 *
 * @param {unknown} text
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[], wildcardMinor: boolean, wildcardPatch: boolean } | null}
 */
function parsePartial(text) {
  if (typeof text !== "string") return null;
  const match = PARTIAL_PATTERN.exec(text.trim().replace(/^v/, ""));
  if (!match) return null;
  const [, rawMajor, rawMinor, rawPatch, rawPrerelease] = match;
  const wildcardMinor = rawMinor === undefined || /^[xX*]$/.test(rawMinor);
  const wildcardPatch = rawPatch === undefined || /^[xX*]$/.test(rawPatch);
  return {
    major: Number(rawMajor),
    minor: wildcardMinor ? 0 : Number(rawMinor),
    patch: wildcardPatch ? 0 : Number(rawPatch),
    prerelease: rawPrerelease ? rawPrerelease.split(".") : [],
    wildcardMinor,
    wildcardPatch,
  };
}

/**
 * Compares two prerelease identifier lists.
 *
 * @param {string[]} left
 * @param {string[]} right
 */
function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const numericA = /^\d+$/.test(a);
    const numericB = /^\d+$/.test(b);
    if (numericA && numericB) {
      const order = Number(a) - Number(b);
      if (order !== 0) return order < 0 ? -1 : 1;
    } else if (numericA !== numericB) {
      return numericA ? -1 : 1;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Compares two versions.
 *
 * @param {Version} left
 * @param {Version} right
 */
export function compareVersions(left, right) {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * @param {number} major
 * @param {number} minor
 * @param {number} patch
 * @param {string[]} [prerelease]
 * @returns {Version}
 */
function makeVersion(major, minor, patch, prerelease = []) {
  return { major, minor, patch, prerelease };
}

/**
 * Expands one range token into comparators.
 *
 * @param {string} spec
 * @param {string} op
 * @returns {Comparator[] | null}
 */
function expandToken(spec, op) {
  const parsed = parsePartial(spec);
  if (!parsed) return null;
  const { major, minor, patch, prerelease, wildcardMinor, wildcardPatch } = parsed;

  if (wildcardMinor) {
    // "1", "1.x", "1.*"
    switch (op) {
      case ">":
        return [{ op: ">=", version: makeVersion(major + 1, 0, 0) }];
      case ">=":
        return [{ op: ">=", version: makeVersion(major, 0, 0) }];
      case "<":
        return [{ op: "<", version: makeVersion(major, 0, 0) }];
      case "<=":
        return [{ op: "<", version: makeVersion(major + 1, 0, 0) }];
      default:
        return [
          { op: ">=", version: makeVersion(major, 0, 0) },
          { op: "<", version: makeVersion(major + 1, 0, 0) },
        ];
    }
  }

  if (wildcardPatch) {
    // "1.2", "1.2.x"
    switch (op) {
      case ">":
        return [{ op: ">=", version: makeVersion(major, minor + 1, 0) }];
      case ">=":
        return [{ op: ">=", version: makeVersion(major, minor, 0) }];
      case "<":
        return [{ op: "<", version: makeVersion(major, minor, 0) }];
      case "<=":
        return [{ op: "<", version: makeVersion(major, minor + 1, 0) }];
      case "^":
        return major > 0
          ? [
              { op: ">=", version: makeVersion(major, minor, 0) },
              { op: "<", version: makeVersion(major + 1, 0, 0) },
            ]
          : [
              { op: ">=", version: makeVersion(major, minor, 0) },
              { op: "<", version: makeVersion(major, minor + 1, 0) },
            ];
      default:
        // "", "=", "~"
        return [
          { op: ">=", version: makeVersion(major, minor, 0) },
          { op: "<", version: makeVersion(major, minor + 1, 0) },
        ];
    }
  }

  const exact = makeVersion(major, minor, patch, prerelease);
  switch (op) {
    case ">":
      return [{ op: ">", version: exact }];
    case ">=":
      return [{ op: ">=", version: exact }];
    case "<":
      return [{ op: "<", version: exact }];
    case "<=":
      return [{ op: "<=", version: exact }];
    case "^": {
      let upper;
      if (major > 0) upper = makeVersion(major + 1, 0, 0);
      else if (minor > 0) upper = makeVersion(major, minor + 1, 0);
      else upper = makeVersion(major, minor, patch + 1);
      return [
        { op: ">=", version: exact },
        { op: "<", version: upper },
      ];
    }
    case "~":
      return [
        { op: ">=", version: exact },
        { op: "<", version: makeVersion(major, minor + 1, 0) },
      ];
    default:
      return [{ op: "=", version: exact }];
  }
}

/**
 * Parses a single conjunction of comparators ("&gt;=1.0.0 &lt;2.0.0").
 *
 * @param {string} text
 * @returns {Comparator[] | null}
 */
function parseComparatorSet(text) {
  const trimmed = text.trim();
  if (trimmed === "") return [];

  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
  if (hyphen) {
    const lower = expandToken(hyphen[1], ">=");
    const upper = expandToken(hyphen[2], "<=");
    if (!lower || !upper) return null;
    return [...lower, ...upper];
  }

  const comparators = [];
  for (const token of trimmed.split(/\s+/)) {
    const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token);
    if (!match) return null;
    const expanded = expandToken(match[2], match[1] ?? "");
    if (!expanded) return null;
    comparators.push(...expanded);
  }
  return comparators;
}

/**
 * Parses a range into its alternatives.
 *
 * @param {unknown} text
 * @returns {Comparator[][] | null}
 */
export function parseRange(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "*" || trimmed === "x" || trimmed === "X") return [[]];
  const sets = [];
  for (const alternative of trimmed.split("||")) {
    const set = parseComparatorSet(alternative);
    if (!set) return null;
    sets.push(set);
  }
  return sets;
}

/**
 * @param {Version} parsed
 * @param {Comparator} comparator
 */
function satisfiesComparator(parsed, comparator) {
  const order = compareVersions(parsed, comparator.version);
  switch (comparator.op) {
    case "=":
      return order === 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    default:
      return false;
  }
}

/**
 * @param {Version} parsed
 * @param {Comparator[]} comparators
 */
function satisfiesSet(parsed, comparators) {
  for (const comparator of comparators) {
    if (!satisfiesComparator(parsed, comparator)) return false;
  }
  if (parsed.prerelease.length > 0) {
    // A prerelease only satisfies a set that mentions the same tuple.
    const allowed = comparators.some(
      (comparator) =>
        comparator.version.prerelease.length > 0 &&
        comparator.version.major === parsed.major &&
        comparator.version.minor === parsed.minor &&
        comparator.version.patch === parsed.patch,
    );
    if (!allowed) return false;
  }
  return true;
}

/**
 * Tells whether a version satisfies a range.
 *
 * Returns null when either side is not plain semver, in which case the caller
 * must not treat the answer as a failure.
 *
 * @param {unknown} versionText
 * @param {unknown} rangeText
 * @returns {boolean | null}
 */
export function satisfies(versionText, rangeText) {
  const parsed = parseVersion(versionText);
  const sets = parseRange(rangeText);
  if (!parsed || !sets) return null;
  return sets.some((set) => satisfiesSet(parsed, set));
}

/**
 * Renders a range in a canonical form so that two spellings of the same
 * range ("^1.2.3" and ">=1.2.3 <2.0.0") compare equal.
 *
 * @param {unknown} text
 * @returns {string | null}
 */
function canonicalRange(text) {
  const sets = parseRange(text);
  if (!sets) return null;
  return sets
    .map((set) =>
      set
        .map((comparator) => {
          const version = comparator.version;
          const prerelease = version.prerelease.length ? `-${version.prerelease.join(".")}` : "";
          return `${comparator.op}${version.major}.${version.minor}.${version.patch}${prerelease}`;
        })
        .sort()
        .join(" "),
    )
    .sort()
    .join(" || ");
}

/**
 * Tells whether the range a lockfile records still agrees with the range a
 * manifest declares.
 *
 * @param {unknown} declared
 * @param {unknown} locked
 * @param {unknown} resolved
 */
function rangesAgree(declared, locked, resolved) {
  if (declared === locked) return true;
  const left = canonicalRange(declared);
  const right = canonicalRange(locked);
  if (left !== null && left === right) return true;
  if (typeof resolved === "string") {
    const declaredOk = satisfies(resolved, declared);
    const lockedOk = satisfies(resolved, locked);
    if (declaredOk === true && lockedOk === true) return true;
  }
  return false;
}

// --- the check -------------------------------------------------------------

/**
 * @typedef {{ section?: string, name?: string, package?: string, message: string }} Problem
 */

/**
 * The dependency sections of a lock entry that npm resolves from.
 *
 * `devDependencies` are not among them: npm installs the dev dependencies of
 * the project itself, not the ones of every package in the tree.
 */
const LOCK_ENTRY_SECTIONS = ["dependencies", "optionalDependencies"];

/**
 * Derives the name of the package a lock entry describes.
 *
 * @param {unknown} entry
 * @param {string} path
 * @returns {string}
 */
function entryName(entry, path) {
  if (typeof /** @type {any} */ (entry)?.name === "string") {
    return /** @type {any} */ (entry).name;
  }
  const index = path.lastIndexOf("node_modules/");
  return index === -1 ? path : path.slice(index + "node_modules/".length);
}

/**
 * Resolves a dependency the way Node does: the closest node_modules first,
 * then the node_modules of every ancestor directory.
 *
 * @param {Record<string, unknown>} packages
 * @param {string} fromPath the lock path of the package that needs the dependency
 * @param {string} name
 * @returns {string | null} the lock path that provides the dependency
 */
export function resolveDependency(packages, fromPath, name) {
  let prefix = fromPath;
  for (;;) {
    const candidate = prefix === "" ? `node_modules/${name}` : `${prefix}/node_modules/${name}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (prefix === "") return null;
    const index = prefix.lastIndexOf("/node_modules/");
    prefix = index === -1 ? "" : prefix.slice(0, index);
  }
}

/**
 * Collects the dependencies a lock entry declares.
 *
 * A peer dependency that the entry marks as optional is skipped: npm does not
 * install it, so the lock does not have to hold it.
 *
 * @param {unknown} entry
 * @returns {{ section: string, name: string, spec: string }[]}
 */
function entryDependencies(entry) {
  /** @type {{ section: string, name: string, spec: string }[]} */
  const collected = [];

  for (const section of LOCK_ENTRY_SECTIONS) {
    const declared = /** @type {any} */ (entry)?.[section];
    if (!declared || typeof declared !== "object") continue;
    for (const [name, spec] of Object.entries(declared)) {
      collected.push({ section, name, spec: String(spec) });
    }
  }

  const peers = /** @type {any} */ (entry)?.peerDependencies;
  const peerMeta = /** @type {any} */ (entry)?.peerDependenciesMeta;
  if (peers && typeof peers === "object") {
    for (const [name, spec] of Object.entries(peers)) {
      if (peerMeta?.[name]?.optional === true) continue;
      collected.push({ section: "peerDependencies", name, spec: String(spec) });
    }
  }

  return collected;
}

/**
 * Renders the message for a dependency that no entry of the lock tree
 * provides.
 *
 * @param {string} section
 * @param {string} name
 * @param {string} spec
 * @param {string} owner
 * @returns {string}
 */
function missingEntryMessage(section, name, spec, owner) {
  const kind =
    section === "optionalDependencies"
      ? "an optional dependency"
      : section === "peerDependencies"
        ? "a peer dependency"
        : "a dependency";
  const note =
    section === "optionalDependencies"
      ? " - an optional platform package has to be in the lock even when the current platform does not install it"
      : "";
  return (
    `the lock file has no entry for "${name}@${spec}", ${kind} of "${owner}"; ` +
    `npm ci fails with "Missing: ${name} from lock file"${note}`
  );
}

/**
 * Checks that every dependency declared by an entry of the lock tree can be
 * resolved inside that tree.
 *
 * The root entry is left out: it is compared with the manifest instead, and
 * a root dependency that has no entry is reported there.
 *
 * @param {unknown} lock
 * @returns {Problem[]}
 */
export function checkLockTree(lock) {
  const packages = /** @type {Record<string, any>} */ (
    /** @type {any} */ (lock)?.packages ?? {}
  );
  /** @type {Problem[]} */
  const problems = [];

  for (const [path, entry] of Object.entries(packages)) {
    if (path === "") continue;
    const version = typeof entry?.version === "string" ? `@${entry.version}` : "";
    const owner = `${entryName(entry, path)}${version}`;

    for (const dependency of entryDependencies(entry)) {
      if (resolveDependency(packages, path, dependency.name)) continue;
      problems.push({
        section: dependency.section,
        name: dependency.name,
        package: path,
        message: missingEntryMessage(dependency.section, dependency.name, dependency.spec, owner),
      });
    }
  }

  return problems;
}

/**
 * Checks one manifest against one lockfile.
 *
 * @param {unknown} manifest
 * @param {unknown} lock
 * @returns {Problem[]}
 */
export function checkManifestAgainstLock(manifest, lock) {
  /** @type {Problem[]} */
  const problems = [];
  const root = /** @type {any} */ (lock)?.packages?.[""];
  if (!root) {
    problems.push({
      message:
        'the lock file has no root entry (packages[""]); regenerate it with ' +
        REPAIR_COMMAND,
    });
    return problems;
  }

  /** @type {Set<string>} */
  const missing = new Set();

  for (const section of DEPENDENCY_SECTIONS) {
    const declared = /** @type {Record<string, string>} */ (
      /** @type {any} */ (manifest)?.[section] ?? {}
    );
    const locked = /** @type {Record<string, string>} */ (root?.[section] ?? {});

    for (const [name, spec] of Object.entries(declared)) {
      if (!(name in locked)) {
        if (!missing.has(name)) {
          missing.add(name);
          problems.push({
            section,
            name,
            message:
              `${section} "${name}@${spec}" is not listed in the lock root entry ` +
              `(packages[""].${section})`,
          });
        }
        continue;
      }

      const lockedSpec = locked[name];
      const entry = /** @type {any} */ (lock)?.packages?.[`node_modules/${name}`];
      const resolved = typeof entry?.version === "string" ? entry.version : undefined;

      if (!entry) {
        problems.push({
          section,
          name,
          message:
            `the lock file has no resolved entry for "${name}"; npm ci fails with ` +
            `"Missing: ${name} from lock file"`,
        });
        continue;
      }

      if (!rangesAgree(spec, lockedSpec, resolved)) {
        problems.push({
          section,
          name,
          message:
            `the lock root entry records "${name}@${lockedSpec}" but package.json ` +
            `declares "${name}@${spec}"`,
        });
      }

      if (typeof resolved === "string") {
        const ok = satisfies(resolved, spec);
        if (ok === false) {
          problems.push({
            section,
            name,
            message: `the lock file resolves "${name}@${resolved}" which does not satisfy "${spec}"`,
          });
        }
      }
    }

    for (const name of Object.keys(locked)) {
      if (!(name in declared)) {
        problems.push({
          section,
          name,
          message: `the lock root entry lists "${name}" but package.json does not declare it`,
        });
      }
    }
  }

  // The root is in sync with the manifest; the rest of the tree has to
  // resolve on its own.
  problems.push(...checkLockTree(lock));

  return problems;
}

/**
 * Lists every directory of a tree, skipping the ones that never hold a
 * package of their own.
 *
 * @param {string} root
 * @returns {string[]}
 */
function collectDirectories(root) {
  const directories = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = /** @type {string} */ (stack.pop());
    directories.push(current);
    /** @type {import("node:fs").Dirent[]} */
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      stack.push(join(current, entry.name));
    }
  }
  return directories;
}

/**
 * Finds every package.json that has a sibling package-lock.json.
 *
 * @param {string} root
 * @returns {{ directory: string, manifestPath: string, lockPath: string }[]}
 */
export function findLockPairs(root) {
  const pairs = [];
  for (const directory of collectDirectories(root)) {
    const manifestPath = join(directory, "package.json");
    const lockPath = join(directory, "package-lock.json");
    if (existsSync(manifestPath) && existsSync(lockPath)) {
      pairs.push({ directory, manifestPath, lockPath });
    }
  }
  return pairs.sort((left, right) => left.directory.localeCompare(right.directory));
}

/**
 * @param {string} path
 * @returns {unknown}
 */
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Checks every package.json that has a sibling package-lock.json.
 *
 * @param {string} root
 * @returns {{ root: string, pairs: { directory: string, manifestPath: string, lockPath: string }[], problems: (Problem & { label: string })[] }}
 */
export function checkRepository(root) {
  const pairs = findLockPairs(root);
  /** @type {(Problem & { label: string })[]} */
  const problems = [];

  for (const pair of pairs) {
    const label = relative(root, pair.directory) || ".";
    /** @type {unknown} */
    let manifest;
    /** @type {unknown} */
    let lock;
    try {
      manifest = readJson(pair.manifestPath);
    } catch (error) {
      problems.push({
        label,
        message: `cannot read package.json: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    try {
      lock = readJson(pair.lockPath);
    } catch (error) {
      problems.push({
        label,
        message: `cannot read package-lock.json: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    for (const problem of checkManifestAgainstLock(manifest, lock)) {
      problems.push({ label, ...problem });
    }
  }

  return { root, pairs, problems };
}

/**
 * Renders the result of a repository check.
 *
 * @param {{ pairs: unknown[], problems: (Problem & { label: string })[] }} result
 * @returns {string}
 */
export function formatReport(result) {
  const lines = [];
  const pairs = result.pairs.length;

  if (result.problems.length === 0) {
    lines.push(`lock check: ok (${pairs} package.json / package-lock.json pair(s) checked)`);
    return `${lines.join("\n")}\n`;
  }

  lines.push(`lock check: ${result.problems.length} problem(s) in ${pairs} pair(s)`);
  lines.push("");
  let current = null;
  for (const problem of result.problems) {
    if (problem.label !== current) {
      current = problem.label;
      lines.push(`  ${current}${current === "." ? "" : "/"}`);
    }
    lines.push(`    - ${problem.message}`);
  }
  lines.push("");
  lines.push("package-lock.json is out of sync with package.json.");
  lines.push("Repair it with:");
  lines.push(`  ${REPAIR_COMMAND}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Resolves the directory that is checked.
 *
 * @param {string[]} argv
 * @returns {string}
 */
function resolveRoot(argv) {
  const index = argv.indexOf("--root");
  if (index !== -1) {
    const value = argv[index + 1];
    if (!value) throw new Error("--root needs a directory");
    return resolve(value);
  }
  const inline = argv.find((argument) => argument.startsWith("--root="));
  if (inline) return resolve(inline.slice("--root=".length));
  const fromEnvironment = process.env.CHECK_LOCK_ROOT;
  if (fromEnvironment) return resolve(fromEnvironment);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Runs the check.
 *
 * @param {string[]} [argv]
 * @returns {number} the exit code
 */
export function main(argv = process.argv.slice(2)) {
  /** @type {string} */
  let root;
  try {
    root = resolveRoot(argv);
  } catch (error) {
    process.stderr.write(`lock check: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const result = checkRepository(root);
  process.stdout.write(formatReport(result));
  return result.problems.length > 0 ? 1 : 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  process.exitCode = main();
}
