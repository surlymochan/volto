import { createInterface } from 'node:readline';

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let promptId;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fake-session' } });
  } else if (message.method === 'session/prompt') {
    promptId = message.id;
    const text = message.params.prompt[0].text;
    if (text === 'stream') {
      for (const part of ['Hello', ' world']) {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part } } } });
      }
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    } else if (text === 'permission') {
      send({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: { sessionId: message.params.sessionId, options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] } });
    } else if (text === 'unknown') {
      send({ jsonrpc: '2.0', method: 'vendor/unknown', params: { value: 42 } });
      process.stdout.write('{"jsonrpc":\n');
    } else if (text === 'exit') {
      process.exit(23);
    }
  } else if (message.method === 'session/cancel') {
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });
  } else if (message.id === 'permission-1') {
    send({ jsonrpc: '2.0', method: 'vendor/permission_received', params: message.result });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  }
}
