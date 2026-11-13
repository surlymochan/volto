#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { redact } from '../src/redact.ts';

export function parseTranscript(input) {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Transcript is empty');
  const entries = trimmed.startsWith('[')
    ? JSON.parse(trimmed)
    : trimmed.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Transcript must contain entries');
  return entries;
}

export function verify(entries) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const valid = entries.every((entry) => object(entry) && typeof entry.t === 'string' &&
    typeof entry.host === 'string' && entry.host.length > 0 &&
    typeof entry.bot === 'string' && entry.bot.length > 0 &&
    (entry.dir === 'in' || entry.dir === 'out') && object(entry.frame) &&
    typeof entry.frame.op === 'string' && entry.frame.op.length > 0 &&
    Number.isSafeInteger(entry.frame.seq) && entry.frame.seq >= 0 &&
    Number.isSafeInteger(entry.frame.ack) && entry.frame.ack >= 0);
  add('Transcript format', valid, 'Entries require timestamps, host, bot, direction, operation, seq and ack');
  const usable = entries.filter((entry) => object(entry) && typeof entry.host === 'string' &&
    typeof entry.bot === 'string' && (entry.dir === 'in' || entry.dir === 'out') && object(entry.frame));
  const hosts = new Map();
  for (const entry of usable) {
    if (!hosts.has(entry.host)) hosts.set(entry.host, []);
    hosts.get(entry.host).push(entry);
  }
  const kinds = new Set(usable.map((entry) => entry.bot));
  add('Host and bot coverage', hosts.size >= 2 && kinds.size >= 2 && kinds.has('claude') && kinds.has('codex') &&
    [...hosts.values()].every((rows) => new Set(rows.map((row) => row.bot)).size === 1),
  'At least two hosts and bot kinds, including claude and codex; each host has one kind');
  add('Host aliases', usable.every(({ host }) => /^[A-Za-z0-9_-]+$/.test(host)),
    'Host names must be simple aliases without IP addresses or FQDNs');
  let lastTime = -Infinity;
  const timestamps = entries.every((entry) => {
    if (!object(entry) || typeof entry.t !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(entry.t)) return false;
    const time = Date.parse(entry.t);
    if (!Number.isFinite(time) || time < lastTime) return false;
    lastTime = time;
    return true;
  });
  add('Timestamps', timestamps, 'ISO-8601 timestamps are non-decreasing');
  let sequence = true;
  let lifecycle = hosts.size > 0;
  let recovery = true;
  for (const rows of hosts.values()) {
    const previous = new Map();
    let handshake = false;
    let ready = false;
    let prompt = false;
    let text = false;
    let terminal = false;
    let pendingError = false;
    for (const { dir, frame } of rows) {
      const prev = previous.get(dir);
      if (!Number.isSafeInteger(frame.seq) || frame.seq < 0 || !Number.isSafeInteger(frame.ack) || frame.ack < 0 ||
          (prev && (frame.seq !== prev.seq + 1 || frame.ack < prev.ack))) sequence = false;
      previous.set(dir, frame);
      if (dir === 'out' && (frame.op === 'handshake' || frame.op === 'hello')) handshake = true;
      if (dir === 'in' && frame.op === 'ready') ready = true;
      if (dir === 'out' && frame.op === 'prompt') { prompt = true; text = false; terminal = false; }
      if (dir === 'in' && frame.op === 'text' && prompt) text = true;
      if (dir === 'in' && frame.op === 'turn_end' && prompt && text) terminal = true;
      if (frame.op === 'error') pendingError = true;
      else if (dir === 'in' && (frame.op === 'ready' || frame.op === 'turn_end')) pendingError = false;
    }
    if (!(handshake && ready && prompt && text && terminal)) lifecycle = false;
    if (pendingError) recovery = false;
  }
  add('Host lifecycle', lifecycle, 'Each host has an outgoing handshake and prompt, and incoming ready, text and terminal turn_end');
  add('Sequence and acknowledgements', sequence && usable.length > 0, 'Sequence increases by one and ack never decreases per host and direction');
  add('Error recovery', recovery, 'Each error is followed by ready or turn_end on the same host');
  add('Redaction', isDeepStrictEqual(entries, redact(entries)), 'Transcript is a fixed point of redact()');
  return checks;
}

async function main() {
  const args = process.argv.slice(2);
  if (!(args.length === 1 || (args.length === 3 && args[1] === '--json')) || args[0].startsWith('--')) {
    throw new Error('Usage: node botd/demo-verify/verify-transcript.mjs <transcript> [--json out.json]');
  }
  const entries = parseTranscript(await readFile(args[0], 'utf8'));
  const checks = verify(entries);
  const pass = checks.every((check) => check.pass);
  for (const check of checks) console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
  console.log(`\n## Transcript verification\n\n**${pass ? 'PASS' : 'FAIL'}** — ${checks.filter((check) => check.pass).length}/${checks.length} checks passed.\n`);
  if (args.length === 3) await writeFile(args[2], `${JSON.stringify({ pass, checks }, null, 2)}\n`);
  if (!pass) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(`FAIL Transcript: ${error.message}`);
  console.log('\n## Transcript verification\n\n**FAIL** — unable to verify transcript.\n');
  process.exitCode = 1;
});
