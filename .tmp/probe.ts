import { test } from "node:test";
import assert from "node:assert/strict";
interface Foo { a: string }
const f: Foo = { a: "ok" };
test("ts works", () => { assert.equal(f.a, "ok"); });
