// Console + capture-file logging. Locally every packet body goes to the console and to private/capture-<time>.jsonl
// (the reverse-engineering workflow). In cloud mode (NCAA_CLOUD=1) only the one-line messages are printed (journald
// keeps them), bodies and the capture file are off, and control characters a client put in a name cannot forge a line.
//   NCAA_LOG_BODIES=1   print decoded packet bodies anyway (credentials, passwords and session keys stay redacted)
//   NCAA_CAPTURE=on     write the capture file anyway
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isCloud, isHardened, envSwitch, privateDir } from './cloud-config.mjs';

// On/off settings are strict (cloud-config.mjs parseSwitch): a value that is neither on nor off stops the process
// with exit code 78 and one line naming the setting, here, before anything listens.
const cloud = isCloud();
isHardened(); // NCAA_HARDEN is checked the same way, whichever service this is
export const logBodies = envSwitch('NCAA_LOG_BODIES', !cloud);
const capture = envSwitch('NCAA_CAPTURE', !cloud);

const dir = privateDir();
if (capture) mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
export const captureFile = capture ? join(dir, `capture-${stamp}.jsonl`) : '(off)';

// Never written to a log, whatever the logging level: login credentials, dynasty passwords, session keys, tokens.
const SECRET_KEYS = new Set(['TCKT', 'PASS', 'SKEY', 'cap', 'token', 'authorization']);
function safe(k, v) { if (SECRET_KEYS.has(k) && v !== undefined && v !== null && v !== '') return '[redacted]'; return typeof v === 'bigint' ? v.toString() : v; }
const oneLine = (s) => String(s).replace(/[\x00-\x08\x0a-\x1f\x7f]/g, ' ');

export function log(tag, msg, extra) {
  if (!logBodies) extra = undefined;
  const text = cloud ? oneLine(msg) : msg;
  const line = `${new Date().toISOString()} [${tag}] ${text}`;
  console.log(line + (extra !== undefined ? ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra, safe)) : ''));
  if (capture) { try { appendFileSync(captureFile, JSON.stringify({ t: Date.now(), tag, msg, extra }, safe) + '\n'); } catch { /* a full disk must not stop the server */ } }
}
