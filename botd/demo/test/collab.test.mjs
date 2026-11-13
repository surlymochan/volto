import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

test('offline collaboration records implementation and independent review', async () => {
  const base = resolve('.tmp');
  await (await import('node:fs/promises')).mkdir(base, { recursive: true });
  const out = await mkdtemp(resolve(base, 'collab-'));
  try {
    const argv = process.argv;
    const { REMOTE_CLAUDE, REMOTE_CODEX } = process.env;
    try {
      process.env.REMOTE_CLAUDE = 'remote';
      process.env.REMOTE_CODEX = 'local';
      process.argv = [process.execPath, resolve('botd/demo/collab.mjs'), '--fake', '--out', out];
      const { main } = await import('../collab.mjs');
      await main();
    } finally {
      process.argv = argv;
      if (REMOTE_CLAUDE === undefined) delete process.env.REMOTE_CLAUDE; else process.env.REMOTE_CLAUDE = REMOTE_CLAUDE;
      if (REMOTE_CODEX === undefined) delete process.env.REMOTE_CODEX; else process.env.REMOTE_CODEX = REMOTE_CODEX;
    }
    const summary = JSON.parse(await readFile(resolve(out, 'summary.json'), 'utf8'));
    const frames = (await readFile(resolve(out, 'transcript.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(summary.bots, [{ host: 'REMOTE_A', kind: 'claude' }, { host: 'REMOTE_B', kind: 'codex' }]);
    assert.equal(summary.ok, true);
    assert.equal(summary.review.verdict, 'PASS');
    assert.equal(summary.turns.length, 2);
    assert.match(summary.turns[0].text, /slugify/);
    assert.match(summary.turns[1].text, /VERDICT: PASS/);
    assert.ok(frames.some(row => row.host === 'REMOTE_A' && row.dir === 's2c'));
    const review = frames.find(row => row.host === 'REMOTE_B' && row.frame.payload?.method === 'turn/start');
    assert.match(review.frame.payload.params.input[0].text, /slugify\.mjs/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
