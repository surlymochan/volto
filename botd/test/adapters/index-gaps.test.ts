// botd/test/adapters/index-gaps.test.ts
//
// Gap tests for the adapter registry (botd/src/adapters/index.ts).
//
// registry.test.ts covers the happy path of the registry: the table lists
// every known kind, every kind resolves to an adapter and an unknown kind
// fails with a clear error. This file covers what is left of the module:
//
//   - the capability table is frozen and listAdapters() hands out copies
//     that cannot change it,
//   - the placeholder adapter that stands in for a kind whose module is not
//     part of the build (the optional `pi` adapter),
//   - the loader of that optional module: a module that is missing, one
//     that cannot be required synchronously and ones that hand out a
//     factory, a class, an instance or nothing usable at all.
//
// The optional `pi` module is loaded lazily through createRequire(), so the
// tests intercept that single require() and answer it with a synthetic
// module. Everything happens in process: no provider is contacted, no child
// process is started and no port is opened.

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

import type { AdapterCapability } from "../../src/adapters/index.ts";
import type { BotAdapter, BotKind } from "../../src/adapter-types.ts";

/** The registry module under test. */
type Registry = typeof import("../../src/adapters/index.ts");

/** What the optional `pi` module looks like to the registry. */
type PiModule =
  /** The module is not part of this build. */
  | { kind: "missing" }
  /** The module cannot be required synchronously. */
  | { kind: "async" }
  /** The module hands out its exports. */
  | { kind: "exports"; exports: Record<string, unknown> };

/** The internals of the module loader, used to intercept one require(). */
const loader = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
};

/** Counts the copies of the registry module: one per scenario. */
let registryCopies = 0;

/** True when the require() comes from the registry module. */
function isRegistry(parent: unknown): boolean {
  const filename = (parent as { filename?: unknown } | null | undefined)?.filename;
  return typeof filename === "string" && filename.endsWith("/src/adapters/index.ts");
}

/**
 * Load a fresh copy of the registry.
 *
 * The registry keeps the state of the optional module in a module level
 * cache, so every scenario needs its own copy of the module: the copy is
 * loaded through a query string, which gives it its own module instance.
 *
 * With `pi` given, the single require() of the optional module is
 * intercepted and answered with the synthetic module of the scenario.
 */
async function loadRegistry(pi?: PiModule): Promise<Registry> {
  registryCopies += 1;
  const url = `../../src/adapters/index.ts?gaps=${registryCopies}`;

  if (!pi) return (await import(url)) as Registry;

  const original = loader._load;
  loader._load = function (
    this: unknown,
    request: string,
    parent: unknown,
    isMain: boolean,
  ): unknown {
    if (request === "./pi.ts" && isRegistry(parent)) {
      if (pi.kind === "exports") return pi.exports;
      const error = new Error(`Cannot find module '${request}'`) as Error & {
        code: string;
      };
      error.code = pi.kind === "missing" ? "MODULE_NOT_FOUND" : "ERR_REQUIRE_ASYNC_MODULE";
      throw error;
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    const registry = (await import(url)) as Registry;
    // Reading the table loads the optional module while the interception
    // is still in place.
    registry.listAdapters();
    return registry;
  } finally {
    loader._load = original;
  }
}

/** A synthetic adapter that stands in for the optional module. */
function syntheticAdapter(): BotAdapter {
  return {
    kind: "pi",
    family: "other",
    spawn: () => ({ command: ["synthetic-pi"], env: {}, cwd: "/synthetic/work" }),
    handshake: () => [],
    prompt: () => ({ type: "synthetic" }),
    cancel: () => [],
    parse: () => [],
    answerPermission: () => null,
  };
}

/** The capability row of one kind. */
function rowOf(registry: Registry, kind: BotKind): AdapterCapability {
  const row = registry.listAdapters().find((entry) => entry.kind === kind);
  assert.ok(row, `the capability table has no row for "${kind}"`);
  return row;
}

// --- the capability table ----------------------------------------------------

test("the capability table is frozen", async () => {
  const registry = await loadRegistry();

  assert.ok(Object.isFrozen(registry.ADAPTER_CAPABILITIES));
  // Every row is frozen as well.
  for (const row of registry.ADAPTER_CAPABILITIES) {
    assert.ok(Object.isFrozen(row), `the row of "${row.kind}" is not frozen`);
  }

  // A frozen table refuses new rows ...
  assert.throws(() => {
    (registry.ADAPTER_CAPABILITIES as AdapterCapability[]).push({
      kind: "codex",
      family: "gpt",
      protocol: "json-rpc",
      supportsResume: true,
      supportsCancel: true,
      enabled: true,
    });
  }, TypeError);

  // ... and a frozen row refuses new values.
  assert.throws(() => {
    (registry.ADAPTER_CAPABILITIES[0] as { enabled: boolean }).enabled = false;
  }, TypeError);
});

test("listAdapters() hands out copies that cannot change the table", async () => {
  const registry = await loadRegistry();

  const first = registry.listAdapters();
  const second = registry.listAdapters();

  // Every call hands out a fresh array with fresh rows.
  assert.notEqual(first, second);
  assert.notEqual(first[0], second[0]);
  assert.notEqual(first[0], registry.ADAPTER_CAPABILITIES[0]);
  assert.deepEqual(first, second);

  const before = registry.ADAPTER_CAPABILITIES.map((row) => ({ ...row }));

  // Changing a field of a returned row leaves the table alone ...
  const changed = first[0] as { enabled: boolean };
  changed.enabled = false;
  // ... and so does dropping a row from the returned array.
  first.pop();

  assert.deepEqual(registry.ADAPTER_CAPABILITIES.map((row) => ({ ...row })), before);
  assert.equal(registry.ADAPTER_CAPABILITIES.length, before.length);
});

// --- the placeholder adapter ------------------------------------------------

test("a known kind whose module is missing resolves to the placeholder", async () => {
  const registry = await loadRegistry({ kind: "missing" });

  const adapter = registry.getAdapter("pi");
  assert.equal(adapter.kind, "pi");
  // Without the module the row falls back to the family of the pi CLI.
  assert.equal(adapter.family, "minimax");
  assert.equal(rowOf(registry, "pi").enabled, false);

  // The placeholder satisfies the adapter contract.
  for (const method of [
    "spawn",
    "handshake",
    "prompt",
    "cancel",
    "parse",
    "answerPermission",
  ] as const) {
    assert.equal(typeof adapter[method], "function", method);
  }
});

test("the placeholder refuses every call that would touch a provider", async () => {
  const registry = await loadRegistry({ kind: "missing" });
  const adapter = registry.getAdapter("pi");
  const unavailable = /not available in this build/;

  assert.throws(() => adapter.spawn({ cwd: "/synthetic/work" }), unavailable);
  assert.throws(() => adapter.handshake({ cwd: "/synthetic/work" }), unavailable);
  assert.throws(() => adapter.prompt("synthetic prompt", {}), unavailable);
  assert.throws(() => adapter.cancel({}), unavailable);
  // The placeholder has no provider to answer, so it refuses as well.
  assert.throws(() => adapter.answerPermission("perm-1", true), unavailable);
});

test("the placeholder parses nothing", async () => {
  const registry = await loadRegistry({ kind: "missing" });
  const adapter = registry.getAdapter("pi");

  assert.deepEqual(adapter.parse("x"), []);
  assert.deepEqual(adapter.parse(""), []);
  assert.deepEqual(adapter.parse('{"type":"text_delta"}'), []);
});

test(
  "the placeholder answers a permission request with null",
  {
    todo: "DEFECT: the placeholder throws in answerPermission() instead of answering null, so the control plane cannot tell 'no request is pending' from 'the adapter is missing'",
  },
  async () => {
    const registry = await loadRegistry({ kind: "missing" });
    const adapter = registry.getAdapter("pi");

    assert.equal(adapter.answerPermission("perm-1", true), null);
    assert.equal(adapter.answerPermission("perm-1", false), null);
  },
);

test("an unknown kind throws instead of falling back to the placeholder", async () => {
  const registry = await loadRegistry({ kind: "missing" });

  // registry.test.ts covers the wording of the error; the point here is
  // that an unknown kind never reaches the placeholder adapter.
  assert.throws(() => registry.getAdapter("gemini" as BotKind), /unknown adapter kind/);
  // The placeholder is only handed out for a kind the table knows.
  assert.doesNotThrow(() => registry.getAdapter("pi"));
});

// --- the optional module loader ---------------------------------------------

test("an optional module that cannot be required synchronously is ignored", async () => {
  const registry = await loadRegistry({ kind: "async" });

  assert.equal(rowOf(registry, "pi").enabled, false);
  assert.throws(
    () => registry.getAdapter("pi").spawn({ cwd: "/synthetic/work" }),
    /not available in this build/,
  );
});

test("the optional module may hand out a factory", async () => {
  const adapter = syntheticAdapter();
  const registry = await loadRegistry({
    kind: "exports",
    exports: { createPiAdapter: () => adapter },
  });

  assert.equal(registry.getAdapter("pi"), adapter);
  assert.equal(rowOf(registry, "pi").enabled, true);
});

test("the optional module may hand out a class", async () => {
  class SyntheticPiAdapter {
    readonly kind = "pi";
    readonly family = "other";
    spawn() {
      return { command: ["synthetic-pi"], env: {}, cwd: "/synthetic/work" };
    }
    handshake() {
      return [];
    }
    prompt() {
      return { type: "synthetic" };
    }
    cancel() {
      return [];
    }
    parse() {
      return [];
    }
    answerPermission() {
      return null;
    }
  }
  const registry = await loadRegistry({
    kind: "exports",
    exports: { PiAdapter: SyntheticPiAdapter },
  });

  const adapter = registry.getAdapter("pi");
  assert.ok(adapter instanceof SyntheticPiAdapter);
  assert.equal(adapter.kind, "pi");
  assert.equal(rowOf(registry, "pi").enabled, true);
});

test("the optional module may hand out an instance", async () => {
  const adapter = syntheticAdapter();
  const registry = await loadRegistry({
    kind: "exports",
    exports: { default: adapter },
  });

  assert.equal(registry.getAdapter("pi"), adapter);
  assert.equal(rowOf(registry, "pi").enabled, true);
});

test("a factory that throws leaves the placeholder in place", async () => {
  const registry = await loadRegistry({
    kind: "exports",
    exports: {
      createPiAdapter: () => {
        throw new Error("synthetic failure");
      },
    },
  });

  assert.equal(rowOf(registry, "pi").enabled, false);
  assert.throws(
    () => registry.getAdapter("pi").spawn({ cwd: "/synthetic/work" }),
    /not available in this build/,
  );
});

test("an optional module that hands out nothing usable is ignored", async () => {
  const registry = await loadRegistry({ kind: "exports", exports: {} });

  assert.equal(rowOf(registry, "pi").enabled, false);
  assert.throws(
    () => registry.getAdapter("pi").spawn({ cwd: "/synthetic/work" }),
    /not available in this build/,
  );
});

test("an optional module that disables itself is reported as disabled", async () => {
  const adapter = syntheticAdapter();
  const registry = await loadRegistry({
    kind: "exports",
    exports: { enabled: false, createPiAdapter: () => adapter },
  });

  assert.equal(rowOf(registry, "pi").enabled, false);
  // The adapter itself still resolves: only the row reports it as unusable.
  assert.equal(registry.getAdapter("pi"), adapter);
});
