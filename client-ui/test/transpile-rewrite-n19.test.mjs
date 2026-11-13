import assert from "node:assert/strict";
import test from "node:test";

import { rewriteSpecifiers } from "../transpile.mjs";

test("rewrites a single-quoted default import from the current directory", () => {
  assert.equal(rewriteSpecifiers("import item from './x.ts';"), "import item from './x.js';");
});

test("leaves a bare package import unchanged", () => {
  const source = 'import item from "sample-package";';
  assert.equal(rewriteSpecifiers(source), source);
});

test("rewrites type-only import specifiers without stripping the imports", () => {
  const source = 'import type { Shape } from "./shape.ts";\nimport type * as Types from "../types.ts";';
  const expected = 'import type { Shape } from "./shape.js";\nimport type * as Types from "../types.js";';
  assert.equal(rewriteSpecifiers(source), expected);
});

test("rewrites a single-quoted dynamic import with whitespace", () => {
  assert.equal(rewriteSpecifiers("const item = import( './y.ts' );"), "const item = import( './y.js' );");
});

// DEFECT: a call to a function named from is mistaken for an import specifier.
test.todo("leaves a relative path string passed to a function named from unchanged", () => {
  const source = 'const item = from("./literal.ts");';
  assert.equal(rewriteSpecifiers(source), source);
});
