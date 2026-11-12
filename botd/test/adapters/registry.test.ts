// botd/test/adapters/registry.test.ts
//
// Tests for the adapter registry (botd/src/adapters/index.ts).
//
// The registry is the single place that knows every adapter kind. The tests
// cover the three guarantees the control plane relies on:
//
//   - every known kind resolves to an adapter,
//   - adapters that ship disabled (copilot needs a paid seat) say so,
//   - an unknown kind fails with a clear error.
//
// The optional `pi` adapter is not part of this build, so the registry loads
// it lazily and reports it as disabled. The test adapts to both cases: the
// module may be missing (this build) or present (a later build).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  ADAPTER_CAPABILITIES,
  getAdapter,
  listAdapters,
} from "../../src/adapters/index.ts";
import type { AdapterCapability } from "../../src/adapters/index.ts";
import { COPILOT_ENABLED_ENV } from "../../src/adapters/copilot.ts";
import type { BotKind } from "../../src/adapter-types.ts";

const require = createRequire(import.meta.url);

/** True when the optional `pi` module is part of this build. */
function piModulePresent(): boolean {
  try {
    require("../../src/adapters/pi.ts");
    return true;
  } catch {
    return false;
  }
}

const KNOWN_KINDS: BotKind[] = ["agy", "claude", "codex", "copilot", "dsh", "pi"];

function rowFor(kind: BotKind): AdapterCapability {
  const row = listAdapters().find((entry) => entry.kind === kind);
  assert.ok(row, `the capability table has no row for "${kind}"`);
  return row;
}

/** Run `body` with one environment variable set (or unset). */
function withEnv(name: string, value: string | undefined, body: () => void): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

// --- the capability table ----------------------------------------------------

test("the capability table lists every known kind", () => {
  const rows = listAdapters();
  const kinds = rows.map((row) => row.kind).sort();

  assert.deepEqual(kinds, [...KNOWN_KINDS].sort());
  assert.equal(rows.length, KNOWN_KINDS.length);
});

test("every row carries the full capability shape", () => {
  for (const row of listAdapters()) {
    assert.ok(KNOWN_KINDS.includes(row.kind), `unexpected kind: ${row.kind}`);
    assert.equal(typeof row.family, "string");
    assert.ok(row.family.length > 0);
    assert.equal(typeof row.protocol, "string");
    assert.ok(row.protocol.length > 0);
    assert.equal(typeof row.supportsResume, "boolean");
    assert.equal(typeof row.supportsCancel, "boolean");
    assert.equal(typeof row.enabled, "boolean");
  }
});

test("listAdapters() hands out plain copies of the table", () => {
  const first = listAdapters();
  const second = listAdapters();

  assert.notEqual(first, second);
  assert.notEqual(first[0], second[0]);
  assert.deepEqual(first, second);

  // Mutating a copy must not leak into the shared table.
  first[0] = { ...first[0], enabled: false };
  assert.notEqual(listAdapters()[0].enabled, false);
  assert.equal(ADAPTER_CAPABILITIES.length, KNOWN_KINDS.length);
});

// --- resolving adapters ------------------------------------------------------

test("every kind resolves to an adapter", () => {
  for (const kind of KNOWN_KINDS) {
    const adapter = getAdapter(kind);
    assert.ok(adapter, `getAdapter("${kind}") returned nothing`);
    assert.equal(adapter.kind, kind);
  }
});

test("the resolved adapter matches the capability row", () => {
  for (const row of listAdapters()) {
    const adapter = getAdapter(row.kind);
    assert.equal(adapter.family, row.family);
  }
});

test("the resolved adapter implements the adapter contract", () => {
  for (const kind of KNOWN_KINDS) {
    const adapter = getAdapter(kind);
    assert.equal(typeof adapter.spawn, "function");
    assert.equal(typeof adapter.handshake, "function");
    assert.equal(typeof adapter.prompt, "function");
    assert.equal(typeof adapter.cancel, "function");
    assert.equal(typeof adapter.parse, "function");
    assert.equal(typeof adapter.answerPermission, "function");
  }
});

test("each call hands out a fresh adapter instance", () => {
  // Adapters keep per-session state, so two sessions must not share one.
  assert.notEqual(getAdapter("claude"), getAdapter("claude"));
  assert.notEqual(getAdapter("codex"), getAdapter("codex"));
});

test("the resolved adapters can be spawned without a provider binary", () => {
  // spawn() only builds a command line; it never starts the CLI. Copilot is
  // disabled by default and refuses to spawn unless it is opted in.
  const claude = getAdapter("claude");
  const spec = claude.spawn({ cwd: "/synthetic/work" });
  assert.ok(Array.isArray(spec.command));
  assert.ok(spec.command.length > 0);
  assert.equal(spec.cwd, "/synthetic/work");
});

// --- disabled adapters -------------------------------------------------------

test("copilot is disabled by default", () => {
  // Without the opt-in the row reports the adapter as unusable.
  withEnv(COPILOT_ENABLED_ENV, undefined, () => {
    assert.equal(rowFor("copilot").enabled, false);
  });
});

test("copilot is enabled once the operator opts in", () => {
  withEnv(COPILOT_ENABLED_ENV, "1", () => {
    assert.equal(rowFor("copilot").enabled, true);
  });
});

test("the other kinds are enabled", () => {
  for (const row of listAdapters()) {
    if (row.kind === "copilot") continue;
    if (row.kind === "pi" && !piModulePresent()) continue;
    assert.equal(row.enabled, true, `expected "${row.kind}" to be enabled`);
  }
});

test("the optional pi adapter is reported as disabled when it is missing", () => {
  const row = rowFor("pi");

  if (piModulePresent()) {
    assert.equal(row.enabled, true);
    assert.equal(getAdapter("pi").kind, "pi");
    return;
  }

  assert.equal(row.enabled, false);
  // The kind still resolves so the control plane can plan work...
  const adapter = getAdapter("pi");
  assert.equal(adapter.kind, "pi");
  // ...but it refuses to talk to a provider that is not there.
  assert.throws(() => adapter.spawn({ cwd: "/synthetic/work" }), /not available/);
});

// --- unknown kinds -----------------------------------------------------------

test("an unknown kind throws a clear error", () => {
  assert.throws(
    () => getAdapter("gemini" as BotKind),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /unknown adapter kind/i);
      assert.match(error.message, /gemini/);
      // The message lists the kinds that do exist.
      for (const kind of KNOWN_KINDS) {
        assert.match(error.message, new RegExp(kind));
      }
      return true;
    },
  );
});

test("an unknown kind does not resolve through the capability table", () => {
  assert.equal(
    listAdapters().find((row) => row.kind === ("gemini" as BotKind)),
    undefined,
  );
});
