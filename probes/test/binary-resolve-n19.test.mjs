// probes/test/binary-resolve-n19.test.mjs
//
// Focused tests for the binary lookup helper (probes/lib/binary.mjs).
//
// The helper only stats files, so the fixtures are fake programs that are
// never executed: the whole suite stays in-process, without a child process
// and without touching a real PATH. Every scratch file lives below the
// repository .tmp folder (probes/.tmp is git ignored) and the synthetic
// binary names never collide with a real CLI.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FALLBACK_DIRS, resolveBinary } from "../lib/binary.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const tmpRoot = join(here, "..", ".tmp", "binary-resolve-n19");

/** Create a scratch directory below the repository .tmp folder. */
function fixture(t) {
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, "case-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

/** A fake executable. It is only stat()ed by the helper, never run. */
function fakeExecutable(path) {
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

/** A readable file without any execute bit. */
function fakePlainFile(path) {
  writeFileSync(path, "not a program\n");
  chmodSync(path, 0o644);
  return path;
}

test("a binary in the PATH directory is resolved to its full path", (t) => {
  const dir = fixture(t);
  const name = "volto-n19-fake-bot";
  const binary = fakeExecutable(join(dir, name));

  const result = resolveBinary(name, { env: { PATH: dir } });

  assert.equal(result.path, binary);
  assert.equal(result.source, "path");
  assert.ok(isAbsolute(result.path), "the resolved path is not absolute");
  assert.deepEqual(result.searched, [binary]);
});

test("a missing binary resolves to no path", (t) => {
  const dir = fixture(t);
  const name = "volto-n19-absent-bot";
  assert.equal(existsSync(join(dir, name)), false, "the fixture must not exist");

  const result = resolveBinary(name, { env: { PATH: dir } });

  assert.equal(result.path, null);
  assert.equal(result.source, "missing");
  // The PATH directory comes first, the fallback directories are searched after it.
  assert.deepEqual(result.searched, [join(dir, name), ...FALLBACK_DIRS.map((fallback) => join(fallback, name))]);
});

test("a non-executable file is not resolved", (t) => {
  const dir = fixture(t);
  const name = "volto-n19-plain-file";
  const candidate = fakePlainFile(join(dir, name));
  assert.equal(existsSync(candidate), true, "the fixture must exist");

  const result = resolveBinary(name, { env: { PATH: dir } });

  assert.equal(result.path, null);
  assert.equal(result.source, "missing");
  assert.deepEqual(result.searched, [candidate, ...FALLBACK_DIRS.map((fallback) => join(fallback, name))]);
});

test("an empty PATH falls back to the fallback directories", () => {
  const name = "volto-n19-absent-fallback";

  let result;
  assert.doesNotThrow(() => {
    result = resolveBinary(name, { env: { PATH: "" } });
  });

  assert.equal(result.path, null);
  assert.equal(result.source, "missing");
  assert.deepEqual(result.searched, FALLBACK_DIRS.map((dir) => join(dir, name)));
});

test("the fallback directories are absolute paths", () => {
  assert.ok(FALLBACK_DIRS.length > 0, "there are no fallback directories");
  for (const dir of FALLBACK_DIRS) {
    assert.equal(typeof dir, "string");
    assert.ok(isAbsolute(dir), `${dir} is not an absolute path`);
  }
});
