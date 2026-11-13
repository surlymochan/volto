import { daemonCommand } from '../src/client.ts';

export function hostSpecs(aliases) {
  if (aliases.some(x => !x) || aliases[0] === aliases[1]) throw new Error('Set REMOTE_CLAUDE and REMOTE_CODEX to distinct host aliases');
  return aliases.map((alias, i) => ({ alias, display: ['REMOTE_A', 'REMOTE_B'][i], ...(alias === 'local' ? { command: daemonCommand() } : {}) }));
}

export function maskHosts(value, hosts) {
  return hosts.reduce((text, { alias, display }) => alias === 'local'
    ? text.replace(/(?<![A-Za-z0-9_])local(?![A-Za-z0-9_])/g, display)
    : text.split(alias).join(display), String(value));
}
