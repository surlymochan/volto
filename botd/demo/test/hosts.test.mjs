import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daemonCommand } from '../../src/client.ts';
import { hostSpecs, maskHosts } from '../hosts.mjs';

test('local host uses the daemon command in either position', () => {
  assert.deepEqual(hostSpecs(['local', 'remote']), [
    { alias: 'local', display: 'REMOTE_A', command: daemonCommand() },
    { alias: 'remote', display: 'REMOTE_B' },
  ]);
  assert.deepEqual(hostSpecs(['remote', 'local']), [
    { alias: 'remote', display: 'REMOTE_A' },
    { alias: 'local', display: 'REMOTE_B', command: daemonCommand() },
  ]);
});

test('hosts must be present and distinct', () => {
  for (const aliases of [['local', 'local'], ['remote', 'remote'], ['', 'remote'], ['local', undefined]]) {
    assert.throws(() => hostSpecs(aliases), /distinct host aliases/);
  }
});

test('masking replaces local as a whole token and masks remote aliases', () => {
  const hosts = hostSpecs(['local', 'ssh-alias']);
  assert.equal(maskHosts('local, (local) localhost locally localization _local local_ ssh-alias', hosts),
    'REMOTE_A, (REMOTE_A) localhost locally localization _local local_ REMOTE_B');
});
