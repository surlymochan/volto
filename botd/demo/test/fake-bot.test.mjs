import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const demo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = resolve(demo, 'fake-bot.mjs');
const user = { type: 'user', message: { content: 'synthetic prompt' } };
const thread = { id: 42, method: 'thread/start' };
const turn = { id: 43, method: 'turn/start' };

function run(input) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('executor timed out')); }, 4000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (status, signal) => { clearTimeout(timer); resolveRun({ status, signal, stdout, stderr }); });
    child.stdin.end(input);
  });
}

function lines(...messages) {
  return messages.map(message => JSON.stringify(message)).join('\n') + '\n';
}

function output(result) {
  if (!result.stdout) return [];
  assert.ok(result.stdout.endsWith('\n'));
  return result.stdout.slice(0, -1).split('\n').map(line => {
    const value = JSON.parse(line);
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    return value;
  });
}

test('user prompt produces the canned implementation and success', { timeout: 4500 }, async () => {
  const result = await run(lines(user));
  assert.equal(result.status, 0);
  assert.deepEqual(output(result), [
    { type: 'system', subtype: 'init', session_id: 'fake-claude' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Implemented and tested in a temporary directory.\nslugify.mjs: export const slugify = s => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\nslugify.test.mjs: tests cover case, punctuation, whitespace and empty input.\nTests passed.' }] } },
    { type: 'result', subtype: 'success' },
  ]);
});

test('thread start echoes the request id and returns the fake thread', { timeout: 4500 }, async () => {
  const result = await run(lines(thread));
  assert.equal(result.status, 0);
  assert.deepEqual(output(result), [{ id: 42, result: { thread: { id: 'fake-codex' } } }]);
});

test('turn start returns the review and completed turn', { timeout: 4500 }, async () => {
  const result = await run(lines(turn));
  assert.equal(result.status, 0);
  assert.deepEqual(output(result), [
    { method: 'item/agentMessage/delta', params: { itemId: 'review', delta: 'VERDICT: PASS\nThe implementation and reported tests meet the requested behavior.' } },
    { method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } },
  ]);
});

test('stdin end exits successfully, including with no input', { timeout: 4500 }, async () => {
  const result = await run('');
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
});

test('all stdout lines are JSON objects when multiple requests are sent', { timeout: 4500 }, async () => {
  const result = await run(lines(user, thread, turn));
  assert.equal(result.status, 0);
  assert.equal(output(result).length, 6);
});

test('identical input produces identical output across runs', { timeout: 4500 }, async () => {
  const input = lines(thread, user, turn);
  const first = await run(input);
  const second = await run(input);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(first.stdout, second.stdout);
  output(first);
});

test('unknown messages are ignored and later requests still succeed', { timeout: 4500 }, async () => {
  const result = await run(lines({ method: 'unknown' }, {}, { type: 'unknown' }, thread));
  assert.equal(result.status, 0);
  assert.deepEqual(output(result), [{ id: 42, result: { thread: { id: 'fake-codex' } } }]);
});

test('malformed input does not crash the executor', { timeout: 4500, todo: 'invalid JSON and null currently crash the executor' }, async () => {
  for (const invalid of ['not-json', 'null']) {
    const result = await run(invalid + '\n' + lines(thread));
    assert.equal(result.status, 0, `input ${invalid} should be ignored`);
    assert.deepEqual(output(result), [{ id: 42, result: { thread: { id: 'fake-codex' } } }]);
  }
});

test('documented bot kinds use an existing demo fake command', { timeout: 4500 }, async () => {
  const collab = readFileSync(resolve(demo, 'collab.mjs'), 'utf8');
  const readme = readFileSync(resolve(demo, 'README.md'), 'utf8');
  const kinds = new Set([...collab.matchAll(/\bkind:\s*'([^']+)'/g)].map(match => match[1]));
  for (const [name, kind] of [['Claude', 'claude'], ['Codex', 'codex']]) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(readme)) kinds.add(kind);
  }
  const commands = { claude: 'fake-bot.mjs', codex: 'fake-bot.mjs' };
  assert.ok(kinds.size > 0);
  for (const kind of kinds) {
    assert.ok(commands[kind], `no demo fake command for ${kind}`);
    assert.ok(existsSync(resolve(demo, commands[kind])), `missing command for ${kind}`);
  }
  assert.match(collab, /from '\.\/fake-bot\.mjs'/);
});
