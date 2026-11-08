// The RPCS3 install a swap writes to: which uniform part names it already has (archives by hash, DLC folders by file),
// its FCS2026 roster save and the game's default roster DB (qkl_boot.ast entry 092f677e439a5110, the roster a new
// game starts from), both rewritten in place with the original bytes kept, and the generic slots' home stadiums.
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseTdb, serializeTdb, type TdbFile } from '@ncaa/tdb';
import { archiveToc } from '../stda.js';
import { bgfaToc, type BgfaToc } from '../scorebug.js';
import { fnv1a64, inflateEntry } from './bigfile.js';

export const GENERIC_SLOTS = [160, 161, 162, 163, 164] as const;
export const DEFAULT_ROSTER_HASH = 0x092f677e439a5110n;
export const ROSTER_SAVE = 'BLUS31159-ROSTER-FCS2026';
// Home stadiums for the generic slots: High School stadium rows the FCS schedule never uses, repainted as the generic
// bowl stadium (GNRIC1) on a plain, undesigned HS field. Names are the schools' real stadiums until a swap renames them.
export const GENERIC_STADIUMS: Record<number, { sgid: number; field: string; name: string; city: string }> = {
  160: { sgid: 261, field: 'HSSTAD', name: 'Saxon Stadium', city: 'Erie' },
  161: { sgid: 262, field: 'HSMODX', name: 'Pen Air Field', city: 'Pensacola' },
  162: { sgid: 265, field: 'HSTRAD', name: 'Hameline Field', city: 'Staten Island' },
  163: { sgid: 266, field: 'HSSEMD', name: 'Abbott Memorial Alumni Stadium', city: 'Tuskegee' },
  164: { sgid: 268, field: 'HSSWSM', name: 'McCool Stadium', city: 'Cleveland' },
};
export const GENERIC_STADIUM_ART = 'GNRIC1';

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
export const discDir = (rpcs3: string) => join(rpcs3, 'dev_hdd0', 'disc', 'BLUS31159-[NCAA Football 14]', 'PS3_GAME', 'USRDIR');
export const dlcDir = (rpcs3: string) => join(rpcs3, 'dev_hdd0', 'game', 'BLUS31159', 'USRDIR', 'DLC');
export const rosterSavePath = (rpcs3: string) => join(rpcs3, 'dev_hdd0', 'home', '00000001', 'savedata', ROSTER_SAVE, 'USR-DATA');
export const interfaceArchive = (rpcs3: string) => join(discDir(rpcs3), 'qkl_interface.ast');
export const bootArchive = (rpcs3: string) => join(discDir(rpcs3), 'qkl_boot.ast');

// ---- part names this install has ----
export class InstallParts {
  private readonly archives: { path: string; toc: BgfaToc }[] = [];
  private readonly dlc = new Map<string, string>(); // lower-case file name (no .edat) -> path
  constructor(readonly rpcs3: string) {
    const files = ['qkl_fe2ig.ast', 'qkl_misc.ast', 'qkl_stream.ast', 'qkl_interface.ast', 'qkl_boot.ast'].map((f) => join(discDir(rpcs3), f)).concat([join(dlcDir(rpcs3), 'qkl_patch.ast')]);
    for (const path of files) {
      if (!existsSync(path)) continue; const fd = openSync(path, 'r');
      try { const h = Buffer.alloc(64); readSync(fd, h, 0, 64, 0); const t = Buffer.alloc(h.readUInt32LE(16) + h.readUInt32LE(24)); readSync(fd, t, 0, t.length, 0); this.archives.push({ path, toc: bgfaToc(t) }); } finally { closeSync(fd); }
    }
    if (existsSync(dlcDir(rpcs3))) for (const d of readdirSync(dlcDir(rpcs3))) { const p = join(dlcDir(rpcs3), d); if (statSync(p).isDirectory()) for (const f of readdirSync(p)) this.dlc.set(f.replace(/\.edat$/i, '').toLowerCase(), join(p, f)); }
  }
  has(bigName: string): boolean { return this.dlc.has(`${bigName}.ast`.toLowerCase()) || this.archives.some((a) => a.toc.entries.some((e) => e.hash === fnv1a64(bigName))); }
  bytes(bigName: string): Buffer | null {
    const d = this.dlc.get(`${bigName}.ast`.toLowerCase()); if (d && !/\.edat$/i.test(d)) return readFileSync(d);
    for (const a of this.archives) {
      const e = a.toc.entries.find((x) => x.hash === fnv1a64(bigName)); if (!e) continue;
      const fd = openSync(a.path, 'r'); try { const b = Buffer.alloc(e.csize); readSync(fd, b, 0, b.length, e.off); return e.usize !== e.csize ? inflateEntry(b) : b; } finally { closeSync(fd); }
    }
    return null;
  }
  // where a slot's DLC uniform XML lives (every copy, by folder)
  slotXmls(slot: string): string[] { const want = `${slot}_pack0_mixandmatch.xml`; return [...this.dlc.entries()].filter(([k]) => k === want).map(([, p]) => p); }
  noteWritten(path: string): void { this.dlc.set(path.replace(/.*[\\/]/, '').replace(/\.edat$/i, '').toLowerCase(), path); }
}

// ---- a TDB file rewritten in place: the roster save (a plain DB) or the default roster entry of qkl_boot.ast ----
export interface DbTarget { label: string; kind: 'file' | 'entry'; path: string; hash?: bigint }
export const dbTargets = (rpcs3: string): DbTarget[] => [
  { label: `roster save ${ROSTER_SAVE}`, kind: 'file', path: rosterSavePath(rpcs3) },
  { label: 'default roster (qkl_boot.ast)', kind: 'entry', path: bootArchive(rpcs3), hash: DEFAULT_ROSTER_HASH },
];
function locate(t: DbTarget): { off: number; len: number } {
  if (t.kind === 'file') return { off: 0, len: statSync(t.path).size };
  const fd = openSync(t.path, 'r'); try { const e = archiveToc(fd).find((x) => x.hash === t.hash); if (!e) throw new Error(`${t.path}: no entry ${t.hash!.toString(16)}`); if (e.csize !== e.usize) throw new Error(`${t.path}: default roster entry is compressed`); return { off: e.off, len: e.csize }; } finally { closeSync(fd); }
}
export function readDb(t: DbTarget): TdbFile {
  const { off, len } = locate(t); const fd = openSync(t.path, 'r');
  try { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return parseTdb(new Uint8Array(b)); } finally { closeSync(fd); }
}
// edit, re-serialise at the same length, keep the original bytes in backupDir (first write per target only), write, read back
export function rewriteDb(t: DbTarget, backupDir: string, edit: (f: TdbFile) => void): { changed: boolean; sha: string } {
  const { off, len } = locate(t); const fd = openSync(t.path, 'r+');
  try {
    const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); const before = new Uint8Array(b);
    const f = parseTdb(before); edit(f); const out = serializeTdb(f, { padTo: len });
    if (out.length !== len) throw new Error(`${t.label}: rewrite is ${out.length} B, not ${len}`);
    if (Buffer.from(out).equals(b)) return { changed: false, sha: sha256(before) };
    mkdirSync(backupDir, { recursive: true }); const bk = join(backupDir, `${t.kind === 'file' ? 'USR-DATA' : `qkl_boot.${off}`}.orig`);
    if (!existsSync(bk)) { writeFileSync(bk, b); writeFileSync(`${bk}.json`, JSON.stringify({ target: t.label, path: t.path, off, len, sha: sha256(before) })); }
    writeSync(fd, out, 0, out.length, off); const back = Buffer.alloc(len); readSync(fd, back, 0, len, off);
    if (!back.equals(Buffer.from(out))) { writeSync(fd, b, 0, len, off); throw new Error(`${t.label}: read back differs; original written back`); }
    return { changed: true, sha: sha256(out) };
  } finally { closeSync(fd); }
}
export const backupFile = (path: string, dir: string, name: string): string => { mkdirSync(dir, { recursive: true }); const p = join(dir, name); if (!existsSync(p)) copyFileSync(path, p); return p; };
