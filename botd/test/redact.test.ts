// Tests for the volto-botd redaction helpers.
//
// Fixtures are synthetic: every credential is a made up string, the addresses
// come from the documentation ranges (RFC 5737 / RFC 2606) and the host names
// use reserved TLDs only. No real secret, machine or person is mentioned.

import test from "node:test";
import assert from "node:assert/strict";

import {
  redact,
  redactText,
  isSecretKeyName,
  REDACTED,
  REDACTED_HOST,
  REDACTED_IP,
} from "../src/redact.ts";
import type { RedactOptions } from "../src/redact.ts";

interface TextCase {
  name: string;
  input: string;
  expected: string;
  options?: RedactOptions;
}

/** Credentials and secrets: every one of them has to disappear. */
const SECRET_CASES: TextCase[] = [
  {
    name: "openai style api key",
    input: "key sk-EXAMPLEEXAMPLEEXAMPLEEXAMPLE",
    expected: "key <redacted>",
  },
  {
    name: "anthropic style api key",
    input: "key sk-ant-EXAMPLEEXAMPLEEXAMPLEEXAMPLE",
    expected: "key <redacted>",
  },
  {
    name: "github personal access token",
    input: "token ghp_EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE",
    expected: "token <redacted>",
  },
  {
    name: "github fine grained token",
    input: "token github_pat_EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE",
    expected: "token <redacted>",
  },
  {
    name: "aws access key id",
    input: "aws AKIAEXAMPLEEXAMPLE12",
    expected: "aws <redacted>",
  },
  {
    name: "slack token",
    input: "slack xoxb-EXAMPLEEXAMPLE-1234567890",
    expected: "slack <redacted>",
  },
  {
    name: "json web token",
    input: "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJFWFBTEUifQ.dozjgNryP4J3jVmNHl0w5N",
    expected: "jwt <redacted>",
  },
  {
    name: "bearer token in a header",
    input: "Authorization: Bearer EXAMPLEEXAMPLEEXAMPLE",
    expected: "Authorization: Bearer <redacted>",
  },
  {
    name: "bearer token in lower case",
    input: "authorization: bearer EXAMPLEEXAMPLEEXAMPLE",
    expected: "authorization: bearer <redacted>",
  },
  {
    name: "rsa private key block",
    input: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
    expected: "<redacted>",
  },
  {
    name: "openssh private key block",
    input: "-----BEGIN OPENSSH PRIVATE KEY-----\nEXAMPLE\n-----END OPENSSH PRIVATE KEY-----",
    expected: "<redacted>",
  },
  {
    name: "password pair",
    input: "password=hunter2000",
    expected: "password=<redacted>",
  },
  {
    name: "password pair with spaces",
    input: "password = hunter2000",
    expected: "password = <redacted>",
  },
  {
    name: "password pair in upper case",
    input: "PASSWORD=hunter2000",
    expected: "PASSWORD=<redacted>",
  },
  {
    name: "token pair",
    input: "token: hunter2000",
    expected: "token: <redacted>",
  },
  {
    name: "api key pair",
    input: "api_key=hunter2000",
    expected: "api_key=<redacted>",
  },
  {
    name: "prefixed api key pair",
    input: "x-api-key=hunter2000",
    expected: "x-api-key=<redacted>",
  },
  {
    name: "access token pair",
    input: "access_token=hunter2000",
    expected: "access_token=<redacted>",
  },
  {
    name: "quoted password in json",
    input: '{"password": "hunter2000"}',
    expected: '{"password": "<redacted>"}',
  },
  {
    name: "authorization pair keeps the scheme",
    input: "authorization=Bearer EXAMPLEEXAMPLEEXAMPLE",
    expected: "authorization=Bearer <redacted>",
  },
  {
    name: "secret pair",
    input: "client_secret=hunter2000",
    expected: "client_secret=<redacted>",
  },
  {
    name: "api key inside a pair",
    input: "api_key=sk-EXAMPLEEXAMPLEEXAMPLEEXAMPLE",
    expected: "api_key=<redacted>",
  },
];

/** Nothing that only looks like a secret may be touched. */
const FALSE_POSITIVE_CASES: TextCase[] = [
  { name: "prose about a password", input: "the password policy", expected: "the password policy" },
  { name: "a word starting with token", input: "tokenizer=abcdef", expected: "tokenizer=abcdef" },
  { name: "a plural key", input: "tokens=5", expected: "tokens=5" },
  { name: "a key with a suffix", input: "public_token_count=3", expected: "public_token_count=3" },
  { name: "prose about a secret", input: "secret sauce", expected: "secret sauce" },
  { name: "a short api key", input: "sk-short", expected: "sk-short" },
  { name: "a short github token", input: "ghp_short", expected: "ghp_short" },
  { name: "a short aws key", input: "AKIASHORT", expected: "AKIASHORT" },
  { name: "prose about a bearer", input: "bearer of responsibility", expected: "bearer of responsibility" },
  { name: "a plain word token", input: "the bearer token", expected: "the bearer token" },
  { name: "a normal sentence", input: "nothing to hide here", expected: "nothing to hide here" },
  { name: "a json file name", input: "package.json", expected: "package.json" },
  { name: "a test file name", input: "index.test.ts", expected: "index.test.ts" },
  { name: "a version number", input: "v1.2.3", expected: "v1.2.3" },
  { name: "a readme", input: "README.md", expected: "README.md" },
  { name: "a clock time", input: "12:34:56", expected: "12:34:56" },
  { name: "an abbreviation", input: "e.g. this is fine", expected: "e.g. this is fine" },
  { name: "a key generator", input: "ssh-keygen -t ed25519", expected: "ssh-keygen -t ed25519" },
  { name: "a key file path", input: "cat ~/.ssh/id_rsa", expected: "cat ~/.ssh/id_rsa" },
  { name: "a user name", input: "user=alice", expected: "user=alice" },
  { name: "a header name", input: "the Authorization header is missing", expected: "the Authorization header is missing" },
];

/** Hosts and addresses, masked only when `hostMask` is asked for. */
const HOST_CASES: TextCase[] = [
  {
    name: "an ipv4 address",
    input: "listening on 192.0.2.10:8080",
    expected: "listening on <ip>:8080",
    options: { hostMask: true },
  },
  {
    name: "an ipv6 address",
    input: "listening on fe80::1",
    expected: "listening on <ip>",
    options: { hostMask: true },
  },
  {
    name: "a host name",
    input: "the box is build-box.invalid",
    expected: "the box is <host>",
    options: { hostMask: true },
  },
  {
    name: "a url host",
    input: "see https://build-box.invalid/status",
    expected: "see https://<host>/status",
    options: { hostMask: true },
  },
  {
    name: "a url with an ip",
    input: "see http://198.51.100.7:18765/v1",
    expected: "see http://<ip>:18765/v1",
    options: { hostMask: true },
  },
  {
    name: "an ssh target",
    input: "ssh deploy@build-box.invalid",
    expected: "ssh deploy@<host>",
    options: { hostMask: true },
  },
  {
    name: "an ssh target without a domain",
    input: "ssh deploy@build-box",
    expected: "ssh deploy@<host>",
    options: { hostMask: true },
  },
  {
    name: "an ssh target with a port",
    input: "ssh -p 2222 deploy@build-box.invalid uptime",
    expected: "ssh -p 2222 deploy@<host> uptime",
    options: { hostMask: true },
  },
  {
    name: "an scp target",
    input: "scp notes.txt deploy@build-box.invalid:/srv/",
    expected: "scp notes.txt deploy@<host>:/srv/",
    options: { hostMask: true },
  },
  {
    name: "an rsync target",
    input: "rsync -av src/ user@build-box:dest/",
    expected: "rsync -av src/ user@<host>:dest/",
    options: { hostMask: true },
  },
  {
    name: "an ssh config host",
    input: "Host build-box\n  User deploy",
    expected: "Host <host>\n  User deploy",
    options: { hostMask: true },
  },
  {
    name: "a user at a host",
    input: "write to deploy@build-box.invalid",
    expected: "write to deploy@<host>",
    options: { hostMask: true },
  },
  {
    name: "an ipv4 address without host mask",
    input: "listening on 192.0.2.10:8080",
    expected: "listening on 192.0.2.10:8080",
  },
  {
    name: "a host name without host mask",
    input: "the box is build-box.invalid",
    expected: "the box is build-box.invalid",
  },
  {
    name: "an ssh target without host mask",
    input: "ssh deploy@build-box.invalid",
    expected: "ssh deploy@build-box.invalid",
  },
];

/** Host masking must not eat ordinary text. */
const HOST_FALSE_POSITIVE_CASES: TextCase[] = [
  {
    name: "a json file name",
    input: "open package.json",
    expected: "open package.json",
    options: { hostMask: true },
  },
  {
    name: "a version number",
    input: "version v1.2.3",
    expected: "version v1.2.3",
    options: { hostMask: true },
  },
  {
    name: "a clock time",
    input: "at 12:34:56 the job started",
    expected: "at 12:34:56 the job started",
    options: { hostMask: true },
  },
  {
    name: "an ssh in prose",
    input: "I ssh into the box every morning",
    expected: "I ssh into the box every morning",
    options: { hostMask: true },
  },
  {
    name: "a local rsync target",
    input: "rsync -av src/ dest/",
    expected: "rsync -av src/ dest/",
    options: { hostMask: true },
  },
  {
    name: "a key generator",
    input: "ssh-keygen -t ed25519 -f id_ed25519",
    expected: "ssh-keygen -t ed25519 -f id_ed25519",
    options: { hostMask: true },
  },
  {
    name: "an address that is not one",
    input: "999.999.999.999 is not an address",
    expected: "999.999.999.999 is not an address",
    options: { hostMask: true },
  },
];

for (const testCase of [...SECRET_CASES, ...FALSE_POSITIVE_CASES, ...HOST_CASES, ...HOST_FALSE_POSITIVE_CASES]) {
  test(`redactText: ${testCase.name}`, () => {
    assert.equal(redactText(testCase.input, testCase.options), testCase.expected);
  });
}

test("redactText leaves an empty string alone", () => {
  assert.equal(redactText(""), "");
});

test("redactText is idempotent", () => {
  const once = redactText("token=ghp_EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE");
  assert.equal(redactText(once), once);
});

test("redactText masks a secret and a host at the same time", () => {
  assert.equal(
    redactText("api_key=sk-EXAMPLEEXAMPLEEXAMPLEEXAMPLE on build-box.invalid", {
      hostMask: true,
    }),
    "api_key=<redacted> on <host>",
  );
});

test("redact walks a nested object", () => {
  const input = {
    id: "run-1",
    note: "token ghp_EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE",
    nested: { deep: { secret: "sk-EXAMPLEEXAMPLEEXAMPLEEXAMPLE" } },
  };

  assert.deepEqual(redact(input), {
    id: "run-1",
    note: "token <redacted>",
    nested: { deep: { secret: "<redacted>" } },
  });
});

test("redact masks values stored under secret keys", () => {
  const input = { password: "hunter2000", apiKey: "hunter2000", token: "hunter2000", user: "alice" };

  assert.deepEqual(redact(input), {
    password: REDACTED,
    apiKey: REDACTED,
    token: REDACTED,
    user: "alice",
  });
});

test("redact can keep secret keys untouched", () => {
  const input = { password: "hunter2000", note: "hunter2000" };

  assert.deepEqual(redact(input, { maskSecretKeys: false }), {
    password: "hunter2000",
    note: "hunter2000",
  });
});

test("redact does not mutate its input", () => {
  const input = Object.freeze({
    list: Object.freeze([Object.freeze({ token: "hunter2000" })]),
    note: "api_key=sk-EXAMPLEEXAMPLEEXAMPLEEXAMPLE",
  });
  const before = JSON.stringify(input);

  const output = redact(input);

  assert.equal(JSON.stringify(input), before);
  assert.notEqual(output, input);
  assert.notEqual(output.list, input.list);
  assert.deepEqual(output, {
    list: [{ token: REDACTED }],
    note: "api_key=<redacted>",
  });
});

test("redact copies arrays", () => {
  const input = ["api_key=sk-EXAMPLEEXAMPLEEXAMPLEEXAMPLE", 42, null, true];

  const output = redact(input);

  assert.deepEqual(output, ["api_key=<redacted>", 42, null, true]);
  assert.notEqual(output, input);
});

test("redact keeps values that are not strings", () => {
  const input = { count: 7, ratio: 0.5, flag: false, missing: null };

  assert.deepEqual(redact(input), input);
});

test("redact keeps class instances as they are", () => {
  class Model {
    id: string;
    constructor(id: string) {
      this.id = id;
    }
  }
  const model = new Model("m");

  const output = redact({ model });

  assert.equal(output.model, model);
});

test("redact survives a circular reference", () => {
  const input: Record<string, unknown> = { name: "loop" };
  input.self = input;

  const output = redact(input) as Record<string, unknown>;

  assert.equal(output.name, "loop");
  assert.equal(output.self, output);
});

test("redact accepts a plain string", () => {
  assert.equal(redact("token=ghp_EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE"), "token=<redacted>");
});

test("redact masks hosts in a nested object", () => {
  const input = { host: "build-box.invalid", note: "listening on 192.0.2.10" };

  assert.deepEqual(redact(input, { hostMask: true }), {
    host: "<host>",
    note: "listening on <ip>",
  });
});

test("the placeholders are stable", () => {
  assert.equal(REDACTED, "<redacted>");
  assert.equal(REDACTED_HOST, "<host>");
  assert.equal(REDACTED_IP, "<ip>");
});

test("secret key names are recognised", () => {
  for (const key of ["password", "passwd", "apiKey", "api_key", "API-KEY", "x-api-key", "token", "refreshToken"]) {
    assert.equal(isSecretKeyName(key), true, `${key} should be a secret key`);
  }
  for (const key of ["user", "author", "tokenizer", "model", "hostname"]) {
    assert.equal(isSecretKeyName(key), false, `${key} should not be a secret key`);
  }
});
