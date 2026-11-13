import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const manifest = () => JSON.parse(read("package.json"));

function githubSlug(value) {
  assert.equal(typeof value, "string");
  const match = value.match(/^(?:git\+)?(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/#?]+?)(?:\.git)?\/?(?:[?#].*)?$/i);
  assert.ok(match, `Expected a GitHub repository URL: ${value}`);
  return `${match[1]}/${match[2]}`.toLowerCase();
}

test("package.json parses as an object with the reserved name", () => {
  const pkg = manifest();
  assert.ok(pkg && typeof pkg === "object" && !Array.isArray(pkg));
  assert.equal(pkg.name, "@surlymochan/volto");
});

test("package version is valid semver", () => {
  assert.match(manifest().version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
});

test("main points to the existing placeholder entry point", () => {
  assert.equal(manifest().main, "index.js");
  assert.ok(existsSync(resolve(root, manifest().main)));
});

test("license is the MIT SPDX identifier and agrees with LICENSE when present", () => {
  const { license } = manifest();
  assert.equal(license, "MIT");
  if (existsSync(resolve(root, "LICENSE"))) {
    assert.match(read("LICENSE").split(/\r?\n/, 1)[0], /\bMIT\b/i);
  }
});

test("repository, homepage, and optional bugs URLs identify the same GitHub repository", () => {
  const pkg = manifest();
  const repository = githubSlug(pkg.repository?.url);
  assert.equal(githubSlug(pkg.homepage), repository);
  if (pkg.bugs !== undefined) {
    assert.equal(githubSlug(typeof pkg.bugs === "string" ? pkg.bugs : pkg.bugs?.url), repository);
  }
});

test("index.js enables strict mode and exports an object", () => {
  const source = read("index.js");
  assert.match(source, /^\s*(['"])use strict\1\s*;/);
  assert.match(source, /\bmodule\.exports\s*=\s*\{\s*\}\s*;/);
});

test("both project READMEs name volto", () => {
  assert.match(read("python/README.md"), /\bvolto\b/i);
  assert.match(read("README.md"), /\bvolto\b/i);
});

test("the placeholder does not run install lifecycle scripts", () => {
  const scripts = manifest().scripts ?? {};
  assert.equal(Object.hasOwn(scripts, "preinstall"), false);
  assert.equal(Object.hasOwn(scripts, "postinstall"), false);
});

test("every explicitly packaged path exists", () => {
  const { files } = manifest();
  if (files !== undefined) {
    assert.ok(Array.isArray(files));
    for (const path of files) {
      assert.equal(typeof path, "string");
      assert.ok(existsSync(resolve(root, path)), `Missing packaged path: ${path}`);
    }
  }
});
