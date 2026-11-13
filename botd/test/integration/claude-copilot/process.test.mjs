import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../../../src/adapters/claude.ts';
import { CopilotAdapter } from '../../../src/adapters/copilot.ts';

const fake = fileURLToPath(new URL('./fixtures/fake-bot.mjs', import.meta.url));

async function run(provider, scenario, allow) {
  const adapter = provider === 'claude' ? new ClaudeAdapter() : new CopilotAdapter();
  const opts = { cwd: process.cwd() };
  const oldEnabled = process.env.COPILOT_ENABLED;
  process.env.COPILOT_ENABLED = '1';
  let spec;
  try { spec = adapter.spawn(opts); } finally {
    if (oldEnabled === undefined) delete process.env.COPILOT_ENABLED;
    else process.env.COPILOT_ENABLED = oldEnabled;
  }
  const env = { ...process.env, ...spec.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [fake, provider], {
    cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events = [];
  let buffer = '';
  let stderr = '';
  let prompted = false;
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const prompt = () => {
    prompted = true;
    send(adapter.prompt(scenario, { providerSessionId: provider === 'copilot' ? 'session' : undefined }));
  };
  const consume = (line) => {
    for (const event of adapter.parse(line)) {
      events.push(event);
      if (provider === 'copilot' && event.kind === 'ready' && event.providerSessionId && !prompted) prompt();
      if (event.kind === 'permission') send(adapter.answerPermission(event.id, allow));
      if (scenario === 'cancel' && event.kind === 'ready' && event.providerSessionId) {
        for (const message of adapter.cancel({ providerSessionId: event.providerSessionId })) send(message);
      }
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      consume(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  });
  child.stdin.on('error', () => {});
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  for (const message of adapter.handshake(opts)) send(message);
  if (provider === 'claude') prompt();
  const result = await closed;
  clearTimeout(timer);
  assert.equal(buffer, '', 'fixture must end on a line boundary');
  assert.equal(result.signal, null, `child timed out: ${stderr}`);
  return { events, code: result.code, stderr };
}

for (const provider of ['claude', 'copilot']) {
  const ready = provider === 'claude' ? [{ kind: 'ready', providerSessionId: 'session' }] : [{ kind: 'ready' }, { kind: 'ready', providerSessionId: 'session' }];
  test(`${provider}: complete turn over stdio`, async () => {
    const { events, code, stderr } = await run(provider, 'happy');
    assert.equal(code, 0, stderr);
    assert.deepEqual(events, [...ready,
      { kind: 'text', delta: 'hello ' }, { kind: 'text', delta: 'world' },
      { kind: 'tool', name: 'shell', status: 'start', summary: provider === 'claude' ? '{"cmd":"ls"}' : 'running' },
      { kind: 'tool', name: 'shell', status: 'end', summary: 'done' },
      { kind: 'turn_end', status: 'ok', usage: { inputTokens: 3, outputTokens: 2 } },
    ]);
  });
  test(`${provider}: provider error over stdio`, async () => {
    const { events, code } = await run(provider, 'error');
    assert.equal(code, 0);
    assert.deepEqual(events, [...ready, provider === 'claude' ? { kind: 'turn_end', status: 'error' } : { kind: 'error', message: 'provider failed' }]);
  });
  test(`${provider}: reassembles split stdout lines`, async () => {
    const { events, code } = await run(provider, 'split');
    assert.equal(code, 0);
    assert.deepEqual(events, [...ready, { kind: 'text', delta: 'one' }, { kind: 'text', delta: 'two' }]);
  });
  test(`${provider}: preserves garbage output`, async () => {
    const { events, code } = await run(provider, 'garbage');
    assert.equal(code, 0);
    assert.deepEqual(events, [...ready, { kind: 'raw', payload: 'not json' }]);
  });
  test(`${provider}: child exits mid-turn`, async () => {
    const { events, code } = await run(provider, 'exit');
    assert.equal(code, 7);
    assert.deepEqual(events, [...ready, { kind: 'text', delta: 'unfinished' }]);
  });
  for (const allow of [true, false]) {
    test(`${provider}: permission ${allow ? 'allow' : 'deny'} is accepted`, async () => {
      const { events, code } = await run(provider, 'permission', allow);
      assert.equal(code, 0);
      const request = provider === 'claude' ? { subtype: 'can_use_tool', input: { command: 'ls' } } : { options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] };
      assert.deepEqual(events, [...ready, { kind: 'permission', id: 'perm', request }, { kind: 'text', delta: `answer:${allow ? 'allow' : 'deny'}` }]);
    });
  }
  test(`${provider}: cancel is accepted`, async () => {
    const { events, code } = await run(provider, 'cancel');
    assert.equal(code, 0);
    assert.deepEqual(events, [...ready, { kind: 'turn_end', status: 'cancelled' }]);
  });
}
