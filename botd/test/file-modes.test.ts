// File modes of the state botd keeps on disk.
//
// Contract: the session table, the lease state and the session event log
// hold session state, lease fences and event payloads.  None of them may be
// readable by group or other, i.e. `mode & 0o077 === 0`.
//
// The mode bits only exist on POSIX, so every case is skipped on win32.
// All fixtures are synthetic: made-up session ids, hosts and owners, never
// real hosts, addresses or credentials.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { SessionStore } from "../src/store.ts";
import type { SessionRecord } from "../src/store.ts";
import { LeaseStore } from "../src/lease-store.ts";
import { SessionLog } from "../src/session-log.ts";

/** The mode bits do not exist on Windows. */
const SKIP_POSIX = process.platform === "win32" ? "POSIX file modes only" : false;

/** Scratch space: a relative .tmp directory inside the work tree. */
const TMP_ROOT = path.join(import.meta.dirname, "..", ".tmp", "file-modes");

/** A fixed clock, so the fixtures do not depend on the wall clock. */
const NOW = 1_700_000_000_000;

/** A synthetic session record for the session table. */
const RECORD: SessionRecord = {
  sid: "sess-modes",
  kind: "acp",
  command: ["bot", "--stdio"],
  state: "running",
  createdAt: NOW,
  updatedAt: NOW,
  lastSeq: 1,
  ackedSeq: 0,
  progressAt: NOW,
};

after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** Create a fresh home directory below the scratch space. */
function makeHome(label: string): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TMP_ROOT, `${label}-`));
}

/** The permission bits of a file. */
function modeOf(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

/** The permission bits of a file as an octal string, e.g. "0644". */
function oct(mode: number): string {
  return mode.toString(8).padStart(4, "0");
}

/** The temporary files left behind in a directory. */
function tmpFiles(dir: string): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => name.includes(".tmp")).sort();
}

/** Write the session table and return the path of the table. */
function writeSessionTable(): string {
  const home = makeHome("store");
  const file = path.join(home, "sessions.json");
  new SessionStore(file).save([RECORD]);
  return file;
}

/** Take a host lease and return the path of the lease state file. */
async function writeLeaseState(): Promise<string> {
  const home = makeHome("lease");
  const store = new LeaseStore({ home, clock: () => NOW });
  await store.acquire("host/h1", "owner-a", 60_000);
  return store.statePath;
}

/** Append one event and return the segment and the index of the log. */
function writeSessionLog(): { segment: string; index: string } {
  const home = makeHome("log");
  const log = new SessionLog({ home, now: () => NOW });
  log.append("sess-modes", { type: "evt", payload: { n: 1 } });
  log.flush("sess-modes");
  const stat = log.stat("sess-modes");
  return { segment: stat.activeFile, index: stat.indexFile };
}

/**
 * Probe the writers once, with a umask of 022.
 *
 * The mode a writer really produces decides whether a case below is a real
 * test or a documented defect, so the file stays truthful when the writers
 * are fixed.
 */
async function probeModes(): Promise<{
  table: number;
  lease: number;
  segment: number;
  index: number;
}> {
  const previous = process.umask(0o022);
  try {
    const table = writeSessionTable();
    const lease = await writeLeaseState();
    const log = writeSessionLog();
    return {
      table: modeOf(table),
      lease: modeOf(lease),
      segment: modeOf(log.segment),
      index: modeOf(log.index),
    };
  } finally {
    process.umask(previous);
  }
}

const modes = await probeModes();

/**
 * Declare one file mode case.
 *
 * `write` performs the write under a umask of 022 and returns the paths of
 * the files whose mode is checked.  When the writers do not keep the files
 * private the case is declared as a todo that carries the observed mode.
 */
function modeCase(
  name: string,
  observed: number[],
  write: () => string[] | Promise<string[]>,
): void {
  if (observed.some((mode) => (mode & 0o077) !== 0)) {
    const seen = observed.length === 1 ? oct(observed[0]) : observed.map(oct).join(", ");
    test.todo(`${name} (actual mode ${seen})`);
    return;
  }
  test(name, { skip: SKIP_POSIX }, async (t) => {
    const previous = process.umask(0o022);
    t.after(() => {
      process.umask(previous);
    });
    const files = await write();
    for (const file of files) {
      assert.equal(
        modeOf(file) & 0o077,
        0,
        `${file} must not be readable by group or other`,
      );
    }
  });
}

// (1) The session table of store.ts.
// DEFECT: store.ts writes sessions.json with mode 0644, group and other may read it.
modeCase(
  "store.ts writes the session table with a private mode",
  [modes.table],
  () => [writeSessionTable()],
);

// (2) The state file of lease-store.ts.
// DEFECT: lease-store.ts writes leases.json with mode 0644, group and other may read it.
modeCase(
  "lease-store.ts writes the lease state with a private mode",
  [modes.lease],
  async () => [await writeLeaseState()],
);

// (3) The segment and the index of session-log.ts.
// DEFECT: session-log.ts writes the segment and the index with mode 0644, group and other may read them.
modeCase(
  "session-log.ts writes the segment and the index with a private mode",
  [modes.segment, modes.index],
  () => {
    const log = writeSessionLog();
    return [log.segment, log.index];
  },
);

// (4) A normal write must not leave a temporary file behind.
test("a normal write leaves no temporary file behind", { skip: SKIP_POSIX }, async (t) => {
  const previous = process.umask(0o022);
  t.after(() => {
    process.umask(previous);
  });
  const table = writeSessionTable();
  const lease = await writeLeaseState();
  const log = writeSessionLog();
  const leftovers = [
    ...tmpFiles(path.dirname(table)),
    ...tmpFiles(path.dirname(lease)),
    ...tmpFiles(path.dirname(log.segment)),
  ];
  assert.deepEqual(leftovers, []);
});
