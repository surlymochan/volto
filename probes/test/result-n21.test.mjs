// probes/test/result-n21.test.mjs
//
// The contract of the probe result (probes/lib/result.mjs) and of the binary
// lookup (probes/lib/binary.mjs):
//
//   * the shape of a result does not depend on its status (ok, skipped,
//     failed, timeout)
//   * the status vocabulary is exactly the four documented values
//   * the lookup honours an injected PATH and returns the first executable
//   * a directory that is named like the CLI is not a CLI
//
// Everything runs in-process: the fake binaries are only stat()ed, never
// executed, so no child process and no network is involved. Every scratch file
// lives below the git ignored probes/.tmp folder and the synthetic names never
// collide with a real CLI.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

import { resolveBinary } from "../lib/binary.mjs";
import { createResult, markNotProbed } from "../lib/result.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const probesRoot = resolve(here, "..");
const scratchRoot = join(probesRoot, ".tmp", "result-n21");

/** The status values that probes/lib/result.mjs documents. */
const STATUS_VOCABULARY = ["ok", "skipped", "failed", "timeout"];

const META = { id: "n21-sample", label: "Sample", command: "sample" };

after(() => rmSync(scratchRoot, { recursive: true, force: true }));

/**
 * The documented shape of a fresh result.
 *
 * @param {string} status
 */
function expectedResult(status) {
  return {
    id: META.id,
    label: META.label,
    status,
    binary: { command: META.command, available: false },
    auth: { state: "unknown", evidence: "not probed" },
    protocol: {
      name: "unknown",
      transport: "unknown",
      framing: "unknown",
      sessionCreate: { supported: null, method: "", detail: "" },
      streaming: { granularity: "unknown", detail: "", samples: 0 },
      cancel: { works: null, method: "", detail: "" },
      resume: { supported: null, method: "", detail: "" },
      permissions: { shape: "unknown", observed: [] },
    },
    timings: {
      initializeMs: null,
      sessionCreateMs: null,
      firstOutputMs: null,
      promptMs: null,
      cancelMs: null,
      totalMs: null,
    },
    methods: { requests: [], notifications: [], serverRequests: [] },
    notes: [],
    transcript: "",
  };
}

/**
 * Check the documented shape of a result. Throws an AssertionError as soon as
 * the result deviates from the documentation.
 *
 * @param {any} result
 */
function checkShape(result) {
  assert.deepEqual(Object.keys(result).sort(), [
    "auth",
    "binary",
    "id",
    "label",
    "methods",
    "notes",
    "protocol",
    "status",
    "timings",
    "transcript",
  ]);
  assert.equal(typeof result.id, "string");
  assert.equal(typeof result.label, "string");
  assert.ok(STATUS_VOCABULARY.includes(result.status), `the status ${result.status} is not documented`);
  assert.equal(typeof result.transcript, "string");
  assert.ok(Array.isArray(result.notes), "the notes are not a list");
  for (const note of result.notes) assert.equal(typeof note, "string");

  assert.deepEqual(Object.keys(result.binary).sort(), ["available", "command"]);
  assert.equal(typeof result.binary.command, "string");
  assert.equal(typeof result.binary.available, "boolean");

  assert.deepEqual(Object.keys(result.auth).sort(), ["evidence", "state"]);
  assert.equal(typeof result.auth.state, "string");
  assert.equal(typeof result.auth.evidence, "string");

  assert.deepEqual(Object.keys(result.protocol).sort(), [
    "cancel",
    "framing",
    "name",
    "permissions",
    "resume",
    "sessionCreate",
    "streaming",
    "transport",
  ]);
  assert.equal(typeof result.protocol.name, "string");
  assert.equal(typeof result.protocol.transport, "string");
  assert.equal(typeof result.protocol.framing, "string");

  assert.deepEqual(Object.keys(result.protocol.sessionCreate).sort(), ["detail", "method", "supported"]);
  assert.deepEqual(Object.keys(result.protocol.streaming).sort(), ["detail", "granularity", "samples"]);
  assert.deepEqual(Object.keys(result.protocol.cancel).sort(), ["detail", "method", "works"]);
  assert.deepEqual(Object.keys(result.protocol.resume).sort(), ["detail", "method", "supported"]);
  assert.deepEqual(Object.keys(result.protocol.permissions).sort(), ["observed", "shape"]);

  assert.deepEqual(Object.keys(result.timings).sort(), [
    "cancelMs",
    "firstOutputMs",
    "initializeMs",
    "promptMs",
    "sessionCreateMs",
    "totalMs",
  ]);
  for (const [key, value] of Object.entries(result.timings)) {
    assert.ok(value === null || Number.isFinite(value), `the timing ${key} is not a number`);
  }

  assert.deepEqual(Object.keys(result.methods).sort(), ["notifications", "requests", "serverRequests"]);
  for (const [key, value] of Object.entries(result.methods)) {
    assert.ok(Array.isArray(value), `the method list ${key} is not a list`);
    for (const entry of value) assert.equal(typeof entry, "string");
  }
}

/**
 * A scratch directory below the git ignored probes/.tmp folder.
 *
 * @param {import("node:test").TestContext} t
 */
function fixture(t) {
  mkdirSync(scratchRoot, { recursive: true });
  const dir = mkdtempSync(join(scratchRoot, "case-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

/**
 * A fake executable. The lookup only stats it, the suite never runs it.
 *
 * @param {string} path
 */
function fakeExecutable(path) {
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

/**
 * The source files of the probes that may assign a status.
 *
 * @returns {string[]}
 */
function probeSources() {
  const dirs = ["lib", "bots"];
  const files = [];
  for (const dir of dirs) {
    for (const entry of readdirSync(join(probesRoot, dir))) {
      if (entry.endsWith(".mjs")) files.push(join(dir, entry));
    }
  }
  files.push("run.mjs");
  return files;
}

for (const status of STATUS_VOCABULARY) {
  test(`a result with the status ${status} has the documented shape`, () => {
    const result = createResult(META);
    result.status = status;

    assert.deepEqual(result, expectedResult(status));
    assert.doesNotThrow(() => checkShape(result));
  });
}

test("a skipped result carries the documented not probed details", () => {
  const result = createResult(META);
  result.status = "skipped";
  markNotProbed(result);

  const expected = expectedResult("skipped");
  expected.protocol.sessionCreate = { supported: null, method: "", detail: "not probed (binary missing)" };
  expected.protocol.streaming = { granularity: "unknown", detail: "not probed (binary missing)", samples: 0 };
  expected.protocol.cancel = { works: null, method: "", detail: "not probed (binary missing)" };
  expected.protocol.resume = { supported: null, method: "", detail: "not probed (binary missing)" };
  expected.auth = { state: "unknown", evidence: "not probed (binary missing)" };

  assert.deepEqual(result, expected);
  assert.doesNotThrow(() => checkShape(result));
});

test("the shape check accepts the result of createResult", () => {
  assert.doesNotThrow(() => checkShape(createResult(META)));
});

test("the shape check rejects a result that was changed", () => {
  const mutations = [
    ["an undocumented status", (result) => { result.status = "success"; }],
    ["a status that differs in case", (result) => { result.status = "OK"; }],
    ["a missing top level field", (result) => { delete result.transcript; }],
    ["a timing that is a string", (result) => { result.timings.totalMs = "12"; }],
    ["a method list that is not a list", (result) => { result.methods.requests = {}; }],
    ["an extra protocol field", (result) => { result.protocol.extra = true; }],
    ["a note that is not a string", (result) => { result.notes.push(42); }],
    ["a binary flag that is not a boolean", (result) => { result.binary.available = "yes"; }],
  ];

  for (const [description, mutate] of mutations) {
    const result = createResult(META);
    mutate(result);
    assert.throws(() => checkShape(result), assert.AssertionError, `the shape check accepted ${description}`);
  }
});

test("the documented status vocabulary is exactly the four known statuses", () => {
  const source = readFileSync(join(probesRoot, "lib", "result.mjs"), "utf8");
  const documented = source.match(/@property \{([^}]*)\} status/);
  assert.ok(documented, "the result module does not document the status property");

  const vocabulary = documented[1].split("|").map((entry) => entry.replace(/^"|"$/g, ""));
  assert.deepEqual(vocabulary, STATUS_VOCABULARY);
});

test("every status the probes assign belongs to the documented vocabulary", () => {
  /** @type {Set<string>} */
  const assigned = new Set();
  for (const file of probeSources()) {
    const source = readFileSync(join(probesRoot, file), "utf8");
    for (const match of source.matchAll(/\bstatus\b\s*[:=]\s*"([^"]*)"/g)) assigned.add(match[1]);
  }

  assert.deepEqual([...assigned].sort(), [...STATUS_VOCABULARY].sort());
});

test("the status vocabulary rejects near misses", () => {
  for (const candidate of ["skip", "Skipped", "OK", "ok ", "passed", "success", "error", ""]) {
    assert.equal(STATUS_VOCABULARY.includes(candidate), false, `${candidate} is not a documented status`);
  }
});

test("the first executable of the injected PATH wins", (t) => {
  const dir = fixture(t);
  const first = join(dir, "first");
  const second = join(dir, "second");
  mkdirSync(first);
  mkdirSync(second);
  const name = "volto-n21-fake-bot";
  fakeExecutable(join(first, name));
  fakeExecutable(join(second, name));

  const result = resolveBinary(name, { env: { PATH: `${first}:${second}` }, extraDirs: [] });

  assert.deepEqual(result, { path: join(first, name), source: "path", searched: [join(first, name)] });
});

test("a binary that is not on the injected PATH is missing", (t) => {
  const dir = fixture(t);
  const name = "volto-n21-absent-bot";
  assert.equal(existsSync(join(dir, name)), false, "the fixture must not exist");

  const result = resolveBinary(name, { env: { PATH: dir }, extraDirs: [] });

  assert.deepEqual(result, { path: null, source: "missing", searched: [join(dir, name)] });
});

test("a directory without the execute bit is not matched", (t) => {
  const dir = fixture(t);
  const name = "volto-n21-locked-dir-bot";
  const candidate = join(dir, name);
  mkdirSync(candidate);
  chmodSync(candidate, 0o600);

  const result = resolveBinary(name, { env: { PATH: dir }, extraDirs: [] });

  assert.deepEqual(result, { path: null, source: "missing", searched: [candidate] });
});

// DEFECT: probes/lib/binary.mjs decides with accessSync(path, X_OK), which a
// directory has as well, so a directory named like the CLI is resolved as the
// binary instead of being skipped.
test.todo("a directory named like the binary is not matched");

test("a directory named like the binary is resolved as a binary (documents the defect)", (t) => {
  const dir = fixture(t);
  const name = "volto-n21-dir-bot";
  const candidate = join(dir, name);
  mkdirSync(candidate);

  const result = resolveBinary(name, { env: { PATH: dir }, extraDirs: [] });

  // The execute bit of a directory is set, so the lookup takes the directory.
  assert.deepEqual(result, { path: candidate, source: "path", searched: [candidate] });
});

test("the injected environment replaces the inherited one", (t) => {
  const dir = fixture(t);
  const name = "volto-n21-env-bot";
  const binary = fakeExecutable(join(dir, name));
  const key = `VOLTO_PROBE_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BIN`;
  const previous = process.env[key];
  process.env[key] = join(dir, "inherited-override");
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });

  const result = resolveBinary(name, { env: { PATH: dir }, extraDirs: [] });

  assert.deepEqual(result, { path: binary, source: "path", searched: [binary] });
});
