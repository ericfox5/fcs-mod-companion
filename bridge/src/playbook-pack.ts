// A team's private playbook on the console, shared by the bridge (commands/playbook.ts writes it on the host's PC) and
// FCS-online.exe (installer/src/main.ts puts the same bytes on every member's PC), kept free of the bridge's heavier
// modules so the installer bundle stays small.
//
// What a private book is (proven in game 2026-11-10, spike/blaze/NOTES.md): the team's composed per-book DB written into
// an UNUSED stock book's entry of qkl_fe2ig.ast (PLAYBOOK_<PLAB.PBAN>, appended + TOC record repointed because it grows),
// that book's PLAB row renamed in both list copies (qkl_boot.ast #356 and qkl_misc.ast #151, in place: BNAM is a fixed
// 168-bit string), and the team's TEAM.TOPB pointed at the row's BGID in the roster save, the default roster and (through
// the dynasty-file copy, dynasty-patch.ts) the online dynasty's file.
//
// The slot map ~/.ncaa-bridge/playbooks.json keeps "<scope>/<tgid>/<side>" -> slot so a team keeps its book across
// releases (scope: od<DID> for an online dynasty's edits, "local" for `playbook private` by hand). A pack is what a
// release ships: every slot's entry bytes (one blob) with the names and pointers; a member's copy takes a book when its
// entry still holds the stock donor's bytes or an earlier version of the same private book, never anything else.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseTdb, serializeTdb, verifyTdb, type TdbFile, type TdbTable } from '@ncaa/tdb';
import { playbookEntryHash } from '@ncaa/ncaa14';
import { appendEntry, readEntry, rewriteEntry, type EntryOutcome, type EntryTarget } from './archive-entry.js';
import { bootArchive, dbTargets, discDir, readDb, rewriteDb, rosterSavePath } from './swap/install.js';

export const PLAYBOOK_DB_HASH = 0x4e226c292cd63322n; // qkl_misc.ast: CUSTOMPLAYBOOKS, the master playbook DB (3,036,588 bytes, stored)
export const PLAYBOOK_LIST_HASH = 0x1d4509dc8d1a528en; // qkl_boot.ast: PLAB, the playbook list (BGID BOFF PBGI BNAM PBAN)
export const PLAYBOOK_LIST2_HASH = 0x1f00cfcc51550d23n; // qkl_misc.ast #151: a second PLAB copy (no PBGI) next to DCSB/DRPS/PLPS/POSG; renamed along with the first
export const BASE_DB_HASH = 0xb0ccfdf2435c3916n; // qkl_boot.ast: the base book DB (shared special-teams sets, plays, programs, art)
export const STOCK_PLAYBOOK_DB_SHA = '3d2cbe578b1f99ba00e90cbbeacdc270406426b524b3705ed58f538ea96819f9';
export const PLAB_NAME_CHARS = 21; // PLAB.BNAM is 168 bits
export const PRIVATE_BOOKS_FILE = join(homedir(), '.ncaa-bridge', 'playbooks.json');
export const miscArchive = (rpcs3: string): string => join(discDir(rpcs3), 'qkl_misc.ast');
export const fe2igArchive = (rpcs3: string): string => join(discDir(rpcs3), 'qkl_fe2ig.ast');
export const plabTargets = (rpcs3: string): EntryTarget[] => [{ archive: bootArchive(rpcs3), hash: PLAYBOOK_LIST_HASH }, { archive: miscArchive(rpcs3), hash: PLAYBOOK_LIST2_HASH }];
export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export type BookSide = 'off' | 'def';
// a team's book choice to write: TEAM.TOPB (off) / TDPB (def) = bgid, only while the row holds one of `from`
export interface BookPointer { tgid: number; side: BookSide; bgid: number; from: number[]; name: string }
export interface PrivateSlot {
  bgid: number; bokl: number; pban: string; donor: string; name: string; at: string;
  donorSha?: string; // the stock book's entry bytes the slot held before the first write (what a member's copy still holds)
  base?: { bokl: number; bgid: number }; // the stock book the edits start from: TOPB is only moved off it (or back onto it)
  sha?: string; history?: string[]; // the entry as last written, and every earlier version written to the slot
  released?: boolean; // the team reset its edits: TOPB goes back to the base; the slot stays reserved for the team
  taken?: { file: number; bgid: number }; // the online dynasty's console file seen pointing where the slot wants (markBooksTaken)
}
export type PrivateMap = Record<string, PrivateSlot>;
export const slotKey = (scope: string, tgid: number, side: BookSide): string => `${scope}/${tgid}/${side}`;
export const dynastyScope = (did: number): string => `od${did}`;
export const parseSlotKey = (key: string): { scope: string; tgid: number; side: BookSide } | null => { const m = /^(.+)\/(\d+)\/(off|def)$/.exec(key); return m ? { scope: m[1]!, tgid: Number(m[2]), side: m[3] as BookSide } : null; };
export const readPrivateMap = (file = PRIVATE_BOOKS_FILE): PrivateMap => { try { return JSON.parse(readFileSync(file, 'utf8')) as PrivateMap; } catch { return {}; } };
export const writePrivateMap = (m: PrivateMap, file = PRIVATE_BOOKS_FILE): void => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(m, null, 1)); };
// where a slot wants the team's book pointer: its own book, or the base again once released
export function slotTarget(key: string, s: PrivateSlot): BookPointer | null {
  const k = parseSlotKey(key); if (!k || !s.base) return null;
  return s.released ? { tgid: k.tgid, side: k.side, bgid: s.base.bgid, from: [s.bgid], name: `stock book (was "${s.name}")` } : { tgid: k.tgid, side: k.side, bgid: s.bgid, from: [s.base.bgid], name: s.name };
}

const rowsWhere = (t: TdbTable, pred: (i: number) => boolean): number[] => { const out: number[] = []; for (let i = 0; i < t.recordCount; i++) if (pred(i)) out.push(i); return out; };
export const plabRows = (rpcs3: string): Record<string, number | string>[] => [...parseTdb(new Uint8Array(readEntry({ archive: bootArchive(rpcs3), hash: PLAYBOOK_LIST_HASH }).bytes)).table('PLAB').rows()] as Record<string, number | string>[];
export function teamNameOf(rpcs3: string, tgid: number): string | null {
  const save = rosterSavePath(rpcs3); if (!existsSync(save)) return null;
  const t = readDb({ label: 'roster', kind: 'file', path: save }).table('TEAM');
  const i = rowsWhere(t, (k) => Number(t.get(k, 'TGID')) === tgid)[0]; return i === undefined ? null : String(t.get(i, 'TDNA'));
}

// ---- the dynasty-file side: pointers an online dynasty's file still needs, and the console's file taking them ----
export function pendingBookPointers(did: number, map = readPrivateMap()): BookPointer[] {
  const out: BookPointer[] = [];
  for (const [key, s] of Object.entries(map)) {
    const k = parseSlotKey(key); if (!k || k.scope !== dynastyScope(did)) continue;
    const want = slotTarget(key, s); if (!want) continue;
    if (s.taken && s.taken.bgid === want.bgid) continue;
    out.push(want);
  }
  return out.sort((a, b) => a.tgid - b.tgid);
}
// the console's own upload shows a team's book where the slot wants it: remembered so the pointer is not re-sent (and a
// book the coach picks in game afterwards stays theirs)
export function markBooksTaken(did: number, file: TdbFile, fileId: number, mapFile = PRIVATE_BOOKS_FILE): string[] {
  const map = readPrivateMap(mapFile), team = file.table('TEAM'), notes: string[] = []; let changed = false;
  for (const [key, s] of Object.entries(map)) {
    const k = parseSlotKey(key); if (!k || k.scope !== dynastyScope(did)) continue;
    const want = slotTarget(key, s); if (!want || (s.taken && s.taken.bgid === want.bgid)) continue;
    const i = rowsWhere(team, (x) => Number(team.get(x, 'TGID')) === k.tgid)[0]; if (i === undefined) continue;
    if (Number(team.get(i, k.side === 'off' ? 'TOPB' : 'TDPB')) !== want.bgid) continue;
    s.taken = { file: fileId, bgid: want.bgid }; changed = true; notes.push(`team ${k.tgid} ${k.side === 'off' ? 'TOPB' : 'TDPB'} ${want.bgid} ("${want.name}") taken by console file ${fileId}`);
  }
  if (changed) writePrivateMap(map, mapFile);
  return notes;
}

// ---- the two writes a book needs besides its entry: list rows renamed, TOPB pointed ----
// PLAB.BNAM of each BGID (offensive rows) in both list copies, in place; already-named rows cost nothing
export function renameBookRows(rpcs3: string, names: { bgid: number; name: string }[], backupDir: string, tool: string): { label: string; outcome: EntryOutcome }[] {
  const out: { label: string; outcome: EntryOutcome }[] = [];
  for (const t of plabTargets(rpcs3)) {
    if (!existsSync(t.archive)) { out.push({ label: t.archive.split(/[\\/]/).pop()!, outcome: { status: 'skipped', note: 'archive not found' } }); continue; }
    const cur = readEntry(t), db = parseTdb(new Uint8Array(cur.bytes)), plab = db.table('PLAB'); const changed: string[] = [];
    for (const n of names) {
      const i = rowsWhere(plab, (k) => Number(plab.get(k, 'BGID')) === n.bgid && Number(plab.get(k, 'BOFF')) === 1);
      if (i.length !== 1) throw new Error(`${t.archive}: PLAB has ${i.length} offensive rows for BGID ${n.bgid}`);
      const was = String(plab.get(i[0]!, 'BNAM')); if (was === n.name) continue; plab.set(i[0]!, 'BNAM', n.name); changed.push(`BGID ${n.bgid} "${was}" -> "${n.name}"`);
    }
    const label = t.archive.split(/[\\/]/).pop()!;
    if (!changed.length) { out.push({ label, outcome: { status: 'already', note: `${names.length} book name(s) already in place` } }); continue; }
    const bytes = serializeTdb(db, { padTo: cur.bytes.length }); if (verifyTdb(bytes, db).length) throw new Error(`${t.archive}: the PLAB rewrite does not verify; nothing written`);
    out.push({ label, outcome: rewriteEntry(t, bytes, backupDir, { tool, note: changed.join(', ') }) });
  }
  return out;
}
// TEAM.TOPB / TDPB in the roster save and the default roster, guarded by `from` (a book the coach picked in game stays)
export function pointTeamBooks(rpcs3: string, list: BookPointer[], backupDir: string): string[] {
  const notes: string[] = [];
  for (const t of dbTargets(rpcs3).filter((x) => existsSync(x.path))) {
    const lines: string[] = [];
    const res = rewriteDb(t, backupDir, (f) => {
      const team = f.table('TEAM');
      for (const p of list) {
        const col = p.side === 'off' ? 'TOPB' : 'TDPB', i = rowsWhere(team, (x) => Number(team.get(x, 'TGID')) === p.tgid);
        if (i.length !== 1) { lines.push(`team ${p.tgid}: ${i.length} TEAM rows, skipped`); continue; }
        const cur = Number(team.get(i[0]!, col));
        if (cur === p.bgid) lines.push(`team ${p.tgid} ${col} already ${p.bgid}`);
        else if (!p.from.includes(cur)) lines.push(`team ${p.tgid} ${col} holds ${cur} (chosen in game), left alone`);
        else { team.set(i[0]!, col, p.bgid); lines.push(`team ${p.tgid} ${col} ${cur} -> ${p.bgid} ("${p.name}")`); }
      }
    });
    notes.push(`${t.label}: ${lines.join('; ')}${res.changed ? ` (written, sha ${res.sha.slice(0, 12)})` : ''}`);
  }
  return notes;
}

// ---- the pack a release ships ----
export interface PackBook { key: string; scope: string; tgid: number; team: string | null; side: BookSide; bgid: number; bokl: number; pban: string; donor: string; name: string; base: { bokl: number; bgid: number }; sha: string; replaces: string[]; offset: number; size: number; at: string }
export interface PlaybookPackManifest { builtAt: string; books: PackBook[]; skipped: string[] }
// every live slot whose entry still holds what the bridge wrote (one blob, entries back to back); a slot whose archive
// bytes differ from its record is reported and left out (the host restored or re-wrote it outside the bridge)
export function exportPlaybookPack(rpcs3: string, map = readPrivateMap()): { manifest: PlaybookPackManifest; blob: Buffer } {
  const chunks: Buffer[] = [], books: PackBook[] = [], skipped: string[] = []; let off = 0;
  for (const [key, s] of Object.entries(map).sort((a, b) => a[1].at.localeCompare(b[1].at))) {
    const k = parseSlotKey(key); if (!k) { skipped.push(`${key}: not a slot key`); continue; }
    if (s.released) { skipped.push(`${key}: released (the team reset its book)`); continue; }
    if (!s.sha || !s.base || !s.donorSha) { skipped.push(`${key}: written before the pack format (no sha / base / donorSha); run playbook sync again`); continue; }
    const cur = readEntry({ archive: fe2igArchive(rpcs3), hash: playbookEntryHash(s.pban) });
    if (cur.sha !== s.sha) { skipped.push(`${key}: PLAYBOOK_${s.pban} holds sha ${cur.sha.slice(0, 12)}, not the book recorded (${s.sha.slice(0, 12)}); run playbook sync`); continue; }
    books.push({ key, scope: k.scope, tgid: k.tgid, team: teamNameOf(rpcs3, k.tgid), side: k.side, bgid: s.bgid, bokl: s.bokl, pban: s.pban, donor: s.donor, name: s.name, base: s.base, sha: s.sha, replaces: [...new Set([s.donorSha, ...(s.history ?? [])])].filter((x) => x !== s.sha), offset: off, size: cur.bytes.length, at: s.at });
    chunks.push(cur.bytes); off += cur.bytes.length;
  }
  return { manifest: { builtAt: new Date().toISOString().slice(0, 16).replace('T', ' '), books, skipped }, blob: Buffer.concat(chunks) };
}
export const packSummary = (m: PlaybookPackManifest): string => m.books.map((b) => `${b.team ?? `team ${b.tgid}`}: "${b.name}"`).join(', ') || 'none';

export interface PackStep { label: string; status: 'done' | 'already' | 'skipped' | 'error'; note: string }
// Put a pack on this PC: each book into its slot's entry (stock donor / earlier version only), the list rows renamed, the
// teams pointed (roster save when present, default roster). Nothing here needs the site.
export function applyPlaybookPack(rpcs3: string, m: PlaybookPackManifest, blob: Buffer, backupDir: string, tool = 'FCS-online.exe'): PackStep[] {
  const steps: PackStep[] = [];
  const run = (label: string, fn: () => { status: PackStep['status']; note: string }) => { try { const r = fn(); steps.push({ label, ...r }); } catch (e) { steps.push({ label, status: 'error', note: (e as Error).message }); } };
  if (!existsSync(fe2igArchive(rpcs3))) return [{ label: 'playbooks', status: 'error', note: `no ${fe2igArchive(rpcs3)} (install the FCS mod first)` }];
  const placed: PackBook[] = [];
  for (const b of m.books) run(`"${b.name}" (${b.team ?? `team ${b.tgid}`})`, () => {
    const bytes = blob.subarray(b.offset, b.offset + b.size); if (bytes.length !== b.size || sha256(bytes) !== b.sha) throw new Error('the pack bytes do not match their manifest entry');
    const r = appendEntry({ archive: fe2igArchive(rpcs3), hash: playbookEntryHash(b.pban) }, bytes, backupDir, { replaces: b.replaces, tool, note: `${b.team ?? b.tgid} "${b.name}" into PLAYBOOK_${b.pban} (BGID ${b.bgid})` });
    if (r.status !== 'skipped') placed.push(b);
    return { status: r.status === 'written' ? 'done' : r.status, note: r.status === 'skipped' ? `${r.note}: this copy's "${b.donor}" book slot was changed by something else; left alone` : r.note };
  });
  if (placed.length) {
    run('playbook list names', () => { const rs = renameBookRows(rpcs3, placed.map((b) => ({ bgid: b.bgid, name: b.name })), backupDir, tool); return { status: rs.every((x) => x.outcome.status === 'already') ? 'already' : rs.some((x) => x.outcome.status === 'written') ? 'done' : 'skipped', note: rs.map((x) => `${x.label}: ${x.outcome.note}`).join('; ') }; });
    run('teams pointed at their books', () => ({ status: 'done', note: pointTeamBooks(rpcs3, placed.map((b) => ({ tgid: b.tgid, side: b.side, bgid: b.bgid, from: [b.base.bgid], name: b.name })), backupDir).join('; ') }));
  }
  return steps;
}
// one line per book: current / the stock book or an earlier version (join writes it) / not this build's
export function playbookPackStatus(rpcs3: string, m: PlaybookPackManifest): string[] {
  if (!existsSync(fe2igArchive(rpcs3))) return ['playbooks: no qkl_fe2ig.ast'];
  const names = new Map<number, string>(); try { for (const r of plabRows(rpcs3)) if (Number(r.BOFF) === 1) names.set(Number(r.BGID), String(r.BNAM)); } catch { /* no list */ }
  const topb = new Map<number, number>(); try { const t = readDb(dbTargets(rpcs3)[0]!).table('TEAM'); for (let i = 0; i < t.recordCount; i++) topb.set(Number(t.get(i, 'TGID')), Number(t.get(i, 'TOPB'))); } catch { /* no roster save */ }
  return m.books.map((b) => {
    let entry: string; try { const cur = readEntry({ archive: fe2igArchive(rpcs3), hash: playbookEntryHash(b.pban) }); entry = cur.sha === b.sha ? 'current' : b.replaces.includes(cur.sha) ? (cur.sha === b.replaces[0] ? `the stock "${b.donor}" book (join writes it)` : 'an earlier version (join updates it)') : `sha ${cur.sha.slice(0, 12)} (not this build's)`; } catch (e) { entry = (e as Error).message; }
    const listed = names.get(b.bgid), pt = topb.get(b.tgid);
    return `"${b.name}" for ${b.team ?? `team ${b.tgid}`}: ${entry}; listed as "${listed ?? '?'}"${pt === undefined ? '' : pt === b.bgid ? '; the team uses it' : pt === b.base.bgid ? '; the team still runs the stock book (join points it)' : `; the team runs book ${pt} (chosen in game)`}`;
  });
}
