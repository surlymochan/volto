import assert from "node:assert/strict";
import { test } from "node:test";

import * as pi from "../../src/adapters/pi.ts";
import * as agy from "../../src/adapters/agy.ts";

const adapters = [
  {
    name: "pi",
    defaultEnv: pi.defaultEnv,
    inheritedEnv: pi.inheritedEnv,
    spawn: (env: Record<string, string | undefined>) =>
      new pi.PiAdapter({ env }).spawn({ cwd: ".tmp/work" }),
  },
  {
    name: "agy",
    defaultEnv: agy.defaultEnv,
    inheritedEnv: agy.inheritedEnv,
    spawn: (env: Record<string, string | undefined>) =>
      new agy.AgyAdapter({ env, protocol: "acp" }).spawn({ cwd: ".tmp/work" }),
  },
];

for (const adapter of adapters) {
  test(`${adapter.name}: inheritedEnv keeps only strings, including empty strings`, () => {
    const source = {
      TEXT: "synthetic-value",
      EMPTY: "",
      MISSING: undefined,
      NUMBER: 12,
      FALSE: false,
      NULL: null,
      OBJECT: {},
    } as unknown as Record<string, string | undefined>;
    assert.deepEqual(adapter.inheritedEnv(source), { TEXT: "synthetic-value", EMPTY: "" });
  });

  test(`${adapter.name}: inheritedEnv preserves key spelling`, () => {
    const source = { MixedCase: "one", mixedcase: "two", "odd.key-!": "three", "": "four" };
    assert.deepEqual(adapter.inheritedEnv(source), source);
  });

  test(`${adapter.name}: inheritedEnv returns a copy of its source`, () => {
    const source = { VALUE: "before" };
    const result = adapter.inheritedEnv(source);
    assert.notStrictEqual(result, source);
    result.VALUE = "after";
    result.ADDED = "synthetic";
    assert.deepEqual(source, { VALUE: "before" });
  });

  test(`${adapter.name}: inheritedEnv defaults to a copy of process.env`, () => {
    const before = { ...process.env };
    const result = adapter.inheritedEnv();
    assert.deepEqual(result, before);
    assert.notStrictEqual(result, process.env);
    result.VOLTO_SYNTHETIC_ENV_TEST = "changed";
    delete result.PATH;
    assert.deepEqual({ ...process.env }, before);
  });

  test(`${adapter.name}: defaultEnv returns process.env`, () => {
    assert.strictEqual(adapter.defaultEnv(), process.env);
  });

  test(`${adapter.name}: defaultEnv is empty without process`, (t) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "process");
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, "process", descriptor);
      else Reflect.deleteProperty(globalThis, "process");
    });
    Object.defineProperty(globalThis, "process", { configurable: true, value: undefined });
    assert.deepEqual(adapter.defaultEnv(), {});
  });

  test(`${adapter.name}: spawn uses the injected environment`, () => {
    const env = { SYNTHETIC_ONLY: "injected", EMPTY: "", OMIT: undefined };
    const spec = adapter.spawn(env);
    assert.deepEqual(spec.env, { SYNTHETIC_ONLY: "injected", EMPTY: "" });
    assert.notStrictEqual(spec.env, env);
  });
}
