// probes/test/bots-contract.test.mjs
//
// The contract every probe bot has to honour:
//
//   * the same descriptor shape, so that probes/run.mjs can drive all of them
//   * a clean skip when the CLI is missing: no throw, a result, every probed
//     step marked as "not probed" and a note that names the missing binary
//   * a result that survives the redaction of probes/lib/redact.mjs
//   * no side effect outside the scratch directory of the probe
//
// No CLI is ever started here: the PATH of the probe points at an empty
// directory and the binary override of the probe points at a missing file, so
// nothing is executed and no network is touched.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

import { createRedactor } from "../lib/redact.mjs";
import { createResult, markNotProbed } from "../lib/result.mjs";

import * as agyModule from "../bots/agy.mjs";
import * as claudeModule from "../bots/claude.mjs";
import * as codexModule from "../bots/codex.mjs";
import * as dshModule from "../bots/dsh.mjs";
import * as piModule from "../bots/pi.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

// The scratch area of the suite: the repository relative .tmp/ directory.
const scratchRoot = join(repoRoot, ".tmp");

const MODULES = [codexModule, claudeModule, dshModule, piModule, agyModule];

/** The fields probes/run.mjs reads from a probe descriptor. */
const REQUIRED_FIELDS = ["id", "label", "command", "args", "protocol", "run"];

/** Token shapes that must never survive in a probe result. */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
];

/** Directories that are scratch space of the harness and not of a probe. */
const IGNORED_PATHS = [".git", ".tmp", ".swrm-tmp", "node_modules", "probes/.tmp"];

mkdirSync(scratchRoot, { recursive: true });

// The work tree before the first probe runs: nothing may change during the
// suite.
const initialSnapshot = snapshot(repoRoot);

after(() => {
  // The scratch area is empty again, the directory itself is not tracked.
  try {
    rmdirSync(scratchRoot);
  } catch {
    /* not empty */
  }
});

/**
 * The environment variable that overrides the binary lookup of a probe.
 *
 * @param {string} command
 */
function overrideKey(command) {
  return `VOLTO_PROBE_${command.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BIN`;
}

/**
 * @param {string} text
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Set environment variables for the duration of a test.
 *
 * @param {import("node:test").TestContext} t
 * @param {Record<string, string>} vars
 */
function setEnv(t, vars) {
  /** @type {Map<string, string|undefined>} */
  const previous = new Map();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/**
 * @param {string} rel
 */
function isIgnored(rel) {
  return IGNORED_PATHS.some((entry) => rel === entry || rel.startsWith(`${entry}/`));
}

/**
 * A snapshot of the work tree: the files (with their size) and the
 * directories, so that a write can be detected.
 *
 * @param {string} root
 */
function snapshot(root) {
  /** @type {Map<string, number>} */
  const files = new Map();
  /** @type {Set<string>} */
  const dirs = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (isIgnored(rel)) continue;
      if (entry.isDirectory()) {
        dirs.add(rel);
        walk(full);
      } else if (entry.isFile()) {
        files.set(rel, statSync(full).size);
      }
    }
  };
  walk(root);
  return { files, dirs };
}

/**
 * Every file below a directory.
 *
 * @param {string} root
 */
function listFiles(root) {
  /** @type {string[]} */
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  walk(root);
  return found;
}

/**
 * Run a probe with a PATH that points at an empty directory, so that no CLI
 * can be found. The probe never throws and never starts a process.
 *
 * @param {typeof MODULES[number]} module
 * @param {import("node:test").TestContext} t
 */
async function runWithoutBinary(module, t) {
  const probe = module.probe;
  const scratch = mkdtempSync(join(scratchRoot, "t-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  // The PATH of the probe points at an empty directory.
  const binDir = join(scratch, "bin");
  const tmpDir = join(scratch, "tmp");
  const outDir = join(scratch, "out");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  // The fallback directories of probes/lib/binary.mjs may hold a real CLI, so
  // the override of the probe is used as well: it is authoritative and never
  // falls back to the PATH.
  setEnv(t, {
    PATH: binDir,
    [overrideKey(probe.command)]: join(binDir, probe.command),
  });

  /** @type {any[]} */
  const children = [];
  const ctx = {
    tmpDir,
    outDir,
    timeoutMs: 5_000,
    transcript: { record() {}, note() {} },
    redactor: createRedactor({ worktree: repoRoot, home: homedir() }),
    worktree: repoRoot,
    onChild: (child) => children.push(child),
  };

  const result = await probe.run(ctx);
  return { probe, result, scratch, tmpDir, outDir, children };
}

test("every bot module exports a probe descriptor with the fields the runner uses", () => {
  for (const module of MODULES) {
    const probe = module.probe;
    assert.ok(probe, "the module does not export a probe descriptor");
    for (const field of REQUIRED_FIELDS) {
      assert.ok(field in probe, `the probe descriptor has no ${field} field`);
    }
    assert.equal(typeof probe.id, "string");
    assert.ok(probe.id.length > 0, "the probe has no name");
    assert.equal(typeof probe.label, "string");
    assert.ok(probe.label.length > 0, "the probe has no label");
    assert.equal(typeof probe.command, "string");
    assert.ok(probe.command.length > 0, "the probe has no command");
    assert.ok(Array.isArray(probe.args), "the args of the probe are not a list");
    assert.ok(
      probe.args.every((arg) => typeof arg === "string"),
      "the args of the probe are not a list of strings",
    );
    assert.equal(typeof probe.protocol, "string");
    assert.ok(probe.protocol.length > 0, "the probe has no wire kind");
    assert.equal(typeof probe.run, "function");
  }
});

test("the probe descriptors are wired to the exported run function", () => {
  for (const module of MODULES) {
    assert.equal(typeof module.run, "function", "the module does not export run(ctx)");
    assert.equal(module.probe.run, module.run, "the descriptor does not use the exported run");
  }
});

test("the probes are registered under a unique name", () => {
  const ids = MODULES.map((module) => module.probe.id);
  assert.equal(new Set(ids).size, ids.length, "two probes share the same name");
  const labels = MODULES.map((module) => module.probe.label);
  assert.equal(new Set(labels).size, labels.length, "two probes share the same label");
  for (const id of ids) {
    // The runner derives the transcript name and the scratch directory from it.
    assert.match(id, /^[a-z][a-z0-9-]*$/, `"${id}" is not a safe file name`);
  }
});

test("every probe declares a wire kind and how its CLI is started", () => {
  for (const module of MODULES) {
    const probe = module.probe;
    assert.equal(typeof probe.protocol, "string");
    assert.ok(probe.protocol.trim().length > 0, `${probe.id} has no wire kind`);
    assert.ok(probe.args.length > 0, `${probe.id} does not declare the arguments of its CLI`);
    assert.ok(
      probe.args.every((arg) => !arg.includes(" ")),
      `${probe.id} passes an argument that contains a space`,
    );
  }
});

test("every probe run resolves without throwing when its CLI is missing", async (t) => {
  for (const module of MODULES) {
    await t.test(module.probe.id, async (t) => {
      const { probe, result } = await runWithoutBinary(module, t);
      assert.ok(result, `${probe.id} did not return a result`);
      assert.equal(typeof result, "object");
      assert.equal(result.status, "skipped");
    });
  }
});

test("a skipped probe returns the result shape of createResult", async (t) => {
  for (const module of MODULES) {
    await t.test(module.probe.id, async (t) => {
      const { probe, result } = await runWithoutBinary(module, t);
      const expected = createResult({ id: probe.id, label: probe.label, command: probe.command });
      // The reason is the only optional field of the result.
      assert.deepEqual(
        Object.keys(result).filter((key) => key !== "reason").sort(),
        Object.keys(expected).sort(),
      );
      assert.deepEqual(Object.keys(result.protocol).sort(), Object.keys(expected.protocol).sort());
      assert.deepEqual(Object.keys(result.auth).sort(), Object.keys(expected.auth).sort());
      assert.deepEqual(Object.keys(result.binary).sort(), Object.keys(expected.binary).sort());
      assert.equal(result.id, probe.id);
      assert.equal(result.label, probe.label);
      assert.equal(result.binary.command, probe.command);
      assert.equal(result.binary.available, false);
    });
  }
});

test("a skipped probe marks every probed step as not probed", async (t) => {
  for (const module of MODULES) {
    await t.test(module.probe.id, async (t) => {
      const { probe, result } = await runWithoutBinary(module, t);
      const expected = createResult({ id: probe.id, label: probe.label, command: probe.command });
      markNotProbed(expected);
      assert.equal(result.protocol.sessionCreate.supported, expected.protocol.sessionCreate.supported);
      assert.equal(result.protocol.streaming.granularity, expected.protocol.streaming.granularity);
      assert.equal(result.protocol.cancel.works, expected.protocol.cancel.works);
      assert.equal(result.protocol.resume.supported, expected.protocol.resume.supported);
      assert.equal(result.auth.state, expected.auth.state);
      for (const detail of [
        result.protocol.sessionCreate.detail,
        result.protocol.streaming.detail,
        result.protocol.cancel.detail,
        result.protocol.resume.detail,
        result.auth.evidence,
      ]) {
        assert.match(detail, /not probed/i, `${probe.id} does not explain why it was not probed`);
      }
      assert.equal(result.protocol.streaming.samples, 0);
      assert.deepEqual(result.timings, {
        initializeMs: null,
        sessionCreateMs: null,
        firstOutputMs: null,
        promptMs: null,
        cancelMs: null,
        totalMs: null,
      });
    });
  }
});

test("a skipped probe still describes its wire", async (t) => {
  for (const module of MODULES) {
    await t.test(module.probe.id, async (t) => {
      const { probe, result } = await runWithoutBinary(module, t);
      assert.equal(typeof result.protocol.name, "string");
      assert.ok(result.protocol.name.length > 0, `${probe.id} does not name its protocol`);
      assert.equal(result.protocol.transport, "stdio");
      assert.equal(result.protocol.framing, "newline-delimited JSON");
    });
  }
});

test("a skipped probe names the missing binary", async (t) => {
  for (const module of MODULES) {
    await t.test(module.probe.id, async (t) => {
      const { probe, result } = await runWithoutBinary(module, t);
      assert.match(result.reason ?? "", /binary not found/i, `${probe.id} does not report a missing binary`);
      assert.ok(Array.isArray(result.notes), `${probe.id} has no notes`);
      assert.ok(result.notes.length > 0, `${probe.id} has no note`);
      const notes = result.notes.join("\n");
      const named = new RegExp(`${escapeRegExp(probe.label)}|${escapeRegExp(probe.command)}`, "i");
      assert.match(notes, named, `${probe.id} does not name the missing binary in a note`);
    });
  }
});

test("a skipped probe never starts the CLI", async (t) => {
  for (const module of MODULES) {
    await t.test(module.probe.id, async (t) => {
      const { probe, children } = await runWithoutBinary(module, t);
      assert.deepEqual(children, [], `${probe.id} started a process`);
    });
  }
});

test("the result of a skipped probe survives the redaction", async (t) => {
  const home = homedir();
  for (const module of MODULES) {
    await t.test(module.probe.id, async (t) => {
      const { probe, result } = await runWithoutBinary(module, t);
      const redactor = createRedactor({ worktree: repoRoot, home });
      const raw = JSON.stringify(result);
      const redacted = JSON.stringify(redactor.value(result));
      if (home && home !== "/") {
        assert.ok(!raw.includes(home), `${probe.id} leaks the home path`);
        assert.ok(!redacted.includes(home), `${probe.id} leaks the home path`);
      }
      assert.ok(!redacted.includes(repoRoot), `${probe.id} leaks the work tree path`);
      for (const pattern of SECRET_PATTERNS) {
        assert.ok(!pattern.test(redacted), `${probe.id} leaks a token`);
      }
      assert.ok(redacted.includes("skipped"), `${probe.id} loses its status while it is redacted`);
    });
  }
});

test("a skipped probe writes nothing outside its scratch directory", async (t) => {
  for (const module of MODULES) {
    await t.test(module.probe.id, async (t) => {
      const { probe, scratch, tmpDir, outDir } = await runWithoutBinary(module, t);

      // Everything the probe wrote has to live below ctx.tmpDir.
      const outside = listFiles(scratch).filter((file) => !file.startsWith(tmpDir + sep));
      assert.deepEqual(outside, [], `${probe.id} wrote outside of its scratch directory`);
      assert.deepEqual(listFiles(outDir), [], `${probe.id} wrote outside of its scratch directory`);
    });
  }

  // The work tree must be untouched by the whole suite.
  const after = snapshot(repoRoot);
  assert.deepEqual([...after.files.keys()].sort(), [...initialSnapshot.files.keys()].sort());
  assert.deepEqual([...after.dirs].sort(), [...initialSnapshot.dirs].sort());
  for (const [file, size] of initialSnapshot.files) {
    assert.equal(after.files.get(file), size, `${file} changed while the probes ran`);
  }
});
