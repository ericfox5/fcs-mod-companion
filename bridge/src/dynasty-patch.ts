// Writing a dynasty file the console will load (2026-11-02). The file is zlib(prefix + EA DB) where the 4-byte prefix
// is FNV-1 (offset 0x811c9dc5, prime 0x01000193, multiply then xor) of the DB's first 0x7e5000 bytes, big-endian: the
// console's download step (0x335738) hashes them and rejects the file on a mismatch, then opens the DB from buffer + 4.
//
// Used for site edits the change tables cannot express. The bridge writes them into a copy of the console's own
// dynasty file and the league server publishes it under a new file id; the console downloads it on its next load like
// a file another member uploaded:
//  - portal transfers: TRAZ merges by PGID into existing TRAN rows only, so a player made to transfer (no TRAN row)
//    reached the console flagged but with no destination;
//  - depth charts and formation subs: there is no change table for DCHT / PLSU at all;
//  - transfer eligibility: a portal player the game redshirted at the rollover gets PRSD 0 here as well as in PLYZ;
//  - the recruiting class reshaped by Fang's Recruit Overhaul at the preseason (recruit-overhaul.ts).
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { parseTdb, serializeTdb, verifyTdb, type TdbFile, type TdbTable } from '@ncaa/tdb';
import { DEPTH_SLOTS } from '@ncaa/ncaa14';
import { openDynastyFile } from './od.js';
import { applyRecruitClass, classTaken, sha256 } from './recruit-overhaul.js';

const HASHED = 0x7e5000;
export function fnv1(bytes: Uint8Array, n = HASHED): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < n; i++) { h = Math.imul(h, 0x01000193) >>> 0; h = (h ^ (bytes[i] ?? 0)) >>> 0; }
  return h >>> 0;
}
export function buildDynastyFile(db: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + db.length);
  new DataView(out.buffer).setUint32(0, fnv1(db), false);
  out.set(db, 4);
  return new Uint8Array(deflateSync(out, { level: 9 }));
}

import { applyPlayoff, verifyPlayoff, type PlayoffPatch } from './playoff.js';
export const PATCH_FORMAT = 5; // part of the bridge's rebuild key: a change to what patchDynasty writes rebuilds pending files
export const NEW_TRANSFER_WEIGHT = 150; // PLSS.WTLS for a player the site sends to the portal (70..245 on the game's own)
export interface TransferPatch { pgid: number; action: 'transfer' | 'stay'; to: number | null; reason: number }
// one team's whole depth chart ({pos: [pgid by depth]}, 0 = leave the console's player) and its formation subs
export interface DepthPatch { tgid: number; chart: Record<string, number[]>; subs: { side: 'off' | 'def'; set: number; slot: number; pgid: number }[] }
// the reshaped recruiting class: the tool's output DB on disk (file, sha), the RCPT fields to carry over and the RCPR
// fields (interest) to carry when the console's file is still the one the tool ran on
export interface RecruitPatch { file: string; sha: string; fields: string[]; interestFields: string[] }
// a prospect edited on the site (null = unchanged); weight in pounds (RCPT.PWGT holds lb - 160)
// lockTgid: a commissioner's "commit to this team": the team's interest in the prospect (RCPR PS of its PT slot) is raised
// above the points-to-commit threshold and above every other school, so the game commits him at its next weekly update
export interface RecruitEdit { prsi: number; firstName: string | null; lastName: string | null; pos: number | null; height: number | null; weight: number | null; stars: number | null; headId?: number | null; lockTgid?: number | null }
// startYear: the calendar year a brand-new dynasty starts in (the game counts seasons from 2013)
// playoff: the FCS playoff's re-weeked bowl rows and the rounds written so far (bridge/src/playoff.ts)
export interface DynastyPatchSet { transfers: TransferPatch[]; depth: DepthPatch[]; eligible: number[]; recruits?: RecruitPatch; recruitEdits?: RecruitEdit[]; startYear?: number; playoff?: PlayoffPatch } // eligible: PGIDs whose redshirt (PRSD) is cleared
export const emptyPatchSet = (): DynastyPatchSet => ({ transfers: [], depth: [], eligible: [] });
export const patchSetEmpty = (s: DynastyPatchSet) => !s.transfers.length && !s.depth.length && !s.eligible.length && !s.recruits && !s.recruitEdits?.length && !s.startYear && !s.playoff;
export const RECRUIT_FIRST_MAX = 11, RECRUIT_LAST_MAX = 13, WEIGHT_BASE = 160;

// Recruit edits from the site: RCPT rows by PRSI (name, position, height, weight, stars); applied after the overhaul so
// a coach's edit wins over the tool's names.
function applyRecruitEdits(file: TdbFile, edits: RecruitEdit[], changes: string[]): void {
  if (!edits.length) return;
  if (!file.hasTable('RCPT')) { changes.push('recruit edits: no RCPT table, skipped'); return; }
  const t = file.table('RCPT'); const rows = new Map<number, number>();
  for (let i = 0; i < t.recordCount; i++) rows.set(Number(t.get(i, 'PRSI')), i);
  for (const e of edits) {
    const i = rows.get(e.prsi); if (i === undefined) { changes.push(`recruit PRSI ${e.prsi}: not in RCPT, skipped`); continue; }
    const was = `${t.get(i, 'PFNA')} ${t.get(i, 'PLNA')}`; const bits: string[] = [];
    if (e.firstName !== null) { t.set(i, 'PFNA', e.firstName.slice(0, RECRUIT_FIRST_MAX)); }
    if (e.lastName !== null) { t.set(i, 'PLNA', e.lastName.slice(0, RECRUIT_LAST_MAX)); }
    if (e.firstName !== null || e.lastName !== null) bits.push(`${was} -> ${t.get(i, 'PFNA')} ${t.get(i, 'PLNA')}`);
    if (e.pos !== null) { t.set(i, 'PPOS', Math.max(0, Math.min(31, e.pos))); bits.push(`PPOS ${e.pos}`); }
    if (e.height !== null) { t.set(i, 'PHGT', Math.max(0, Math.min(127, e.height))); bits.push(`PHGT ${e.height}`); }
    if (e.weight !== null) { t.set(i, 'PWGT', Math.max(0, Math.min(255, e.weight - WEIGHT_BASE))); bits.push(`${e.weight} lb`); }
    if (e.stars !== null) { t.set(i, 'RCCB', Math.max(0, Math.min(7, e.stars))); bits.push(`${e.stars} stars`); }
    if (e.headId !== null && e.headId !== undefined) { t.set(i, 'PGHE', Math.max(0, Math.min(511, e.headId))); bits.push(`face ${e.headId}`); } // 9-bit field; the game's art runs 1..246
    if (e.lockTgid !== null && e.lockTgid !== undefined) bits.push(lockInterest(file, e.prsi, e.lockTgid));
    changes.push(`recruit ${was} (PRSI ${e.prsi}): ${bits.join(', ') || 'no change'}`);
  }
}
// RCPR: ten (PTnn team, PSnn points) slots sorted by points, CMTS = points to commit, PTCM = committed team (1023 none).
// Gives tgid the top slot with more points than the commit threshold and the current leader (15-bit field, max 32767).
export const LOCK_MARGIN = 600;
function lockInterest(file: TdbFile, prsi: number, tgid: number): string {
  if (!file.hasTable('RCPR')) return 'lock: no RCPR table';
  const r = file.table('RCPR'); let row = -1;
  for (let i = 0; i < r.recordCount; i++) if (Number(r.get(i, 'PRSI')) === prsi) { row = i; break; }
  if (row < 0) return 'lock: not in RCPR';
  if (Number(r.get(row, 'PTCM')) !== 1023) return `lock: already committed to ${r.get(row, 'PTCM')}`;
  const slots = Array.from({ length: 10 }, (_, k) => { const s = String(k + 1).padStart(2, '0'); return { team: Number(r.get(row, `PT${s}`)), pts: Number(r.get(row, `PS${s}`)) }; });
  const cmts = Number(r.get(row, 'CMTS')), lead = Math.max(...slots.map((s) => s.pts));
  const target = Math.min(32767, Math.max(cmts, lead) + LOCK_MARGIN);
  const mine = slots.findIndex((s) => s.team === tgid);
  if (mine >= 0) slots[mine]!.pts = target; else slots[9] = { team: tgid, pts: target }; // no slot yet: take the lowest
  slots.sort((a, b) => b.pts - a.pts);
  slots.forEach((s, k) => { const n = String(k + 1).padStart(2, '0'); r.set(row, `PT${n}`, s.team); r.set(row, `PS${n}`, s.pts); });
  return `interest for team ${tgid} set to ${target} (commit at ${cmts}, previous leader ${lead})`;
}
export const BASE_YEAR = 2013; // SEAI.SEYR 0; the console adds 2013 to it for its calendar (EBOOT 0x4d9b48)

// The start year, as the NCAA 14 Dynasty Tool's Year Changer sets it on a freshly created dynasty at its first
// preseason: SEAI.SSYE (the year the dynasty began) and SEYR (the current year) both become year - 2013, SNPW 8 and
// SEOW 23 (its fix for an offseason loop). Anything past that first preseason is left alone.
function applyStartYear(file: TdbFile, year: number, changes: string[]): boolean {
  if (!file.hasTable('SEAI') || !file.table('SEAI').recordCount) { changes.push('start year: no SEAI row, skipped'); return false; }
  const t = file.table('SEAI'); const off = year - BASE_YEAR; const cur = Number(t.get(0, 'SEYR')), week = Number(t.get(0, 'SEWN'));
  if (cur === off) { changes.push(`start year ${year}: already set`); return false; }
  if (cur !== 0 || week !== 0) { changes.push(`start year ${year}: the dynasty is past its first preseason (${BASE_YEAR + cur}, week ${week}), left alone`); return false; }
  t.set(0, 'SSYE', off); t.set(0, 'SEYR', off); t.set(0, 'SNPW', 8); t.set(0, 'SEOW', 23);
  changes.push(`start year ${year} (SEAI SSYE/SEYR ${off}, SNPW 8, SEOW 23)`);
  return true;
}
const findRow = (t: TdbTable, col: string, v: number) => { for (let i = 0; i < t.recordCount; i++) if (Number(t.get(i, col)) === v) return i; return -1; };

// Portal transfers. The game keeps one TRAN and one PLSS row per player in the portal (70 and 70 in file 124), so a stay
// only flips flags and a new transfer gets both rows:
//  transfer: PLAY PTYP 1 + PLFL reason; TRAN row (PTID dest, TRYR 0, TRAC 1), inserted when missing; PLSS row if missing;
//  stay:     PLAY PTYP 0 + PLFL 28; TRAN row kept with TRAC 0.
function applyTransfers(file: TdbFile, patches: TransferPatch[], changes: string[]) {
  if (!patches.length) return;
  const play = file.table('PLAY'), tran = file.table('TRAN'), plss = file.table('PLSS');
  for (const p of patches) {
    const r = findRow(play, 'PGID', p.pgid);
    if (r < 0) { changes.push(`PGID ${p.pgid}: not in PLAY, skipped`); continue; }
    const who = `${play.get(r, 'PFNA')} ${play.get(r, 'PLNA')} (PGID ${p.pgid})`;
    const t = findRow(tran, 'PGID', p.pgid), s = findRow(plss, 'PGID', p.pgid);
    if (p.action === 'transfer' && p.to !== null) {
      play.set(r, 'PTYP', 1); play.set(r, 'PLFL', p.reason);
      if (t >= 0) { tran.set(t, 'PTID', p.to); tran.set(t, 'TRAC', 1); } else tran.appendRecord({ PTID: p.to, PGID: p.pgid, TRYR: 0, TRAC: 1 });
      if (s < 0) plss.appendRecord({ WTLS: NEW_TRANSFER_WEIGHT, PGID: p.pgid, CSPL: 0, CTSP: 0 });
      changes.push(`${who}: transfers to team ${p.to} (reason ${p.reason})${t < 0 ? ', TRAN row added' : ''}${s < 0 ? ', PLSS row added' : ''}`);
    } else if (p.action === 'stay') {
      play.set(r, 'PTYP', 0); play.set(r, 'PLFL', 28);
      if (t >= 0) tran.set(t, 'TRAC', 0);
      changes.push(`${who}: stays`);
    }
  }
}
// Depth charts: DCHT holds 88 rows per team (DEPTH_SLOTS per position, not contiguous, no index); each slot's PGID is
// set in place, a 0 in the chart leaves the console's player. Formation subs replace the team's PLSU rows: PGID, TGID,
// PFPI = slot (0..10), PLFO = set id, PFIO = 1 offense / 0 defense (the site's reading of the table; unverified).
function applyDepth(file: TdbFile, patches: DepthPatch[], changes: string[]) {
  if (!patches.length) return;
  const dcht = file.table('DCHT'), plsu = file.hasTable('PLSU') ? file.table('PLSU') : null;
  const slots = new Map<string, number>(); // "tgid:pos:depth" -> row
  for (let i = 0; i < dcht.recordCount; i++) slots.set(`${dcht.get(i, 'TGID')}:${dcht.get(i, 'PPOS')}:${dcht.get(i, 'ddep')}`, i);
  for (const p of patches) {
    let set = 0, missing = 0;
    for (const [pos, ids] of Object.entries(p.chart)) {
      const n = DEPTH_SLOTS[Number(pos)] ?? 0;
      for (let d = 0; d < Math.min(n, ids.length); d++) {
        const pgid = ids[d]!; if (!pgid) continue;
        const row = slots.get(`${p.tgid}:${pos}:${d}`); if (row === undefined) { missing++; continue; }
        if (Number(dcht.get(row, 'PGID')) !== pgid) { dcht.set(row, 'PGID', pgid); set++; }
      }
    }
    let subs = '';
    if (plsu) {
      let removed = 0; for (let i = plsu.recordCount - 1; i >= 0; i--) if (Number(plsu.get(i, 'TGID')) === p.tgid) { plsu.removeRecord(i); removed++; }
      const room = plsu.header.maxRecords - plsu.recordCount; const list = p.subs.slice(0, Math.max(0, room));
      for (const s of list) plsu.appendRecord({ PGID: s.pgid, TGID: p.tgid, PFPI: Math.min(15, s.slot), PLFO: Math.min(1023, s.set), PFIO: s.side === 'off' ? 1 : 0 });
      subs = p.subs.length || removed ? `, formation subs: ${list.length} row(s)${removed ? ` replacing ${removed}` : ''}${list.length < p.subs.length ? ` (${p.subs.length - list.length} dropped, PLSU full)` : ''}` : '';
    }
    changes.push(`team ${p.tgid} depth chart: ${set} slot(s) changed${missing ? `, ${missing} slot(s) not in DCHT` : ''}${subs}`);
  }
}
// Transfer eligibility: the redshirt the game put on a portal player at the rollover comes off (PRSD 1 -> 0).
function applyEligible(file: TdbFile, pgids: number[], changes: string[]) {
  if (!pgids.length) return;
  const play = file.table('PLAY');
  for (const pgid of pgids) {
    const r = findRow(play, 'PGID', pgid);
    if (r < 0) { changes.push(`PGID ${pgid}: not in PLAY, eligibility skipped`); continue; }
    if (Number(play.get(r, 'PRSD')) === 1) { play.set(r, 'PRSD', 0); changes.push(`${play.get(r, 'PFNA')} ${play.get(r, 'PLNA')} (PGID ${pgid}): redshirt cleared, eligible this season`); }
  }
}

// Applies every pending site edit to a copy of the console's dynasty file. Returns the new file and a description of
// each change; throws if the result does not re-open cleanly or does not read back as written.
export function patchDynasty(blob: Uint8Array, set: DynastyPatchSet): { blob: Uint8Array; changes: string[] } {
  const o = openDynastyFile(blob);
  const changes: string[] = [];
  let overhaul: TdbFile | null = null;
  if (set.recruits) {
    const bytes = new Uint8Array(readFileSync(set.recruits.file));
    if (sha256(bytes) !== set.recruits.sha) throw new Error(`the overhauled class at ${set.recruits.file} is not the one recorded`);
    overhaul = parseTdb(bytes);
    if (classTaken(o.file, overhaul)) { changes.push('recruit overhaul: the console already has this class'); overhaul = null; }
    else applyRecruitClass(o.file, overhaul, set.recruits.fields, set.recruits.interestFields, changes);
  }
  applyRecruitEdits(o.file, set.recruitEdits ?? [], changes);
  const yearSet = set.startYear ? applyStartYear(o.file, set.startYear, changes) : false;
  applyTransfers(o.file, set.transfers, changes);
  applyDepth(o.file, set.depth, changes);
  applyEligible(o.file, set.eligible, changes);
  if (set.playoff) applyPlayoff(o.file, set.playoff, changes);
  const db = serializeTdb(o.file, { padTo: o.db.length });
  const problems = verifyTdb(db, o.file);
  if (problems.length) throw new Error(`patched dynasty file does not verify: ${JSON.stringify(problems.slice(0, 3))}`);
  const out = buildDynastyFile(db);
  // read it back as the console will: hash, then the rows we wrote
  const back = openDynastyFile(out);
  const pre = new DataView(back.prefix.buffer, back.prefix.byteOffset, 4).getUint32(0, false);
  if (pre !== fnv1(back.db)) throw new Error('patched dynasty file: prefix hash mismatch');
  for (const p of set.transfers.filter((x) => x.action === 'transfer' && x.to !== null)) {
    const bt = back.file.table('TRAN'); const i = findRow(bt, 'PGID', p.pgid);
    if (i < 0 || Number(bt.get(i, 'PTID')) !== p.to) throw new Error(`patched dynasty file: TRAN row for PGID ${p.pgid} missing after re-read`);
  }
  if (set.depth.length) {
    const bd = back.file.table('DCHT'); const want = new Map<string, number>();
    for (const p of set.depth) for (const [pos, ids] of Object.entries(p.chart)) ids.forEach((pgid, d) => { if (pgid && d < (DEPTH_SLOTS[Number(pos)] ?? 0)) want.set(`${p.tgid}:${pos}:${d}`, pgid); });
    for (let i = 0; i < bd.recordCount && want.size; i++) { const k = `${bd.get(i, 'TGID')}:${bd.get(i, 'PPOS')}:${bd.get(i, 'ddep')}`; const w = want.get(k); if (w === undefined) continue; if (Number(bd.get(i, 'PGID')) !== w) throw new Error(`patched dynasty file: DCHT ${k} reads ${bd.get(i, 'PGID')}, wanted ${w}`); want.delete(k); }
    if (back.file.hasTable('PLSU')) { const bp = back.file.table('PLSU'); const n = set.depth.reduce((a, p) => a + p.subs.length, 0); const have = set.depth.reduce((a, p) => { let c = 0; for (let i = 0; i < bp.recordCount; i++) if (Number(bp.get(i, 'TGID')) === p.tgid) c++; return a + c; }, 0); if (have > n) throw new Error(`patched dynasty file: PLSU has ${have} rows for the patched teams, wanted at most ${n}`); }
  }
  for (const pgid of set.eligible) { const bp = back.file.table('PLAY'); const i = findRow(bp, 'PGID', pgid); if (i >= 0 && Number(bp.get(i, 'PRSD')) === 1) throw new Error(`patched dynasty file: PGID ${pgid} still redshirted after re-read`); }
  if (overhaul && !classTaken(back.file, overhaul)) throw new Error('patched dynasty file: the reshaped recruits did not read back');
  if (yearSet && Number(back.file.table('SEAI').get(0, 'SEYR')) !== set.startYear! - BASE_YEAR) throw new Error('patched dynasty file: the start year did not read back');
  if (set.playoff) { const problem = verifyPlayoff(back.file, set.playoff); if (problem) throw new Error(`patched dynasty file: ${problem}`); }
  if (set.recruitEdits?.length && back.file.hasTable('RCPT')) {
    const bt = back.file.table('RCPT'); const want = new Map(set.recruitEdits.map((e) => [e.prsi, e]));
    for (let i = 0; i < bt.recordCount && want.size; i++) { const e = want.get(Number(bt.get(i, 'PRSI'))); if (!e) continue; want.delete(e.prsi); if (e.lastName !== null && bt.get(i, 'PLNA') !== e.lastName.slice(0, RECRUIT_LAST_MAX)) throw new Error(`patched dynasty file: recruit ${e.prsi} did not read back`); }
  }
  return { blob: out, changes };
}
export const patchTransfers = (blob: Uint8Array, patches: TransferPatch[]) => patchDynasty(blob, { ...emptyPatchSet(), transfers: patches });
