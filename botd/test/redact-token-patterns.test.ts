// Catalogue of the credential shapes that botd/src/redact.ts masks.
//
// The credentials below are built at run time from short pieces, so this file
// never holds a literal that looks like a secret. Every value is synthetic:
// it has the shape of a credential and authenticates nothing. The host names
// use the reserved `.invalid` top level domain only.
//
// The catalogue adds the shapes that redact.test.ts, redact-leak.test.ts,
// redact-home-paths.test.ts and redact-structured.test.ts do not cover yet:
// the known token shapes in the contexts a transcript really holds — an env
// dump, a JSON body, a shell command line, a PEM block of several lines —
// and the shapes the text rules and the structured rules disagree on.
//
// Every entry asserts three things: the secret is gone, the text around it is
// preserved byte for byte, and the redaction is idempotent. Two cases are
// marked as todo: they describe defects of botd/src/redact.ts that this card
// does not fix (see the pull request body).

import test from "node:test";
import assert from "node:assert/strict";

import { redactText, REDACTED, REDACTED_HOST } from "../src/redact.ts";
import type { RedactOptions } from "../src/redact.ts";

/** Repeat a filler to build a synthetic credential of a given length. */
function filler(char: string, length: number): string {
  return char.repeat(length);
}

/** Join the pieces of a synthetic credential. */
function build(...pieces: string[]): string {
  return pieces.join("");
}

// --- the synthetic credentials --------------------------------------------

/** A JSON web token: three base64url parts. */
const jwt = build("ey", "J", "SYNTHETICHEADER", ".", "SYNTHETICPAYLOAD", ".", "SYNTHETICSIGNATURE");

/** A GitHub personal access token. */
const ghpToken = build("gh", "p_", filler("A", 24));

/** A GitHub OAuth token. */
const ghoToken = build("gh", "o_", filler("B", 24));

/** A GitHub server to server token. */
const ghsToken = build("gh", "s_", filler("C", 24));

/** A GitHub fine grained personal access token. */
const patToken = build("github", "_pat_", filler("D", 24));

/** An AWS access key id. */
const awsKeyId = build("AK", "IA", filler("E", 16));

/** An AWS temporary access key id. */
const awsSessionKeyId = build("AS", "IA", filler("F", 16));

/** An API key with dashes in the body of the key. */
const skKey = build("sk", "-proj-", "SYNTHETIC", "-KEY-0123456789");

/** The value of a bearer header. */
const bearerValue = build("SYNTHETIC", "-BEARER-", "0123456789");

/** The value of an env assignment. */
const envValue = build("SYNTHETIC", "-ENV-", "0123456789");

/** The password of a url userinfo. */
const urlPassword = build("hunt", "er", "2000");

/** A long hex string: no credential shape, so it has to survive. */
const longHex = filler("0123456789abcdef", 4);

/** A private key block of several lines. */
const pemBlock = [
  "-----BEGIN EC PRIVATE KEY-----",
  "SYNTHETIC-KEY-MATERIAL-LINE-ONE",
  "SYNTHETIC-KEY-MATERIAL-LINE-TWO",
  "SYNTHETIC-KEY-MATERIAL-LINE-THREE",
  "-----END EC PRIVATE KEY-----",
].join("\n");

// --- the catalogue ---------------------------------------------------------

/** One entry: the text, the secrets inside it and the text that must come out. */
interface Shape {
  name: string;
  text: string;
  secrets: string[];
  masked: string;
  options?: RedactOptions;
}

const SHAPES: Shape[] = [
  {
    name: "a json web token in a sentence",
    text: `the session started with ${jwt} and then failed`,
    secrets: [jwt],
    masked: `the session started with ${REDACTED} and then failed`,
  },
  {
    name: "a json web token used as a bearer credential",
    text: `Authorization: Bearer ${jwt}`,
    secrets: [jwt],
    masked: `Authorization: Bearer ${REDACTED}`,
  },
  {
    name: "a bearer header inside a request block",
    text: [
      "POST /v1/messages HTTP/1.1",
      `Authorization: Bearer ${bearerValue}`,
      "Host: api.example.invalid",
    ].join("\n"),
    secrets: [bearerValue],
    masked: [
      "POST /v1/messages HTTP/1.1",
      `Authorization: Bearer ${REDACTED}`,
      "Host: api.example.invalid",
    ].join("\n"),
  },
  {
    name: "a github personal access token in a sentence",
    text: `the remote refused ${ghpToken} with a 401`,
    secrets: [ghpToken],
    masked: `the remote refused ${REDACTED} with a 401`,
  },
  {
    name: "a github oauth token",
    text: `the refresh of ${ghoToken} failed`,
    secrets: [ghoToken],
    masked: `the refresh of ${REDACTED} failed`,
  },
  {
    name: "a github server to server token",
    text: `the webhook of ${ghsToken} was rejected`,
    secrets: [ghsToken],
    masked: `the webhook of ${REDACTED} was rejected`,
  },
  {
    name: "a github fine grained token in a json note",
    text: `{"note":"the credential is ${patToken}"}`,
    secrets: [patToken],
    masked: `{"note":"the credential is ${REDACTED}"}`,
  },
  {
    name: "an aws access key id in an env dump",
    text: `AWS_ACCESS_KEY_ID=${awsKeyId}`,
    secrets: [awsKeyId],
    masked: `AWS_ACCESS_KEY_ID=${REDACTED}`,
  },
  {
    name: "an aws temporary access key id",
    text: `the session key ${awsSessionKeyId} expired`,
    secrets: [awsSessionKeyId],
    masked: `the session key ${REDACTED} expired`,
  },
  {
    name: "a private key block of several lines",
    text: `the key follows\n${pemBlock}\nkeep this line`,
    secrets: [pemBlock],
    masked: `the key follows\n${REDACTED}\nkeep this line`,
  },
  {
    name: "an api key with dashes",
    text: `the key ${skKey} was rejected`,
    secrets: [skKey],
    masked: `the key ${REDACTED} was rejected`,
  },
  {
    name: "an env dump with several assignments",
    text: [
      "PATH=/usr/local/bin",
      `export API_KEY=${skKey}`,
      `export TOKEN=${envValue}`,
      "HOME=/root",
    ].join("\n"),
    secrets: [skKey, envValue],
    masked: [
      "PATH=/usr/local/bin",
      `export API_KEY=${REDACTED}`,
      `export TOKEN=${REDACTED}`,
      "HOME=/root",
    ].join("\n"),
  },
  {
    name: "a token in a json body",
    text: `{"id":"run-1","token":"${ghpToken}","note":"keep me"}`,
    secrets: [ghpToken],
    masked: `{"id":"run-1","token":"${REDACTED}","note":"keep me"}`,
  },
  {
    name: "a token in a shell command line",
    text: `API_KEY=${skKey} ./scripts/deploy.sh --token ${ghpToken}`,
    secrets: [skKey, ghpToken],
    masked: `API_KEY=${REDACTED} ./scripts/deploy.sh --token ${REDACTED}`,
  },
  {
    name: "the password of a url userinfo with host masking",
    text: `clone https://deploy:${urlPassword}@git.example.invalid/org/repo.git`,
    secrets: [urlPassword],
    masked: `clone https://${REDACTED_HOST}/org/repo.git`,
    options: { hostMask: true },
  },
  {
    name: "the same secret twice in one text",
    text: `first ${ghpToken} then ${ghpToken} last`,
    secrets: [ghpToken],
    masked: `first ${REDACTED} then ${REDACTED} last`,
  },
  {
    name: "a secret at the very start of the text",
    text: `${skKey} was the first thing`,
    secrets: [skKey],
    masked: `${REDACTED} was the first thing`,
  },
];

for (const shape of SHAPES) {
  test(`redactText masks ${shape.name}`, () => {
    const output = redactText(shape.text, shape.options);

    for (const secret of shape.secrets) {
      assert.ok(!output.includes(secret), `a secret of ${shape.name} survived`);
    }
    assert.equal(output, shape.masked);
    assert.equal(redactText(output, shape.options), output);
  });
}

test("redactText is idempotent for every shape of the catalogue", () => {
  for (const shape of SHAPES) {
    const once = redactText(shape.text, shape.options);
    assert.equal(redactText(once, shape.options), once, `${shape.name} is not idempotent`);
  }
});

test("redactText keeps a long hex string, it is not a known shape", () => {
  // The module documents a table of well known credential shapes; a hex
  // digest is none of them, so it has to survive untouched.
  const text = `sha256 ${longHex} of the archive`;

  const output = redactText(text);

  assert.equal(output, text);
  assert.ok(output.includes(longHex));
  assert.equal(redactText(output), output);
});

// TODO(defect): the text rules know no url userinfo, so the password of
// `https://user:pass@host` survives until the host masking takes the whole
// authority away. See the pull request body of this card.
test.todo("redactText masks the password of a url userinfo", () => {
  const text = `clone https://deploy:${urlPassword}@git.example.invalid/org/repo.git`;

  const output = redactText(text);

  assert.ok(!output.includes(urlPassword), "the password of the userinfo survived");
  assert.equal(output, `clone https://deploy:${REDACTED}@git.example.invalid/org/repo.git`);
  assert.equal(redactText(output), output);
});

// TODO(defect): the key/value rule of the text needs a word boundary before
// the key, so `x_api_key=` is kept while `x-api-key=` is masked — even
// though `isSecretKeyName` calls both a secret key name. See the pull
// request body of this card.
test.todo("redactText masks a secret key that carries a prefix", () => {
  const text = `EXAMPLE_TOKEN=${envValue}`;

  const output = redactText(text);

  assert.ok(!output.includes(envValue), "the value of the prefixed key survived");
  assert.equal(output, `EXAMPLE_TOKEN=${REDACTED}`);
  assert.equal(redactText(output), output);
});
