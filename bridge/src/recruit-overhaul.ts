// Fang's Recruit Overhaul (a community tool: RecruitOverhaul.exe, V6.0 BETA, a packaged Node program) reshapes a
// freshly generated recruiting class in a dynasty file: names drawn to match skin tone (with Hawaiian names), faces
// and body builds, gem/bust variance, the star and rank spread, pitch importances and small rating edits; the
// recruits' interest table (RCPR) is re-rolled with them. Offline it runs on a decrypted save in its your-save-file/
// folder; here the bridge runs it on the console's dynasty file when a season opens (the class is generated at the
// preseason, week 0) and publishes the result as the dynasty's file (DYNASTY.patch.bin), so every console downloads
// the reshaped class on its next load. The tool's base ratings live in the RCAT table of game file 4664 in
// qkl_fe2ig.ast, which it ships: installRcat writes that entry into the archive (same length, stored uncompressed,
// so the entry is replaced byte for byte and the TOC is untouched).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseTdb, serializeTdb, verifyTdb, type TdbFile } from '@ncaa/tdb';

export const OVERHAUL_DIR = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ncaa-bridge', 'overhaul');
export const RCAT_ENTRY = 4664;
export const RCAT_ARCHIVE = join('dev_hdd0', 'disc', 'BLUS31159-[NCAA Football 14]', 'PS3_GAME', 'USRDIR', 'qkl_fe2ig.ast');
const TIMEOUT_MS = 15 * 60 * 1000;

export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

// What one run of the tool produced: the reshaped DB on disk and the RCPT / RCPR fields it changed (the same fields
// are carried onto any later console file of the season that still has the vanilla class).
export interface OverhaulRun { db: Uint8Array; sha: string; fields: string[]; interestFields: string[]; renamed: number; seconds: number }

function rowsByPrsi(file: TdbFile, table: string): Map<number, number> {
  const t = file.table(table); const out = new Map<number, number>();
  for (let i = 0; i < t.recordCount; i++) out.set(Number(t.get(i, 'PRSI')), i);
  return out;
}
function changedFields(a: TdbFile, b: TdbFile, table: string): string[] {
  const ta = a.table(table), tb = b.table(table); const ib = rowsByPrsi(b, table); const out = new Set<string>();
  for (let i = 0; i < ta.recordCount; i++) { const j = ib.get(Number(ta.get(i, 'PRSI'))); if (j === undefined) continue; for (const f of ta.fields) if (!out.has(f.name) && ta.get(i, f.name) !== tb.get(j, f.name)) out.add(f.name); }
  return [...out];
}

// Runs the tool on a copy of `db` (a plain EA DB, the dynasty file's contents) in a private work folder and returns
// the reshaped DB once it verifies: checksums intact, the same recruits (PRSI) in the same order, names that fit.
export function runRecruitOverhaul(exe: string, db: Uint8Array, log: (line: string) => void = () => {}): OverhaulRun {
  if (!existsSync(exe)) throw new Error(`recruit overhaul tool not found at ${exe}`);
  const before = parseTdb(db);
  if (!before.hasTable('RCPT') || !before.table('RCPT').recordCount) throw new Error('the dynasty file has no recruits to overhaul');
  const work = join(OVERHAUL_DIR, 'work', `${Date.now()}-${process.pid}`); const saveDir = join(work, 'your-save-file');
  mkdirSync(saveDir, { recursive: true });
  writeFileSync(join(saveDir, 'USR-DATA'), db);
  const t0 = Date.now();
  let out = '';
  try {
    out = execFileSync(exe, [], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'], timeout: TIMEOUT_MS, maxBuffer: 64 << 20, windowsHide: true }).toString('utf8');
  } catch (e) {
    const err = e as Error & { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`recruit overhaul tool failed: ${err.message}${err.stdout?.length ? `\n${err.stdout.toString().slice(-800)}` : ''}${err.stderr?.length ? `\n${err.stderr.toString().slice(-800)}` : ''}`);
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  for (const line of out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== 'x')) log(`  tool: ${line}`);
  const result = new Uint8Array(readFileSync(join(saveDir, 'USR-DATA')));
  if (result.length !== db.length) throw new Error(`recruit overhaul tool wrote ${result.length} bytes, expected ${db.length}`);
  const after = parseTdb(result);
  const problems = verifyTdb(result, after);
  if (problems.length) throw new Error(`the overhauled file does not verify: ${JSON.stringify(problems.slice(0, 3))}`);
  const ra = before.table('RCPT'), rb = after.table('RCPT');
  if (ra.recordCount !== rb.recordCount) throw new Error(`the overhauled file has ${rb.recordCount} recruits, expected ${ra.recordCount}`);
  let renamed = 0;
  for (let i = 0; i < ra.recordCount; i++) {
    if (ra.get(i, 'PRSI') !== rb.get(i, 'PRSI')) throw new Error(`recruit order changed at row ${i}`);
    const fn = String(rb.get(i, 'PFNA')), ln = String(rb.get(i, 'PLNA'));
    if (!fn.trim() || !ln.trim() || fn.length > 11 || ln.length > 13) throw new Error(`recruit ${rb.get(i, 'PRSI')} has an unusable name "${fn} ${ln}"`);
    if (fn !== ra.get(i, 'PFNA') || ln !== ra.get(i, 'PLNA')) renamed++;
  }
  for (const t of before.tables) if (!['RCPT', 'RCPR'].includes(t.name) && after.hasTable(t.name)) { const u = after.table(t.name); if (u.recordCount !== t.recordCount) throw new Error(`the tool changed the row count of ${t.name}`); }
  const fields = changedFields(before, after, 'RCPT'); const interestFields = after.hasTable('RCPR') ? changedFields(before, after, 'RCPR') : [];
  rmSync(work, { recursive: true, force: true });
  return { db: result, sha: sha256(result), fields, interestFields, renamed, seconds };
}

// Does the console's file already carry this class (the console loaded the reshaped file and uploaded from it)? Names
// are the tell: the vanilla class and the reshaped one share no more than a handful.
export function classTaken(file: TdbFile, overhaul: TdbFile): boolean {
  if (!file.hasTable('RCPT') || !overhaul.hasTable('RCPT')) return false;
  const a = file.table('RCPT'), b = overhaul.table('RCPT'); const ib = rowsByPrsi(overhaul, 'RCPT');
  let same = 0, n = 0;
  for (let i = 0; i < a.recordCount; i++) { const j = ib.get(Number(a.get(i, 'PRSI'))); if (j === undefined) continue; n++; if (a.get(i, 'PFNA') === b.get(j, 'PFNA') && a.get(i, 'PLNA') === b.get(j, 'PLNA')) same++; }
  return n > 0 && same / n >= 0.9;
}

// Writes the reshaped class into `file` (a console dynasty file of the same season): the changed RCPT fields by
// recruit, and the re-rolled interest (RCPR) when the file is the one the tool ran on, before anyone recruited.
export function applyRecruitClass(file: TdbFile, overhaul: TdbFile, fields: string[], interestFields: string[], changes: string[]): void {
  const copy = (table: string, names: string[]) => {
    if (!names.length || !file.hasTable(table) || !overhaul.hasTable(table)) return 0;
    const t = file.table(table), o = overhaul.table(table); const io = rowsByPrsi(overhaul, table);
    const cols = names.filter((n) => t.fields.some((f) => f.name === n) && o.fields.some((f) => f.name === n));
    let rows = 0;
    for (let i = 0; i < t.recordCount; i++) { const j = io.get(Number(t.get(i, 'PRSI'))); if (j === undefined) continue; rows++; for (const c of cols) t.set(i, c, o.get(j, c)); }
    return rows;
  };
  const n = copy('RCPT', fields); const m = copy('RCPR', interestFields);
  changes.push(`recruit overhaul: ${n} recruits reshaped (${fields.length} fields)${m ? `, interest re-rolled for ${m}` : ''}`);
}

// ---- the archive entry with the tool's base ratings (RCAT) ----
interface AstEntry { i: number; off: number; csize: number; usize: number }
function astEntries(fd: number): AstEntry[] {
  const read = (off: number, len: number) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return b; };
  const head = read(0, 0x40);
  if (head.toString('latin1', 0, 8) !== 'BGFA1.05') throw new Error('not a BGFA 1.05 archive');
  const tocOff = head.readUInt32LE(0x10), tocSize = head.readUInt32LE(0x18), prefixWords = head.readUInt32LE(0x28), nameW = head.readUInt32LE(0x2c);
  const toc = read(tocOff, tocSize), rec = 22 + nameW; const out: AstEntry[] = [];
  for (let p = prefixWords * 4; p + rec <= tocSize; p += rec) out.push({ i: out.length, off: toc.readUInt32LE(p + 10), csize: toc.readUInt32LE(p + 14), usize: toc.readUInt32LE(p + 14) + toc.readUInt32LE(p + 18) });
  return out;
}
export const rcatBackupPath = (backupDir: string) => join(backupDir, `qkl_fe2ig.ast.${RCAT_ENTRY}.orig`);
// Writes the RCAT table of `rcat` (the tool's File04664.DB) into entry 4664 of the archive. Only that table moves: the
// FCS mod's own file 4664 differs from the tool's elsewhere too (rivalry name tables, RVNM / RVLY), and those stay.
// The table has the same rows and layout in both, so the DB keeps its length and the entry is rewritten in place
// with its checksum chain recomputed; the current entry is saved first so it can be put back.
export function installRcat(archive: string, rcat: Uint8Array, backupDir: string): { changed: boolean; offset: number } {
  const rep = parseTdb(rcat); if (!rep.hasTable('RCAT')) throw new Error('the replacement is not a game DB with an RCAT table');
  const fd = openSync(archive, 'r+');
  try {
    const e = astEntries(fd)[RCAT_ENTRY]; if (!e) throw new Error(`the archive has no entry ${RCAT_ENTRY}`);
    if (e.csize !== e.usize) throw new Error(`entry ${RCAT_ENTRY} is compressed (${e.csize} of ${e.usize} bytes); only a stored entry can be rewritten in place`);
    if (e.off + e.csize > fstatSync(fd).size) throw new Error(`entry ${RCAT_ENTRY} runs past the end of the archive`);
    const cur = Buffer.alloc(e.csize); readSync(fd, cur, 0, e.csize, e.off);
    const curDb = parseTdb(new Uint8Array(cur)); if (!curDb.hasTable('RCAT')) throw new Error(`entry ${RCAT_ENTRY} does not hold the RCAT DB; wrong archive?`);
    const a = curDb.table('RCAT'), b = rep.table('RCAT');
    if (a.data.length !== b.data.length || a.fieldDefsRaw.length !== b.fieldDefsRaw.length || a.fieldDefsRaw.some((v, i) => v !== b.fieldDefsRaw[i])) throw new Error('the RCAT tables differ in layout; the entry cannot be rewritten in place');
    if (a.data.every((v, i) => v === b.data[i]) && a.header.currentRecords === b.header.currentRecords) return { changed: false, offset: e.off };
    a.data.set(b.data); a.header.currentRecords = b.header.currentRecords;
    const out = serializeTdb(curDb, { padTo: cur.length });
    if (out.length !== cur.length) throw new Error(`the rewritten DB is ${out.length} bytes, the entry ${cur.length}`);
    const problems = verifyTdb(out, parseTdb(out)); if (problems.length) throw new Error(`the rewritten DB does not verify: ${JSON.stringify(problems.slice(0, 3))}`);
    mkdirSync(backupDir, { recursive: true });
    const backup = rcatBackupPath(backupDir); if (!existsSync(backup)) writeFileSync(backup, cur);
    writeSync(fd, out, 0, out.length, e.off);
    return { changed: true, offset: e.off };
  } finally { closeSync(fd); }
}
export function restoreRcat(archive: string, backupDir: string): boolean {
  const backup = rcatBackupPath(backupDir); if (!existsSync(backup)) throw new Error(`no backup at ${backup}`);
  const orig = new Uint8Array(readFileSync(backup));
  const fd = openSync(archive, 'r+');
  try {
    const e = astEntries(fd)[RCAT_ENTRY]; if (!e || e.csize !== orig.length) throw new Error(`entry ${RCAT_ENTRY} no longer matches the backup`);
    writeSync(fd, orig, 0, orig.length, e.off);
  } finally { closeSync(fd); }
  return true;
}
// The tool's exe is copied beside the bridge's own files so the download folder can be cleaned up.
export function installTool(exe: string): string {
  if (!existsSync(exe)) throw new Error(`not found: ${exe}`);
  mkdirSync(OVERHAUL_DIR, { recursive: true });
  const dest = join(OVERHAUL_DIR, 'RecruitOverhaul.exe');
  copyFileSync(exe, dest);
  return dest;
}
