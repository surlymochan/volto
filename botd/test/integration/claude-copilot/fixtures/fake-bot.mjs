import { createInterface } from 'node:readline';

const provider = process.argv[2];
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const update = (update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session', update } });
let promptId;

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (provider === 'copilot' && msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  } else if (provider === 'copilot' && msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session' } });
  } else if (msg.type === 'control_response' || (provider === 'copilot' && msg.result?.outcome)) {
    const answer = provider === 'claude' ? msg.response.response.behavior : msg.result.outcome.optionId;
    if (provider === 'claude') send({ type: 'assistant', message: { content: `answer:${answer}` } });
    else update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answer:${answer}` } });
    process.exit(0);
  } else if (msg.request?.subtype === 'interrupt' || msg.method === 'session/cancel') {
    if (provider === 'claude') send({ type: 'result', subtype: 'cancelled' });
    else send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });
    process.exit(0);
  } else if (msg.type === 'user' || msg.method === 'session/prompt') {
    const scenario = provider === 'claude' ? msg.message.content : msg.params.prompt[0].text;
    promptId = msg.id;
    if (provider === 'claude') send({ type: 'system', subtype: 'init', session_id: 'session' });
    if (scenario === 'exit') {
      if (provider === 'claude') send({ type: 'assistant', message: { content: 'unfinished' } });
      else update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'unfinished' } });
      process.exit(7);
    } else if (scenario === 'permission') {
      if (provider === 'claude') send({ type: 'control_request', request_id: 'perm', request: { subtype: 'can_use_tool', input: { command: 'ls' } } });
      else send({ jsonrpc: '2.0', id: 'perm', method: 'session/request_permission', params: { options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] } });
    } else if (scenario === 'cancel') {
      // Wait for the interrupt after the prompt has been received.
    } else if (scenario === 'error') {
      if (provider === 'claude') send({ type: 'result', subtype: 'error_during_execution' });
      else send({ jsonrpc: '2.0', id: promptId, error: { code: -1, message: 'provider failed' } });
      process.exit(0);
    } else if (scenario === 'garbage') {
      process.stdout.write('not json\n');
      process.exit(0);
    } else if (scenario === 'split') {
      const first = provider === 'claude' ? { type: 'assistant', message: { content: 'one' } } : { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'one' } } } };
      const second = provider === 'claude' ? { type: 'assistant', message: { content: 'two' } } : { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'two' } } } };
      const data = `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`;
      const cut = data.indexOf('\n') + 4;
      process.stdout.write(data.slice(0, cut));
      setTimeout(() => { process.stdout.write(data.slice(cut)); process.exit(0); }, 20);
    } else if (provider === 'claude') {
      send({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }, { type: 'tool_use', id: 't', name: 'shell', input: { cmd: 'ls' } }] } });
      send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'done' }] } });
      send({ type: 'result', subtype: 'success', usage: { input_tokens: 3, output_tokens: 2 } });
      process.exit(0);
    } else {
      update({ sessionUpdate: 'agent_message_chunk', content: { text: 'hello ' } });
      update({ sessionUpdate: 'agent_message_chunk', content: { text: 'world' } });
      update({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'shell', status: 'in_progress', content: { text: 'running' } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed', content: { text: 'done' } });
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 2 } } });
      process.exit(0);
    }
  }
});
