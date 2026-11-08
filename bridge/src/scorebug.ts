// The in-game score bug is CFBR's Apt movie (ncaa.art.linelook.screen.GameClock.GenericGameClock) in the DLC folder's
// qkl_patch.ast: outer entry 4c8dfc202f211605 (a bigfile) -> 1654104e3c8536df (a bigfile) -> 6445aa243104fffe, its
// "Apt Data" (zlib). Its GetTeamNameAndColor holds the team table: one short name and two colours per TEAM.TLGL (the
// stock slots' TLGLs, so the order is alphabetical by the stock school). The FCS mod renamed most of them; the rest
// showed the slot's earlier team (Robert Morris read "Kennesaw" in gold). This module reads that table, edits it
// (setScorebugTeams) and writes a new Apt Data back:
// - in place when the new zlib stream fits the entry's slot (the room up to the next entry of its bigfile; the rest stays
//   zero): only the stream and the two size fields of its TOC record change, so nothing else in the 500 MB archive moves;
// - otherwise appended: the stream at the end of its bigfile, that bigfile at the end of its parent, the parent at the
//   end of the archive (in place when an earlier write already put it there), each TOC record repointed. The original
//   bytes stay where they were, unreferenced, so a restore only puts the outer record back and truncates;
// - what a write replaces goes to <backups>/<stamp>-scorebug/ first, with a manifest `restoreScorebug` uses.
// The nested bigfiles use a BGFA variant the uniform codec does not read: the flags field is ((widths >> 8) & 255) + 1
// bytes wide (1 in the outer entry, whose TOC also sits after a gap rather than at 64). Used by `ncaa-bridge scorebug`,
// the swap tool (swap/swap.ts) and FCS-online.exe's join step (installer/src/main.ts bundles it).
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { STDA_BACKUP_ROOT, rpcs3RootFromConfig, rpcs3RunningOver } from './stda.js';

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
export const scorebugSha = sha256;
// outer entry -> nested entry -> Apt Data, by FNV-1a hash (the archives carry no names)
export const SCOREBUG_PATH = [0x4c8dfc202f211605n, 0x1654104e3c8536dfn, 0x6445aa243104fffen] as const;
// the Apt Data as the FCS mod ships it: the only score bug the join step replaces
export const FCS_MOD_SCOREBUG_SHA = '1085804280c962bc04ec3da6ad046584da3cc2d4ba064dffa184cf0e0672316d';
export const scorebugArchive = (rpcs3Root: string): string => join(rpcs3Root, 'dev_hdd0', 'game', 'BLUS31159', 'USRDIR', 'DLC', 'qkl_patch.ast');

// ---- BGFA 1.05, both layouts: header 'BGFA1.05', u32 n @12, tocOff @16, tocSize @24, widths @32 (offset / hash /
// flags-1 bytes), widths2 @36 (csize / usize-csize bytes), prefixWords @40, nameWidth @44; records {flags, hash, off,
// csize, usize - csize, name}, little endian ----
export interface BgfaWidths { flagsW: number; hashW: number; offW: number; csW: number; usW: number; nw: number }
export interface BgfaEntry { hash: bigint; off: number; csize: number; usize: number; recOff: number }
export interface BgfaToc { widths: BgfaWidths; rec: number; entries: BgfaEntry[] }
export function bgfaToc(b: Uint8Array): BgfaToc {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (Buffer.from(b.subarray(0, 8)).toString('latin1') !== 'BGFA1.05') throw new Error('not a BGFA 1.05 container');
  const n = dv.getUint32(12, true), tocOff = dv.getUint32(16, true), tocSize = dv.getUint32(24, true), w8 = dv.getUint32(32, true), w9 = dv.getUint32(36, true);
  const pw = dv.getUint32(40, true), nw = dv.getUint32(44, true);
  const widths = { flagsW: ((w8 >>> 8) & 255) + 1, hashW: (w8 >>> 16) & 255, offW: (w8 >>> 24) & 255, csW: (w9 >>> 8) & 255, usW: w9 & 255, nw };
  const rec = widths.flagsW + widths.hashW + widths.offW + widths.csW + widths.usW + nw;
  if (tocOff + tocSize > b.length) throw new Error(`TOC (${tocOff}+${tocSize}) runs past the ${b.length} bytes read`);
  const num = (p: number, w: number) => { let v = 0n; for (let i = w - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[p + i]!); return v; };
  const entries: BgfaEntry[] = [];
  for (let k = 0, p = tocOff + pw * 4; k < n && p + rec <= tocOff + tocSize; k++, p += rec) {
    let q = p + widths.flagsW; const hash = num(q, widths.hashW); q += widths.hashW; const off = Number(num(q, widths.offW)); q += widths.offW;
    const csize = Number(num(q, widths.csW)); q += widths.csW; const usize = csize + Number(num(q, widths.usW));
    entries.push({ hash, off, csize, usize, recOff: p });
  }
  return { widths, rec, entries };
}
const tocEnd = (b: Uint8Array): number => { const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); return dv.getUint32(16, true) + dv.getUint32(24, true); };
const entryData = (b: Uint8Array, e: BgfaEntry): Buffer => { const raw = Buffer.from(b.subarray(e.off, e.off + e.csize)); return e.usize !== e.csize && raw[0] === 0x78 ? inflateSync(raw) : raw; };
// a TOC record's offset / csize / usize-csize fields (little endian, widths from the TOC)
function setRecord(buf: Buffer, w: BgfaWidths, recOff: number, off: number, csize: number, usize: number): void {
  const put = (o: number, n: number, v: number) => { if (v >= 2 ** (8 * n)) throw new Error(`${v} does not fit a ${n}-byte TOC field`); for (let i = 0; i < n; i++) buf[o + i] = Math.floor(v / 2 ** (8 * i)) & 255; };
  const o = recOff + w.flagsW + w.hashW; put(o, w.offW, off); put(o + w.offW, w.csW, csize); put(o + w.offW + w.csW, w.usW, usize - csize);
}
// a copy of a bigfile with entry `e` replaced by `data`, appended (16-aligned) after everything else the bigfile keeps
// (its TOC and its other entries); e's old bytes stay where they were unless e was already the last thing in it
function appendEntry(big: Buffer, toc: BgfaToc, e: BgfaEntry, data: Buffer, usize: number): Buffer {
  const keep = Math.max(tocEnd(big), ...toc.entries.filter((x) => x !== e).map((x) => x.off + x.csize)), at = Math.ceil(keep / 16) * 16;
  const out = Buffer.concat([big.subarray(0, keep), Buffer.alloc(at - keep), data]); setRecord(out, toc.widths, e.recOff, at, data.length, usize); return out;
}

// ---- the score bug's Apt Data from any reader (an install's archive, CFBR's pkg) ----
export function scorebugApt(read: (off: number, len: number) => Buffer): Buffer | null {
  const head = read(0, 64); if (head.toString('latin1', 0, 8) !== 'BGFA1.05') throw new Error('not a BGFA archive');
  const outer = bgfaToc(read(0, head.readUInt32LE(16) + head.readUInt32LE(24)));
  const e1 = outer.entries.find((e) => e.hash === SCOREBUG_PATH[0]); if (!e1 || e1.csize !== e1.usize) return null;
  const big1 = read(e1.off, e1.csize); const e2 = bgfaToc(big1).entries.find((e) => e.hash === SCOREBUG_PATH[1]); if (!e2 || e2.csize !== e2.usize) return null;
  const big2 = big1.subarray(e2.off, e2.off + e2.csize); const e3 = bgfaToc(big2).entries.find((e) => e.hash === SCOREBUG_PATH[2]); if (!e3) return null;
  const apt = entryData(big2, e3); return apt.toString('latin1', 0, 8) === 'Apt Data' ? apt : null;
}

// ---- where the score bug is ----
// slot = the room the stream may use: up to the next entry of its bigfile (or the bigfile's end); stream = the current
// stream (TOC csize bytes).
export interface ScorebugLocation { archive: string; slotOffset: number; slot: number; recOffset: number; rec: Buffer; widths: BgfaWidths; stream: Buffer; apt: Buffer; sha: string }
export function readScorebug(archive: string): ScorebugLocation | null {
  const fd = openSync(archive, 'r');
  try {
    const read = (off: number, len: number) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return b; };
    const head = read(0, 64); if (head.toString('latin1', 0, 8) !== 'BGFA1.05') throw new Error(`${archive}: not a BGFA archive`);
    const outer = bgfaToc(read(0, head.readUInt32LE(16) + head.readUInt32LE(24)));
    const e1 = outer.entries.find((e) => e.hash === SCOREBUG_PATH[0]); if (!e1 || e1.csize !== e1.usize) return null;
    const big1 = read(e1.off, e1.csize); const e2 = bgfaToc(big1).entries.find((e) => e.hash === SCOREBUG_PATH[1]); if (!e2 || e2.csize !== e2.usize) return null;
    const big2 = big1.subarray(e2.off, e2.off + e2.csize); const t3 = bgfaToc(big2); const e3 = t3.entries.find((e) => e.hash === SCOREBUG_PATH[2]); if (!e3) return null;
    const apt = entryData(big2, e3); if (apt.toString('latin1', 0, 8) !== 'Apt Data') throw new Error(`${archive}: the score bug entry is not Apt Data`);
    const base = e1.off + e2.off, next = Math.min(big2.length, ...t3.entries.filter((e) => e.off > e3.off).map((e) => e.off));
    return { archive, slotOffset: base + e3.off, slot: next - e3.off, recOffset: base + e3.recOff, rec: Buffer.from(big2.subarray(e3.recOff, e3.recOff + t3.rec)), widths: t3.widths, stream: Buffer.from(big2.subarray(e3.off, e3.off + e3.csize)), apt, sha: sha256(apt) };
  } finally { closeSync(fd); }
}

// ---- the team table ----
// GetTeamNameAndColor(teamInfo, isHome) starts from what the game passes (r3 = teamInfo.teamName, r4 = r5 =
// teamInfo.teamColor, r8 = teamInfo.teamLogoId = TEAM.TLGL), then runs a chain of `if (r8 == NN) { r4 = c1; r5 = c2;
// r3 = name }`, one per TLGL CFBR set (0-118, 133-139: the generic slots' 120-124 are not in it, so they show the game's
// values). CFBR's layout, 56 bytes per team (the opcodes are EA's AVM1: b9 push register, b6 push u16, b7 push u32,
// 49 Equals2, 12 Not, 9d If, 87 StoreRegister, 17 Pop, a1 push string, 99 Jump):
//   b9 08 | b6 <NN> | 49 | 12 | 9d <s32 +41> | b7 <c1> | 87 <4> | 17 | b7 <c2> | 87 <5> | 17 | a1 <name> | 87 <3> | 17
// The operands of 9d / 99 / 87 / a1 sit at the next multiple of 4 of the Apt Data (zero padded), the others do not;
// jumps count from the end of their instruction. The Apt is full of absolute offsets, so a team cannot be added by
// growing the chain: setScorebugTeams re-encodes it in the same bytes, compactly when it has to,
//   per team `if (r8 != NN) skip; push c1, c2, name; jump STORE`, then `jump END; STORE: r3, r5, r4 = pop; jump END`,
// the rest Pop opcodes that never run; and in CFBR's layout again (byte for byte) once the teams fit it. Names the Apt
// does not have go in an area appended to it: 'FCSNAMES', u32 BE length of the Apt without the area, the names
// (zero-terminated, 4-aligned).
export interface ScorebugColours { name: string; primary: number; secondary: number }
export interface ScorebugTeam extends ScorebugColours { index: number }
export interface ScorebugChain { start: number; end: number; layout: 'cfbr' | 'compact'; teams: (ScorebugTeam & { ptr: number })[] }
const al4 = (p: number) => Math.ceil(p / 4) * 4;
interface Ins { op: number; arg: number; next: number }
function ins(b: Buffer, p: number): Ins {
  const op = b[p];
  switch (op) {
    case 0xb9: return { op, arg: b[p + 1]!, next: p + 2 };
    case 0xb6: return { op, arg: b.readUInt16BE(p + 1), next: p + 3 };
    case 0xb7: return { op, arg: b.readUInt32BE(p + 1), next: p + 5 };
    case 0x9d: case 0x99: { const o = al4(p + 1); return { op, arg: b.readInt32BE(o), next: o + 4 }; }
    case 0x87: case 0xa1: { const o = al4(p + 1); return { op, arg: b.readUInt32BE(o), next: o + 4 }; }
    case 0x49: case 0x12: case 0x17: return { op, arg: 0, next: p + 1 };
    default: throw new Error(`score bug team table: unexpected opcode ${op === undefined ? 'past the end' : op.toString(16)} at ${p}`);
  }
}
const isTest = (b: Buffer, p: number) => b[p] === 0xb9 && b[p + 1] === 0x08 && b[p + 2] === 0xb6 && b[p + 5] === 0x49 && b[p + 6] === 0x12 && b[p + 7] === 0x9d;
const cstr = (b: Buffer, p: number) => { let e = p; while (e < b.length && b[e]) e++; return b.toString('latin1', p, e); };
export function scorebugChain(apt: Uint8Array): ScorebugChain | null {
  const b = Buffer.from(apt.buffer, apt.byteOffset, apt.byteLength); const pat = Buffer.from('b908b6', 'hex');
  let p = -1; for (let h = b.indexOf(pat); h >= 0 && p < 0; h = b.indexOf(pat, h + 1)) if (isTest(b, h)) p = h;
  if (p < 0) return null;
  const start = p, teams: ScorebugChain['teams'] = []; let layout: ScorebugChain['layout'] | undefined;
  const seq = (q: number, ops: number[]) => ops.map((op) => { const i = ins(b, q); if (i.op !== op) throw new Error(`score bug team table: opcode ${i.op.toString(16)} at ${q}, expected ${op.toString(16)}`); q = i.next; return i; });
  while (isTest(b, p)) {
    const t = seq(p, [0xb9, 0xb6, 0x49, 0x12, 0x9d]), iff = t[4]!, next = iff.next + iff.arg;
    const kind = ins(b, ins(b, iff.next).next).op === 0x87 ? 'cfbr' : 'compact'; if (layout && kind !== layout) throw new Error(`score bug team table: mixed layouts at ${p}`); layout = kind;
    const s = kind === 'cfbr' ? seq(iff.next, [0xb7, 0x87, 0x17, 0xb7, 0x87, 0x17, 0xa1, 0x87, 0x17]) : seq(iff.next, [0xb7, 0xb7, 0xa1, 0x99]);
    const [c1, c2, ptr, endsAt] = kind === 'cfbr' ? [s[0]!.arg, s[3]!.arg, s[6]!.arg, s[8]!.next] : [s[0]!.arg, s[1]!.arg, s[2]!.arg, s[3]!.next];
    if (kind === 'cfbr' && (s[1]!.arg !== 4 || s[4]!.arg !== 5 || s[7]!.arg !== 3)) throw new Error(`score bug team table: registers ${s[1]!.arg}/${s[4]!.arg}/${s[7]!.arg} at ${p}`);
    if (endsAt !== next) throw new Error(`score bug team table: the test at ${p} skips to ${next}, the team ends at ${endsAt}`);
    teams.push({ index: t[1]!.arg, name: cstr(b, ptr), primary: c1, secondary: c2, ptr }); p = next;
  }
  let end = p;
  if (layout === 'compact') { const j = ins(b, p); if (j.op !== 0x99) throw new Error(`score bug team table: no jump past the table at ${p}`); end = j.next + j.arg; }
  return { start, end, layout: layout!, teams };
}
export function scorebugTeams(apt: Uint8Array): ScorebugTeam[] { return (scorebugChain(apt)?.teams ?? []).map(({ ptr: _, ...t }) => t); }

// a little assembler for the chain: bytes at absolute Apt offsets from `base`, aligned operands zero padded
class Asm {
  readonly b: number[] = [];
  constructor(readonly base: number) {}
  get pos(): number { return this.base + this.b.length; }
  op(...x: number[]): void { this.b.push(...x); }
  u16(v: number): void { this.b.push((v >>> 8) & 255, v & 255); }
  u32(v: number): void { this.b.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); }
  aligned(v: number): number { while (this.pos % 4) this.b.push(0); const at = this.b.length; this.u32(v >>> 0); return at; }
  jumpTo(at: number, target: number): void { const rel = target - (this.base + at + 4); this.b[at] = (rel >>> 24) & 255; this.b[at + 1] = (rel >>> 16) & 255; this.b[at + 2] = (rel >>> 8) & 255; this.b[at + 3] = rel & 255; }
}
function encodeChain(teams: (ScorebugTeam & { ptr: number })[], start: number, end: number, layout: ScorebugChain['layout']): Buffer | null {
  const a = new Asm(start), toStore: number[] = [];
  for (const t of teams) {
    a.op(0xb9, 0x08, 0xb6); a.u16(t.index); a.op(0x49, 0x12, 0x9d); const skip = a.aligned(0);
    if (layout === 'cfbr') {
      a.op(0xb7); a.u32(t.primary); a.op(0x87); a.aligned(4); a.op(0x17); a.op(0xb7); a.u32(t.secondary); a.op(0x87); a.aligned(5); a.op(0x17);
      a.op(0xa1); a.aligned(t.ptr); a.op(0x87); a.aligned(3); a.op(0x17);
    } else { a.op(0xb7); a.u32(t.primary); a.op(0xb7); a.u32(t.secondary); a.op(0xa1); a.aligned(t.ptr); a.op(0x99); toStore.push(a.aligned(0)); }
    a.jumpTo(skip, a.pos);
  }
  if (layout === 'cfbr') return a.pos === end ? Buffer.from(a.b) : null;
  a.op(0x99); const past = a.aligned(0); const store = a.pos;
  for (const r of [3, 5, 4]) { a.op(0x87); a.aligned(r); a.op(0x17); }
  a.op(0x99); const out = a.aligned(0);
  if (a.pos > end) return null;
  while (a.pos < end) a.op(0x17);
  for (const x of toStore) a.jumpTo(x, store); a.jumpTo(past, end); a.jumpTo(out, end);
  return Buffer.from(a.b);
}
const NAMES = Buffer.from('FCSNAMES', 'latin1');
// the Apt without its appended name area
function aptBase(apt: Buffer): Buffer {
  const at = apt.lastIndexOf(NAMES); if (at < 0 || at % 4 || at + 12 > apt.length) return apt;
  const len = apt.readUInt32BE(at + 8); return len <= at && al4(len) === at ? apt.subarray(0, len) : apt;
}
// set (or with null, remove) the table's entries for some TLGLs; everything else in the Apt stays as it is
export function setScorebugTeams(apt: Uint8Array, changes: Record<number, ScorebugColours | null>): Buffer {
  const full = Buffer.from(apt), base = aptBase(full); const ch = scorebugChain(full); if (!ch) throw new Error('no team table in this score bug'); // names read with the area
  const by = new Map(ch.teams.map((t) => [t.index, { ...t }]));
  for (const [k, v] of Object.entries(changes)) {
    const i = Number(k), cur = by.get(i); if (v === null) { by.delete(i); continue; }
    if (!/^[\x20-\xff]{1,31}$/.test(v.name)) throw new Error(`score bug name ${JSON.stringify(v.name)}: 1-31 characters`);
    by.set(i, { index: i, name: v.name, primary: v.primary >>> 0, secondary: v.secondary >>> 0, ptr: cur && cur.name === v.name ? cur.ptr : -1 });
  }
  const teams = [...by.values()].sort((a, b) => a.index - b.index), homeless = teams.filter((t) => t.ptr < 0 || t.ptr >= base.length);
  const parts: Buffer[] = [base];
  if (homeless.length) {
    const head = Buffer.alloc(12); NAMES.copy(head); head.writeUInt32BE(base.length, 8); parts.push(Buffer.alloc(al4(base.length) - base.length), head);
    let p = al4(base.length) + 12; for (const t of homeless) { const s = Buffer.alloc(al4(t.name.length + 1)); s.write(t.name, 'latin1'); t.ptr = p; p += s.length; parts.push(s); }
  }
  const out = Buffer.concat(parts);
  const code = (homeless.length ? null : encodeChain(teams, ch.start, ch.end, 'cfbr')) ?? encodeChain(teams, ch.start, ch.end, 'compact');
  if (!code) throw new Error(`${teams.length} teams do not fit the score bug's team table (${ch.end - ch.start} bytes)`);
  code.copy(out, ch.start); return out;
}

const readSlot = (archive: string, loc: ScorebugLocation): Buffer => { const fd = openSync(archive, 'r'); try { const b = Buffer.alloc(loc.slot); readSync(fd, b, 0, b.length, loc.slotOffset); return b; } finally { closeSync(fd); } };

// ---- write a new Apt Data (as its zlib stream), with a backup ----
// manifest kind 'slot' (in place: slot.orig + rec.orig) or 'append' (rec.orig = the outer record, tail.orig = the
// archive bytes from tailOffset on that the write replaced, sizeBefore = the archive's length before)
export interface ScorebugManifest { created: string; tool: string; archive: string; kind?: 'slot' | 'append'; slotOffset: number; slotLength: number; recOffset: number; recLength: number; tailOffset?: number; sizeBefore?: number; shaBefore: string; shaAfter: string }
export interface ScorebugOutcome { status: 'written' | 'already' | 'skipped'; note: string }
export const newScorebugBackupDir = (root = STDA_BACKUP_ROOT): string => join(root, `${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}-scorebug`);
export function writeScorebug(archive: string, stream: Uint8Array, backupDir: string, opts: { replaces?: readonly string[]; tool?: string } = {}): ScorebugOutcome {
  const loc = readScorebug(archive); if (!loc) return { status: 'skipped', note: 'no score bug entry in this qkl_patch.ast' };
  const apt = inflateSync(stream), shaAfter = sha256(apt);
  if (loc.sha === shaAfter) return { status: 'already', note: 'already current' };
  if (opts.replaces && !opts.replaces.includes(loc.sha)) return { status: 'skipped', note: `this score bug is not one this build replaces (sha ${loc.sha.slice(0, 12)}); left alone` };
  if (apt.toString('latin1', 0, 8) !== 'Apt Data' || !scorebugTeams(apt).length) throw new Error('the new stream is not a score bug Apt Data');
  mkdirSync(backupDir, { recursive: true });
  if (existsSync(join(backupDir, 'manifest.json'))) throw new Error(`${backupDir} already holds a score bug backup; use a new folder`);
  const tool = opts.tool ?? 'ncaa-bridge scorebug', done = (how: string): ScorebugOutcome => ({ status: 'written', note: `updated (${scorebugTeams(apt).length} teams, ${how}); original backed up in ${backupDir} (ncaa-bridge scorebug restore --backup "${backupDir}" puts it back)` });
  if (stream.length <= loc.slot) {
    const w = loc.widths, rec = Buffer.from(loc.rec); const put = (o: number, n: number, v: number) => { for (let i = 0; i < n; i++) rec[o + i] = Math.floor(v / 2 ** (8 * i)) & 255; };
    const cs = w.flagsW + w.hashW + w.offW; put(cs, w.csW, stream.length); put(cs + w.csW, w.usW, apt.length - stream.length);
    const slotNow = readSlot(archive, loc), slot = Buffer.from(slotNow); slot.fill(0, 0, Math.max(stream.length, loc.stream.length)); slot.set(stream);
    writeFileSync(join(backupDir, 'slot.orig'), slotNow); writeFileSync(join(backupDir, 'rec.orig'), loc.rec);
    const manifest: ScorebugManifest = { created: new Date().toISOString(), tool, archive, kind: 'slot', slotOffset: loc.slotOffset, slotLength: loc.slot, recOffset: loc.recOffset, recLength: loc.rec.length, shaBefore: loc.sha, shaAfter };
    writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
    const fd = openSync(archive, 'r+');
    try { writeSync(fd, slot, 0, slot.length, loc.slotOffset); writeSync(fd, rec, 0, rec.length, loc.recOffset); } finally { closeSync(fd); }
    if (readScorebug(archive)?.sha !== shaAfter) {
      const fd2 = openSync(archive, 'r+'); try { writeSync(fd2, slotNow, 0, slotNow.length, loc.slotOffset); writeSync(fd2, loc.rec, 0, loc.rec.length, loc.recOffset); } finally { closeSync(fd2); }
      throw new Error('the score bug read back differs from what was written; the original bytes were written back');
    }
    return done('in place');
  }
  // appended: Apt stream -> end of its bigfile -> end of the parent -> end of the archive
  const fd = openSync(archive, 'r+');
  try {
    const read = (off: number, len: number) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return b; };
    const size = fstatSync(fd).size, head = read(0, 64), outerHead = read(0, head.readUInt32LE(16) + head.readUInt32LE(24)), outer = bgfaToc(outerHead);
    const e1 = outer.entries.find((e) => e.hash === SCOREBUG_PATH[0])!, big1 = read(e1.off, e1.csize), t1 = bgfaToc(big1), e2 = t1.entries.find((e) => e.hash === SCOREBUG_PATH[1])!;
    const big2 = Buffer.from(big1.subarray(e2.off, e2.off + e2.csize)), t2 = bgfaToc(big2), e3 = t2.entries.find((e) => e.hash === SCOREBUG_PATH[2])!;
    const nb2 = appendEntry(big2, t2, e3, Buffer.from(stream), apt.length), nb1 = appendEntry(big1, t1, e2, nb2, nb2.length);
    const keep = Math.max(tocEnd(outerHead), ...outer.entries.filter((x) => x !== e1).map((x) => x.off + x.csize)), at = Math.ceil(keep / 16) * 16, from = Math.min(at, size);
    const tail = read(from, size - from), rec = read(e1.recOff, outer.rec), nrec = Buffer.from(rec); setRecord(nrec, outer.widths, 0, at, nb1.length, nb1.length);
    writeFileSync(join(backupDir, 'rec.orig'), rec); writeFileSync(join(backupDir, 'tail.orig'), tail);
    const manifest: ScorebugManifest = { created: new Date().toISOString(), tool, archive, kind: 'append', slotOffset: loc.slotOffset, slotLength: loc.slot, recOffset: e1.recOff, recLength: rec.length, tailOffset: from, sizeBefore: size, shaBefore: loc.sha, shaAfter };
    writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
    const undo = () => { writeSync(fd, tail, 0, tail.length, from); ftruncateSync(fd, size); writeSync(fd, rec, 0, rec.length, e1.recOff); };
    try {
      const data = Buffer.concat([Buffer.alloc(at - from), nb1]); writeSync(fd, data, 0, data.length, from); ftruncateSync(fd, at + nb1.length); writeSync(fd, nrec, 0, nrec.length, e1.recOff);
      if (readScorebug(archive)?.sha !== shaAfter) throw new Error('the score bug read back differs from what was written');
    } catch (e) { undo(); throw new Error(`${(e as Error).message}; the archive was put back`); }
    return done(`appended at ${at}`);
  } finally { closeSync(fd); }
}

// Put a backup back: only when the archive still holds what was written (or `force`).
export function restoreScorebug(backupDir: string, opts: { force?: boolean } = {}): string {
  const m = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8')) as ScorebugManifest;
  const rec = readFileSync(join(backupDir, 'rec.orig')); if (rec.length !== m.recLength) throw new Error(`${backupDir}: backup files do not match the manifest`);
  const cur = readScorebug(m.archive); if (!cur) throw new Error(`${m.archive}: no score bug entry`);
  if (cur.sha === m.shaBefore) return `${m.archive}: already the original`;
  if (cur.sha !== m.shaAfter && !opts.force) throw new Error(`${m.archive}: the score bug changed since the backup (sha ${cur.sha.slice(0, 12)}); pass --force to restore anyway`);
  const fd = openSync(m.archive, 'r+');
  try {
    if (m.kind === 'append') {
      const tail = readFileSync(join(backupDir, 'tail.orig')); if (m.tailOffset === undefined || m.sizeBefore === undefined || m.tailOffset + tail.length !== m.sizeBefore) throw new Error(`${backupDir}: backup files do not match the manifest`);
      writeSync(fd, tail, 0, tail.length, m.tailOffset); ftruncateSync(fd, m.sizeBefore); writeSync(fd, rec, 0, rec.length, m.recOffset);
    } else {
      const slot = readFileSync(join(backupDir, 'slot.orig')); if (slot.length !== m.slotLength) throw new Error(`${backupDir}: backup files do not match the manifest`);
      if (cur.slotOffset !== m.slotOffset || cur.recOffset !== m.recOffset || cur.slot !== m.slotLength) throw new Error(`${m.archive}: the entry moved since the backup; not restoring`);
      writeSync(fd, slot, 0, slot.length, m.slotOffset); writeSync(fd, rec, 0, rec.length, m.recOffset);
    }
  } finally { closeSync(fd); }
  if (readScorebug(m.archive)?.sha !== m.shaBefore) throw new Error(`${m.archive}: restored bytes do not read back as the original`);
  return `${m.archive}: score bug restored (sha ${m.shaBefore.slice(0, 12)})`;
}

// The archive's outer score bug record as it stands, to go back to later without a backup folder: the swap tool takes
// one before its first score bug write and returns to it when the last swap is undone (the bytes it points at are
// never overwritten: every later write appends).
export interface ScorebugSnapshot { recOffset: number; rec: string; size: number; sha: string }
export function scorebugSnapshot(archive: string): ScorebugSnapshot {
  const loc = readScorebug(archive); if (!loc) throw new Error(`${archive}: no score bug entry`);
  const fd = openSync(archive, 'r');
  try {
    const head = Buffer.alloc(64); readSync(fd, head, 0, 64, 0); const t = Buffer.alloc(head.readUInt32LE(16) + head.readUInt32LE(24)); readSync(fd, t, 0, t.length, 0);
    const toc = bgfaToc(t), e1 = toc.entries.find((e) => e.hash === SCOREBUG_PATH[0])!;
    return { recOffset: e1.recOff, rec: t.subarray(e1.recOff, e1.recOff + toc.rec).toString('hex'), size: fstatSync(fd).size, sha: loc.sha };
  } finally { closeSync(fd); }
}
export function revertScorebug(archive: string, s: ScorebugSnapshot): string {
  const fd = openSync(archive, 'r+');
  try {
    const head = Buffer.alloc(64); readSync(fd, head, 0, 64, 0); const t = Buffer.alloc(head.readUInt32LE(16) + head.readUInt32LE(24)); readSync(fd, t, 0, t.length, 0);
    const toc = bgfaToc(t), e1 = toc.entries.find((e) => e.hash === SCOREBUG_PATH[0])!, rec = Buffer.from(s.rec, 'hex');
    if (e1.recOff !== s.recOffset || rec.length !== toc.rec) throw new Error(`${archive}: the score bug record moved since the snapshot`);
    if (toc.entries.some((e) => e !== e1 && e.off + e.csize > s.size)) throw new Error(`${archive}: something else was added after the snapshot; not truncating`);
    // the archive as the snapshot's record would read it: its TOC with the old record, everything else from the file
    const sim = Buffer.from(t); rec.copy(sim, s.recOffset); const old = bgfaToc(sim).entries.find((e) => e.hash === SCOREBUG_PATH[0])!;
    if (old.off + old.csize > s.size) throw new Error(`${archive}: the snapshot's score bug lies past its archive length`);
    const apt = scorebugApt((off, len) => { if (off + len <= sim.length) return Buffer.from(sim.subarray(off, off + len)); const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return b; });
    if (!apt || sha256(apt) !== s.sha) throw new Error(`${archive}: the snapshot's score bug no longer reads back; not reverting`);
    const now = Buffer.from(t.subarray(s.recOffset, s.recOffset + toc.rec));
    writeSync(fd, rec, 0, rec.length, s.recOffset); ftruncateSync(fd, s.size);
    if (readScorebug(archive)?.sha !== s.sha) { writeSync(fd, now, 0, now.length, s.recOffset); throw new Error(`${archive}: the reverted score bug does not read back`); }
    return `back to the score bug from before the first swap (sha ${s.sha.slice(0, 12)})`;
  } finally { closeSync(fd); }
}

// every score bug sha this PC wrote or replaced (the backup manifests under `roots`): what a member's install can hold
// from an earlier FCS-online.exe, so the join step may replace it
export function scorebugShaHistory(roots: readonly string[]): string[] {
  const out = new Set<string>([FCS_MOD_SCOREBUG_SHA]);
  const walk = (d: string, depth: number) => {
    if (!existsSync(d) || depth > 3) return;
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) walk(join(d, f.name), depth + 1);
      else if (f.name === 'manifest.json') try { const m = JSON.parse(readFileSync(join(d, f.name), 'utf8')); if (/qkl_patch\.ast$/i.test(String(m.archive ?? ''))) for (const k of ['shaBefore', 'shaAfter', 'aptShaBefore', 'aptShaAfter']) if (/^[0-9a-f]{64}$/.test(String(m[k]))) out.add(m[k]); } catch { /* not a score bug manifest */ }
    }
  };
  for (const r of roots) walk(r, 0);
  return [...out];
}
// the swap tool's state and backups (swap/swap.ts SWAP_ROOT), next to the bridge's backups
export const SCOREBUG_HISTORY_ROOTS = [STDA_BACKUP_ROOT, join(STDA_BACKUP_ROOT, '..', 'swaps')];

// ncaa-bridge scorebug status [--teams] | export --out FILE | restore [--backup DIR] [--force]; [--rpcs3 DIR] or
// [--archive FILE]. `export` writes this install's score bug stream for installer/build.mjs (nothing when it is the
// FCS mod's original), with every earlier score bug of this PC as replaceable.
export function scorebugCli(sub: string | undefined, flags: Map<string, string>): void {
  const root = flags.get('rpcs3') ?? process.env.NCAA_RPCS3 ?? rpcs3RootFromConfig();
  const archive = flags.get('archive') ?? (root ? scorebugArchive(root) : undefined);
  if (sub === 'restore') {
    let dir = flags.get('backup');
    if (!dir) { const all = existsSync(STDA_BACKUP_ROOT) ? readdirSync(STDA_BACKUP_ROOT).filter((d) => d.endsWith('-scorebug') && existsSync(join(STDA_BACKUP_ROOT, d, 'manifest.json'))).sort() : []; if (!all.length) throw new Error(`no scorebug backup under ${STDA_BACKUP_ROOT}`); dir = join(STDA_BACKUP_ROOT, all[all.length - 1]!); }
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ScorebugManifest;
    if (rpcs3RunningOver([m.archive])) throw new Error('RPCS3 is running from this install: close it before touching the game archives');
    console.log(restoreScorebug(dir, { force: flags.has('force') })); return;
  }
  if (!archive || !existsSync(archive)) throw new Error('no qkl_patch.ast: pass --rpcs3 DIR or --archive FILE (or set rpcs3Root in ~/.ncaa-bridge/config.json)');
  const loc = readScorebug(archive); if (!loc) throw new Error(`${archive}: no score bug entry`);
  if (sub === 'status' || sub === undefined) {
    const teams = scorebugTeams(loc.apt);
    console.log(`${archive}: score bug ${loc.sha === FCS_MOD_SCOREBUG_SHA ? "= the FCS mod's original" : `changed (sha ${loc.sha.slice(0, 12)})`}, ${teams.length} teams (${scorebugChain(loc.apt)?.layout} layout), stream ${loc.stream.length} of ${loc.slot} B`);
    if (flags.has('teams')) for (const t of teams) console.log(`  ${String(t.index).padStart(3)} ${t.name.padEnd(18)} #${t.primary.toString(16).padStart(6, '0')} #${t.secondary.toString(16).padStart(6, '0')}`);
  } else if (sub === 'export' && flags.has('out')) {
    if (loc.sha === FCS_MOD_SCOREBUG_SHA) { writeFileSync(flags.get('out')!, '{}'); console.log("score bug = the FCS mod's original: nothing to ship"); return; }
    const z = loc.stream;
    if (sha256(inflateSync(z)) !== loc.sha) throw new Error('the stream in the slot does not inflate to the score bug');
    const replaces = scorebugShaHistory(SCOREBUG_HISTORY_ROOTS).filter((s) => s !== loc.sha);
    writeFileSync(flags.get('out')!, JSON.stringify({ stream: Buffer.from(z).toString('base64'), sha: loc.sha, replaces, teams: scorebugTeams(loc.apt).length }));
    console.log(`score bug exported: ${z.length} B stream, sha ${loc.sha.slice(0, 12)}, replaces ${replaces.length} earlier version(s)`);
  } else console.log('usage: ncaa-bridge scorebug status [--teams] | export --out FILE | restore [--backup DIR] [--force]   [--rpcs3 DIR | --archive FILE]');
}
