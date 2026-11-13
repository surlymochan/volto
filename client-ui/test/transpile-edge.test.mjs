import assert from "node:assert/strict";
import test from "node:test";

import { createTranspiler, rewriteSpecifiers } from "../transpile.mjs";

const transpiler = createTranspiler();
const skip = transpiler ? false : "no TypeScript stripping available";

test("rewrites a parent-directory named import", () => {
  assert.equal(
    rewriteSpecifiers('import { value } from "../lib/value.ts";'),
    'import { value } from "../lib/value.js";',
  );
});

test("leaves a package subpath ending in .ts untouched", () => {
  const source = 'import item from "sample-package/item.ts";';
  assert.equal(rewriteSpecifiers(source), source);
});

test("leaves query strings and fragments untouched", () => {
  const source = 'import "./item.ts?raw";\nexport * from "../item.ts#part";';
  assert.equal(rewriteSpecifiers(source), source);
});

test("rewrites only the exact lowercase .ts extension", () => {
  const source = 'import "./item.ts";\nimport "./item.tsx";\nimport "./item.TS";\nimport "./item";';
  const expected = 'import "./item.js";\nimport "./item.tsx";\nimport "./item.TS";\nimport "./item";';
  assert.equal(rewriteSpecifiers(source), expected);
});

test("preserves quoted examples and comments while rewriting an adjacent import", () => {
  const source = 'const example = \'import "./fake.ts"\';\n// import "./fake.ts"\nimport "./real.ts";';
  const expected = 'const example = \'import "./fake.ts"\';\n// import "./fake.ts"\nimport "./real.js";';
  assert.equal(rewriteSpecifiers(source), expected);
});

test("strips a type-only import while preserving a value import", { skip }, () => {
  const output = transpiler('import type { Shape } from "./shape.ts";\nimport { value } from "./value.ts";\nexport const result: Shape = value;');
  assert.doesNotMatch(output, /import\s+type|\.\/shape\.ts/);
  assert.match(rewriteSpecifiers(output), /\.\/value\.js/);
});

test("strips a module containing only a type import", { skip }, () => {
  const output = transpiler('import type { Shape } from "./shape.ts";');
  assert.doesNotMatch(output, /import\s+type|\.\/shape\.ts/);
});

test("surfaces a readable error for invalid TypeScript", { skip }, () => {
  assert.throws(() => transpiler("const value: = ;"), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /\S/);
    return true;
  });
});

test("rewrites a named re-export with a parent path", () => {
  assert.equal(
    rewriteSpecifiers('export { value as renamed } from "../lib/value.ts";'),
    'export { value as renamed } from "../lib/value.js";',
  );
});
