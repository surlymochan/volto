import test from "node:test";
import assert from "node:assert/strict";
import { redact, redactText } from "../src/redact.ts";

const paths = [
  ["/Users/alice/project/file", "/Users/<user>/project/file"],
  ["/home/alice/project/file", "/home/<user>/project/file"],
  ["C:\\Users\\alice\\project\\file", "C:\\Users\\<user>\\project\\file"],
  ["~alice/project/file", "~<user>/project/file"],
];

for (const [input, expected] of paths) {
  test(`masks ${input} in text`, () => assert.equal(redactText(`open ${input}`), `open ${expected}`));
  test(`masks ${input} in nested values and arrays`, () => {
    assert.deepEqual(redact({ nested: { paths: [input] } }), { nested: { paths: [expected] } });
  });
}

// Bare roots and similar words are not user home paths. Shared and runner are
// still masked: they can also be account names and should not leak by default.
for (const input of ["/Users", "/home", "/var/home-like/alice", "/usr/home-looking/alice", "~/.ssh/id_rsa"]) {
  test(`leaves ${input} alone`, () => assert.equal(redactText(input), input));
}
test("masks account names that may also be system accounts", () => {
  assert.equal(redactText("/home/runner/a /Users/Shared/b"), "/home/<user>/a /Users/<user>/b");
});
test("redact is pure and idempotent", () => {
  const input = Object.freeze({ paths: Object.freeze(paths.map(([path]) => path)) });
  const result = redact(input);
  assert.deepEqual(input.paths, paths.map(([path]) => path));
  assert.notEqual(result.paths, input.paths);
  assert.deepEqual(redact(result), result);
});
test("host masking remains optional alongside home masking", () => {
  const input = "/home/alice/file on build-box.invalid";
  assert.equal(redactText(input), "/home/<user>/file on build-box.invalid");
  assert.equal(redactText(input, { hostMask: true }), "/home/<user>/file on <host>");
});
