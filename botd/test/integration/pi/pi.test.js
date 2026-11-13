import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PiAdapter } from '../../../src/adapters/pi.ts';

const fake = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));

function start(t, options = {}) {
  const adapter = new PiAdapter();
  const opts = { cwd: process.cwd(), ...options };
  const spec = adapter.spawn(opts);
  const env = { ...spec.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [fake], { cwd: spec.cwd, env, stdio: 'pipe' });
  const events = [];
  let stderr = '';
  let wake = () => {};
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; wake(); });
  createInterface({ input: child.stdout }).on('line', (line) => {
    events.push(...adapter.parse(line));
    wake();
  });
  child.on('exit', () => wake());
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const send = (messages) => {
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 5000;
    while (!predicate(events)) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`child exited before expected event: ${child.exitCode} ${child.signalCode}: ${stderr}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('timed out waiting for event');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, remaining);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  };
  return { adapter, child, events, send, waitFor, opts, get stderr() { return stderr; } };
}

async function ready(t, opts) {
  const run = start(t, opts);
  run.send(run.adapter.handshake(run.opts));
  await run.waitFor((events) => events.some((event) => event.kind === 'ready'));
  return run;
}

async function turn(run, prompt) {
  const start = run.events.length;
  run.send([run.adapter.prompt(prompt, {})]);
  await run.waitFor((events) => events.slice(start).some((event) => event.kind === 'turn_end'));
  return run.events.slice(start);
}

const ack = (id) => ({ kind: 'raw', payload: { type: 'response', id, success: true } });

test('handshake reaches ready through the child', async (t) => {
  const run = await ready(t);
  assert.deepEqual(run.events, [ack('pi-1'), { kind: 'ready', providerSessionId: '/sessions/new.jsonl' }]);
  assert.equal(run.adapter.sessionId, 'session-1');
});

test('resume sends the session path to the child', async (t) => {
  const run = await ready(t, { resumeProviderSessionId: '/sessions/previous.jsonl' });
  assert.deepEqual(run.events, [ack('pi-1'), { kind: 'ready', providerSessionId: '/sessions/previous.jsonl' }]);
});

test('prompt streams deltas and ends without repeating final text', async (t) => {
  const events = await turn(await ready(t), 'stream');
  assert.deepEqual(events, [ack('pi-3'), { kind: 'text', delta: 'stream' }, { kind: 'text', delta: ' more' },
    { kind: 'raw', payload: { type: 'message_end', message: { role: 'assistant', content: 'stream more' } } },
    { kind: 'turn_end', status: 'ok' }]);
});

test('tool start and end travel through the process', async (t) => {
  const events = await turn(await ready(t), 'tools');
  assert.deepEqual(events, [ack('pi-3'), { kind: 'tool', name: 'read', status: 'start', summary: '{"path":"a.txt"}' },
    { kind: 'tool', name: 'read', status: 'end', summary: 'result' }, { kind: 'text', delta: 'tools' }, { kind: 'turn_end', status: 'ok' }]);
});

test('failed tool result is reported as an error', async (t) => {
  const events = await turn(await ready(t), 'tool error');
  assert.deepEqual(events[2], { kind: 'tool', name: 'read', status: 'error', summary: 'result' });
  assert.deepEqual(events.at(-1), { kind: 'turn_end', status: 'ok' });
});

test('abort ends an active turn and a later prompt succeeds', async (t) => {
  const run = await ready(t);
  run.send([run.adapter.prompt('hold', {})]);
  await run.waitFor((events) => events.some((event) => event.kind === 'text' && event.delta === 'hold'));
  run.send(run.adapter.cancel({}));
  await run.waitFor((events) => events.some((event) => event.kind === 'turn_end'));
  assert.deepEqual(run.events.slice(2), [ack('pi-3'), { kind: 'text', delta: 'hold' }, ack('pi-4'), { kind: 'turn_end', status: 'cancelled' }]);
  assert.deepEqual(await turn(run, 'again'), [ack('pi-5'), { kind: 'text', delta: 'again' }, { kind: 'turn_end', status: 'ok' }]);
});

test('malformed stdout is preserved and the turn continues', async (t) => {
  const events = await turn(await ready(t), 'malformed');
  assert.deepEqual(events, [ack('pi-3'), { kind: 'raw', payload: '{bad json' }, { kind: 'text', delta: 'malformed' }, { kind: 'turn_end', status: 'ok' }]);
});

test('stderr noise does not enter the normalized event stream', async (t) => {
  const run = await ready(t);
  const events = await turn(run, 'stderr');
  await run.waitFor(() => run.stderr.includes('diagnostic noise'));
  assert.deepEqual(events, [ack('pi-3'), { kind: 'text', delta: 'stderr' }, { kind: 'turn_end', status: 'ok' }]);
});

test('child exit during a turn does not invent a turn end', async (t) => {
  const run = await ready(t);
  const exited = once(run.child, 'close');
  run.send([run.adapter.prompt('exit', {})]);
  const [code] = await exited;
  assert.equal(code, 7);
  assert.deepEqual(run.events.slice(2), [ack('pi-3'), { kind: 'text', delta: 'before exit' }]);
});

test('a single stdout line larger than 1 MiB is parsed intact', async (t) => {
  const events = await turn(await ready(t), 'long');
  assert.deepEqual(events, [ack('pi-3'), { kind: 'text', delta: 'x'.repeat(1024 * 1024 + 1) }, { kind: 'turn_end', status: 'ok' }]);
});
