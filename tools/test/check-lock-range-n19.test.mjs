// tools/test/check-lock-range-n19.test.mjs
//
// Tests for the range arithmetic and for the npm constants of the
// lockfile check.
//
// The suite is static: it never runs npm, never opens a socket and never
// spawns a child process. Every version, range and package name below is
// synthetic - no real name, host, address or credential appears here.
//
// tools/check-lock.mjs implements a small subset of the semver range
// grammar: enough to tell whether the version a lockfile pins still
// satisfies the range a manifest declares. The tests below pin down the
// boundaries of that subset - the partial bound ">=22.22", the caret and
// the tilde - and the way a range that cannot be parsed is reported: as
// unknown (null), never as a failure.
//
// The npm layer of the check (the `npm ci --dry-run` that proves a
// lockfile installs) is covered by tools/test/check-lock-npm.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NPM_CI_ARGS,
  NPM_CI_COMMAND,
  NPM_ERROR_PATTERN,
  REPAIR_COMMAND,
  parseRange,
  satisfies,
} from "../check-lock.mjs";

// The npm layer talks to a registry: this file never reaches it, the
// switch only makes that explicit.
process.env.CHECK_LOCK_SKIP_NPM = "1";

/**
 * A comparator of a parsed range.
 *
 * @typedef {{ op: string, version: { major: number, minor: number, patch: number, prerelease: string[] } }} Comparator
 */

/**
 * Builds the comparator of an exact version.
 *
 * @param {string} op
 * @param {number} major
 * @param {number} minor
 * @param {number} patch
 * @returns {Comparator}
 */
function comparator(op, major, minor, patch) {
  return { op, version: { major, minor, patch, prerelease: [] } };
}

test("a partial lower bound is read as a full version", () => {
  // ">=22.22" is ">=22.22.0": the version on the bound satisfies it, the
  // one below does not.
  assert.equal(satisfies("22.22.0", ">=22.22"), true);
  assert.equal(satisfies("22.21.9", ">=22.22"), false);
  assert.equal(satisfies("22.21.9", ">=22.22.0"), false);

  // A version above the bound satisfies it as well.
  assert.equal(satisfies("22.22.1", ">=22.22"), true);
  assert.equal(satisfies("23.0.0", ">=22.22"), true);

  // The two spellings of the bound expand to the same comparator.
  assert.deepEqual(parseRange(">=22.22"), parseRange(">=22.22.0"));
  assert.deepEqual(parseRange(">=22.22"), [[comparator(">=", 22, 22, 0)]]);
});

test("the caret range covers the rest of the major version", () => {
  // The lower bound belongs to the range, the upper one does not.
  assert.equal(satisfies("22.1.0", "^22.1.0"), true);
  assert.equal(satisfies("22.1.9", "^22.1.0"), true);
  assert.equal(satisfies("22.9.9", "^22.1.0"), true);

  assert.equal(satisfies("22.0.9", "^22.1.0"), false);
  assert.equal(satisfies("23.0.0", "^22.1.0"), false);
});

test("the tilde range covers the rest of the minor version", () => {
  assert.equal(satisfies("22.1.0", "~22.1.0"), true);
  assert.equal(satisfies("22.1.9", "~22.1.0"), true);

  assert.equal(satisfies("22.0.9", "~22.1.0"), false);
  assert.equal(satisfies("22.2.0", "~22.1.0"), false);
});

test("the caret and the tilde range expand to their boundaries", () => {
  assert.deepEqual(parseRange("^22.1.0"), [
    [comparator(">=", 22, 1, 0), comparator("<", 23, 0, 0)],
  ]);
  assert.deepEqual(parseRange("~22.1.0"), [
    [comparator(">=", 22, 1, 0), comparator("<", 22, 2, 0)],
  ]);
});

test("a partial caret and tilde range keep their boundaries", () => {
  // "^22.1" is ">=22.1.0 <23.0.0", "~22.1" is ">=22.1.0 <22.2.0".
  assert.equal(satisfies("22.1.0", "^22.1"), true);
  assert.equal(satisfies("22.9.9", "^22.1"), true);
  assert.equal(satisfies("22.0.9", "^22.1"), false);
  assert.equal(satisfies("23.0.0", "^22.1"), false);

  assert.equal(satisfies("22.1.0", "~22.1"), true);
  assert.equal(satisfies("22.1.9", "~22.1"), true);
  assert.equal(satisfies("22.0.9", "~22.1"), false);
  assert.equal(satisfies("22.2.0", "~22.1"), false);

  assert.deepEqual(parseRange("^22.1"), [
    [comparator(">=", 22, 1, 0), comparator("<", 23, 0, 0)],
  ]);
  assert.deepEqual(parseRange("~22.1"), [
    [comparator(">=", 22, 1, 0), comparator("<", 22, 2, 0)],
  ]);
});

test("a range that cannot be parsed is unknown, not a failure", () => {
  // A spec that is not plain semver - a tag, an alias, a workspace
  // reference - is reported as unknown, so that the caller does not treat
  // it as a mismatch.
  assert.equal(satisfies("22.22.0", "not-a-range"), null);
  assert.equal(satisfies("22.22.0", "latest"), null);
  assert.equal(satisfies("22.22.0", "workspace:*"), null);
  assert.equal(satisfies("22.22.0", "npm:@example/other@^1.0.0"), null);

  assert.equal(parseRange("not-a-range"), null);
  assert.equal(parseRange("workspace:*"), null);
  assert.equal(parseRange("npm:@example/other@^1.0.0"), null);

  // A range that is not a string is unknown as well.
  assert.equal(parseRange(42), null);
  assert.equal(parseRange(undefined), null);
});

test("an unparseable range never throws", () => {
  assert.doesNotThrow(() => satisfies("22.22.0", "not-a-range"));
  assert.doesNotThrow(() => satisfies("22.22.0", ">=22.22 <"));
  assert.doesNotThrow(() => satisfies("not-a-version", ">=22.22"));
  assert.doesNotThrow(() => parseRange("not-a-range"));
  assert.doesNotThrow(() => parseRange(42));
  assert.doesNotThrow(() => parseRange(undefined));

  // A version that is not plain semver is unknown as well.
  assert.equal(satisfies("not-a-version", ">=22.22"), null);
  assert.equal(satisfies("22.22", ">=22.22"), null);
});

test("an empty range accepts every version", () => {
  assert.deepEqual(parseRange(""), [[]]);
  assert.deepEqual(parseRange("*"), [[]]);
  assert.deepEqual(parseRange("x"), [[]]);
  assert.deepEqual(parseRange("X"), [[]]);

  assert.equal(satisfies("22.22.0", ""), true);
  assert.equal(satisfies("22.22.0", "*"), true);
});

test("the npm command is the argument list spelled out", () => {
  assert.equal(NPM_CI_COMMAND, `npm ${NPM_CI_ARGS.join(" ")}`);
  assert.ok(NPM_CI_COMMAND.includes("--dry-run"));
  assert.ok(NPM_CI_ARGS.includes("--dry-run"));
  assert.ok(NPM_CI_ARGS.includes("ci"));
});

test("the npm error marker knows both spellings and no other", () => {
  // npm 10 and older print "npm ERR!", npm 11 and newer "npm error".
  assert.equal(NPM_ERROR_PATTERN.test("npm ERR! x"), true);
  assert.equal(NPM_ERROR_PATTERN.test("npm error x"), true);

  // A warning is not an error.
  assert.equal(NPM_ERROR_PATTERN.test("npm warn x"), false);
  assert.equal(NPM_ERROR_PATTERN.test("npm warn deprecated x"), false);
});

test("the repair command is the one the module documents", () => {
  assert.match(REPAIR_COMMAND, /^run: npm install --package-lock-only --include=optional$/);
});
