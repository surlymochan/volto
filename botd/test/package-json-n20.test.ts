import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const required = ["package.json", "botd/package.json", "botd/e2e/package.json", "botd/test/package.json"];
const paths = [...required, ...["client-ui/package.json"].filter((path) => existsSync(resolve(root, path)))];
type Manifest = Record<string, any>;
type Entry = { path: string; pkg: Manifest };

function parseManifest(text: string): Manifest {
  const value = JSON.parse(text);
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value;
}

function checkModules(entries: Entry[]): void {
  for (const { path, pkg } of entries) {
    if (["botd/package.json", "botd/e2e/package.json", "botd/test/package.json"].includes(path)) {
      assert.equal(pkg.type, "module", path);
    }
  }
}

function checkEngines(entries: Entry[]): void {
  const floors = entries.filter(({ pkg }) => pkg.engines?.node !== undefined)
    .map(({ pkg }) => pkg.engines.node);
  assert.notEqual(floors.length, 0);
  for (const floor of floors) assert.equal(floor, ">=22.18.0");
}

function checkScripts(entries: Entry[], exists: (path: string) => boolean): void {
  for (const { path, pkg } of entries) {
    for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
      assert.equal(typeof script, "string", `${path}: ${name}`);
      const tokens = (script as string).match(/(?:"[^"]*"|'[^']*'|&&|\|\||[;&|]|[^\s;&|]+)/g) ?? [];
      for (let i = 0; i < tokens.length - 1; i++) {
        if (tokens[i] !== "node" || tokens[i + 1] !== "--test") continue;
        for (let j = i + 2; j < tokens.length && !["&&", "||", ";", "|", "&"].includes(tokens[j]); j++) {
          const target = tokens[j].replace(/^(['"])(.*)\1$/, "$2");
          if (target.startsWith("-")) continue;
          const wildcard = target.search(/[*?\[\]{}]/);
          const prefix = target.slice(0, wildcard);
          const base = wildcard < 0 ? target : prefix.endsWith("/") ? prefix : dirname(prefix);
          assert.equal(exists(resolve(root, dirname(path), base)), true, `${path}: ${name}: ${target}`);
        }
      }
    }
  }
}

function checkDependencies(entries: Entry[]): void {
  for (const { path, pkg } of entries) {
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, version] of Object.entries(pkg[section] ?? {})) {
        assert.equal(typeof version, "string", `${path}: ${section}.${name}`);
        assert.notEqual(version, "*", `${path}: ${section}.${name}`);
        assert.notEqual(version, "latest", `${path}: ${section}.${name}`);
      }
    }
  }
}

function checkPrivate(entries: Entry[]): void {
  for (const { path, pkg } of entries) {
    if (["botd/e2e/package.json", "botd/test/package.json"].includes(path)) assert.equal(pkg.private, true, path);
  }
}

function cleanTest(name: string, fn: () => void): void {
  test(name, (t) => {
    const original = { ...process.env };
    process.env = {};
    t.after(() => { process.env = original; });
    fn();
  });
}

cleanTest("manifests are valid JSON and ESM packages declare module type", () => {
  const entries = paths.map((path) => ({ path, pkg: parseManifest(readFileSync(resolve(root, path), "utf8")) }));
  checkModules(entries);
  assert.throws(() => parseManifest('{"type":'));
  assert.throws(() => checkModules([{ path: "botd/package.json", pkg: { type: "commonjs" } }]));
});

cleanTest("declared Node engine floors agree exactly", () => {
  const entries = paths.map((path) => ({ path, pkg: parseManifest(readFileSync(resolve(root, path), "utf8")) }));
  checkEngines(entries);
  assert.throws(() => checkEngines([{ path: "fixture", pkg: { engines: { node: ">=22" } } }]));
  assert.throws(() => checkEngines([{ path: "fixture", pkg: { engines: { node: 22 } } }]));
});

cleanTest("node test script paths and glob bases exist", () => {
  const entries = paths.map((path) => ({ path, pkg: parseManifest(readFileSync(resolve(root, path), "utf8")) }));
  checkScripts(entries, existsSync);
  const fixture = [{ path: "botd/package.json", pkg: { scripts: { test: "node --test missing/test.ts" } } }];
  assert.throws(() => checkScripts(fixture, () => false));
  assert.doesNotThrow(() => checkScripts([{ path: "botd/package.json", pkg: { scripts: { test: "node --test test/*.ts" } } }], (path) => path === resolve(root, "botd/test")));
});

cleanTest("dependency versions avoid floating wildcard and latest tags", () => {
  const entries = paths.map((path) => ({ path, pkg: parseManifest(readFileSync(resolve(root, path), "utf8")) }));
  checkDependencies(entries);
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const version of ["*", "latest"]) {
      assert.throws(() => checkDependencies([{ path: "fixture", pkg: { [section]: { example: version } } }]));
    }
  }
});

cleanTest("e2e and test packages are private", () => {
  const entries = paths.map((path) => ({ path, pkg: parseManifest(readFileSync(resolve(root, path), "utf8")) }));
  checkPrivate(entries);
  for (const path of ["botd/e2e/package.json", "botd/test/package.json"]) {
    assert.throws(() => checkPrivate([{ path, pkg: { private: false } }]));
  }
});
