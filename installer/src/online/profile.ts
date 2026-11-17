// A member's online profile: what the companion site hands out after sign-up, as a file (fcs-online-profile.json) or as
// a join code ("FCS1-" + base64url of the same JSON). This module reads either, says exactly what is wrong with a bad
// one, and keeps the accepted profile in the user's own profile folder. The credential (ticketHex) is never put in a
// message, a log line or an error, and neither is text that may be a mistyped join code (shownPath).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from './system.js';

export interface OnlineProfile { version: 1; userId: number; onlineId: string; ticketHex: string; issuedMs: number; expiresMs: number; server: string }
export type ProfileErrorCode = 'empty' | 'not-a-code' | 'code-version' | 'bad-characters' | 'truncated' | 'not-a-profile' | 'profile-version' | 'missing-fields'
  | 'bad-identity' | 'bad-credential' | 'bad-lifetime' | 'expired' | 'bad-server' | 'no-file';
export class ProfileError extends Error {
  constructor(public code: ProfileErrorCode, message: string) { super(message); this.name = 'ProfileError'; }
}
export const JOIN_PREFIX = 'FCS1-';
export const PROFILE_FILE = 'fcs-online-profile.json';
const TICKET_MAGIC_HEX = Buffer.from('FCSNP001').toString('hex');
const FIELDS = ['version', 'userId', 'onlineId', 'ticketHex', 'issuedMs', 'expiresMs', 'server'] as const;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const MAX_PROFILE_BYTES = 64 * 1024; // a real profile file is under 1 KB

// ---- the server name ------------------------------------------------------------------------------------------------
// What is wrong with a server name, in words (null when it is a plain host name or an IPv4 address). Only ASCII is
// accepted, and that is checked before anything is lower-cased: a name spelled with look-alike letters from another
// alphabet must not turn into the real one on the way in.
export function serverNameProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return 'it is empty';
  if (/[^\x21-\x7e]/.test(raw)) return 'it has spaces or letters that are not plain English letters (a look-alike name)';
  if (raw.includes('@')) return 'it has a user name or password in it';
  if (/[/\\?#]/.test(raw)) return 'it is a web address, not a server name';
  if (raw.includes(':')) return 'it has a port number or a colon in it';
  if (raw.endsWith('.')) return 'it ends with a dot';
  const host = raw.toLowerCase();
  if (!HOST_RE.test(host)) return 'it is not a host name';
  if (/^(0x[0-9a-f]*|\d+)$/.test(host.split('.').at(-1)!) && !IPV4_RE.test(host)) return 'it is a number that is not an ordinary IPv4 address';
  return null;
}
export const isPunycodeName = (host: string) => host.toLowerCase().split('.').some((label) => label.startsWith('xn--'));
// Is `host` the league's own server: the site's name or a name under it. Compared in lower case, label by label. A
// name with a punycode (xn--) label is never official, wherever it sits: that is how look-alike names are spelled.
// An address in numbers is never official either.
export function isOfficialServer(host: string, siteHost: string): boolean {
  if (serverNameProblem(host) || serverNameProblem(siteHost)) return false;
  const h = host.toLowerCase(), s = siteHost.toLowerCase();
  if (IPV4_RE.test(h) || isPunycodeName(h) || isPunycodeName(s) || !s.includes('.')) return false;
  return h === s || h.endsWith(`.${s}`);
}
// A path for a message. Text that may be a join code or a profile pasted at the wrong prompt is not repeated.
export function shownPath(file: string): string {
  if (file.length > 200 || /FCS\d+-|[{}]|[0-9a-f]{32}|[A-Za-z0-9_-]{60}/i.test(file) || /[\x00-\x1f\x7f]/.test(file)) return 'that file';
  return file;
}
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const again = 'Sign in on the site and copy the join code again (use the Copy button, not a mouse selection).';

// "FCS1-..." -> the JSON value inside. Whitespace and quotes a chat app or a line wrap added are ignored.
export function parseJoinCode(text: string): unknown {
  const code = text.replace(/[\s"'`​﻿]/g, '');
  if (!code) throw new ProfileError('empty', 'Nothing was pasted.');
  const m = /^FCS(\d+)-(.*)$/i.exec(code);
  if (!m) throw new ProfileError('not-a-code', `That is not a join code: a join code starts with ${JOIN_PREFIX}. ${again}`);
  if (m[1] !== '1') throw new ProfileError('code-version', `This is a version ${m[1]} join code and this FCS-online.exe reads version 1. Download the newest FCS-online.exe and run it again.`);
  const body = m[2]!.replace(/=+$/, '');
  if (!body) throw new ProfileError('truncated', `The join code is cut off right after ${JOIN_PREFIX}. ${again}`);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) throw new ProfileError('bad-characters', `The join code has characters that do not belong in one (only letters, digits, - and _ do). ${again}`);
  const cut = new ProfileError('truncated', `The join code is cut off: ${code.length} characters arrived and the end is missing. ${again}`);
  if (body.length % 4 === 1) throw cut;
  const json = Buffer.from(body, 'base64url').toString('utf8');
  try { return JSON.parse(json); } catch { throw json.trimStart().startsWith('{') ? cut : new ProfileError('not-a-profile', `That join code does not hold a profile. ${again}`); }
}

// The contract with the site: { version: 1, userId, onlineId, ticketHex, issuedMs, expiresMs, server }.
export function validateProfile(raw: unknown, now = Date.now()): OnlineProfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProfileError('not-a-profile', 'That is not an online profile.');
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) {
    if (typeof r.version === 'number' && r.version > 1) throw new ProfileError('profile-version', `This profile is version ${r.version} and this FCS-online.exe reads version 1. Download the newest FCS-online.exe and run it again.`);
    throw new ProfileError('profile-version', `This profile has no usable version (expected 1). ${again}`);
  }
  const missing = FIELDS.filter((f) => r[f] === undefined || r[f] === null);
  if (missing.length) throw new ProfileError('missing-fields', `The profile is incomplete (missing: ${missing.join(', ')}). ${again}`);
  const { userId, onlineId, ticketHex, issuedMs, expiresMs, server } = r;
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0 || userId > 0x7fffffff) throw new ProfileError('bad-identity', `The profile's player number is not valid. ${again}`);
  if (typeof onlineId !== 'string' || !/^[A-Za-z0-9_-]{3,16}$/.test(onlineId)) throw new ProfileError('bad-identity', `The profile's online name is not valid (3 to 16 letters, digits, - or _). Change it on the site, then copy the join code again.`);
  if (typeof ticketHex !== 'string' || !/^[0-9a-fA-F]{144}$/.test(ticketHex) || ticketHex.slice(0, 16).toLowerCase() !== TICKET_MAGIC_HEX) throw new ProfileError('bad-credential', `The sign-in key inside this profile is damaged. ${again}`);
  if (typeof issuedMs !== 'number' || typeof expiresMs !== 'number' || !Number.isSafeInteger(issuedMs) || !Number.isSafeInteger(expiresMs) || issuedMs < 0 || issuedMs >= expiresMs) throw new ProfileError('bad-lifetime', `The profile's dates are not valid. ${again}`);
  if (expiresMs <= now) throw new ProfileError('expired', `This profile expired on ${day(expiresMs)}. Sign in on the site and get a new join code.`);
  const serverProblem = serverNameProblem(server);
  if (typeof server !== 'string' || serverProblem) throw new ProfileError('bad-server', `The server address inside this profile cannot be used: ${serverProblem}. ${again}`);
  return { version: 1, userId, onlineId, ticketHex: ticketHex.toLowerCase(), issuedMs, expiresMs, server: server.toLowerCase() };
}

// A join code or the profile JSON itself, never a file path (what --code and standard input accept).
export function readProfileText(input: string, now = Date.now()): { profile: OnlineProfile; source: 'code' | 'json' } {
  const text = input.trim().replace(/^﻿/, '');
  if (!text) throw new ProfileError('empty', 'Nothing was entered.');
  if (text.length > MAX_PROFILE_BYTES) throw new ProfileError('not-a-code', `That is far too long to be a join code. ${again}`);
  if (text.startsWith('{')) {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new ProfileError('truncated', `The profile text is cut off or damaged. ${again}`); }
    return { profile: validateProfile(raw, now), source: 'json' };
  }
  return { profile: validateProfile(parseJoinCode(text), now), source: 'code' };
}
// What the member gave us: a join code, the profile JSON itself, or the path of the profile file.
export function readProfileInput(input: string, now = Date.now()): { profile: OnlineProfile; source: 'code' | 'json' | 'file' } {
  const text = input.trim().replace(/^﻿/, '');
  if (!text) throw new ProfileError('empty', 'Nothing was entered.');
  if (text.startsWith('{')) return readProfileText(text, now);
  const unquoted = text.replace(/^"(.*)"$/, '$1');
  if (!/^FCS\d+-/i.test(text.replace(/[\s"'`]/g, '')) && (/[\\/]|\.json$/i.test(unquoted) || fs.existsSync(unquoted))) return { profile: readProfileFile(unquoted, now), source: 'file' };
  return readProfileText(text, now);
}
export function readProfileFile(file: string, now = Date.now()): OnlineProfile {
  let text: string;
  try {
    if (fs.statSync(file).size > MAX_PROFILE_BYTES) throw new Error('too large');
    text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch { throw new ProfileError('no-file', `Cannot read ${shownPath(file)} as a profile file. Check the path, or paste the join code instead.`); }
  if (/^\s*FCS\d+-/i.test(text)) return validateProfile(parseJoinCode(text), now); // a join code saved in a text file
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ProfileError('truncated', `${shownPath(path.basename(file))} is cut off or is not a profile file. Download it again from the site.`); }
  return validateProfile(raw, now);
}

// ---- what may be shown ---------------------------------------------------------------------------------------------
// the SHA-256 the site keeps, shortened: enough to tell two profiles apart, useless for signing in
export const credentialFingerprint = (p: Pick<OnlineProfile, 'ticketHex'>) => createHash('sha256').update(Buffer.from(p.ticketHex, 'hex')).digest('hex').slice(0, 8);
export function describeProfile(p: OnlineProfile, now = Date.now()): string {
  const days = Math.floor((p.expiresMs - now) / 86400000);
  return `${p.onlineId} on ${p.server} (valid until ${day(p.expiresMs)}${days < 0 ? ', EXPIRED' : days <= 14 ? `, ${days} day(s) left` : ''}; key fingerprint ${credentialFingerprint(p)})`;
}
// Whose sign-in a profile is: the in-game name and the member number, never the key.
export const identityOf = (p: Pick<OnlineProfile, 'onlineId' | 'userId'>) => `${p.onlineId} (member number ${p.userId})`;
export const OWN_CODE_RULE = 'Use only a join code or profile file that you got from your own account page on the site: with one that somebody sent you, you would be playing as them.';
// What installing `next` does to the profile already saved on this PC:
//   none       nothing is saved yet            same     the very same profile
//   renewed    the same member, a new key or a changed name
//   different  ANOTHER member's profile: the saved one is replaced, and both are named
export function profileChange(saved: OnlineProfile | null, next: OnlineProfile): { kind: 'none' | 'same' | 'renewed' | 'different'; line?: string } {
  if (!saved) return { kind: 'none' };
  if (saved.userId !== next.userId) return { kind: 'different', line: `This PC is set up for ${identityOf(saved)}. Continuing REPLACES that profile with ${identityOf(next)}: the game on this PC will then sign in as ${next.onlineId}, not as ${saved.onlineId}.` };
  if (saved.ticketHex === next.ticketHex && saved.onlineId === next.onlineId && saved.server === next.server && saved.expiresMs === next.expiresMs) return { kind: 'same' };
  return { kind: 'renewed', line: `This replaces the profile saved on this PC for the same member (${identityOf(saved)}, key fingerprint ${credentialFingerprint(saved)}) with ${saved.onlineId === next.onlineId ? 'the new one' : `the new one, now named ${next.onlineId}`} (key fingerprint ${credentialFingerprint(next)}).` };
}
export function profileWarnings(p: OnlineProfile, now = Date.now()): string[] {
  const out: string[] = [], days = Math.floor((p.expiresMs - now) / 86400000);
  if (days <= 14) out.push(`this profile runs out in ${days} day(s): get a new join code on the site before then and run join again`);
  if (p.issuedMs > now + 86400000) out.push(`this profile was issued on ${day(p.issuedMs)}, after this PC's date (${day(now)}): check the PC clock, the game uses it to decide whether the profile is still valid`);
  return out;
}

// ---- storage: the user's own profile folder, nobody else's access ------------------------------------------------------
export const profileStoreDir = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'ncaa-bridge', 'online');
export const profileStorePath = (dir = profileStoreDir()) => path.join(dir, PROFILE_FILE);
const icacls = (args: string[]) => { try { return spawnSync('icacls', args, { stdio: 'ignore', windowsHide: true }).status === 0; } catch { return false; } };
// Windows: grant this user, then drop inherited access (in that order: if the grant fails, the access the folder
// had stays as it was). Elsewhere: 0700 / 0600. Returns false when it could not.
export function restrictToUser(target: string, isDir: boolean): boolean {
  if (process.platform !== 'win32') { try { fs.chmodSync(target, isDir ? 0o700 : 0o600); return true; } catch { return false; } }
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username;
  if (/[\0-\x1f"*?<>|:]/.test(user)) return false;
  return icacls([target, '/grant:r', `${user}:${isDir ? '(OI)(CI)F' : 'F'}`]) && icacls([target, '/inheritance:r']);
}
// back to the access the folder gives (after the personal entry is gone from a file other programs also use)
export function inheritAccess(target: string): boolean {
  if (process.platform !== 'win32') return true;
  return icacls([target, '/reset']);
}
// Written under a name nobody can guess or prepare, inside the folder that is already restricted, then moved into place.
export function saveProfile(p: OnlineProfile, dir = profileStoreDir()): { file: string; restricted: boolean } {
  fs.mkdirSync(dir, { recursive: true });
  const restricted = restrictToUser(dir, true); // before the file exists: it is never readable by anyone else
  for (const f of fs.readdirSync(dir)) if (f.startsWith(`${PROFILE_FILE}.`) && f.endsWith('.tmp')) fs.rmSync(path.join(dir, f), { force: true }); // left by a run that was cut short
  const file = profileStorePath(dir), tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(p, null, 1), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw new Error(`could not save the profile in ${dir} (${(e as NodeJS.ErrnoException).code ?? 'error'})`); }
  return { file, restricted: restrictToUser(file, false) && restricted };
}
// the stored profile as saved (an expired one still loads, so status can say it expired); null when there is none
export function loadStoredProfile(dir = profileStoreDir()): OnlineProfile | null {
  try { const file = profileStorePath(dir); if (fs.statSync(file).size > MAX_PROFILE_BYTES) return null; return validateProfile(JSON.parse(fs.readFileSync(file, 'utf8')), 0); } catch { return null; }
}
export function forgetProfile(dir = profileStoreDir()): boolean {
  fs.rmSync(path.join(dir, INSTALL_NOTE), { force: true });
  const file = profileStorePath(dir); if (!fs.existsSync(file)) return false;
  fs.rmSync(file); return true;
}
// What join last set up on this PC: which RPCS3 folder, which server name, and the address written into the game's
// settings. No key in it. `check` and `status` use it to notice that the server has moved.
const INSTALL_NOTE = 'last-join.json';
export interface InstallNote { rpcs3: string; server: string; ip: string; at: number }
export function saveInstallNote(note: InstallNote, dir = profileStoreDir()): void {
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, INSTALL_NOTE), JSON.stringify(note, null, 1)); } catch { /* a convenience: join does not fail over it */ }
}
export function loadInstallNote(dir = profileStoreDir()): InstallNote | null {
  try {
    const file = path.join(dir, INSTALL_NOTE); if (fs.statSync(file).size > MAX_PROFILE_BYTES) return null;
    const n = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (typeof n.rpcs3 !== 'string' || !path.isAbsolute(n.rpcs3) || typeof n.server !== 'string' || serverNameProblem(n.server) || typeof n.ip !== 'string' || !IPV4_RE.test(n.ip)) return null;
    return { rpcs3: n.rpcs3, server: n.server.toLowerCase(), ip: n.ip, at: typeof n.at === 'number' ? n.at : 0 };
  } catch { return null; }
}
// a profile file the browser saved (Downloads, Desktop), newest first: offered so nobody has to type a path. Ordinary
// files only (no links), and nothing bigger than a profile can be.
export function findDownloadedProfiles(dirs = [path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Desktop'), path.join(os.homedir(), 'OneDrive', 'Desktop')]): string[] {
  const found: { file: string; at: number }[] = [];
  for (const d of dirs) {
    try {
      for (const f of fs.readdirSync(d)) {
        if (!/^fcs-online-profile( ?\(\d+\))?\.json$/i.test(f)) continue;
        try { const st = fs.lstatSync(path.join(d, f)); if (st.isFile() && st.size <= MAX_PROFILE_BYTES) found.push({ file: path.join(d, f), at: st.mtimeMs }); } catch { /* gone */ }
      }
    } catch { /* no such folder */ }
  }
  return found.sort((a, b) => b.at - a.at).map((x) => x.file);
}
