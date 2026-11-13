// scripts/test/install-botd-selftest.test.mjs
//
// The wrapper of the offline self test of the installer.
//
// scripts/botd-selftest.sh exercises scripts/install-botd.sh against fake
// ssh, rsync, node, uname and curl shims. Nothing in the node test run
// called it, so a broken installer stayed green. This file runs the self
// test, checks the safety rules of the installer that the self test does
// not cover and checks the two invocations of the installer that cannot
// reach a host: --help and a run without an alias.
//
// No host is ever contacted: the runs that could reach one get a PATH that
// holds a fake ssh which records every call.
//
// The argument parsing of the installer is covered by
// scripts/test/install-botd-args.test.mjs and is not repeated here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const installer = join(repoRoot, "scripts", "install-botd.sh");

/** The bash of the host: the installer and the self test are bash scripts. */
function findBash() {
  const found = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" });
  if (found.error || found.status !== 0) return null;
  const path = (found.stdout ?? "").trim().split("\n")[0];
  return path && existsSync(path) ? path : null;
}

const bash = process.platform === "win32" ? null : findBash();

// The suite needs a posix host with bash.
const skip =
  process.platform === "win32"
    ? "the installer needs bash"
    : bash === null
      ? "bash is not installed"
      : false;

// Scratch space for the fixtures: inside the worktree, below botd/.tmp
// (botd/.gitignore already ignores it).
const scratch = join(repoRoot, "botd", ".tmp", "install-selftest");
mkdirSync(scratch, { recursive: true });

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Read a shell script: the commands it runs here, the bodies of the
 * heredocs it carries (the script that runs on the host, the help text) and
 * nothing else. The comments are data as well and are left out.
 */
function scanScript(script) {
  const commands = [];
  const bodies = new Map();
  let heredoc = null;
  for (const line of script.split("\n")) {
    if (heredoc !== null) {
      if (line.trim() === heredoc) {
        heredoc = null;
        continue;
      }
      if (!line.trim().startsWith("#")) {
        bodies.set(heredoc, [...(bodies.get(heredoc) ?? []), line]);
      }
      continue;
    }
    const opened = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    if (opened) heredoc = opened[1];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    commands.push(line);
  }
  return { commands, bodies };
}

/** The header of a shell script: the comment block at the top of it. */
function usageHeader(script) {
  const header = [];
  for (const line of script.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("#")) break;
    header.push(line);
  }
  return header.join("\n");
}

/**
 * Write a fake ssh into a fresh directory: it records every call and never
 * reaches a host. The directory holds nothing else.
 */
function fakeSshDirectory(prefix) {
  const directory = mkdtempSync(join(scratch, prefix));
  const log = join(directory, "ssh.log");
  writeFileSync(
    join(directory, "ssh"),
    ["#!/bin/sh", "# Fake ssh: records the call, never reaches a host.", `printf '%s\\n' "$*" >> '${log}'`, ""].join("\n"),
  );
  chmodSync(join(directory, "ssh"), 0o755);
  return { directory, log };
}

/** The calls the fake ssh recorded: none, when the log is missing. */
function sshCalls(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

// The result of the self test: it is expensive, so it runs once.
let selfTestResult = null;

/** Run the offline self test of the installer from the root of the repo. */
function runSelfTest() {
  if (selfTestResult === null) {
    selfTestResult = spawnSync(bash, ["scripts/botd-selftest.sh"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120_000,
    });
  }
  return selfTestResult;
}

describe("the offline self test of the installer", () => {
  test("the self test passes", { skip }, () => {
    const result = runSelfTest();
    assert.equal(result.error, undefined, `the self test did not run: ${result.error}`);
    assert.equal(result.signal, null, "the self test was killed");
    assert.equal(result.status, 0, `the self test failed:\n${result.stdout}\n${result.stderr}`);
  });

  test("the self test reports no failed case", { skip }, () => {
    const result = runSelfTest();
    const summary = /(\d+) checks, (\d+) failures/.exec(result.stdout ?? "");
    assert.ok(summary, `the self test printed no summary:\n${result.stdout}`);
    assert.ok(Number(summary[1]) > 0, "the self test ran no check");
    assert.equal(summary[2], "0", `the self test reported failures:\n${result.stdout}`);
    assert.doesNotMatch(result.stdout, /^not ok /m, "the self test printed a failed case");
  });
});

describe("the safety rules of the installer", () => {
  const source = readFileSync(installer, "utf8");
  const { commands, bodies } = scanScript(source);
  // The script that runs on the host: it is carried by the installer.
  const remote = bodies.get("REMOTE_EOF") ?? [];

  test("the installer never runs sudo", { skip }, () => {
    const offenders = commands.filter((line) => /\bsudo\b/.test(line));
    assert.deepEqual(offenders, [], "the installer runs sudo");
  });

  test("the script that runs on the host never runs sudo", { skip }, () => {
    assert.ok(remote.length > 0, "the installer carries no script for the host");
    const offenders = remote.filter((line) => /\bsudo\b/.test(line));
    assert.deepEqual(offenders, [], "the script of the host runs sudo");
  });

  test("the installer stops on the first error", { skip }, () => {
    assert.match(source, /^set -euo pipefail$/m);
  });

  test("the installer never dumps the environment", { skip }, () => {
    assert.doesNotMatch(source, /\bprintenv\b/);
    const dumps = [...commands, ...remote].filter((line) =>
      /(?:^|[;&|(]|\bthen\b|\bdo\b|\$\()\s*env\b/.test(line),
    );
    assert.deepEqual(dumps, [], "the installer dumps the environment");
  });

  test("the installer never pipes a download into a shell", { skip }, () => {
    const piped = source
      .split("\n")
      .filter((line) => /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|k|fi|d)?sh\b/.test(line));
    assert.deepEqual(piped, [], "the installer pipes a download into a shell");

    // Every download is written to a file that is used afterwards.
    const downloads = [...commands, ...remote].filter((line) => /^\s*(?:curl|wget)\s/.test(line));
    assert.ok(downloads.length > 0, "the installer downloads nothing");
    for (const line of downloads) {
      assert.match(line, /(?:^|\s)(?:-o|-O)\s+"?\$/, `the download is not written to a file: ${line}`);
    }
  });

  test("the usage header documents --dry-run", { skip }, () => {
    const header = usageHeader(source);
    assert.match(header, /Usage:/);
    assert.match(header, /--dry-run/);
  });
});

describe("the invocations of the installer that cannot reach a host", () => {
  test("--help prints the usage", { skip }, () => {
    const { directory, log } = fakeSshDirectory("help-");
    const result = spawnSync(bash, ["scripts/install-botd.sh", "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /--dry-run/);
    assert.deepEqual(sshCalls(log), [], "--help contacted a host");
  });

  test("without an alias the installer fails without contacting a host", { skip }, () => {
    const { directory, log } = fakeSshDirectory("no-alias-");
    const result = spawnSync(bash, ["scripts/install-botd.sh"], {
      cwd: repoRoot,
      encoding: "utf8",
      // The PATH holds the fake ssh and nothing else: no tool of the host
      // and no real ssh is reachable.
      env: { ...process.env, PATH: directory },
    });
    assert.notEqual(result.status, 0, "the installer accepted a run without an alias");
    assert.ok((result.stderr ?? "").trim().length > 0, "the installer printed no message");
    assert.doesNotMatch(result.stdout, /plan: install botd on/, "the installer started an installation");
    assert.deepEqual(sshCalls(log), [], "the installer contacted a host");
  });

  test("without an alias the installer names the missing alias", { skip }, () => {
    const { directory, log } = fakeSshDirectory("no-alias-tools-");
    const result = spawnSync(bash, ["scripts/install-botd.sh"], {
      cwd: repoRoot,
      encoding: "utf8",
      // The tools of the host stay reachable, the fake ssh shadows the real
      // one.
      env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ""}` },
    });
    assert.notEqual(result.status, 0, "the installer accepted a run without an alias");
    assert.match(result.stderr, /ssh-alias/);
    assert.deepEqual(sshCalls(log), [], "the installer contacted a host");
  });
});
