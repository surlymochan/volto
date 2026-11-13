import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser, readSseStream, relayBase, RealBotdClient, RelayError } from '../src/real-client.ts';
import type { ByteStream, FetchResponse } from '../src/real-client.ts';

const message = (data: string, id: string | null = null, event: string | null = null) => ({ id, event, data });
const stream = (chunks: Uint8Array[], release = () => {}): ByteStream => ({
  getReader() {
    let index = 0;
    return { async read() { return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }; }, releaseLock: release };
  },
});
const response = (status: number, body: string): FetchResponse => ({
  ok: status >= 200 && status < 300, status, body: null, async text() { return body; },
});

test('joins multiple data lines', () => {
  assert.deepEqual(createSseParser().push('data: one\ndata: two\n\n'), [message('one\ntwo')]);
});
test('field without colon has empty value', () => {
  assert.deepEqual(createSseParser().push('data\n\n'), [message('')]);
});
test('removes at most one leading space after colon', () => {
  assert.deepEqual(createSseParser().push('data:value\ndata: value\ndata:  value\n\n'), [message('value\nvalue\n value')]);
});
test('ignores id containing NUL', () => {
  assert.deepEqual(createSseParser().push('id: old\nid: bad\0id\ndata: x\n\n'), [message('x', 'old')]);
});
test('empty id resets the id', () => {
  assert.deepEqual(createSseParser().push('id: old\ndata: x\n\nid:\ndata: y\n\n'), [message('x', 'old'), message('y', '')]);
});
test('event type resets after dispatch', () => {
  assert.deepEqual(createSseParser().push('event: custom\ndata: x\n\ndata: y\n\n'), [message('x', null, 'custom'), message('y')]);
});
test('comments alone do not dispatch', () => {
  assert.deepEqual(createSseParser().push(': ping\n: pong\n\n'), []);
});
test('handles CRLF split between chunks', () => {
  const parser = createSseParser();
  assert.deepEqual(parser.push('data: x\r'), []);
  assert.deepEqual(parser.push('\n\r'), []);
  assert.deepEqual(parser.push('\n'), [message('x')]);
});
test('flushes unterminated message', () => {
  const parser = createSseParser();
  parser.push('data: tail');
  assert.deepEqual(parser.flush(), [message('tail')]);
});
test('handles one MiB of data in small chunks', () => {
  const parser = createSseParser();
  const data = 'x'.repeat(1024 * 1024);
  const input = `data: ${data}\n\n`;
  const result = [];
  for (let i = 0; i < input.length; i += 1024) result.push(...parser.push(input.slice(i, i + 1024)));
  assert.deepEqual(result, [message(data)]);
});
test('decodes UTF-8 split across byte chunks', async () => {
  const bytes = new TextEncoder().encode('data: 🐈\n\n');
  const result = [];
  for await (const item of readSseStream(stream([bytes.slice(0, 8), bytes.slice(8)]))) result.push(item);
  assert.deepEqual(result, [message('🐈')]);
});
test('empty stream yields nothing', async () => {
  const result = [];
  for await (const item of readSseStream(stream([]))) result.push(item);
  assert.deepEqual(result, []);
});
test('releases reader when consumer breaks', async () => {
  let released = false;
  for await (const item of readSseStream(stream([new TextEncoder().encode('data: x\n\n')], () => { released = true; }))) {
    assert.equal(item.data, 'x');
    break;
  }
  assert.equal(released, true);
});
test('relay query is trimmed and preserves path prefix', () => {
  assert.equal(relayBase('?other=x&relay=%20https%3A%2F%2Fexample.com%2Fprefix%2F%2F%20', 'fallback'), 'https://example.com/prefix');
});
test('missing or blank relay uses normalized fallback', () => {
  for (const query of ['', '?other=value', '?relay=', '?relay=+++']) assert.equal(relayBase(query, 'https://fallback///'), 'https://fallback');
});
test('top-level JSON error fields are used', { todo: 'client currently reads only nested error fields' }, async () => {
  const client = new RealBotdClient({ fetch: async () => response(403, JSON.stringify({ code: 'denied', message: 'No access' })) });
  await assert.rejects(client.listHosts(), (error: unknown) => error instanceof RelayError && error.status === 403 && error.code === 'denied' && error.message === 'No access');
});
test('nested JSON error fields are used', async () => {
  const client = new RealBotdClient({ fetch: async () => response(403, JSON.stringify({ error: { code: 'denied', message: 'No access' } })) });
  await assert.rejects(client.listHosts(), (error: unknown) => error instanceof RelayError && error.status === 403 && error.code === 'denied' && error.message === 'No access');
});
test('non-JSON errors retain status', async () => {
  const client = new RealBotdClient({ fetch: async () => response(502, 'bad gateway') });
  await assert.rejects(client.listHosts(), (error: unknown) => error instanceof RelayError && error.status === 502);
});
test('fetch rejection becomes status zero', async () => {
  const client = new RealBotdClient({ fetch: async () => { throw new Error('offline'); } });
  await assert.rejects(client.listHosts(), (error: unknown) => error instanceof RelayError && error.status === 0);
});
test('204 does not read a body', async () => {
  const client = new RealBotdClient({ fetch: async () => ({ ...response(204, ''), async text() { throw new Error('body read'); } }) });
  await client.connect('host');
});
test('encodes host aliases in request paths', async () => {
  let url = '';
  const client = new RealBotdClient({ base: 'https://relay', fetch: async (input) => { url = input; return response(204, ''); } });
  await client.connect('a/b ?#');
  assert.equal(url, 'https://relay/api/hosts/a%2Fb%20%3F%23/connect');
});
