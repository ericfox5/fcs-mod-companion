import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'private');
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
export const captureFile = join(dir, `capture-${stamp}.jsonl`);

function bigintSafe(_k, v) { return typeof v === 'bigint' ? v.toString() : v; }

export function log(tag, msg, extra) {
  const line = `${new Date().toISOString()} [${tag}] ${msg}`;
  console.log(line + (extra !== undefined ? ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra, bigintSafe)) : ''));
  appendFileSync(captureFile, JSON.stringify({ t: Date.now(), tag, msg, extra }, bigintSafe) + '\n');
}
