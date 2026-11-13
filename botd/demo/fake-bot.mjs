#!/usr/bin/env node
// Scripted provider for the demo. It responds only to provider prompt messages.
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function respond(message) {
  const result = [];
  const write = value => result.push(value);
  if (message.type === 'user') {
    write({ type: 'system', subtype: 'init', session_id: 'fake-claude' });
    write({ type: 'assistant', message: { content: [{ type: 'text', text: 'Implemented and tested in a temporary directory.\nslugify.mjs: export const slugify = s => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\nslugify.test.mjs: tests cover case, punctuation, whitespace and empty input.\nTests passed.' }] } });
    write({ type: 'result', subtype: 'success' });
  } else if (message.method === 'thread/start') {
    write({ id: message.id, result: { thread: { id: 'fake-codex' } } });
  } else if (message.method === 'turn/start') {
    write({ method: 'item/agentMessage/delta', params: { itemId: 'review', delta: 'VERDICT: PASS\nThe implementation and reported tests meet the requested behavior.' } });
    write({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for await (const line of createInterface({ input: process.stdin })) {
    for (const value of respond(JSON.parse(line))) process.stdout.write(JSON.stringify(value) + '\n');
  }
}
