import assert from "node:assert/strict";
import test from "node:test";
import { defaultHosts, ensureHostsFile, hostsPath, isValidAlias, parseHosts } from "../electron/paths.mjs";

test("hosts file lives in the user-data directory", () => {
  assert.equal(hostsPath("/app-data"), "/app-data/hosts.json");
  assert.deepEqual(defaultHosts(), []);
});

test("create-if-missing initializes an empty list without replacing an existing file", () => {
  const files = new Map<string, string>();
  const fs = {
    mkdirSync(path: string, options: { recursive: boolean }) { assert.equal(path, "/app-data"); assert.equal(options.recursive, true); },
    writeFileSync(path: string, contents: string, options: { flag: string; mode: number }) {
      assert.equal(options.flag, "wx"); assert.equal(options.mode, 0o600);
      if (files.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      files.set(path, contents);
    },
  };
  const path = ensureHostsFile(fs, "/app-data");
  assert.deepEqual(JSON.parse(files.get(path)!), []);
  files.set(path, "existing");
  ensureHostsFile(fs, "/app-data");
  assert.equal(files.get(path), "existing");
  assert.throws(() => ensureHostsFile({ ...fs, writeFileSync() { throw new Error("denied"); } }, "/app-data"), /denied/);
});

test("aliases match the relay's SSH alias rules", () => {
  for (const alias of ["work", "_a", "a.b-c_1"]) assert.equal(isValidAlias(alias), true);
  for (const alias of ["", "-a", ".a", "a b", "a/b", "a@b", "a\n", null]) assert.equal(isValidAlias(alias), false);
});

test("host configuration accepts SSH aliases only", () => {
  assert.deepEqual(parseHosts('[{"alias":"work","label":"Work"}]'), [{ alias: "work", label: "Work" }]);
  for (const input of ['{}', '[{"alias":"-bad"}]', '[{"alias":"work","command":["run"]}]', '[{"alias":"work","label":1}]', '[null]', 'invalid']) {
    assert.throws(() => parseHosts(input));
  }
});
