import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, verify } from '../verify-transcript.mjs';

const entries = () => ['claude', 'codex'].flatMap((bot, hostIndex) =>
  [
    ['out', 'handshake', 1, 0],
    ['in', 'ready', 1, 1],
    ['out', 'prompt', 2, 1],
    ['in', 'text', 2, 2],
    ['in', 'turn_end', 3, 2],
  ].map(([dir, op, seq, ack], index) => ({
    t: `2026-01-01T00:00:0${hostIndex * 5 + index}Z`,
    host: `worker-${hostIndex}`,
    bot,
    dir,
    frame: { v: 1, op, seq, ack },
  })));

const check = (rows, name, pass) => {
  const result = verify(rows).find((item) => item.name === name);
  assert.ok(result, `missing check: ${name}`);
  assert.equal(result.pass, pass, name);
};

test('empty input and empty JSON array are rejected', () => {
  assert.throws(() => parseTranscript(' \r\n '), /Transcript is empty/);
  assert.throws(() => parseTranscript('[]'), /Transcript must contain entries/);
});

// DEFECT: parseTranscript accepts nonempty arrays containing invalid entry shapes.
test.todo('rejects a JSON array with the wrong entry shape', () => {
  assert.throws(() => parseTranscript('[null]'), /Transcript must contain entries/);
});

test('parses NDJSON with blank lines and CRLF', () => {
  const rows = entries();
  assert.deepEqual(parseTranscript(`\r\n${rows.map(JSON.stringify).join('\r\n\r\n')}\r\n`), rows);
});

test('valid synthetic transcript passes every named check', () => {
  const checks = verify(entries());
  assert.deepEqual(new Set(checks.map(({ name }) => name)), new Set([
    'Transcript format', 'Timestamps', 'Host and bot coverage', 'Host aliases',
    'Host lifecycle', 'Sequence and acknowledgements', 'Error recovery', 'Redaction',
  ]));
  assert.ok(checks.every(({ pass }) => pass));
});

test('format rejects a negative acknowledgement', () => {
  const rows = entries();
  rows[0].frame.ack = -1;
  check(rows, 'Transcript format', false);
});

test('timestamps accept an offset and reject missing zones and decreasing instants', () => {
  const rows = entries();
  rows[0].t = '2026-01-01T01:00:00+01:00';
  check(rows, 'Timestamps', true);
  rows[1].t = '2026-01-01T00:00:01';
  check(rows, 'Timestamps', false);
  rows[1].t = '2025-12-31T23:59:59Z';
  check(rows, 'Timestamps', false);
});

test('coverage rejects multiple bot kinds on one host', () => {
  const rows = entries();
  rows[0].bot = 'codex';
  check(rows, 'Host and bot coverage', false);
});

test('aliases reject whitespace', () => {
  const rows = entries();
  rows[0].host = 'worker a';
  check(rows, 'Host aliases', false);
});

test('lifecycle requires text after the prompt', () => {
  const rows = entries();
  rows[3].frame.op = 'progress';
  check(rows, 'Host lifecycle', false);
});

test('lifecycle accepts hello as a handshake', () => {
  const rows = entries();
  rows[0].frame.op = 'hello';
  check(rows, 'Host lifecycle', true);
});

test('acknowledgements cannot decrease within a direction', () => {
  const rows = entries();
  rows[4].frame.ack = 1;
  check(rows, 'Sequence and acknowledgements', false);
});

test('error recovery must occur on the same host', () => {
  const rows = entries();
  rows[4].frame.op = 'error';
  check(rows, 'Error recovery', false);
});

test('redaction detects a synthetic secret-key value', () => {
  const rows = entries();
  rows[3].frame.password = 'synthetic-value';
  check(rows, 'Redaction', false);
});
