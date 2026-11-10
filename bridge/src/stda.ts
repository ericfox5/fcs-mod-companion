// The generic rosters (PLST / DCST) live in the game's standard-data DB, an entry of the game's BGFA archives
// (qkl_boot.ast, and qkl_fe2ig.ast as file 4664; hash b57b5e0ae8e74714, stored uncompressed). The 100-player roster
// patch keys every player by TGID * 100 + slot, so that entry has to be re-keyed too (packages/ncaa14 stda.ts). This
// module finds every copy in an RPCS3 install, reports its stride, rewrites it in place and puts it back:
// - in place only: the entry must be stored (not compressed) and the rewrite keeps its length, so the TOC is untouched
//   and only the changed byte ranges (PLST / DCST records and the two checksum words that cover them) are written;
// - before writing, the entry's original bytes and its TOC record go to <backups>/<stamp>-stda/ with a manifest
//   (archive, offset, length, sha256 before / after), which `restoreStda` uses to put the entry back.
// Used by `ncaa-bridge stda` and by FCS-online.exe's join step (installer/src/main.ts bundles it).
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseTdb, type TdbFile } from '@ncaa/tdb';
import { STDA_ENTRY_HASH, genericRosterStride, isStandardDataDb, rewriteStandardData } from '@ncaa/ncaa14';

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
export const STDA_BACKUP_ROOT = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ncaa-bridge', 'backups');

// ---- BGFA 1.05 table of contents (the layout spike/blaze/tools/uniforms/src/codec.cjs parseBigfile reads) ----
// header: 'BGFA1.05', u32 tocOff @0x10, u32 tocSize @0x18, u32 widths @0x20 (offset / hash byte widths in the top
// bytes), u32 widths2 @0x24 (compressed / size-delta widths), u32 prefixWords @0x28, u32 nameWidth @0x2c; TOC records
// {u16 flags, hash, offset, csize, usize - csize, name}, little endian.
export interface ArchiveEntry { index: number; hash: bigint; off: number; csize: number; usize: number; recordOffset: number; recordLength: number }
export interface ArchiveLayout { tocOff: number; tocSize: number; pw: number; nw: number; offW: number; hashW: number; csW: number; usW: number; rec: number }
// the header's TOC geometry: where the records are, the byte widths of their fields (a record is flags u16, hash, offset,
// csize, usize - csize, name)
export function archiveLayout(fd: number): ArchiveLayout {
  const head = Buffer.alloc(0x40); readSync(fd, head, 0, 0x40, 0);
  if (head.toString('latin1', 0, 8) !== 'BGFA1.05') throw new Error('not a BGFA 1.05 archive');
  const tocOff = head.readUInt32LE(0x10), tocSize = head.readUInt32LE(0x18), w8 = head.readUInt32LE(0x20), w9 = head.readUInt32LE(0x24), pw = head.readUInt32LE(0x28), nw = head.readUInt32LE(0x2c);
  const offW = (w8 >>> 24) & 255, hashW = (w8 >>> 16) & 255, csW = (w9 >>> 8) & 255, usW = w9 & 255;
  return { tocOff, tocSize, pw, nw, offW, hashW, csW, usW, rec: 2 + hashW + offW + csW + usW + nw };
}
export function archiveToc(fd: number): ArchiveEntry[] {
  const read = (off: number, len: number) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return b; };
  const { tocOff, tocSize, pw, offW, hashW, csW, usW, rec } = archiveLayout(fd);
  const toc = read(tocOff, tocSize), out: ArchiveEntry[] = [];
  const n = (p: number, w: number) => { let v = 0n; for (let i = w - 1; i >= 0; i--) v = (v << 8n) | BigInt(toc[p + i]!); return v; };
  for (let p = pw * 4; p + rec <= tocSize; p += rec) {
    let q = p + 2; const hash = n(q, hashW); q += hashW; const off = Number(n(q, offW)); q += offW; const csize = Number(n(q, csW)); q += csW; const delta = Number(n(q, usW));
    out.push({ index: out.length, hash, off, csize, usize: csize + delta, recordOffset: tocOff + p, recordLength: rec });
  }
  return out;
}

// ---- where the copies are ----
// Every qkl_*.ast of the game in an RPCS3 tree: the disc folders (dev_hdd0/disc/*/PS3_GAME/USRDIR), the installed game
// folder and its DLC folder (dev_hdd0/game/BLUS31159/USRDIR[/DLC], qkl_patch.ast), and BLUS31159 paths in games.yml.
export function gameArchives(rpcs3Root: string): string[] {
  const dirs = new Set<string>();
  const disc = join(rpcs3Root, 'dev_hdd0', 'disc');
  if (existsSync(disc)) for (const d of readdirSync(disc)) dirs.add(join(disc, d, 'PS3_GAME', 'USRDIR'));
  const game = join(rpcs3Root, 'dev_hdd0', 'game', 'BLUS31159', 'USRDIR'); dirs.add(game); dirs.add(join(game, 'DLC'));
  for (const yml of [join(rpcs3Root, 'config', 'games.yml'), join(rpcs3Root, 'games.yml')]) {
    if (!existsSync(yml)) continue;
    for (const line of readFileSync(yml, 'utf8').split(/\r?\n/)) { const m = /^BLUS31159:\s*"?(.+?)"?\s*$/.exec(line); if (m) dirs.add(join(m[1]!, 'PS3_GAME', 'USRDIR')); }
  }
  const out: string[] = [];
  for (const d of dirs) { if (!existsSync(d)) continue; for (const f of readdirSync(d)) if (/^qkl_.*\.ast$/i.test(f) && statSync(join(d, f)).isFile()) out.push(join(d, f)); }
  return out.sort();
}

export interface StdaCopy { archive: string; entry: ArchiveEntry; stored: boolean; stride: number | null; sha: string; error?: string }
// The standard-data entry of one archive (null when the archive does not carry it).
export function readStda(archive: string): StdaCopy | null {
  const fd = openSync(archive, 'r');
  try {
    const entry = archiveToc(fd).find((e) => e.hash === STDA_ENTRY_HASH); if (!entry) return null;
    const stored = entry.csize === entry.usize;
    if (!stored) return { archive, entry, stored, stride: null, sha: '', error: `stored compressed (${entry.csize} of ${entry.usize} bytes): cannot be rewritten in place` };
    const b = Buffer.alloc(entry.csize); readSync(fd, b, 0, b.length, entry.off);
    const bytes = new Uint8Array(b.buffer, b.byteOffset, b.length);
    try { const f = parseTdb(bytes); if (!isStandardDataDb(f)) throw new Error('no PLST / DCST'); return { archive, entry, stored, stride: genericRosterStride(f), sha: sha256(bytes) }; }
    catch (e) { return { archive, entry, stored, stride: null, sha: sha256(bytes), error: `not the standard-data DB: ${(e as Error).message}` }; }
  } finally { closeSync(fd); }
}
export const findStdaCopies = (archives: string[]): StdaCopy[] => archives.map(readStda).filter((c): c is StdaCopy => c !== null);
// The parsed standard-data DB of one archive (null when the archive carries no stored copy).
export function stdaFile(archive: string): TdbFile | null {
  const fd = openSync(archive, 'r');
  try {
    const entry = archiveToc(fd).find((e) => e.hash === STDA_ENTRY_HASH); if (!entry || entry.csize !== entry.usize) return null;
    const b = Buffer.alloc(entry.csize); readSync(fd, b, 0, b.length, entry.off);
    return parseTdb(new Uint8Array(b.buffer, b.byteOffset, b.length));
  } finally { closeSync(fd); }
}

// Whether an RPCS3 that may be reading these archives is running: one whose rpcs3.exe sits above one of them. When
// the running processes' paths cannot be read, any running rpcs3.exe counts.
export function rpcs3RunningOver(archives: string[]): boolean {
  if (process.platform !== 'win32') return false;
  let running = false;
  try { running = /rpcs3\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq rpcs3.exe', '/NH'], { encoding: 'utf8', windowsHide: true })); } catch { return false; }
  if (!running) return false;
  let paths: string[] = [];
  try { paths = execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process -Name rpcs3 -ErrorAction SilentlyContinue).Path'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean); } catch { return true; }
  if (!paths.length) return true;
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();
  return paths.some((exe) => { const dir = norm(exe).replace(/\\[^\\]+$/, '\\'); return archives.some((a) => norm(a).startsWith(dir)); });
}
export const rpcs3RootFromConfig = (): string | undefined => {
  try { return JSON.parse(readFileSync(join(homedir(), '.ncaa-bridge', 'config.json'), 'utf8')).rpcs3Root as string | undefined; } catch { return undefined; }
};

// ---- re-key in place, with a backup ----
export interface StdaBackupItem { archive: string; entryHash: string; offset: number; length: number; tocRecordOffset: number; tocRecordHex: string; backupFile: string; shaBefore: string; shaAfter: string; from: number; to: number; cells: number; changed: [number, number][] }
export interface StdaManifest { created: string; tool: string; items: StdaBackupItem[] }
export const newStdaBackupDir = (root = STDA_BACKUP_ROOT): string => join(root, `${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}-stda`);

export interface StdaRekeyOutcome { archive: string; status: 'rekeyed' | 'already' | 'skipped'; note: string; item?: StdaBackupItem }
// Re-key one archive's copy (and run `edit` on the re-keyed DB: a generic team swap). The backup (entry bytes + TOC
// record) is written and the manifest updated before the archive is touched; the written entry is read back and must
// match the rewrite byte for byte.
export function rekeyStdaArchive(archive: string, backupDir: string, opts: { to?: number; tool?: string; edit?: (file: TdbFile) => void } = {}): StdaRekeyOutcome {
  const fd = openSync(archive, 'r+');
  try {
    const entry = archiveToc(fd).find((e) => e.hash === STDA_ENTRY_HASH);
    if (!entry) return { archive, status: 'skipped', note: 'no standard-data entry' };
    if (entry.csize !== entry.usize) return { archive, status: 'skipped', note: `entry stored compressed (${entry.csize} of ${entry.usize} bytes): not rewritable in place` };
    if (entry.off + entry.csize > statSync(archive).size) throw new Error(`${archive}: the entry runs past the end of the file`);
    const cur = Buffer.alloc(entry.csize); readSync(fd, cur, 0, cur.length, entry.off);
    const before = new Uint8Array(cur.buffer, cur.byteOffset, cur.length);
    const rw = rewriteStandardData(before, { to: opts.to, edit: opts.edit });
    if (!rw.changed.length) return { archive, status: 'already', note: opts.edit ? `nothing to change (keyed at ${rw.result.to})` : `already keyed at ${rw.result.from}` };
    // backup first
    mkdirSync(backupDir, { recursive: true });
    const backupFile = join(backupDir, `${basename(archive)}.${entry.off}.orig`);
    if (existsSync(backupFile)) throw new Error(`${backupFile} exists; use a new backup folder`);
    writeFileSync(backupFile, before);
    const rec = Buffer.alloc(entry.recordLength); readSync(fd, rec, 0, rec.length, entry.recordOffset);
    const item: StdaBackupItem = { archive, entryHash: STDA_ENTRY_HASH.toString(16), offset: entry.off, length: entry.csize, tocRecordOffset: entry.recordOffset, tocRecordHex: rec.toString('hex'), backupFile, shaBefore: sha256(before), shaAfter: sha256(rw.bytes), from: rw.result.from, to: rw.result.to, cells: rw.result.cells, changed: rw.changed };
    const mf = join(backupDir, 'manifest.json');
    const manifest: StdaManifest = existsSync(mf) ? JSON.parse(readFileSync(mf, 'utf8')) : { created: new Date().toISOString(), tool: opts.tool ?? 'ncaa-bridge stda', items: [] };
    manifest.items.push(item); writeFileSync(mf, JSON.stringify(manifest, null, 1));
    // write only the changed ranges, then read the whole entry back
    for (const [a, b] of rw.changed) writeSync(fd, rw.bytes, a, b - a, entry.off + a);
    const back = Buffer.alloc(entry.csize); readSync(fd, back, 0, back.length, entry.off);
    if (sha256(back) !== item.shaAfter) {
      writeSync(fd, before, 0, before.length, entry.off);
      throw new Error(`${archive}: the entry read back does not match the rewrite; the original bytes were written back`);
    }
    const rekeyed = rw.result.cells ? `${rw.result.cells} ids ${rw.result.from} -> ${rw.result.to} (${Object.entries(rw.result.perColumn).map(([k, v]) => `${k} ${v}`).join(', ')}; teams ${rw.result.teams.join(',')})` : `keyed at ${rw.result.to}`;
    return { archive, status: 'rekeyed', note: `${rekeyed}${opts.edit ? ', edited' : ''}, ${rw.changed.length} byte ranges written`, item };
  } finally { closeSync(fd); }
}

// ncaa-bridge stda status | rekey [--to 100] | restore [--backup DIR] [--force]; [--rpcs3 DIR] (default: rpcs3Root in
// ~/.ncaa-bridge/config.json) or [--archive FILE] for one archive.
export function stdaCli(sub: string | undefined, flags: Map<string, string>): void {
  const root = flags.get('rpcs3') ?? process.env.NCAA_RPCS3 ?? rpcs3RootFromConfig();
  const archives = flags.has('archive') ? [flags.get('archive')!] : root ? gameArchives(root) : [];
  if (sub === 'status' || sub === undefined) {
    if (!archives.length) { console.log('no archives: pass --rpcs3 DIR or --archive FILE (or set rpcs3Root in ~/.ncaa-bridge/config.json)'); return; }
    const copies = findStdaCopies(archives);
    if (!copies.length) console.log(`no standard-data entry in ${archives.length} archive(s)`);
    for (const c of copies) console.log(`${c.archive}: entry ${c.entry.index} at ${c.entry.off}, ${c.entry.csize} bytes, ${c.error ?? `generic rosters keyed at stride ${c.stride ?? '?'}`}${c.sha ? `, sha ${c.sha.slice(0, 12)}` : ''}`);
  } else if (sub === 'rekey') {
    if (rpcs3RunningOver(archives)) throw new Error('RPCS3 is running from this install: close it before touching the game archives');
    const copies = findStdaCopies(archives); if (!copies.length) throw new Error(`no standard-data entry in ${archives.length} archive(s) (pass --rpcs3 DIR or --archive FILE)`);
    const dir = newStdaBackupDir(); const to = flags.has('to') ? Number(flags.get('to')) : 100;
    for (const c of copies) { const r = rekeyStdaArchive(c.archive, dir, { to }); console.log(`${c.archive}: ${r.status}: ${r.note}`); }
    if (existsSync(join(dir, 'manifest.json'))) console.log(`backup: ${dir} (ncaa-bridge stda restore --backup "${dir}")`);
  } else if (sub === 'restore') {
    let dir = flags.get('backup');
    if (!dir) { const all = existsSync(STDA_BACKUP_ROOT) ? readdirSync(STDA_BACKUP_ROOT).filter((d) => d.endsWith('-stda') && existsSync(join(STDA_BACKUP_ROOT, d, 'manifest.json'))).sort() : []; if (!all.length) throw new Error(`no stda backup under ${STDA_BACKUP_ROOT}`); dir = join(STDA_BACKUP_ROOT, all[all.length - 1]!); }
    const items = (JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as StdaManifest).items;
    if (rpcs3RunningOver(items.map((i) => i.archive))) throw new Error('RPCS3 is running from this install: close it before touching the game archives');
    for (const n of restoreStda(dir, { force: flags.has('force') })) console.log(n);
  } else console.log('usage: ncaa-bridge stda status | rekey [--to 100] | restore [--backup DIR] [--force]   [--rpcs3 DIR | --archive FILE]');
}

// Put every entry of a backup folder back. An entry is only overwritten when it still holds what the re-key wrote
// (or `force`); one that already holds the original is left alone.
export function restoreStda(backupDir: string, opts: { force?: boolean } = {}): string[] {
  const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8')) as StdaManifest;
  const notes: string[] = [];
  for (const it of manifest.items) {
    const orig = new Uint8Array(readFileSync(it.backupFile));
    if (orig.length !== it.length || sha256(orig) !== it.shaBefore) throw new Error(`${it.backupFile} does not match its manifest entry`);
    const fd = openSync(it.archive, 'r+');
    try {
      const entry = archiveToc(fd).find((e) => e.hash === STDA_ENTRY_HASH);
      if (!entry || entry.off !== it.offset || entry.csize !== it.length) throw new Error(`${it.archive}: the entry moved or changed size since the backup; not restoring`);
      const cur = Buffer.alloc(entry.csize); readSync(fd, cur, 0, cur.length, entry.off); const now = sha256(cur);
      if (now === it.shaBefore) { notes.push(`${it.archive}: already the original`); continue; }
      if (now !== it.shaAfter && !opts.force) throw new Error(`${it.archive}: the entry changed since the re-key (sha ${now.slice(0, 12)}); pass --force to restore anyway`);
      writeSync(fd, orig, 0, orig.length, entry.off);
      notes.push(`${it.archive}: entry at ${entry.off} restored (${it.length} bytes)`);
    } finally { closeSync(fd); }
  }
  return notes;
}
