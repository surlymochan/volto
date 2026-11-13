import { daemonCommand } from '../src/client.ts';

export function validateBotHosts({ a, b }) {
  for (const bot of [a, b]) {
    if (!bot?.host) throw new Error('Each bot requires a host; set REMOTE_CODEX to an SSH alias');
    if (bot.kind === 'claude' && bot.host !== 'local') throw new Error('claude bots run only on the local machine');
    if ((bot.kind === 'codex' || bot.kind === 'pi') && bot.host === 'local') throw new Error('codex/pi bots run only on remote hosts');
    if (!['claude', 'codex', 'pi'].includes(bot.kind)) throw new Error(`Unsupported bot kind: ${bot.kind}`);
  }
  if (a.host === b.host) throw new Error('Bots require distinct host aliases');
}

export function demoAliases(env = process.env) {
  const a = { kind: 'claude', host: env.REMOTE_CLAUDE ?? 'local' };
  const b = { kind: 'codex', host: env.REMOTE_CODEX };
  validateBotHosts({ a, b });
  return [a.host, b.host];
}

export function hostSpecs(aliases) {
  if (aliases.some(x => !x) || aliases[0] === aliases[1]) throw new Error('Set REMOTE_CLAUDE and REMOTE_CODEX to distinct host aliases');
  return aliases.map((alias, i) => ({ alias, display: ['REMOTE_A', 'REMOTE_B'][i], ...(alias === 'local' ? { command: daemonCommand() } : {}) }));
}

export function maskHosts(value, hosts) {
  return hosts.reduce((text, { alias, display }) => alias === 'local'
    ? text.replace(/(?<![A-Za-z0-9_])local(?![A-Za-z0-9_])/g, display)
    : text.split(alias).join(display), String(value));
}
