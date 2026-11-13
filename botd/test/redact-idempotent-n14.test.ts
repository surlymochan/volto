import test from "node:test";
import assert from "node:assert/strict";
import { redact, REDACTED } from "../src/redact.ts";

test("redact is idempotent for an array with masked keys and text", () => {
  const input = [{ password: "synthetic", note: "token=synthetic" }, [false, null, 12]];
  const once = redact(input);
  assert.deepEqual(once, [{ password: REDACTED, note: "token=<redacted>" }, [false, null, 12]]);
  assert.deepEqual(redact(once), once);
});

test("redact is idempotent when secret-key masking is disabled", () => {
  const input = { password: [{ note: "token=synthetic", count: 3 }] };
  const options = { maskSecretKeys: false };
  const once = redact(input, options);
  assert.deepEqual(once, { password: [{ note: "token=<redacted>", count: 3 }] });
  assert.deepEqual(redact(once, options), once);
});

test("redact leaves the input unchanged across repeated passes", () => {
  const input = { entries: [{ password: "synthetic", note: "token=synthetic" }] };
  const snapshot = structuredClone(input);
  const once = redact(input);
  redact(once);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(once, { entries: [{ password: REDACTED, note: "token=<redacted>" }] });
});

test("editing copied nested containers does not change the input", () => {
  const input = { entries: [{ label: "original", values: [1, 2] }] };
  const output = redact(input);
  output.entries[0].label = "changed";
  output.entries[0].values.push(3);
  assert.deepEqual(input, { entries: [{ label: "original", values: [1, 2] }] });
});

test("ordinary nested non-string leaves retain their exact values", () => {
  const input = [{ values: [0, -0, NaN, Infinity, null, true, false] }];
  const output = redact(input);
  for (let i = 0; i < input[0].values.length; i++) {
    assert.ok(Object.is(output[0].values[i], input[0].values[i]));
  }
});

test("redact copies a self-referential array without changing it", () => {
  const input: unknown[] = ["token=synthetic"];
  input.push(input);
  const output = redact(input);
  assert.notEqual(output, input);
  assert.equal(output[0], "token=<redacted>");
  assert.equal(output[1], output);
  assert.equal(input[0], "token=synthetic");
  assert.equal(input[1], input);
  assert.deepEqual(redact(output), output);
});

test("redact preserves a cycle between two objects", () => {
  const first: { next?: unknown; note: string } = { note: "token=synthetic" };
  const second = { next: first, count: 4 };
  first.next = second;
  const output = redact(first);
  const next = output.next as typeof second;
  assert.notEqual(next, second);
  assert.equal(next.next, output);
  assert.equal(output.note, "token=<redacted>");
  assert.equal(first.next, second);
  assert.equal(first.note, "token=synthetic");
});

test("redact finishes a long string and remains idempotent", () => {
  const input = `${"plain text ".repeat(100_000)}token=synthetic`;
  const start = performance.now();
  const once = redact(input);
  const twice = redact(once);
  const elapsed = performance.now() - start;
  assert.equal(once, `${"plain text ".repeat(100_000)}token=<redacted>`);
  assert.equal(twice, once);
  assert.ok(elapsed < 5000, `redaction took ${elapsed.toFixed(0)} ms`);
});
