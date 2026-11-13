import { createInterface } from 'node:readline';

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (command, data) => send({ type: 'response', id: command.id, success: true, ...(data && { data }) });
const end = (stopReason = 'stop') => send({ type: 'agent_end', messages: [{ role: 'assistant', stopReason }] });
let sessionFile = '/sessions/new.jsonl';
let active = false;

process.stdin.resume();
createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line);
  switch (command.type) {
    case 'new_session':
      reply(command);
      break;
    case 'switch_session':
      sessionFile = command.sessionPath;
      reply(command);
      break;
    case 'get_state':
      reply(command, { sessionId: 'session-1', sessionFile });
      break;
    case 'abort':
      reply(command);
      if (active) {
        active = false;
        end('aborted');
      }
      break;
    case 'prompt':
      reply(command);
      if (command.message === 'exit') {
        send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before exit' } });
        process.exitCode = 7;
        process.stdin.destroy();
        break;
      }
      if (command.message === 'malformed') process.stdout.write('{bad json\n');
      if (command.message === 'stderr') process.stderr.write('diagnostic noise\n');
      if (command.message === 'tools' || command.message === 'tool error') {
        send({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: { path: 'a.txt' } });
        send({ type: 'tool_execution_end', toolCallId: 'call-1', isError: command.message === 'tool error', result: 'result' });
      }
      const delta = command.message === 'long' ? 'x'.repeat(1024 * 1024 + 1) : command.message;
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
      if (command.message === 'hold') {
        active = true;
      } else {
        if (command.message === 'stream') {
          send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' more' } });
          send({ type: 'message_end', message: { role: 'assistant', content: 'stream more' } });
        }
        end();
      }
      break;
  }
});
