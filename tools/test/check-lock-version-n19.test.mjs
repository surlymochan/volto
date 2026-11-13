import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, parseVersion } from "../check-lock.mjs";

test("parses plain and v-prefixed versions", () => {
  const expected = { major: 1, minor: 2, patch: 3, prerelease: [] };
  assert.deepEqual(parseVersion("1.2.3"), expected);
  assert.deepEqual(parseVersion("v1.2.3"), expected);
});

test("rejects invalid version text", () => {
  assert.equal(parseVersion("x.y"), null);
});

test("a prerelease sorts below its release", () => {
  assert.equal(compareVersions(parseVersion("1.2.3-beta.1"), parseVersion("1.2.3")), -1);
});

test("version comparison is antisymmetric", () => {
  for (const [left, right] of [
    ["1.0.0", "2.0.0"],
    ["1.2.3-beta.1", "1.2.3-beta.2"],
    ["1.2.3", "1.2.3"],
  ]) {
    const forward = compareVersions(parseVersion(left), parseVersion(right));
    const reverse = compareVersions(parseVersion(right), parseVersion(left));
    assert.equal(forward + reverse, 0);
  }
});

test("version components are compared numerically", () => {
  assert.equal(compareVersions(parseVersion("1.10.0"), parseVersion("1.9.0")), 1);
});
