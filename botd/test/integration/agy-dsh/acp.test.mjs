import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AgyAdapter } from '../../../src/adapters/agy.ts';
import { DshAdapter } from '../../../src/adapters/dsh.ts';

const fake = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url));
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
    const deadline = Date.now() + 3000;
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
  test(`${name}: handshake through child`, async (t) => {
    const run = await ready(t, create());
    assert.deepEqual(run.events, [{ kind: 'ready' }, { kind: 'ready', providerSessionId: 'fake-session' }]);
  });

  test(`${name}: streamed turn through child`, async (t) => {
    const adapter = create();
    const run = await ready(t, adapter);
    run.send(adapter.prompt('stream', { providerSessionId: 'fake-session' }));
    await run.waitFor((events) => events.some((event) => event.kind === 'turn_end'));
    assert.deepEqual(run.events.slice(2), [{ kind: 'text', delta: 'Hello' }, { kind: 'text', delta: ' world' }, { kind: 'turn_end', status: 'ok' }]);
  });

  test(`${name}: permission answer reaches child`, async (t) => {
    const adapter = create();
    const run = await ready(t, adapter);
    run.send(adapter.prompt('permission', { providerSessionId: 'fake-session' }));
    await run.waitFor((events) => events.some((event) => event.kind === 'permission'));
    const permission = run.events[2];
    assert.equal(permission.id, 'permission-1');
    run.send(adapter.answerPermission(permission.id, true));
    await run.waitFor((events) => events.some((event) => event.kind === 'turn_end'));
    assert.deepEqual(run.events.slice(3), [
      { kind: 'raw', payload: { jsonrpc: '2.0', method: 'vendor/permission_received', params: { outcome: { outcome: 'selected', optionId: 'yes' } } } },
      { kind: 'turn_end', status: 'ok' },
    ]);
  });

  test(`${name}: cancellation reaches child`, async (t) => {
    const adapter = create();
    const run = await ready(t, adapter);
    run.send(adapter.prompt('pending', { providerSessionId: 'fake-session' }));
    for (const message of adapter.cancel({ providerSessionId: 'fake-session' })) run.send(message);
    await run.waitFor((events) => events.some((event) => event.kind === 'turn_end'));
    assert.deepEqual(run.events.slice(2), [{ kind: 'turn_end', status: 'cancelled' }]);
  });

  test(`${name}: unknown method and truncated JSON survive stdout`, async (t) => {
    const adapter = create();
    const run = await ready(t, adapter);
    run.send(adapter.prompt('unknown', { providerSessionId: 'fake-session' }));
    await run.waitFor((events) => events.length >= 4);
    assert.deepEqual(run.events.slice(2), [
      { kind: 'raw', payload: { jsonrpc: '2.0', method: 'vendor/unknown', params: { value: 42 } } },
      { kind: 'raw', payload: '{"jsonrpc":' },
    ]);
  });

  test(`${name}: child exit is observable`, async (t) => {
    const adapter = create();
    const run = await ready(t, adapter);
    const exited = once(run.child, 'exit');
    run.send(adapter.prompt('exit', { providerSessionId: 'fake-session' }));
    assert.deepEqual(await exited, [23, null]);
    assert.deepEqual(run.events, [{ kind: 'ready' }, { kind: 'ready', providerSessionId: 'fake-session' }]);
  });

  test(`${name}: spawn argv contains no secret environment value`, async (t) => {
    const key = 'VOLTO_INTEGRATION_SECRET';
    const previous = process.env[key];
    process.env[key] = 'synthetic-secret-value-92741';
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    const run = start(t, create());
    assert.equal(run.spec.env[key], process.env[key]);
    assert.ok(run.spec.command.every((arg) => !arg.includes(process.env[key])));
  });
}
