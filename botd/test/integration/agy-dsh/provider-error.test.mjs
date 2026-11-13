import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AgyAdapter } from '../../../src/adapters/agy.ts';
import { DshAdapter } from '../../../src/adapters/dsh.ts';

const fake = fileURLToPath(new URL('./fixtures/fake-acp-error.mjs', import.meta.url));
const opts = { cwd: process.cwd() };

function start(t, adapter) {
  const spec = adapter.spawn(opts);
  const child = spawn(process.execPath, [fake], { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [];
  let wake;
  let stderr = '';
  let spawnError;
  child.on('error', (error) => { spawnError = error; wake?.(); });
  child.on('exit', () => wake?.());
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', (line) => {
    events.push(...adapter.parse(line));
    wake?.();
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 2000;
    while (!predicate(events)) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`child exited before event (code ${child.exitCode}, signal ${child.signalCode}): ${stderr}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for event: ${JSON.stringify(events)} ${stderr}`);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, remaining);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    }
  };
  return { child, events, send, waitFor, spec };
}

async function ready(t, adapter) {
  const run = start(t, adapter);
  for (const message of adapter.handshake(opts)) run.send(message);
  await run.waitFor((events) => events.some((event) => event.providerSessionId === 'fake-session'));
  return run;
}

for (const [name, create] of [
  ['agy ACP', () => new AgyAdapter({ protocol: 'acp' })],
  ['dsh', () => new DshAdapter()],
]) {
  test(`${name}: JSON-RPC provider error`, { timeout: 2500 }, async (t) => {
    const adapter = create();
    const run = await ready(t, adapter);
    run.send(adapter.prompt('error', { providerSessionId: 'fake-session' }));
    await run.waitFor((events) => events.some((event) => event.kind === 'error'));
    const event = run.events.find((event) => event.kind === 'error');
    assert.equal(typeof event.message, 'string');
    assert.equal(event.message, 'synthetic provider failure');
    assert.notEqual(event.message, '[object Object]');
  });

  test(`${name}: valid output follows malformed output`, { timeout: 2500 }, async (t) => {
    const adapter = create();
    const run = await ready(t, adapter);
    run.send(adapter.prompt('malformed', { providerSessionId: 'fake-session' }));
    await run.waitFor((events) => events.some((event) => event.kind === 'turn_end'));
    assert.deepEqual(run.events.slice(2), [
      { kind: 'raw', payload: '{"jsonrpc":' },
      { kind: 'text', delta: 'after malformed line' },
      { kind: 'turn_end', status: 'ok' },
    ]);
  });

  test(`${name}: crashed child reaches exit handler`, { timeout: 2500 }, async (t) => {
    const adapter = create();
    const run = await ready(t, adapter);
    const exited = once(run.child, 'exit');
    run.send(adapter.prompt('crash', { providerSessionId: 'fake-session' }));
    assert.deepEqual(await exited, [23, null]);
    assert.ok(!JSON.stringify(run.events).includes('synthetic-secret-92741'));
  });
}
