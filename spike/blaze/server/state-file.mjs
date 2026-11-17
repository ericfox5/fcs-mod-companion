// Crash-safe state files for the league server (dynasties.json, locker/index.json, usersettings.json, the table files).
//
//   writeFileAtomic   temp file in the same folder -> fsync -> rename over the target. A reader (the site sync,
//                     `ncaa-bridge od watch`, reads these files while the server runs) sees the old file or the new
//                     one, never half of one, and a crash or a full disk mid-write leaves the old file in place.
//                     With { backup: true } the file being replaced is kept as <file>.bak: one previous good copy.
//   saveJsonState     the same for a JSON value. Names and format on disk are unchanged.
//   loadJsonState     reads a state file. If it is truncated or not valid JSON, the previous good copy (<file>.bak) is
//                     loaded instead, the damaged file is kept beside it as <file>.damaged, and the log says so.
//
// A damaged file never replaces a good backup: the backup is only refreshed from a file this process has read back
// successfully or written itself.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const backupPath = (file) => `${file}.bak`;
export const damagedPath = (file) => `${file}.damaged`;
const key = (file) => path.resolve(file);
const trusted = new Set(); // files whose current content is known to be good
const damaged = new Set(); // files that failed to load: never copied over the backup
const inPlaceWarned = new Set();

// Windows refuses a rename while another program (antivirus, a sync client) holds the target without sharing it.
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const pause = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no pause available */ } };
const spin = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* shorter than any timer */ } };
function renameRetry(from, to) {
  // Windows only (elsewhere a rename over an open file just works, and these codes mean a real permission problem).
  // A reader holds the file for a moment at a time, so a retry right away usually succeeds: 30 quick ones a fraction
  // of a millisecond apart, then 20 ms apart, about half a second in all before the caller writes in place instead.
  const tries = process.platform === 'win32' ? 55 : 0;
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (!BUSY.has(e.code) || attempt >= tries) throw e;
      if (attempt < 30) spin(0.3); else pause(20);
    }
  }
}
function fsyncDir(dir) {
  if (process.platform === 'win32') return; // directories cannot be opened for fsync there
  let fd; try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch { /* best effort */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}
const parsesAsJson = (file) => { try { JSON.parse(fs.readFileSync(file, 'utf8')); return true; } catch { return false; } };

// Keeps the file that is about to be replaced as <file>.bak. A hard link when the file system has them (no copy, the
// old content stays under the .bak name after the rename), a copy otherwise.
function rotateBackup(file, { log, check, copy = false }) {
  if (!fs.existsSync(file) || damaged.has(key(file))) return false;
  if (!trusted.has(key(file)) && !check(file)) { log(`${path.basename(file)} is not readable as it stands; the previous good copy ${path.basename(backupPath(file))} is left alone`); return false; }
  const bak = backupPath(file), staged = `${bak}.${process.pid}.tmp`;
  try {
    fs.rmSync(staged, { force: true });
    if (copy) fs.copyFileSync(file, staged);
    else { try { fs.linkSync(file, staged); } catch { fs.copyFileSync(file, staged); } }
    renameRetry(staged, bak);
    return true;
  } catch (e) {
    fs.rmSync(staged, { force: true });
    log(`could not refresh ${path.basename(bak)}: ${e.message}`);
    return false;
  }
}

// data: string or Buffer. options: backup (keep the replaced file as .bak), mode (new file permissions, before the
// process umask), log(message), check(file) -> boolean (is the current file good enough to become the backup).
export function writeFileAtomic(file, data, { backup = false, mode = 0o666, log = () => {}, check = parsesAsJson } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (e) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
    fs.rmSync(tmp, { force: true });
    throw e; // the old file is untouched
  }
  fs.closeSync(fd);
  const rotated = backup ? rotateBackup(file, { log, check }) : false;
  try {
    renameRetry(tmp, file);
  } catch (e) {
    if (!BUSY.has(e.code)) { fs.rmSync(tmp, { force: true }); throw e; }
    // Still held after the retries: write in place, as the server always did, so the save is not lost. The backup
    // must be a real copy first (a hard link would be overwritten together with the file).
    try {
      if (rotated) rotateBackup(file, { log, check, copy: true });
      fs.writeFileSync(file, data);
    } finally { fs.rmSync(tmp, { force: true }); }
    if (!inPlaceWarned.has(key(file))) { inPlaceWarned.add(key(file)); log(`${path.basename(file)} is held open by another program (${e.code}); written in place this time`); }
  }
  trusted.add(key(file)); damaged.delete(key(file));
  fsyncDir(dir);
}

// Puts a finished temp file (same folder, already complete and closed) in place of `file`: flushed to disk, then
// renamed, so a reader sees the old file or the new one. Used for uploads that were received straight to disk.
export function commitFileAtomic(tmp, file) {
  let fd; try { fd = fs.openSync(tmp, 'r+'); fs.fsyncSync(fd); } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
  try { renameRetry(tmp, file); }
  catch (e) {
    if (!BUSY.has(e.code)) throw e;
    try { fs.copyFileSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); } // held open by another program: in place, as writeFileAtomic does
  }
  fsyncDir(path.dirname(file));
}

export function saveJsonState(file, value, { pretty = 0, ...options } = {}) {
  const text = JSON.stringify(value, null, pretty);
  writeFileAtomic(file, text, options);
  return Buffer.byteLength(text);
}

// Temp files left by a process that died mid-write (older than a minute, so a running writer's file is never touched).
function removeStaleTemps(file) {
  const dir = path.dirname(file), base = path.basename(file);
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(`${base}.`) || !f.endsWith('.tmp')) continue;
      const p = path.join(dir, f);
      try { if (Date.now() - fs.statSync(p).mtimeMs > 60000) fs.rmSync(p, { force: true }); } catch { /* gone */ }
    }
  } catch { /* no folder yet */ }
}
function readCandidate(file, validate) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { missing: true } : { error: `cannot be read (${e.code ?? e.message})` }; }
  if (text.trim() === '') return { error: 'is empty' };
  let value;
  try { value = JSON.parse(text); } catch { return { error: 'is not valid JSON (truncated or damaged)' }; }
  let ok = false; try { ok = !!validate(value); } catch { ok = false; }
  return ok ? { ok: true, value } : { error: 'does not have the expected content' };
}

// Returns { value, source, error? }:
//   source 'file'        the file itself was good
//          'backup'      the file was damaged; value comes from <file>.bak (changes since that save are lost)
//          'none'        there is no file yet (first start): value is undefined
//          'unreadable'  the file is damaged and there is no usable backup: value is undefined, the caller decides
// validate(value) -> boolean: the shape the caller needs. log(message) receives one clear line for anything unusual.
export function loadJsonState(file, { validate = (v) => v !== null && typeof v === 'object', log = () => {}, what = path.basename(file) } = {}) {
  removeStaleTemps(file);
  const bak = backupPath(file);
  const main = readCandidate(file, validate);
  if (main.ok) { trusted.add(key(file)); damaged.delete(key(file)); return { value: main.value, source: 'file' }; }
  trusted.delete(key(file));
  if (main.missing) {
    if (fs.existsSync(bak)) log(`${what} does not exist: starting without it. An older copy is in ${bak}; to use it, stop the server and copy it to ${file}`);
    return { value: undefined, source: 'none' };
  }
  damaged.add(key(file));
  // keep the damaged file for a look later; it is about to be replaced by the next save
  let kept = '';
  try { fs.copyFileSync(file, damagedPath(file)); kept = ` The damaged file is kept as ${damagedPath(file)}.`; } catch { /* nothing to keep */ }
  const prev = readCandidate(bak, validate);
  if (prev.ok) {
    let when = ''; try { when = ` saved ${fs.statSync(bak).mtime.toISOString()}`; } catch { /* no time */ }
    log(`WARNING: ${what} ${main.error}. Loaded the previous good copy ${bak}${when}; changes made after that save are lost.${kept}`);
    return { value: prev.value, source: 'backup', error: main.error };
  }
  log(`WARNING: ${what} ${main.error} and there is no usable previous copy (${bak} ${prev.missing ? 'does not exist' : prev.error}).${kept}`);
  return { value: undefined, source: 'unreadable', error: main.error };
}

// The number after "key": in a damaged file kept by loadJsonState (<file>.damaged), or 0. A truncated store usually
// still starts with its id counter, which is newer than the one in the previous copy.
export function damagedHint(file, name) {
  try {
    const fd = fs.openSync(damagedPath(file), 'r');
    try { const buf = Buffer.alloc(65536); const n = fs.readSync(fd, buf, 0, buf.length, 0); const m = new RegExp('"' + name + '"\\s*:\\s*(\\d{1,15})\\b').exec(buf.toString('utf8', 0, n)); return m ? Number(m[1]) : 0; }
    finally { fs.closeSync(fd); }
  } catch { return 0; }
}

// Largest whole number used as a file or folder name in `dir` (names like "12" or "12.bin"): after a recovery the id
// counters are moved past everything already on disk, so a new dynasty or file can never take over an old one's data.
export function maxNumericName(dir) {
  let max = 0;
  try { for (const f of fs.readdirSync(dir)) { const m = /^(\d{1,15})(\.[A-Za-z0-9]+)?$/.exec(f); if (m) max = Math.max(max, Number(m[1])); } } catch { /* no folder */ }
  return max;
}

// A state file that cannot be loaded on a public server: stop with a clear message (exit 78; systemd tries again
// each minute and gets the same answer until it is fixed) instead of starting an empty league over data that still
// exists on disk.
export function fatalState(tag, file) {
  console.error(`[${tag}] cannot start: ${file} is damaged and there is no good previous copy (${backupPath(file)}). ` +
    `Restore the newest backup (deploy/league-server/restore.sh), or move the damaged file away to start an empty league on purpose.`);
  process.exit(78);
}
