// The game's RPCS3 network settings for the online league (config/custom_configs/config_BLUS31159.yml, section Net):
//   Internet enabled: Connected          the game may open sockets
//   PSN status: Disconnected             no PSN, no RPCN: the personal sign-in patch answers the game's PSN calls
//   IP swap list: "gosredirector.ea.com=<IPv4>&&*.ea.com=<IPv4>"   EA's host names resolve to the league server
// RPCS3 reads the swap list with inet_pton (Emu/NP/np_dnshook.cpp): the right-hand side must be an IPv4 address, a host
// name is rejected. So the profile's host name is resolved when join runs and the address is written; if the server
// ever moves to another address, `status` notices and running join again rewrites it.
import fs from 'node:fs';
import path from 'node:path';

export const GAME = 'BLUS31159';
export type PsnMode = 'Disconnected' | 'Simulated' | 'RPCN';
export const customConfigPath = (rpcs3: string) => path.join(rpcs3, 'config', 'custom_configs', `config_${GAME}.yml`);
const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n');

// "Section:" at column 0, keys at two spaces; everything else stays byte for byte (line endings included)
export function setYamlKey(text: string, section: string, key: string, value: string): string {
  const eol = eolOf(text), lines = text.split(/\r?\n/); let inSec = false, done = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\S/.test(l)) inSec = l.startsWith(`${section}:`);
    else if (inSec && l.startsWith(`  ${key}:`)) { lines[i] = `  ${key}: ${value}`; done = true; break; }
  }
  if (!done) {
    const idx = lines.findIndex((l) => l.startsWith(`${section}:`));
    if (idx < 0) { if (lines.at(-1) === '') lines.pop(); lines.push(`${section}:`, `  ${key}: ${value}`, ''); } else lines.splice(idx + 1, 0, `  ${key}: ${value}`);
  }
  return lines.join(eol);
}
export function getYamlKey(text: string, section: string, key: string): string | null {
  let inSec = false;
  for (const l of text.split(/\r?\n/)) {
    if (/^\S/.test(l)) inSec = l.startsWith(`${section}:`);
    else if (inSec && l.startsWith(`  ${key}:`)) return l.slice(key.length + 3).trim().replace(/^"(.*)"$/, '$1');
  }
  return null;
}
export const isIPv4 = (s: string) => /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s);
export const swapList = (ip: string) => `gosredirector.ea.com=${ip}&&*.ea.com=${ip}`;
export function applyOnlineNet(text: string, serverIp: string, psn: PsnMode = 'Disconnected'): string {
  if (!isIPv4(serverIp)) throw new Error(`RPCS3's IP swap list needs an IPv4 address, not "${serverIp}"`);
  let t = setYamlKey(text, 'Net', 'Internet enabled', 'Connected');
  t = setYamlKey(t, 'Net', 'PSN status', psn);
  return setYamlKey(t, 'Net', 'IP swap list', `"${swapList(serverIp)}"`);
}
export interface NetState { exists: boolean; internet: string | null; psn: string | null; swap: string | null; serverIp: string | null }
export function readNetState(text: string | null): NetState {
  if (text === null) return { exists: false, internet: null, psn: null, swap: null, serverIp: null };
  const swap = getYamlKey(text, 'Net', 'IP swap list');
  const ip = swap?.split('&&').map((s) => s.split('=')).find(([h]) => h === 'gosredirector.ea.com')?.[1] ?? null;
  return { exists: true, internet: getYamlKey(text, 'Net', 'Internet enabled'), psn: getYamlKey(text, 'Net', 'PSN status'), swap, serverIp: ip };
}
export const netState = (rpcs3: string): NetState => { const f = customConfigPath(rpcs3); return readNetState(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null); };

// Writes the three settings into the game's custom configuration. When the game has none yet, one is made the way
// RPCS3's "Create Custom Configuration" does: a copy of the global config.yml (or, on an install that has never saved
// one, a file with only the Net section: RPCS3 applies a custom configuration on top of the global settings).
export function configureOnlineNet(rpcs3: string, serverIp: string, psn: PsnMode, backup: (file: string) => string | null): { file: string; created: 'no' | 'from-global' | 'minimal'; changed: boolean; before: NetState } {
  const file = customConfigPath(rpcs3), global = path.join(rpcs3, 'config', 'config.yml');
  let created: 'no' | 'from-global' | 'minimal' = 'no', text: string;
  if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
  else if (fs.existsSync(global)) { text = fs.readFileSync(global, 'utf8'); created = 'from-global'; } else { text = ''; created = 'minimal'; }
  const before = readNetState(created === 'no' ? text : null), next = applyOnlineNet(text, serverIp, psn);
  const changed = created !== 'no' || next !== text;
  if (changed) { fs.mkdirSync(path.dirname(file), { recursive: true }); if (created === 'no') backup(file); fs.writeFileSync(file, next); }
  return { file, created, changed, before };
}
