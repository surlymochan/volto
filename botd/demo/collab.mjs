#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { respond } from './fake-bot.mjs';
import { getAdapter } from '../src/adapters/index.ts';
import { route } from '../src/router.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const demo = resolve(root, 'botd/demo');
const fake = process.argv.includes('--fake');
const outIndex = process.argv.indexOf('--out');
if (outIndex !== -1 && !process.argv[outIndex + 1]) throw new Error('--out requires a path');
const out = outIndex === -1 ? resolve(demo, 'out', new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid) : resolve(process.argv[outIndex + 1]);
const aliases = fake ? ['REMOTE_A', 'REMOTE_B'] : [process.env.REMOTE_CLAUDE, process.env.REMOTE_CODEX];
if (aliases.some(x => !x) || aliases[0] === aliases[1]) throw new Error('Set REMOTE_CLAUDE and REMOTE_CODEX to distinct SSH aliases');
const mask = value => aliases.reduce((text, alias, i) => text.split(alias).join(['REMOTE_A', 'REMOTE_B'][i]), String(value));
const log = resolve(out, 'transcript.ndjson');
const started = Date.now();
await mkdir(out, { recursive: true, mode: 0o700 });
let relay;
const turns = [];
const bots = [
  { id: 'claude', host: 'REMOTE_A', kind: 'claude', family: 'claude', lane: 'primary', status: 'idle', quotaUsedPct: 0, costTier: 1 },
  { id: 'codex', host: 'REMOTE_B', kind: 'codex', family: 'gpt', lane: 'primary', status: 'idle', quotaUsedPct: 0, costTier: 1 },
];
const implement = `Create a new temporary directory on this host and implement slugify(input) in slugify.mjs, with node:test tests in slugify.test.mjs. The input is a string; lowercase it, trim whitespace, replace each run of non-ASCII letters and digits with one hyphen, and remove leading and trailing hyphens. Empty input or only punctuation returns an empty string. Run node --test in the directory. In your final answer include the complete contents of both files and the test result so a reviewer on a different host can review them.`;

function timeout(promise, ms = 300000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for provider')), ms); })]).finally(() => clearTimeout(timer));
}

async function fakeSession(kind, host) {
  const adapter = getAdapter(kind);
  let providerSessionId;
  const exchange = async payload => {
    const appendFile = (await import('node:fs/promises')).appendFile;
    await appendFile(log, JSON.stringify({ ts: Date.now(), host, kind, dir: 'c2s', frame: { op: 'send', payload } }) + '\n');
    const events = [];
    for (const reply of respond(payload)) {
      await appendFile(log, JSON.stringify({ ts: Date.now(), host, kind, dir: 's2c', frame: { op: 'event', payload: reply } }) + '\n');
      events.push(...adapter.parse(JSON.stringify(reply)));
    }
    return events;
  };
  for (const message of adapter.handshake({ cwd: '.' })) {
    for (const event of await exchange(message)) if (event.kind === 'ready') providerSessionId = event.providerSessionId;
  }
  return async text => {
    let answer = '', ended = false;
    for (const event of await exchange(adapter.prompt(text, { providerSessionId }))) {
      if (event.kind === 'ready') providerSessionId = event.providerSessionId;
      if (event.kind === 'text') answer += event.delta;
      if (event.kind === 'error') throw new Error(event.message);
      if (event.kind === 'turn_end') { if (event.status !== 'ok') throw new Error(`Provider turn ${event.status}`); ended = true; }
    }
    if (!ended) throw new Error('Fake provider did not end the turn');
    return answer;
  };
}

async function realSessions() {
  const hosts = aliases.map((alias, i) => ({ alias, display: ['REMOTE_A', 'REMOTE_B'][i] }));
  relay = spawn(process.execPath, [resolve(root, 'client-ui/relay.mjs'), '--frame-log', log], { cwd: root, env: { ...process.env, BOTD_HOSTS: JSON.stringify(hosts) }, stdio: ['ignore', 'pipe', 'pipe'] });
  relay.stderr.resume();
  const lines = createInterface({ input: relay.stdout });
  const port = await timeout(new Promise((resolvePort, reject) => {
    lines.on('line', line => { const match = line.match(/127\.0\.0\.1:(\d+)/); if (match) resolvePort(match[1]); });
    relay.once('error', reject); relay.once('exit', () => reject(new Error('Relay exited before listening')));
  }), 15000);
  const base = `http://127.0.0.1:${port}/api`;
  const request = async (path, data) => {
    const response = await fetch(base + path, data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    if (!response.ok) throw new Error(`Relay request failed (${response.status})`);
    return response.status === 204 ? null : response.json();
  };
  const sessions = [];
  for (let i = 0; i < 2; i++) {
    const host = encodeURIComponent(aliases[i]);
    await request(`/hosts/${host}/connect`, {});
    sessions.push(await request(`/hosts/${host}/sessions`, { kind: bots[i].kind }));
  }
  return sessions.map(({ sessionId }) => async text => {
    const controller = new AbortController();
    const response = await fetch(`${base}/sessions/${sessionId}/events`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Event stream failed (${response.status})`);
    const reading = (async () => {
      let buffer = '', answer = '';
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const event = JSON.parse(data);
          if (event.kind === 'text') answer += event.text;
          if (event.kind === 'permission') await request(`/permissions/${event.permissionId}`, { allow: true });
          if (event.kind === 'turn_end') { if (event.status !== 'ok') throw new Error(`Provider turn ${event.status}`); return answer; }
        }
      }
      throw new Error('Event stream ended before the turn');
    })();
    try { await request(`/sessions/${sessionId}/send`, { text }); return await timeout(reading); }
    finally { controller.abort(); }
  });
}

try {
  const sessions = fake ? [await fakeSession('claude', 'REMOTE_A'), await fakeSession('codex', 'REMOTE_B')] : await realSessions();
  const implementation = await sessions[0](implement);
  turns.push({ host: 'REMOTE_A', kind: 'claude', task: 'implementation', text: mask(implementation) });
  const decision = route({ id: 'review', type: 'review', difficulty: 2, implementerFamily: 'claude' }, bots, { running: [], hostLimits: {}, familyLimits: {}, globalLimit: 2 });
  if (!decision.ok || decision.kind !== 'codex') throw new Error('No independent Codex reviewer available');
  const review = await sessions[1](`Review the following implementation and tests against this specification: ${implement}\n\nImplementation report:\n${implementation}\n\nBegin your response with VERDICT: PASS or VERDICT: FAIL and explain your findings.`);
  const verdict = review.match(/\bVERDICT\s*:\s*(PASS|FAIL)\b/i)?.[1].toUpperCase() ?? 'UNKNOWN';
  turns.push({ host: decision.host, kind: decision.kind, task: 'review', text: mask(review) });
  const summary = { bots: bots.map(({ host, kind }) => ({ host, kind })), turns, review: { verdict }, durationMs: Date.now() - started, ok: verdict === 'PASS' };
  await writeFile(resolve(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  for (const turn of turns) console.log(`${turn.host} (${turn.kind}) — ${turn.task}\n${turn.text}\n`);
  console.log(`Review verdict: ${verdict}\nOutput: ${mask(out)}`);
  if (!summary.ok) process.exitCode = 1;
} catch (error) {
  console.error(mask(error.message)); process.exitCode = 1;
} finally {
  if (relay) { relay.kill(); await new Promise(resolveExit => { if (relay.exitCode !== null || relay.signalCode !== null) resolveExit(); else relay.once('exit', resolveExit); }); }
  try {
    const content = await readFile(log, 'utf8');
    const lines = content.split('\n').filter(Boolean).map(line => JSON.stringify(JSON.parse(line), (_key, value) => typeof value === 'string' ? mask(value) : value));
    await writeFile(log, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
