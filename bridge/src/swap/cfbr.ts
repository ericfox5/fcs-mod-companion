// CFBR's assets, read straight from its installer pkg (never installed): uniform XMLs and parts resolve the way the game
// would load them (CFBR's DLC folders, then its qkl_patch, then the disc archives), logos come from its 1,024-entry logo
// bigfile (entry TLGL = menu logo, 340 + TLGL = score bug logo), score bug names and colours from its qkl_patch's score
// bug (by TLGL too).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Pkg, Edat, type ByteSource, type PkgItem } from './pkg.js';
import { bgfaToc, scorebugApt, scorebugTeams, type BgfaToc, type ScorebugTeam } from '../scorebug.js';
import { fnv1a64, inflateEntry } from './bigfile.js';

// NCAA 14's DLC klicensee, which CFBR's EDATs are bound to. It is not kept in this (public) repo: RPCS3 logs it
// (`npDrmIsAvailable(): KLicense key or KLIC=0x...`) whenever the game opens its DLC, so it is read from the install's
// RPCS3.log, or the previous run's RPCS3.log.gz; NCAA_DLC_KLIC (32 hex digits) overrides both.
export function dlcKlic(rpcs3Root?: string): Buffer | null {
  const env = process.env.NCAA_DLC_KLIC?.trim(); if (env && /^(0x)?[0-9a-f]{32}$/i.test(env)) return Buffer.from(env.replace(/^0x/i, ''), 'hex');
  if (!rpcs3Root) return null;
  for (const [f, gz] of [['RPCS3.log', false], ['RPCS3.log.gz', true]] as const) {
    const p = join(rpcs3Root, f); if (!existsSync(p)) continue;
    try { const text = (gz ? gunzipSync(readFileSync(p)) : readFileSync(p)).toString('latin1'); const m = /KLIC=0x([0-9a-f]{32})/i.exec(text); if (m) return Buffer.from(m[1]!, 'hex'); } catch { /* unreadable log: try the next */ }
  }
  return null;
}
export const LOGO_BIGFILE = 0x094ba24caa97c28dn; // qkl_interface.ast
export const SCOREBUG_LOGO = 340; // score bug logo = 340 + TLGL
const DLC_ORDER = ['CFBR_DLC_CUSTOM', 'CFBR_DLC_V19', 'CFBR_DLC_V18', 'CFBR_DLC_V17', ...Array.from({ length: 16 }, (_, i) => `UNIF${String(16 - i).padStart(3, '0')}`)];
const DISC = ['qkl_fe2ig', 'qkl_misc', 'qkl_stream', 'qkl_interface', 'qkl_boot'];

export interface Archive { name: string; src: ByteSource; toc: BgfaToc }
export const readToc = (src: ByteSource): BgfaToc => { const h = src.readAt(0, 64); return bgfaToc(src.readAt(0, h.readUInt32LE(16) + h.readUInt32LE(24))); };
export function entryBytes(a: Archive, hash: bigint): Buffer | null {
  const e = a.toc.entries.find((x) => x.hash === hash); if (!e) return null;
  const raw = a.src.readAt(e.off, e.csize); return e.usize !== e.csize ? inflateEntry(raw) : Buffer.from(raw);
}

export class Cfbr {
  readonly pkg: Pkg; readonly archives: Archive[] = [];
  private readonly dlc = new Map<string, { folder: string; item: PkgItem }[]>();
  private logoBig?: Buffer; private scorebug?: Map<number, ScorebugTeam>;
  constructor(readonly path: string, private readonly klic: Buffer) {
    this.pkg = new Pkg(path);
    const patch = this.pkg.find((n) => /\/DLC\/qkl_patch\.ast\.edat$/i.test(n));
    if (patch) { const src = new Edat(this.pkg.source(patch), klic); this.archives.push({ name: 'CFBR qkl_patch', src, toc: readToc(src) }); }
    for (const a of DISC) {
      const it = this.pkg.find((n) => new RegExp(`/disc/[^/]+/PS3_GAME/USRDIR/${a}\\.ast$`, 'i').test(n));
      if (!it) { if (a === 'qkl_fe2ig') throw new Error(`${path}: no ${a}.ast inside; not the CFBR installer`); continue; }
      const src = this.pkg.source(it); this.archives.push({ name: `CFBR ${a}`, src, toc: readToc(src) });
    }
    for (const item of this.pkg.items) {
      const m = /\/DLC\/([^/]+)\/([^/]+)$/.exec(item.name); if (!m) continue;
      const key = m[2]!.replace(/\.edat$/i, '').toLowerCase(); const list = this.dlc.get(key) ?? []; list.push({ folder: m[1]!, item }); this.dlc.set(key, list);
    }
  }
  private dlcFile(file: string): { from: string; bytes: Buffer } | null {
    const hits = (this.dlc.get(file.toLowerCase()) ?? []).slice().sort((a, b) => DLC_ORDER.indexOf(a.folder) - DLC_ORDER.indexOf(b.folder));
    const h = hits[0]; if (!h) return null;
    const src = this.pkg.source(h.item), name = h.item.name.replace(/.*\//, '');
    const bytes = /\.edat$/i.test(name) ? (() => { const e = new Edat(src, this.klic); return e.readAt(0, e.size); })() : src.readAt(0, src.size);
    return { from: `CFBR DLC ${h.folder}/${name}`, bytes };
  }
  // where a part would come from, without reading it (DLC index / archive TOCs only)
  partSource(bigName: string): string | null {
    const hits = (this.dlc.get(`${bigName}.ast`.toLowerCase()) ?? []).slice().sort((a, b) => DLC_ORDER.indexOf(a.folder) - DLC_ORDER.indexOf(b.folder));
    if (hits[0]) return `CFBR DLC ${hits[0].folder}/${hits[0].item.name.replace(/.*\//, '')}`;
    const h = fnv1a64(bigName); return this.archives.find((a) => a.toc.entries.some((e) => e.hash === h))?.name ?? null;
  }
  // a uniform part: bigName as the XML has it, e.g. 'PITTSB_jersey_2010_blue_big'
  part(bigName: string): { from: string; bytes: Buffer } | null {
    const d = this.dlcFile(`${bigName}.ast`); if (d) return d;
    for (const a of this.archives) { const b = entryBytes(a, fnv1a64(bigName)); if (b) return { from: a.name, bytes: b }; }
    return null;
  }
  // every uniform XML of a slot, in the order the game layers them: the archives' <SLOT>_MIXANDMATCH first, then each
  // DLC <SLOT>_Pack<N>_MixAndMatch.XML by pack number (EA's UNIF packs and CFBR's folders; for the same pack CFBR's own
  // folders come last). EA's UNIF001 Pack0 files are empty stubs, so a pack never replaces the set wholesale: per
  // official, the last XML that defines it wins (uniforms.ts merges them).
  xmls(slot: string): { from: string; text: string }[] {
    const out: { from: string; text: string }[] = [];
    for (const a of this.archives) { const b = entryBytes(a, fnv1a64(`${slot}_MIXANDMATCH`)); if (b) { out.push({ from: a.name, text: b.toString('latin1') }); break; } }
    const re = new RegExp(`^${slot}_Pack(\\d+)_MixAndMatch\\.xml$`, 'i'), rank = (f: string) => { const i = DLC_ORDER.indexOf(f); return i < 0 ? -1 : DLC_ORDER.length - i; };
    const packs: { pack: number; folder: string; item: PkgItem }[] = [];
    for (const [key, list] of this.dlc) { const m = re.exec(key); if (m) for (const h of list) packs.push({ pack: Number(m[1]), folder: h.folder, item: h.item }); }
    packs.sort((a, b) => a.pack - b.pack || rank(a.folder) - rank(b.folder));
    for (const p of packs) {
      const src = this.pkg.source(p.item), name = p.item.name.replace(/.*\//, '');
      const bytes = /\.edat$/i.test(name) ? (() => { const e = new Edat(src, this.klic); return e.readAt(0, e.size); })() : src.readAt(0, src.size);
      out.push({ from: `CFBR DLC ${p.folder}/${name}`, text: bytes.toString('latin1') });
    }
    return out;
  }
  // CFBR's score bug team table (its qkl_patch's), by TLGL: the short name and colours its score bug shows
  scorebugTeams(): Map<number, ScorebugTeam> {
    if (!this.scorebug) {
      const a = this.archives.find((x) => x.name === 'CFBR qkl_patch'), apt = a ? scorebugApt((off, len) => a.src.readAt(off, len)) : null;
      this.scorebug = new Map((apt ? scorebugTeams(apt) : []).map((t) => [t.index, t]));
    }
    return this.scorebug;
  }
  // a logo entry of the logo bigfile: its zlib stream (as stored) and the DDS it inflates to
  logo(index: number): { raw: Buffer; dds: Buffer } {
    if (!this.logoBig) {
      const a = this.archives.find((x) => x.name === 'CFBR qkl_interface'); if (!a) throw new Error('CFBR pkg has no qkl_interface.ast');
      const e = a.toc.entries.find((x) => x.hash === LOGO_BIGFILE); if (!e) throw new Error('CFBR qkl_interface.ast has no logo bigfile');
      const raw = a.src.readAt(e.off, e.csize); this.logoBig = e.usize !== e.csize ? inflateEntry(raw) : Buffer.from(raw);
    }
    const x = bgfaToc(this.logoBig).entries[index]; if (!x) throw new Error(`CFBR has no logo ${index}`);
    const raw = Buffer.from(this.logoBig.subarray(x.off, x.off + x.csize)); return { raw, dds: inflateEntry(raw) };
  }
  close(): void { this.pkg.close(); }
}
