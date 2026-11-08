// Logos on the install: qkl_interface.ast's logo bigfile (LOGO_BIGFILE, 1,024 zlib DDS entries packed tight, a 1-byte
// flags BGFA): entry TLGL is the team's menu / UI logo, 340 + TLGL its score bug logo. A swap appends the donor's two
// streams to the bigfile (16-aligned) and repoints their records; the grown bigfile is written at the end of the archive
// (in place when it already sits there from an earlier swap) and the archive's record repointed. A restore only puts the
// two records back: the original streams never leave the bigfile. The archive's first original record and size are
// kept in the backup folder, so everything can be undone by hand too.
import { closeSync, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { bgfaToc, type BgfaEntry, type BgfaWidths } from '../scorebug.js';
import { LOGO_BIGFILE, SCOREBUG_LOGO } from './cfbr.js';
import { decodeDds, encodePng, inflateEntry } from './bigfile.js';
import { interfaceArchive } from './install.js';

export interface LogoRecord { off: number; csize: number; usize: number }
export interface LogoSnapshot { menu: LogoRecord; scorebug: LogoRecord }
const put = (b: Buffer, o: number, w: number, v: number) => { for (let i = 0; i < w; i++) b[o + i] = Math.floor(v / 2 ** (8 * i)) & 255; };
const fields = (w: BgfaWidths, recOff: number) => { const o = recOff + w.flagsW + w.hashW; return { off: o, cs: o + w.offW, us: o + w.offW + w.csW }; };

function open(path: string, write: boolean) {
  const fd = openSync(path, write ? 'r+' : 'r'); const size = fstatSync(fd).size;
  const h = Buffer.alloc(64); readSync(fd, h, 0, 64, 0); const t = Buffer.alloc(h.readUInt32LE(16) + h.readUInt32LE(24)); readSync(fd, t, 0, t.length, 0);
  const toc = bgfaToc(t); const e = toc.entries.find((x) => x.hash === LOGO_BIGFILE); if (!e || e.csize !== e.usize) { closeSync(fd); throw new Error(`${path}: no stored logo bigfile`); }
  const big = Buffer.alloc(e.csize); readSync(fd, big, 0, big.length, e.off);
  return { fd, size, toc, e, big };
}
const rec = (x: BgfaEntry): LogoRecord => ({ off: x.off, csize: x.csize, usize: x.usize });
export function logoSnapshot(rpcs3: string, tlgl: number): LogoSnapshot {
  const o = open(interfaceArchive(rpcs3), false); try { const t = bgfaToc(o.big); return { menu: rec(t.entries[tlgl]!), scorebug: rec(t.entries[SCOREBUG_LOGO + tlgl]!) }; } finally { closeSync(o.fd); }
}
// the logo bigfile as it stands (header + TOC + that one entry read; not the whole archive)
export function logoBigfile(rpcs3: string): Buffer { const o = open(interfaceArchive(rpcs3), false); try { return o.big; } finally { closeSync(o.fd); } }
export function logoPng(rpcs3: string, index: number, maxSide = 256): Buffer {
  const o = open(interfaceArchive(rpcs3), false); try { const x = bgfaToc(o.big).entries[index]; if (!x) throw new Error(`no logo ${index}`); return encodePng(decodeDds(inflateEntry(o.big.subarray(x.off, x.off + x.csize)), maxSide)); } finally { closeSync(o.fd); }
}
// set the two logo entries of `tlgl`: new streams (appended) or saved records (a restore)
export function writeLogos(rpcs3: string, tlgl: number, src: { menu: { raw: Buffer; dds: Buffer }; scorebug: { raw: Buffer; dds: Buffer } } | LogoSnapshot, backupDir: string): string {
  const path = interfaceArchive(rpcs3), o = open(path, true);
  try {
    let big = Buffer.from(o.big); const inner = bgfaToc(big);
    const set = (index: number, r: LogoRecord) => { const x = inner.entries[index]!, f = fields(inner.widths, x.recOff); put(big, f.off, inner.widths.offW, r.off); put(big, f.cs, inner.widths.csW, r.csize); put(big, f.us, inner.widths.usW, r.usize - r.csize); };
    const notes: string[] = [];
    for (const [key, index] of [['menu', tlgl], ['scorebug', SCOREBUG_LOGO + tlgl]] as const) {
      if ('off' in (src as LogoSnapshot)[key]) { set(index, (src as LogoSnapshot)[key]); continue; }
      const s = (src as { menu: { raw: Buffer; dds: Buffer }; scorebug: { raw: Buffer; dds: Buffer } })[key];
      if (s.dds.toString('latin1', 0, 4) !== 'DDS ') throw new Error(`donor ${key} logo is not a DDS`);
      const at = Math.ceil(big.length / 16) * 16; big = Buffer.concat([big, Buffer.alloc(at - big.length), s.raw]); set(index, { off: at, csize: s.raw.length, usize: s.dds.length });
      notes.push(`${key} logo ${index} (${s.raw.length} B)`);
    }
    for (const index of [tlgl, SCOREBUG_LOGO + tlgl]) { const x = bgfaToc(big).entries[index]!; if (inflateEntry(big.subarray(x.off, x.off + x.csize)).toString('latin1', 0, 4) !== 'DDS ') throw new Error(`logo ${index} does not read back`); }
    mkdirSync(backupDir, { recursive: true }); const outer = Buffer.alloc(o.toc.rec); readSync(o.fd, outer, 0, outer.length, o.e.recOff);
    const first = join(backupDir, 'qkl_interface.logos.json'); if (!existsSync(first)) writeFileSync(first, JSON.stringify({ archive: path, recordOffset: o.e.recOff, recordHex: outer.toString('hex'), size: o.size }, null, 1));
    const atEnd = o.e.off + o.e.csize === o.size, off = atEnd ? o.e.off : o.size;
    writeSync(o.fd, big, 0, big.length, off); if (atEnd) ftruncateSync(o.fd, off + big.length);
    const nrec = Buffer.from(outer), f = fields(o.toc.widths, 0); put(nrec, f.off, o.toc.widths.offW, off); put(nrec, f.cs, o.toc.widths.csW, big.length); put(nrec, f.us, o.toc.widths.usW, 0);
    writeSync(o.fd, nrec, 0, nrec.length, o.e.recOff);
    const back = open(path, false); let ok = false; try { ok = back.big.equals(big); } finally { closeSync(back.fd); }
    if (!ok) { writeSync(o.fd, outer, 0, outer.length, o.e.recOff); if (atEnd) { writeSync(o.fd, o.big, 0, o.big.length, o.e.off); ftruncateSync(o.fd, o.size); } else ftruncateSync(o.fd, o.size); throw new Error('logo bigfile does not read back; the archive was put back'); }
    return notes.length ? `${notes.join(', ')} written; logo bigfile ${big.length} B at ${off}${atEnd ? '' : ' (moved to the archive end)'}` : 'original logo records put back';
  } finally { closeSync(o.fd); }
}
