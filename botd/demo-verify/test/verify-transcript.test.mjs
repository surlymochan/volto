import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseTranscript, verify } from '../verify-transcript.mjs';

const fixture = async (name) => parseTranscript(await readFile(new URL(`../fixtures/${name}.ndjson`, import.meta.url), 'utf8'));

for (const [name, expected, check] of [
  ['good', true, 'Host lifecycle'],
  ['one-bot-only', false, 'Host and bot coverage'],
  ['secret-leak', false, 'Redaction'],
  ['broken-seq', false, 'Sequence and acknowledgements'],
]) {
  test(name, async () => {
    const checks = verify(await fixture(name));
    assert.equal(checks.every((item) => item.pass), expected);
    assert.equal(checks.find((item) => item.name === check).pass, expected);
  });
}

test('JSON array input', async () => {
  const entries = await fixture('good');
  assert.deepEqual(parseTranscript(JSON.stringify(entries)), entries);
  assert.ok(verify(parseTranscript(JSON.stringify(entries))).every((check) => check.pass));
});

test('rejects unrecovered errors and invalid aliases', async () => {
  const entries = await fixture('good');
  entries[0].host = 'example.invalid';
  entries[4].frame.op = 'error';
  const checks = verify(entries);
  assert.equal(checks.find((item) => item.name === 'Host aliases').pass, false);
  assert.equal(checks.find((item) => item.name === 'Error recovery').pass, false);
});
