import { test } from "node:test";
import assert from "node:assert/strict";
const x: number = 1;
test("works", () => { assert.equal(x, 1); });
