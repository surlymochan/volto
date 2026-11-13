import { createInterface } from 'node:readline';

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fake-session' } });
  } else if (message.method === 'session/prompt') {
    const text = message.params.prompt[0].text;
    if (text === 'error') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'synthetic provider failure' } });
    } else if (text === 'malformed') {
      process.stdout.write('{"jsonrpc":\n');
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after malformed line' } } } });
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    } else if (text === 'crash') {
      process.stderr.write('synthetic-secret-92741\n', () => process.exit(23));
    }
  }
}
