import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoAliases, validateBotHosts } from '../collab.mjs';

const bot = (kind, host) => ({ kind, host });

test('Claude runs locally and Codex or pi run remotely in either position', () => {
  for (const kind of ['codex', 'pi']) {
    const local = bot('claude', 'local');
    const remote = bot(kind, 'ssh-alias');
    assert.doesNotThrow(() => validateBotHosts({ a: local, b: remote }));
    assert.doesNotThrow(() => validateBotHosts({ a: remote, b: local }));
  }
  assert.doesNotThrow(() => validateBotHosts({ a: bot('codex', 'ssh-a'), b: bot('pi', 'ssh-b') }));
});

test('rejects forbidden hosts and missing or duplicate aliases', () => {
  assert.throws(() => validateBotHosts({ a: bot('claude', 'ssh-a'), b: bot('codex', 'ssh-b') }), /claude bots run only on the local machine/);
  for (const kind of ['codex', 'pi']) {
    assert.throws(() => validateBotHosts({ a: bot('claude', 'local'), b: bot(kind, 'local') }), /codex\/pi bots run only on remote hosts/);
    assert.throws(() => validateBotHosts({ a: bot(kind, 'local'), b: bot('claude', 'local') }), /codex\/pi bots run only on remote hosts/);
  }
  assert.throws(() => validateBotHosts({ a: bot('claude', 'local'), b: bot('claude', 'local') }), /distinct host aliases/);
  assert.throws(() => validateBotHosts({ a: bot('codex', 'ssh-a'), b: bot('pi', 'ssh-a') }), /distinct host aliases/);
  assert.throws(() => validateBotHosts({ a: bot('claude', 'local'), b: bot('codex', '') }), /REMOTE_CODEX/);
  assert.throws(() => validateBotHosts({ a: bot('other', 'ssh-a'), b: bot('codex', 'ssh-b') }), /Unsupported bot kind/);
});

test('demo defaults Claude to local and requires a remote Codex alias', () => {
  assert.deepEqual(demoAliases({ REMOTE_CODEX: 'ssh-alias' }), ['local', 'ssh-alias']);
  assert.deepEqual(demoAliases({ REMOTE_CLAUDE: 'local', REMOTE_CODEX: 'ssh-alias' }), ['local', 'ssh-alias']);
  assert.throws(() => demoAliases({}), /REMOTE_CODEX/);
  assert.throws(() => demoAliases({ REMOTE_CLAUDE: 'ssh-a', REMOTE_CODEX: 'ssh-b' }), /claude bots run only on the local machine/);
  assert.throws(() => demoAliases({ REMOTE_CODEX: 'local' }), /codex\/pi bots run only on remote hosts/);
});
