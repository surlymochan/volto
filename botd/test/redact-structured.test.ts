import test from "node:test";
import assert from "node:assert/strict";
import { isSecretKeyName, redact, redactText, REDACTED } from "../src/redact.ts";

test("redact walks alternating arrays and objects", () => {
  const input = { groups: [[{ note: "password=FAKE0000", apiKey: "FAKE0001" }]] };
  assert.deepEqual(redact(input), {
    groups: [[{ note: "password=<redacted>", apiKey: REDACTED }]],
  });
});

test("redact masks case and separator variants of secret keys", () => {
  const keys = ["TOKEN", "API_KEY", "Authorization", "PASSWORD", "user_pass_word", "refresh_TOKEN"];
  const input = Object.fromEntries(keys.map((key) => [key, "FAKE0000"]));
  for (const key of keys) assert.equal(isSecretKeyName(key), true, key);
  assert.deepEqual(redact(input), Object.fromEntries(keys.map((key) => [key, REDACTED])));
});

test("secret keys mask non-string values while ordinary leaves remain intact", () => {
  const input = { token: 0, password: false, api_key: null, Authorization: [1, 2], values: [0, false, null, undefined, 3n] };
  assert.deepEqual(redact(input), {
    token: REDACTED, password: REDACTED, api_key: REDACTED, Authorization: REDACTED,
    values: [0, false, null, undefined, 3n],
  });
});

test("redact preserves a cycle through an array and masks its contents", () => {
  const input: { items: unknown[]; token: string } = { items: [], token: "FAKE0000" };
  input.items.push(input);
  const output = redact(input);
  assert.notEqual(output, input);
  assert.notEqual(output.items, input.items);
  assert.equal(output.items[0], output);
  assert.equal(output.token, REDACTED);
  assert.equal(input.items[0], input);
  assert.equal(input.token, "FAKE0000");
});

test("redact preserves shared references without changing the input", () => {
  const shared = { PASSWORD: "FAKE0000", count: 2 };
  const input = { first: shared, second: [shared] };
  const output = redact(input);
  assert.equal(output.first, output.second[0]);
  assert.notEqual(output.first, shared);
  assert.deepEqual(shared, { PASSWORD: "FAKE0000", count: 2 });
  assert.deepEqual(output.first, { PASSWORD: REDACTED, count: 2 });
});

test("redact traverses moderately deep alternating containers", () => {
  let input: unknown = { token: "FAKE0000" };
  let expected: unknown = { token: REDACTED };
  for (let i = 0; i < 100; i++) {
    input = { child: [input] };
    expected = { child: [expected] };
  }
  assert.deepEqual(redact(input), expected);
});

// TODO(defect): walk has no depth bound and overflows the stack on deep input.
test.todo("redact handles deeply nested input without overflowing", () => {
  let input: unknown = { token: "FAKE0000" };
  for (let i = 0; i < 20000; i++) input = { child: input };
  assert.doesNotThrow(() => redact(input));
});

test("redactText masks several secrets across lines", () => {
  const input = "start\nAuthorization: Bearer FAKE00000000\npassword=FAKE0001\napi_key=FAKE0002\nend";
  assert.equal(redactText(input), "start\nAuthorization: Bearer <redacted>\npassword=<redacted>\napi_key=<redacted>\nend");
});

test("redact is idempotent for cyclic mixed containers", () => {
  const input: { entries: unknown[]; token: string } = { entries: [], token: "FAKE0000" };
  input.entries.push({ note: "password=FAKE0001" }, input);
  const once = redact(input);
  const twice = redact(once);
  assert.deepEqual(twice, once);
  assert.equal(twice.entries[1], twice);
});

test("disabling key masking still redacts text inside secret-key containers", () => {
  const input = { token: { note: "password=FAKE0000", count: 1 } };
  assert.deepEqual(redact(input, { maskSecretKeys: false }), {
    token: { note: "password=<redacted>", count: 1 },
  });
});
