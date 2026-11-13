// Unit tests for the branches of botd/src/redact.ts that the other redact
// test files (redact.test.ts, redact-leak.test.ts, redact-home-paths.test.ts
// and redact-structured.test.ts) leave uncovered: host and IP replacement edge
// inputs, empty and non string values, repeated patterns and already redacted
// input.
//
// Fixtures are synthetic: the addresses come from the documentation ranges
// (RFC 5737 / RFC 2606), the host names use reserved TLDs only and every
// credential is a made up string. No real secret, machine or person is
// mentioned.

import test from "node:test";
import assert from "node:assert/strict";

import { redact, redactText, isSecretKeyName, REDACTED } from "../src/redact.ts";
import type { RedactOptions } from "../src/redact.ts";

interface TextCase {
  name: string;
  input: string;
  expected: string;
  options?: RedactOptions;
}

/** Hosts and addresses, masked only when `hostMask` is asked for. */
const HOST_CASES: TextCase[] = [
  {
    name: "an ipv6 address in a url with a port",
    input: "curl http://[2001:db8::1]:8080/status",
    expected: "curl http://<ip>:8080/status",
    options: { hostMask: true },
  },
  {
    name: "an ipv6 address in a url without a port",
    input: "curl http://[2001:db8::1]/status",
    expected: "curl http://<ip>/status",
    options: { hostMask: true },
  },
  {
    name: "an ipv6 address in a url with user info",
    input: "curl http://user:pass@[2001:db8::1]/x",
    expected: "curl http://<ip>/x",
    options: { hostMask: true },
  },
  {
    name: "a url with user info",
    input: "curl http://user:pass@build-box.invalid/x",
    expected: "curl http://<host>/x",
    options: { hostMask: true },
  },
  {
    name: "a url authority without a host",
    input: "curl http://user@/x",
    expected: "curl http://user@/x",
    options: { hostMask: true },
  },
  {
    name: "a url authority with three colons",
    input: "curl http://a:::b/",
    expected: "curl http://<host>/",
    options: { hostMask: true },
  },
  {
    name: "the broadcast address",
    input: "on 255.255.255.255 now",
    expected: "on <ip> now",
    options: { hostMask: true },
  },
  {
    name: "the zero address",
    input: "on 0.0.0.0 now",
    expected: "on <ip> now",
    options: { hostMask: true },
  },
  {
    name: "an address with an out of range octet",
    input: "on 256.1.1.1 now",
    expected: "on 256.1.1.1 now",
    options: { hostMask: true },
  },
  {
    name: "a full form ipv6 address",
    input: "on 2001:0db8:0000:0000:0000:0000:0000:0001 now",
    expected: "on <ip> now",
    options: { hostMask: true },
  },
  {
    name: "the ipv6 loopback address",
    input: "on ::1 now",
    expected: "on <ip> now",
    options: { hostMask: true },
  },
  {
    name: "an ssh invocation without a target",
    input: "ssh -V",
    expected: "ssh -V",
    options: { hostMask: true },
  },
  {
    name: "an ssh invocation with only options",
    input: "ssh -o StrictHostKeyChecking=no",
    expected: "ssh -o StrictHostKeyChecking=no",
    options: { hostMask: true },
  },
  {
    name: "an ssh invocation with nothing behind the verb",
    input: "ssh ",
    expected: "ssh ",
    options: { hostMask: true },
  },
  {
    name: "an ssh target with a port",
    input: "ssh deploy@build-box.invalid:2222 uptime",
    expected: "ssh deploy@<host>:2222 uptime",
    options: { hostMask: true },
  },
  {
    name: "an ssh target with a port and without a user",
    input: "ssh build-box.invalid:2222 uptime",
    expected: "ssh <host>:2222 uptime",
    options: { hostMask: true },
  },
  {
    name: "an ssh invocation with an assignment before the target",
    input: "ssh FOO=bar build-box.invalid",
    expected: "ssh FOO=bar <host>",
    options: { hostMask: true },
  },
  {
    name: "an ssh target without a host",
    input: "ssh user@",
    expected: "ssh user@",
    options: { hostMask: true },
  },
  {
    name: "an ssh target with a trailing colon",
    input: "ssh build-box:",
    expected: "ssh <host>:",
    options: { hostMask: true },
  },
  {
    name: "an rsync target with a port",
    input: "rsync -av src/ user@build-box:22/dest/",
    expected: "rsync -av src/ user@<host>:22/dest/",
    options: { hostMask: true },
  },
];

/** Repeated patterns: every single occurrence has to be masked. */
const REPEATED_CASES: TextCase[] = [
  {
    name: "two key value pairs with the same key",
    input: "token=FAKE0000 token=FAKE0001",
    expected: "token=<redacted> token=<redacted>",
  },
  {
    name: "two json pairs",
    input: '{"password": "FAKE0000", "token": "FAKE0001"}',
    expected: '{"password": "<redacted>", "token": "<redacted>"}',
  },
  {
    name: "two api keys",
    input: "sk-FAKE0000000000000000 sk-FAKE1111111111111111",
    expected: "<redacted> <redacted>",
  },
  {
    name: "two private key blocks",
    input:
      "-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----\n" +
      "-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----",
    expected: "<redacted>\n<redacted>",
  },
  {
    name: "two addresses",
    input: "192.0.2.10 198.51.100.7",
    expected: "<ip> <ip>",
    options: { hostMask: true },
  },
  {
    name: "two host names",
    input: "build-box.invalid other-box.invalid",
    expected: "<host> <host>",
    options: { hostMask: true },
  },
  {
    name: "two home paths",
    input: "/home/alice/a /home/alice/b",
    expected: "/home/<user>/a /home/<user>/b",
  },
];

/** Empty values and placeholders: nothing to mask, nothing to change. */
const EMPTY_CASES: TextCase[] = [
  {
    name: "an empty quoted password",
    input: 'password=""',
    expected: 'password=""',
  },
  {
    name: "an empty quoted secret",
    input: "secret=''",
    expected: "secret=''",
  },
  {
    name: "a pair without a value",
    input: "password=",
    expected: "password=",
  },
  {
    name: "the redacted placeholder",
    input: "<redacted>",
    expected: "<redacted>",
  },
  {
    name: "the host placeholder",
    input: "<host>",
    expected: "<host>",
    options: { hostMask: true },
  },
  {
    name: "the ip placeholder",
    input: "<ip>",
    expected: "<ip>",
    options: { hostMask: true },
  },
  {
    name: "the user placeholder in a home path",
    input: "/home/<user>/file",
    expected: "/home/<user>/file",
  },
  {
    name: "a redacted pair",
    input: "token=<redacted>",
    expected: "token=<redacted>",
  },
  {
    name: "a redacted quoted pair",
    input: 'password="<redacted>"',
    expected: 'password="<redacted>"',
  },
  {
    name: "a host placeholder in a url",
    input: "http://<host>/status",
    expected: "http://<host>/status",
    options: { hostMask: true },
  },
  {
    name: "an ip placeholder in a url",
    input: "http://<ip>:8080/status",
    expected: "http://<ip>:8080/status",
    options: { hostMask: true },
  },
  {
    name: "a host placeholder in an ssh command",
    input: "ssh <host>",
    expected: "ssh <host>",
    options: { hostMask: true },
  },
];

for (const testCase of [...HOST_CASES, ...REPEATED_CASES, ...EMPTY_CASES]) {
  test(`redactText: ${testCase.name}`, () => {
    assert.equal(redactText(testCase.input, testCase.options), testCase.expected);
  });
}

test("redactText returns a non string input as it is", () => {
  for (const value of [null, undefined, 42, 0, false]) {
    assert.equal(redactText(value as unknown as string), value);
  }
});

test("redact returns a value that is not a container as it is", () => {
  for (const value of [null, undefined, 42, 0, false, true, 10n]) {
    assert.equal(redact(value), value);
  }
});

test("redact masks an empty value under a secret key", () => {
  assert.deepEqual(redact({ token: "", note: "", list: [] }), {
    token: REDACTED,
    note: "",
    list: [],
  });
});

test("redact keeps a date as it is", () => {
  const date = new Date(0);
  assert.equal(redact({ date }).date, date);
});

test("redact walks an object without a prototype", () => {
  const input = Object.create(null) as Record<string, unknown>;
  input.note = "token=FAKE0000";

  assert.deepEqual(redact(input), { note: "token=<redacted>" });
});

test("redact keeps a shared array shared", () => {
  const shared = ["token=FAKE0000"];
  const output = redact({ first: shared, second: shared }) as {
    first: unknown[];
    second: unknown[];
  };

  assert.equal(output.first, output.second);
  assert.deepEqual(output.first, ["token=<redacted>"]);
});

test("redact keeps an already redacted object as it is", () => {
  const input = { token: REDACTED, note: "<host>", nested: { list: ["<ip>", "<redacted>"] } };

  assert.deepEqual(redact(input, { hostMask: true }), input);
});

test("a key without letters is not a secret key name", () => {
  assert.equal(isSecretKeyName(""), false);
  assert.equal(isSecretKeyName("---"), false);
});

// TODO(defect): the ssh masking runs after the ip masking and masks the ip placeholder again.
test.todo("redactText keeps an ip placeholder inside an ssh command", () => {
  assert.equal(redactText("ssh <ip>", { hostMask: true }), "ssh <ip>");
});

// TODO(defect): an ipv4 ssh target is masked as a host name instead of an ip address.
test.todo("redactText masks an ipv4 ssh target as an ip address", () => {
  assert.equal(redactText("ssh 192.0.2.10 uptime", { hostMask: true }), "ssh <ip> uptime");
});
