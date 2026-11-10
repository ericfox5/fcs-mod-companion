// Phase 0 of the playbook work: look at the game's master playbook DB and poke one play, so the change can be checked
// in game before anything bigger is built on it. The DB is the stored (uncompressed) entry 4e226c292cd63322 of
// qkl_misc.ast, an EA DB:
//   PBPL plays (PLYL id, name, PLYT type, SETL set); PGPL book -> play rows (BOKL, SETL, PLYL, ord_); PLYS the 11 slot
//   assignments of a play (PLYL, poso 0..10, PSAL program, ARTL art, PLRR role); PSLO program steps (PSAL, step, code,
//   val1..3; code 8 carries a depth in val1); ARTO the route drawn for a slot (ARTL, acnt, 12 segments
//   sp/ls/at/ct/lt/au/av/ax/ay 01..12, ax/ay = segment end in feet, screen-down positive); SETL formation sets (name).
// The playbook list (PLAB: BGID, BOFF 1 offense / 0 defense, PBGI = BOKL, BNAM, PBAN) is entry 1d4509dc8d1a528e of
// qkl_boot.ast; a team's offensive book is TEAM.TOPB (a BGID with BOFF 1) in the FCS2026 roster save.
// What the game runs in a game is NOT that master DB (found 2026-11-10: a poke there changed nothing in Practice mode):
// every stock book is its own compiled DB in qkl_fe2ig.ast, entry name PLAYBOOK_<PBAN> (FNV-1a 64 of the upper-cased
// name, as every archive entry), ~100-190 KB, stored, 19 tables (PLYL plays, PBPL play list, PLYS slots, PSAL steps,
// ARTL art, SETL/SETG/SETP sets, FORM/PBFM/PBST, PLPD/PLRD, PBAI, PBAU, SPKF/SPKG/SGF, PLCM), every table full, its own
// PSAL/ARTL id spaces, play names 24 characters. The master DB is the game's CUSTOMPLAYBOOKS entry: the play source of
// the in-game custom playbook feature only.
//   ncaa-bridge playbook status [--team "Holy Cross"] [--set "5WR Trio"] [--count 12]
//       the entries' offsets / shas, the team's book (master and per-book entry) with its sets, and the book's first
//       plays (of one set with --set)
//   ncaa-bridge playbook poke --plyl N --name "ZZ TEST" [--slot P --yards 5] [--dry-run]
//       (master DB) rename the play; with --slot, push that slot's route N yards deeper (val1 of the program's first
//       code-8 step, and the art's last drawn segment end moved 3 N feet up-screen)
//   ncaa-bridge playbook poke-book --plyl N --name "ZZ TEST" [--slot P --yards 5] [--team "Holy Cross"] [--dry-run]
//       the same poke in the team's per-book entry of qkl_fe2ig.ast (the data the game plays): PBPL and PLYL names,
//       the slot's PSAL first code-8 step, every drawn art segment moved 3 N feet up-screen
//   ncaa-bridge playbook add-play --set "5WR Trio" --draw play.json [--name N] [--ord 1] [--team T] [--dry-run]
//       in-game check E1: one drawn play (the site's DrawnPlay JSON) compiled and appended to the team's own book entry
//   ncaa-bridge playbook private --edits edits.json [--team T] [--scope S] [--donor BGID] [--dry-run]
//       in-game check E2 / by hand: the team's composed book as a private book (an unused book's slot, see playbook-pack.ts)
//   ncaa-bridge playbook sync [--did N] [--dry-run]
//       the site's pending book edits of every online dynasty written as private books (scope od<DID>), acked with the
//       sha of what was written; a team that reset its book is pointed back at the stock one. Defensive edits stay pending
//       (Supersim only) until a private defensive book is proven in game.
//   ncaa-bridge playbook export --out pack.json --blob pack.bin     the pack installer/build.mjs ships (playbook-pack.ts)
//   ncaa-bridge playbook restore [--backup DIR] [--force]    put the entry back from the newest *-playbook backup
// [--rpcs3 DIR] everywhere (default NCAA_RPCS3, then rpcs3Root in ~/.ncaa-bridge/config.json). The rewrite keeps the
// entry's length (archive-entry.ts), backs the original up first and refuses while RPCS3 runs from the install.
import { existsSync, openSync, closeSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { FieldType, parseTdb, serializeTdb, verifyTdb, type TdbFile, type TdbTable } from '@ncaa/tdb';
import { STDA_BACKUP_ROOT, rpcs3RootFromConfig, rpcs3RunningOver } from '../stda.js';
import { appendEntry, newEntryBackupDir, readEntry, restoreEntries, rewriteEntry, type EntryManifest, type EntryTarget } from '../archive-entry.js';
import { bootArchive, rosterSavePath, dbTargets } from '../swap/install.js';
import { WorkerApi } from '../api.js';
import type { BridgeConfig } from '../config.js';
import { loadOdStore } from '../od.js';
import { BASE_DB_HASH, PLAB_NAME_CHARS, PLAYBOOK_DB_HASH, PLAYBOOK_LIST_HASH, PRIVATE_BOOKS_FILE, STOCK_PLAYBOOK_DB_SHA, dynastyScope, exportPlaybookPack, fe2igArchive, miscArchive, packSummary, parseSlotKey, plabRows, pointTeamBooks, readPrivateMap, renameBookRows, sha256, slotKey, slotTarget, writePrivateMap, type BookSide, type PrivateSlot } from '../playbook-pack.js';
import { playbookEntryHash, PlaybookDb, extractBook, compileDrawn, compiledToBook, addPlays, composeBookDb, booksNeeded, CUSTOM_ID_BASE, CompileError, BookWriteError, type BookEdits, type DrawnPlay, type SetDef } from '@ncaa/ncaa14';
export { BASE_DB_HASH, PLAB_NAME_CHARS, PLAYBOOK_DB_HASH, PLAYBOOK_LIST_HASH, PRIVATE_BOOKS_FILE, STOCK_PLAYBOOK_DB_SHA, fe2igArchive, miscArchive } from '../playbook-pack.js';

export const bookEntryHash = playbookEntryHash; // the per-book DB entry of qkl_fe2ig.ast: PLAYBOOK_<PBAN>
export const BOOK_NAME_CHARS = 24; // PBPL.name / PLYL.name in a per-book DB: 192 bits
const SEGMENTS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
const SEG_FIELDS = ['sp', 'ls', 'at', 'ct', 'lt', 'au', 'av', 'ax', 'ay'];

const num = (t: TdbTable, i: number, f: string): number => Number(t.get(i, f));
const rowsWhere = (t: TdbTable, pred: (i: number) => boolean): number[] => { const out: number[] = []; for (let i = 0; i < t.recordCount; i++) if (pred(i)) out.push(i); return out; };
// set a numeric cell, refusing a value its bit width cannot hold (writeBits would wrap it silently)
function setChecked(t: TdbTable, i: number, field: string, v: number): void {
  const f = t.field(field), signed = f.type === FieldType.SInt, lo = signed ? -(2 ** (f.bits - 1)) : 0, hi = signed ? 2 ** (f.bits - 1) - 1 : 2 ** f.bits - 1;
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${t.name}.${field} = ${v} does not fit its ${f.bits}-bit ${signed ? 'signed' : 'unsigned'} field (${lo}..${hi}); nothing changed`);
  t.set(i, field, v);
}
const playRows = (db: TdbFile): Map<number, number> => { const t = db.table('PBPL'), m = new Map<number, number>(); for (let i = 0; i < t.recordCount; i++) m.set(num(t, i, 'PLYL'), i); return m; };
// a play's slots that carry a route: "poso 2 (PLRR 57, PSAL 1148, ARTL 1469)"
const slotLine = (plys: TdbTable, plyl: number): string => rowsWhere(plys, (i) => num(plys, i, 'PLYL') === plyl).filter((i) => num(plys, i, 'ARTL')).map((i) => `poso ${num(plys, i, 'poso')} (PLRR ${num(plys, i, 'PLRR')}, PSAL ${num(plys, i, 'PSAL')}, ARTL ${num(plys, i, 'ARTL')})`).join(', ');

// A team's offensive book: its TEAM.TOPB in the roster save, the PLAB row that names it and the per-book entry of
// qkl_fe2ig.ast the game plays from.
export interface TeamBook { team: string; tgid: number; topb: number; bokl: number; bname: string; pban: string; entry: EntryTarget }
// team: the school name (TEAM.TDNA) or its TGID
export function teamBook(rpcs3: string, team: string | number = 'Holy Cross'): TeamBook {
  const save = rosterSavePath(rpcs3);
  if (!existsSync(save)) throw new Error(`no roster save at ${save}: --team needs the FCS2026 roster save`);
  const teams = parseTdb(new Uint8Array(readFileSync(save))).table('TEAM');
  const ti = typeof team === 'number' ? rowsWhere(teams, (i) => num(teams, i, 'TGID') === team) : rowsWhere(teams, (i) => String(teams.get(i, 'TDNA')).toLowerCase() === team.trim().toLowerCase());
  if (ti.length !== 1) throw new Error(ti.length ? `--team ${team} matches ${ti.length} TEAM rows` : `no team ${team} in ${save} (TEAM.TDNA is the school name${typeof team === 'number' ? ', TGID the id' : ''})`);
  const name = String(teams.get(ti[0]!, 'TDNA')), topb = num(teams, ti[0]!, 'TOPB');
  const plab = parseTdb(new Uint8Array(readEntry({ archive: bootArchive(rpcs3), hash: PLAYBOOK_LIST_HASH }).bytes)).table('PLAB');
  const bi = rowsWhere(plab, (i) => num(plab, i, 'BGID') === topb && num(plab, i, 'BOFF') === 1);
  if (bi.length !== 1) throw new Error(`${name}: TOPB ${topb} matches ${bi.length} offensive PLAB rows`);
  const pban = String(plab.get(bi[0]!, 'PBAN'));
  return { team: name, tgid: num(teams, ti[0]!, 'TGID'), topb, bokl: num(plab, bi[0]!, 'PBGI'), bname: String(plab.get(bi[0]!, 'BNAM')), pban, entry: { archive: fe2igArchive(rpcs3), hash: bookEntryHash(pban) } };
}

export function playbookStatus(rpcs3: string, opts: { team?: string; set?: string; count?: number } = {}): void {
  const misc = readEntry({ archive: miscArchive(rpcs3), hash: PLAYBOOK_DB_HASH });
  console.log(`${miscArchive(rpcs3)}: master playbook DB (CUSTOMPLAYBOOKS) entry ${PLAYBOOK_DB_HASH.toString(16)} at ${misc.off}, ${misc.bytes.length} bytes, sha ${misc.sha} ${misc.sha === STOCK_PLAYBOOK_DB_SHA ? '(stock)' : '(changed from stock)'}`);
  const list = readEntry({ archive: bootArchive(rpcs3), hash: PLAYBOOK_LIST_HASH });
  console.log(`${bootArchive(rpcs3)}: playbook list entry ${PLAYBOOK_LIST_HASH.toString(16)} at ${list.off}, ${list.bytes.length} bytes, sha ${list.sha}`);
  const db = parseTdb(new Uint8Array(misc.bytes)), plab = parseTdb(new Uint8Array(list.bytes)).table('PLAB');
  console.log(`master DB: ${db.tables.map((t) => `${t.name} ${t.recordCount}`).join(', ')}; PLAB ${plab.recordCount} books`);
  // the team's offensive book: the per-book entry the game plays, then the master's view of it
  const tb = teamBook(rpcs3, opts.team), team = tb.team;
  const be = readEntry(tb.entry), bdb = parseTdb(new Uint8Array(be.bytes));
  console.log(`${team} (TGID ${tb.tgid}): TOPB ${tb.topb} -> PLAB "${tb.bname}" (BOKL ${tb.bokl}, PBAN "${tb.pban}")`);
  console.log(`  per-book entry PLAYBOOK_${tb.pban} = ${tb.entry.hash.toString(16)} in ${tb.entry.archive}: at ${be.off}, ${be.bytes.length} bytes, sha ${be.sha}`);
  console.log(`  per-book DB: ${bdb.tables.map((t) => `${t.name} ${t.recordCount}/${t.header.maxRecords}`).join(', ')}`);
  const { bokl } = tb;
  const pgpl = db.table('PGPL'), pbpl = db.table('PBPL'), setl = db.table('SETL'), plys = db.table('PLYS');
  const setName = new Map(rowsWhere(setl, () => true).map((i) => [num(setl, i, 'SETL'), String(setl.get(i, 'name'))])), plays = playRows(db);
  const book = rowsWhere(pgpl, (i) => num(pgpl, i, 'BOKL') === bokl), nameOf = (i: number) => setName.get(num(pgpl, i, 'SETL')) ?? `SETL ${num(pgpl, i, 'SETL')}`;
  const bookName = new Map<number, string>(); { const t = bdb.table('PBPL'); for (let i = 0; i < t.recordCount; i++) bookName.set(num(t, i, 'PLYL'), String(t.get(i, 'name'))); }
  console.log(`  master view: ${book.length} PGPL rows (names below: per-book entry, then the master's when it differs)`);
  const sets = new Map<number, number>(); for (const i of book) sets.set(num(pgpl, i, 'SETL'), (sets.get(num(pgpl, i, 'SETL')) ?? 0) + 1);
  console.log(`  sets: ${[...sets].map(([s, n]) => `${setName.get(s) ?? '?'}(${s}) ${n}`).join(', ')}`);
  const want = opts.set?.trim().toLowerCase(), picked = want ? book.filter((i) => nameOf(i).toLowerCase().includes(want)) : book, count = opts.count ?? 12;
  if (want && !picked.length) throw new Error(`no set named like "${opts.set}" in this book`);
  console.log(`  the first ${Math.min(count, picked.length)} of ${picked.length} ${want ? `"${opts.set}" ` : ''}plays:`);
  for (const i of picked.slice(0, count)) {
    const plyl = num(pgpl, i, 'PLYL'), r = plays.get(plyl), bn = bookName.get(plyl), mn = r === undefined ? undefined : String(pbpl.get(r, 'name'));
    console.log(`  PLYL ${String(plyl).padStart(5)}  ${nameOf(i).padEnd(22)} ${(bn ?? '(not in the per-book entry)').padEnd(24)} ${mn !== undefined && mn !== bn ? `master "${mn}"`.padEnd(28) : ''.padEnd(28)} ${r === undefined ? '(no PBPL row)' : `PLYT ${String(pbpl.get(r, 'PLYT')).padStart(3)}`}  ord ${num(pgpl, i, 'ord_')}`);
    console.log(`         master routes: ${slotLine(plys, plyl) || '(none)'}`);
  }
}

// The poke, in the team's per-book entry of qkl_fe2ig.ast: rename the play (PBPL.name and PLYL.name) and, with a
// slot, push that slot's first code-8 step by `yards` (val1 in eighths of a yard, as the master's data fits) and move
// every drawn art segment 3 `yards` feet up-screen (ay is screen-down positive).
export function playbookPokeBook(rpcs3: string, o: PokeOpts & { team?: string }): void {
  if (o.name.length > BOOK_NAME_CHARS) throw new Error(`--name is ${o.name.length} characters; a per-book play name holds ${BOOK_NAME_CHARS}`);
  const tb = teamBook(rpcs3, o.team), t = tb.entry;
  const cur = readEntry(t), before = cur.bytes, db = parseTdb(new Uint8Array(before));
  console.log(`${tb.team}: TOPB ${tb.topb} -> "${tb.bname}" (BOKL ${tb.bokl}), entry PLAYBOOK_${tb.pban} = ${t.hash.toString(16)} in ${t.archive}: at ${cur.off}, ${before.length} bytes, sha ${cur.sha.slice(0, 12)}`);
  // the play's names (PBPL is the play list the picker shows, PLYL the play itself)
  for (const tn of ['PBPL', 'PLYL']) {
    const tbl = db.table(tn), rows = rowsWhere(tbl, (i) => num(tbl, i, 'PLYL') === o.plyl);
    if (rows.length !== 1) throw new Error(rows.length ? `PLYL ${o.plyl} has ${rows.length} ${tn} rows in this book` : `no play PLYL ${o.plyl} in this book's ${tn}`);
    const oldName = String(tbl.get(rows[0]!, 'name')); tbl.set(rows[0]!, 'name', o.name);
    console.log(`${tn} row ${rows[0]}: name "${oldName}" -> "${o.name}"${tn === 'PLYL' ? ` (PLYT ${num(tbl, rows[0]!, 'PLYT')}, SETL ${num(tbl, rows[0]!, 'SETL')})` : ''}`);
  }
  const yards = o.yards ?? 5;
  if (o.slot !== undefined) {
    const plys = db.table('PLYS'), sr = rowsWhere(plys, (i) => num(plys, i, 'PLYL') === o.plyl && num(plys, i, 'poso') === o.slot);
    if (sr.length !== 1) throw new Error(sr.length ? `PLYL ${o.plyl} poso ${o.slot} has ${sr.length} PLYS rows` : `PLYL ${o.plyl} has no PLYS row for poso ${o.slot} (slots: ${slotLine(plys, o.plyl) || 'none with a route'})`);
    const s = sr[0]!, psal = num(plys, s, 'PSAL'), artl = num(plys, s, 'ARTL');
    console.log(`PLYS row ${s}: poso ${o.slot}, PLRR ${num(plys, s, 'PLRR')}, program PSAL ${psal}, art ARTL ${artl}`);
    const sharedP = rowsWhere(plys, (i) => i !== s && num(plys, i, 'PSAL') === psal).length, sharedA = rowsWhere(plys, (i) => i !== s && num(plys, i, 'ARTL') === artl).length;
    if (sharedP) console.log(`warning: program PSAL ${psal} is shared by ${sharedP} other slot row(s) of this book; the nudge changes those plays too`);
    if (sharedA) console.log(`warning: art ARTL ${artl} is shared by ${sharedA} other slot row(s) of this book; the drawing changes for those too`);
    const prog = db.table('PSAL'), steps = rowsWhere(prog, (i) => num(prog, i, 'PSAL') === psal).sort((a, b) => num(prog, a, 'step') - num(prog, b, 'step'));
    if (!steps.length) throw new Error(`PSAL ${psal}: no steps`);
    const stepLine = (i: number) => `step ${num(prog, i, 'step')}: code ${String(num(prog, i, 'code')).padStart(3)}  val1 ${String(num(prog, i, 'val1')).padStart(4)}  val2 ${String(num(prog, i, 'val2')).padStart(4)}  val3 ${String(num(prog, i, 'val3')).padStart(4)}`;
    console.log(`PSAL program ${psal} before:`); for (const i of steps) console.log(`  ${stepLine(i)}`);
    const first8 = steps.find((i) => num(prog, i, 'code') === 8);
    if (first8 === undefined) throw new Error(`PSAL ${psal}: no code-8 step to push ${yards} yards`);
    setChecked(prog, first8, 'val1', num(prog, first8, 'val1') + yards * 8);
    console.log(`PSAL program ${psal} after (step ${num(prog, first8, 'step')} val1 ${yards >= 0 ? '+' : ''}${yards * 8} = ${yards} yd in eighths):`); for (const i of steps) console.log(`  ${stepLine(i)}`);
    const art = db.table('ARTL'), ar = rowsWhere(art, (i) => num(art, i, 'ARTL') === artl);
    if (ar.length !== 1) throw new Error(`ARTL ${artl}: ${ar.length} ARTL rows`);
    const a = ar[0]!, drawn = SEGMENTS.filter((g) => SEG_FIELDS.some((f) => num(art, a, `${f}${g}`) !== 0));
    const segLine = (g: string) => `seg ${g}: ${SEG_FIELDS.map((f) => `${f} ${num(art, a, `${f}${g}`)}`).join('  ')}`;
    console.log(`ARTL row ${a} (ARTL ${artl}) before:`); for (const g of drawn) console.log(`  ${segLine(g)}`);
    if (!drawn.length) throw new Error(`ARTL ${artl}: no drawn segment to move`);
    for (const g of drawn) setChecked(art, a, `ay${g}`, num(art, a, `ay${g}`) - yards * 3);
    console.log(`ARTL row ${a} after (every segment ay ${-yards * 3 >= 0 ? '+' : ''}${-yards * 3} ft):`); for (const g of drawn) console.log(`  ${segLine(g)}`);
  }
  const out = serializeTdb(db, { padTo: before.length });
  if (out.length !== before.length) throw new Error(`the rewrite is ${out.length} bytes, not ${before.length}; nothing written`);
  const problems = verifyTdb(out, db); if (problems.length) throw new Error(`the rewrite does not verify: ${JSON.stringify(problems.slice(0, 3))}; nothing written`);
  let changed = 0; for (let i = 0; i < out.length; i++) if (out[i] !== before[i]) changed++;
  console.log(`rewrite: ${out.length} bytes, verifies, ${changed} byte(s) differ from the current entry`);
  if (!changed) { console.log('nothing to write'); return; }
  if (o.dryRun) { console.log('dry run: nothing written'); return; }
  if (rpcs3RunningOver([t.archive])) throw new Error('RPCS3 is running from this install: close RPCS3 before touching the game archives');
  const dir = newEntryBackupDir('playbook');
  const r = rewriteEntry(t, out, dir, { replaces: [cur.sha], tool: 'ncaa-bridge playbook poke-book', note: `${tb.team} book "${tb.bname}" PLYL ${o.plyl} -> "${o.name}"${o.slot !== undefined ? `, poso ${o.slot} ${yards >= 0 ? '+' : ''}${yards} yd` : ''}` });
  console.log(`${t.archive}: ${r.status}: ${r.note}`);
  if (r.item) console.log(`backup: ${dir}\nundo:   ncaa-bridge playbook restore --backup "${dir}"`);
}

export interface PokeOpts { plyl: number; name: string; slot?: number; yards?: number; dryRun?: boolean }
export function playbookPoke(rpcs3: string, o: PokeOpts): void {
  const archive = miscArchive(rpcs3), t: EntryTarget = { archive, hash: PLAYBOOK_DB_HASH };
  const cur = readEntry(t), before = cur.bytes, db = parseTdb(new Uint8Array(before)); // the parse works on its own copy
  console.log(`${archive}: entry at ${cur.off}, ${before.length} bytes, sha ${cur.sha.slice(0, 12)} ${cur.sha === STOCK_PLAYBOOK_DB_SHA ? '(stock)' : '(changed from stock)'}`);
  // the play's name
  const pbpl = db.table('PBPL'), pr = rowsWhere(pbpl, (i) => num(pbpl, i, 'PLYL') === o.plyl);
  if (pr.length !== 1) throw new Error(pr.length ? `PLYL ${o.plyl} has ${pr.length} PBPL rows` : `no play PLYL ${o.plyl} in PBPL`);
  const row = pr[0]!, oldName = String(pbpl.get(row, 'name'));
  pbpl.set(row, 'name', o.name);
  console.log(`PBPL row ${row} (PLYL ${o.plyl}, PLYT ${num(pbpl, row, 'PLYT')}, SETL ${num(pbpl, row, 'SETL')}): name "${oldName}" -> "${o.name}"`);
  // one slot's route, deeper by --yards
  const yards = o.yards ?? 5;
  if (o.slot !== undefined) {
    const plys = db.table('PLYS'), sr = rowsWhere(plys, (i) => num(plys, i, 'PLYL') === o.plyl && num(plys, i, 'poso') === o.slot);
    if (sr.length !== 1) throw new Error(sr.length ? `PLYL ${o.plyl} poso ${o.slot} has ${sr.length} PLYS rows` : `PLYL ${o.plyl} has no PLYS row for poso ${o.slot} (slots: ${slotLine(plys, o.plyl) || 'none with a route'})`);
    const s = sr[0]!, psal = num(plys, s, 'PSAL'), artl = num(plys, s, 'ARTL');
    console.log(`PLYS row ${s}: poso ${o.slot}, PLRR ${num(plys, s, 'PLRR')}, program PSAL ${psal}, art ARTL ${artl}`);
    const sharedP = rowsWhere(plys, (i) => i !== s && num(plys, i, 'PSAL') === psal).length, sharedA = rowsWhere(plys, (i) => i !== s && num(plys, i, 'ARTL') === artl).length;
    if (sharedP) console.log(`warning: program PSAL ${psal} is shared by ${sharedP} other slot row(s); the nudge changes those plays too`);
    if (sharedA) console.log(`warning: art ARTL ${artl} is shared by ${sharedA} other slot row(s); the drawing changes for those too`);
    // the program: val1 of the first code-8 step
    const pslo = db.table('PSLO'), steps = rowsWhere(pslo, (i) => num(pslo, i, 'PSAL') === psal).sort((a, b) => num(pslo, a, 'step') - num(pslo, b, 'step'));
    if (!steps.length) throw new Error(`PSAL ${psal}: no PSLO steps`);
    const stepLine = (i: number) => `step ${num(pslo, i, 'step')}: code ${String(num(pslo, i, 'code')).padStart(3)}  val1 ${String(num(pslo, i, 'val1')).padStart(4)}  val2 ${String(num(pslo, i, 'val2')).padStart(4)}  val3 ${String(num(pslo, i, 'val3')).padStart(4)}`;
    console.log(`PSLO program ${psal} before:`); for (const i of steps) console.log(`  ${stepLine(i)}`);
    const first8 = steps.find((i) => num(pslo, i, 'code') === 8);
    if (first8 === undefined) throw new Error(`PSAL ${psal}: no code-8 step to push ${yards} yards`);
    // the stock data fits val1 = eighths of a yard (a route's legs add up to the art's end point with val1/8): +N yards = +8N
    setChecked(pslo, first8, 'val1', num(pslo, first8, 'val1') + yards * 8);
    console.log(`PSLO program ${psal} after (step ${num(pslo, first8, 'step')} val1 ${yards >= 0 ? '+' : ''}${yards * 8} = ${yards} yd in eighths):`); for (const i of steps) console.log(`  ${stepLine(i)}`);
    // the art: the last drawn segment's end, 3 feet per yard, screen-down positive
    const arto = db.table('ARTO'), ar = rowsWhere(arto, (i) => num(arto, i, 'ARTL') === artl);
    if (ar.length !== 1) throw new Error(`ARTL ${artl}: ${ar.length} ARTO rows`);
    const a = ar[0]!, acnt = num(arto, a, 'acnt');
    const drawn = SEGMENTS.filter((g) => SEG_FIELDS.some((f) => num(arto, a, `${f}${g}`) !== 0));
    const segLine = (g: string) => `seg ${g}: ${SEG_FIELDS.map((f) => `${f} ${num(arto, a, `${f}${g}`)}`).join('  ')}`;
    console.log(`ARTO row ${a} (ARTL ${artl}, acnt ${acnt}${drawn.length !== acnt ? `, ${drawn.length} segments drawn` : ''}) before:`); for (const g of drawn) console.log(`  ${segLine(g)}`);
    const last = drawn[drawn.length - 1]; if (!last) throw new Error(`ARTL ${artl}: no drawn segment to move`);
    setChecked(arto, a, `ay${last}`, num(arto, a, `ay${last}`) - yards * 3);
    console.log(`ARTO row ${a} after (seg ${last} ay ${-yards * 3 >= 0 ? '+' : ''}${-yards * 3} ft):`); for (const g of drawn) console.log(`  ${segLine(g)}`);
  }
  // re-serialise at the same length and verify
  const out = serializeTdb(db, { padTo: before.length });
  if (out.length !== before.length) throw new Error(`the rewrite is ${out.length} bytes, not ${before.length}; nothing written`);
  const problems = verifyTdb(out, db); if (problems.length) throw new Error(`the rewrite does not verify: ${JSON.stringify(problems.slice(0, 3))}; nothing written`);
  let changed = 0; for (let i = 0; i < out.length; i++) if (out[i] !== before[i]) changed++;
  console.log(`rewrite: ${out.length} bytes, verifies, ${changed} byte(s) differ from the current entry`);
  if (!changed) { console.log('nothing to write'); return; }
  if (o.dryRun) { console.log('dry run: nothing written'); return; }
  if (rpcs3RunningOver([archive])) throw new Error('RPCS3 is running from this install: close RPCS3 before touching the game archives');
  const dir = newEntryBackupDir('playbook');
  const r = rewriteEntry(t, out, dir, { replaces: [cur.sha], tool: 'ncaa-bridge playbook poke', note: `PLYL ${o.plyl} "${oldName}" -> "${o.name}"${o.slot !== undefined ? `, poso ${o.slot} ${yards >= 0 ? '+' : ''}${yards} yd` : ''}` });
  console.log(`${archive}: ${r.status}: ${r.note}`);
  if (r.item) console.log(`backup: ${dir}\nundo:   ncaa-bridge playbook restore --backup "${dir}"`);
}

// The site's view of the team's book (the per-book entry with the shared special-teams data), as the Playbook page shows it
export function teamBookView(rpcs3: string, tb: TeamBook): { book: TdbFile; view: NonNullable<ReturnType<typeof extractBook>>; shared: { boot: TdbFile; master: TdbFile } } {
  const book = parseTdb(new Uint8Array(readEntry(tb.entry).bytes));
  const shared = { boot: parseTdb(new Uint8Array(readEntry({ archive: bootArchive(rpcs3), hash: BASE_DB_HASH }).bytes)), master: parseTdb(new Uint8Array(readEntry({ archive: miscArchive(rpcs3), hash: PLAYBOOK_DB_HASH }).bytes)) };
  const view = extractBook(new PlaybookDb(book, tb.bokl, shared), tb.bokl, { bgid: tb.topb, side: 'off', name: tb.bname });
  if (!view) throw new Error(`${tb.team}: the per-book entry PLAYBOOK_${tb.pban} has no plays`);
  return { book, view, shared };
}

// In-game check E1: one drawn play (a DrawnPlay JSON, as the site's creator saves it) compiled and appended to the team's
// own book entry, written by appendEntry (the entry grows). The play takes the next free id from CUSTOM_ID_BASE.
export interface AddPlayOpts { team?: string; set: string; draw: string; name?: string; ord?: number; dryRun?: boolean }
export function playbookAddPlay(rpcs3: string, o: AddPlayOpts): void {
  const tb = teamBook(rpcs3, o.team), t = tb.entry;
  const { book, view } = teamBookView(rpcs3, tb);
  const sets = view.formations.flatMap((f) => f.sets.map((s) => ({ f, s })));
  const want = o.set.trim().toLowerCase();
  const hit = sets.filter(({ s }) => String(s.id) === want || s.n.toLowerCase() === want || s.n.toLowerCase().includes(want));
  if (hit.length !== 1) throw new Error(hit.length ? `--set "${o.set}" matches ${hit.length} sets: ${hit.map(({ f, s }) => `${f.n} / ${s.n} (${s.id})`).join(', ')}` : `no set "${o.set}" in ${tb.team}'s ${tb.bname}; sets: ${sets.map(({ s }) => `${s.n} (${s.id})`).join(', ')}`);
  const set: SetDef = hit[0]!.s;
  const draw = JSON.parse(readFileSync(o.draw, 'utf8')) as DrawnPlay;
  if (!draw || typeof draw !== 'object' || !Array.isArray(draw.slots)) throw new Error(`${o.draw}: not a drawn play (needs n, t, set, slots[])`);
  draw.set = set.id; if (o.name) draw.n = o.name;
  let compiled; try { compiled = compileDrawn(draw, set); } catch (e) { if (e instanceof CompileError) throw new Error(`the drawing does not compile:\n  ${e.problems.join('\n  ')}`); throw e; }
  const taken = new Set(Object.keys(view.plays).map(Number)); let plyl = CUSTOM_ID_BASE; while (taken.has(plyl)) plyl++;
  console.log(`${tb.team}: ${hit[0]!.f.n} / ${set.n} (SETL ${set.id}) in "${tb.bname}" (entry PLAYBOOK_${tb.pban}, ${readEntry(t).bytes.length} bytes)`);
  const site = compiledToBook(compiled);
  console.log(`play "${compiled.name}" -> PLYL ${plyl}, PLYT ${compiled.plyt}, ${compiled.slots.length} slots${compiled.prog ? `, progression ${JSON.stringify(compiled.prog)}` : ''}${compiled.hole !== undefined ? `, hole ${compiled.hole}` : ''}`);
  for (const [i, s] of compiled.slots.entries()) console.log(`  slot ${s.poso} ${(set.slots[i]?.pos ?? '?')}: ${site.asg[i]!.k.padEnd(7)} role ${String(s.role).padStart(3)}  steps ${s.steps.map((x) => `${x[0]}(${x[1]},${x[2]},${x[3]})`).join(' ')}${site.asg[i]!.p ? `  path ${JSON.stringify(site.asg[i]!.p)}` : ''}`);
  const before = book.tables.map((x) => `${x.name.replace(/\0/g, '')} ${x.recordCount}`).join(', ');
  let added; try { added = addPlays(book, [{ plyl, setl: set.id, compiled, ...(o.ord ? { ord: o.ord } : {}) }]); } catch (e) { if (e instanceof BookWriteError) throw new Error(`the book cannot take the play:\n  ${e.problems.join('\n  ')}`); throw e; }
  const a = added[0]!;
  console.log(`rows: PBPL id ${a.pbpl}, programs ${a.psal.join(',')} (${a.newPrograms} new), art ${a.artl.join(',')} (${a.newArt} new)`);
  console.log(`tables before: ${before}\ntables after:  ${book.tables.map((x) => `${x.name.replace(/\0/g, '')} ${x.recordCount}`).join(', ')}`);
  const out = serializeTdb(book);
  const problems = verifyTdb(out, book); if (problems.length) throw new Error(`the rewrite does not verify: ${JSON.stringify(problems.slice(0, 3))}; nothing written`);
  // the written entry must extract to the same site assignments the compiler reported
  const check = extractBook(new PlaybookDb(parseTdb(new Uint8Array(out)), tb.bokl, teamBookView(rpcs3, tb).shared), tb.bokl, { bgid: tb.topb, side: 'off', name: tb.bname })!;
  const got = check.plays[String(plyl)]; const same = got && JSON.stringify(got.a.map((i) => check.asg[i])) === JSON.stringify(JSON.parse(JSON.stringify(site.asg)));
  if (!same) throw new Error('the rewritten book does not re-extract to the compiled play; nothing written');
  console.log(`rewrite: ${out.length} bytes (was ${readEntry(t).bytes.length}), verifies, re-extracts to the compiled play`);
  if (o.dryRun) { console.log('dry run: nothing written'); return; }
  if (rpcs3RunningOver([t.archive])) throw new Error('RPCS3 is running from this install: close RPCS3 before touching the game archives');
  const dir = newEntryBackupDir('playbook');
  const r = appendEntry(t, out, dir, { tool: 'ncaa-bridge playbook add-play', note: `${tb.team} book "${tb.bname}": + "${compiled.name}" (PLYL ${plyl}) in ${set.n}` });
  console.log(`${t.archive}: ${r.status}: ${r.note}`);
  if (r.item) console.log(`backup: ${dir}\nundo:   ncaa-bridge playbook restore --backup "${dir}"`);
}

// ---- a team's private book: the composed book in an unused book's entry, that book's list row renamed, TOPB pointed ----
// (the slot map, the list rename and the TOPB write live in playbook-pack.ts, shared with FCS-online.exe)
// a book's compiled DB by its BOKL (PLAB.PBGI -> PBAN -> qkl_fe2ig.ast PLAYBOOK_<PBAN>)
export function bookDbByBokl(rpcs3: string, bokl: number): { pban: string; row: Record<string, number | string>; db: TdbFile } {
  const row = plabRows(rpcs3).find((r) => Number(r.PBGI) === bokl); if (!row) throw new Error(`no PLAB row with PBGI ${bokl}`);
  const pban = String(row.PBAN); return { pban, row, db: parseTdb(new Uint8Array(readEntry({ archive: fe2igArchive(rpcs3), hash: playbookEntryHash(pban) }).bytes)) };
}
// every BGID some team uses (roster save + default roster) or some private slot already took
export function usedBookIds(rpcs3: string, map = readPrivateMap()): Set<number> {
  const used = new Set<number>();
  for (const t of dbTargets(rpcs3)) { let db: TdbFile; try { db = parseTdb(new Uint8Array(t.kind === 'file' ? readFileSync(t.path) : readEntry({ archive: t.path, hash: t.hash! }).bytes)); } catch { continue; } for (const r of db.table('TEAM').rows()) { used.add(Number(r.TOPB)); used.add(Number(r.TDPB)); } }
  for (const s of Object.values(map)) used.add(s.bgid);
  return used;
}
const sharedData = (rpcs3: string) => ({ boot: parseTdb(new Uint8Array(readEntry({ archive: bootArchive(rpcs3), hash: BASE_DB_HASH }).bytes)), master: parseTdb(new Uint8Array(readEntry({ archive: miscArchive(rpcs3), hash: PLAYBOOK_DB_HASH }).bytes)) });
const checkEdits = (edits: unknown, where: string): BookEdits => { const e = edits as BookEdits; if (!e || typeof e !== 'object' || e.v !== 1 || !Number.isInteger(e.base) || !Array.isArray(e.formations)) throw new Error(`${where}: not a BookEdits value (v 1, base, name, formations[], custom{})`); return e; };

export interface PrivateWriteOpts { team: string | number; edits: BookEdits; scope?: string; donor?: number; dryRun?: boolean; tool?: string; mapFile?: string; log?: (s: string) => void }
export interface PrivateWriteResult { team: string; tgid: number; key: string; slot: PrivateSlot; name: string; sha: string; size: number; book: 'written' | 'already' | 'dry-run'; backup?: string }
// The team's edits composed and written as its private book: the slot's entry (appendEntry: written / already), both
// PLAB copies renamed, TOPB pointed in the roster save and the default roster (only off the base book or the slot
// itself), the slot recorded. Throws before anything is written when the edits do not compose or RPCS3 is running.
export function writePrivateBook(rpcs3: string, o: PrivateWriteOpts): PrivateWriteResult {
  const log = o.log ?? ((s: string) => console.log(s)), mapFile = o.mapFile ?? PRIVATE_BOOKS_FILE;
  const tb = teamBook(rpcs3, o.team), edits = checkEdits(o.edits, `${tb.team}'s edits`);
  const name = String(edits.name ?? '').trim(); if (!name) throw new Error(`${tb.team}: the edits carry no book name`);
  const bname = name.length > PLAB_NAME_CHARS ? name.slice(0, PLAB_NAME_CHARS) : name;
  const rows = plabRows(rpcs3), baseRow = rows.find((x) => Number(x.PBGI) === edits.base && Number(x.BOFF) === 1);
  if (!baseRow) throw new Error(`${tb.team}: the edits start from book ${edits.base}, which is no offensive PLAB row`);
  const base = { bokl: edits.base, bgid: Number(baseRow.BGID) };
  // the books: the base and every borrowed one, from their compiled entries
  const books = new Map<number, TdbFile>(); for (const id of booksNeeded(edits)) books.set(id, bookDbByBokl(rpcs3, id).db);
  const r = composeBookDb({ edits, books, shared: sharedData(rpcs3) }), sha = sha256(r.bytes);
  log(`${tb.team} (TGID ${tb.tgid}, TOPB ${tb.topb} "${tb.bname}"): "${name}" composed from book ${edits.base}${booksNeeded(edits).length > 1 ? ` + ${booksNeeded(edits).filter((b) => b !== edits.base).join(', ')}` : ''}: ${r.composed.formations.length} formations, ${Object.keys(r.composed.plays).length} plays, ${r.added.length} drawn; ${r.bytes.length} bytes, sha ${sha.slice(0, 12)}`);
  for (const n of r.notes) log(`  ${n}`);
  // the slot: the one this team already has, the one asked for, or the lowest unused offensive book
  const key = slotKey(o.scope ?? 'local', tb.tgid, 'off'), map = readPrivateMap(mapFile);
  let slot = map[key];
  if (o.donor !== undefined && slot && slot.bgid !== o.donor) throw new Error(`${key} already has book BGID ${slot.bgid} (${slot.donor}); --donor ${o.donor} would leave it behind`);
  if (!slot) {
    const used = usedBookIds(rpcs3, map);
    const cand = o.donor !== undefined ? rows.filter((x) => Number(x.BGID) === o.donor && Number(x.BOFF) === 1) : rows.filter((x) => Number(x.BOFF) === 1 && !used.has(Number(x.BGID))).sort((a, b) => Number(a.BGID) - Number(b.BGID));
    if (!cand.length) throw new Error(o.donor !== undefined ? `BGID ${o.donor} is not an offensive PLAB row` : 'no unused offensive book left');
    if (o.donor !== undefined && used.has(o.donor)) throw new Error(`BGID ${o.donor} is in use (a team's TOPB or another private slot)`);
    const d = cand[0]!, pban = String(d.PBAN);
    slot = { bgid: Number(d.BGID), bokl: Number(d.PBGI), pban, donor: String(d.BNAM), name: bname, at: new Date().toISOString(), donorSha: readEntry({ archive: fe2igArchive(rpcs3), hash: playbookEntryHash(pban) }).sha };
  }
  const entry = { archive: fe2igArchive(rpcs3), hash: playbookEntryHash(slot.pban) }, cur = readEntry(entry);
  const donorRow = rows.find((x) => Number(x.BGID) === slot!.bgid)!;
  log(`slot: PLAB BGID ${slot.bgid} (BOKL ${slot.bokl}, entry PLAYBOOK_${slot.pban}, ${cur.bytes.length} bytes) "${donorRow.BNAM}" -> "${bname}"; TEAM.TOPB -> ${slot.bgid} (from ${base.bgid}) in ${dbTargets(rpcs3).map((t) => t.label).join(' and ')}`);
  if (o.dryRun) { log(cur.sha === sha ? 'dry run: the slot already holds this book' : 'dry run: nothing written'); return { team: tb.team, tgid: tb.tgid, key, slot, name: bname, sha, size: r.bytes.length, book: 'dry-run' }; }
  const archives = [fe2igArchive(rpcs3), bootArchive(rpcs3), miscArchive(rpcs3)];
  if (rpcs3RunningOver(archives)) throw new Error('RPCS3 is running from this install: close RPCS3 before touching the game archives');
  const dir = newEntryBackupDir('playbook'), tool = o.tool ?? 'ncaa-bridge playbook private';
  // 1. the book into the slot's entry
  const w = appendEntry(entry, r.bytes, dir, { tool, note: `${tb.team} "${name}" into PLAYBOOK_${slot.pban} (BGID ${slot.bgid})` });
  log(`qkl_fe2ig.ast: ${w.status}: ${w.note}`);
  // 2. the list rows renamed (both PLAB copies), in place; 3. the team's TOPB in the roster save and the default roster
  for (const x of renameBookRows(rpcs3, [{ bgid: slot.bgid, name: bname }], dir, tool)) log(`${x.label}: ${x.outcome.status}: ${x.outcome.note}`);
  for (const n of pointTeamBooks(rpcs3, [{ tgid: tb.tgid, side: 'off', bgid: slot.bgid, from: [base.bgid], name: bname }], dir)) log(n);
  const history = [...new Set([...(slot.history ?? []), ...(slot.sha && slot.sha !== sha ? [slot.sha] : [])])].filter((x) => x !== sha);
  // a `taken` recorded for the stock book (the slot was released) no longer says anything about the slot's own book
  map[key] = { ...slot, name: bname, at: new Date().toISOString(), base, sha, history, released: false, ...(slot.taken && slot.taken.bgid !== slot.bgid ? { taken: undefined } : {}) };
  writePrivateMap(map, mapFile);
  log(`slot recorded in ${mapFile} as ${key}${w.item ? `\nbackup: ${dir}\nundo:   ncaa-bridge playbook restore --backup "${dir}"` : ''}`);
  return { team: tb.team, tgid: tb.tgid, key, slot: map[key]!, name: bname, sha, size: r.bytes.length, book: w.status === 'written' ? 'written' : 'already', ...(w.item ? { backup: dir } : {}) };
}
// A team that reset its edits: TOPB back to the base book (roster save, default roster; only off the slot), the slot kept
// for the team (released) so the dynasty-file copy points its console back too (pendingBookPointers).
export function releasePrivateBook(rpcs3: string, key: string, o: { dryRun?: boolean; mapFile?: string; log?: (s: string) => void } = {}): boolean {
  const log = o.log ?? ((s: string) => console.log(s)), mapFile = o.mapFile ?? PRIVATE_BOOKS_FILE, map = readPrivateMap(mapFile), s = map[key];
  if (!s || s.released) return false;
  const want = slotTarget(key, { ...s, released: true }); if (!want) { log(`${key}: no base recorded, cannot point the team back`); return false; }
  log(`${key}: the team reset its book; TOPB ${s.bgid} ("${s.name}") -> ${want.bgid} (the stock book)`);
  if (o.dryRun) { log('dry run: nothing written'); return false; }
  if (rpcs3RunningOver([rosterSavePath(rpcs3), bootArchive(rpcs3)])) throw new Error('RPCS3 is running from this install: close RPCS3 before touching the rosters');
  const dir = newEntryBackupDir('playbook');
  for (const n of pointTeamBooks(rpcs3, [want], dir)) log(n);
  map[key] = { ...s, released: true, at: new Date().toISOString(), taken: undefined }; writePrivateMap(map, mapFile);
  return true;
}

export interface PrivateOpts { team?: string; edits: string; scope?: string; donor?: number; dryRun?: boolean }
export function playbookPrivate(rpcs3: string, o: PrivateOpts): void {
  const edits = checkEdits(JSON.parse(readFileSync(o.edits, 'utf8')), o.edits);
  writePrivateBook(rpcs3, { team: o.team ?? 'Holy Cross', edits, scope: o.scope, donor: o.donor, dryRun: o.dryRun });
}

// ---- the site's pending edits, per online dynasty, written as private books and acked ----
interface PendingPlaybookEdit { id: number; tgid: number; side: BookSide; edits: unknown; note?: string | null; updatedAt?: string }
interface WebEditsPlaybooks { playbooks?: PendingPlaybookEdit[]; playbookTeams?: { tgid: number; side: BookSide }[] }
export interface SyncOpts { did?: number; dryRun?: boolean; mapFile?: string }
export async function playbookSync(cfg: BridgeConfig, rpcs3: string, o: SyncOpts = {}): Promise<{ written: number; already: number; released: number; failed: number; pendingDef: number }> {
  const store = loadOdStore(cfg.odDir), api = new WorkerApi(cfg), tally = { written: 0, already: 0, released: 0, failed: 0, pendingDef: 0 };
  const list = Object.values(store.dynasties).filter((d) => (o.did === undefined || d.id === o.did) && d.fileId);
  if (!list.length) { console.log(o.did === undefined ? `no online dynasty with a file in ${cfg.odDir}` : `no dynasty DID ${o.did} with a file in ${cfg.odDir}`); return tally; }
  for (const d of list) {
    const res = await api.json<WebEditsPlaybooks>('GET', `/api/bridge/web-edits?od=${d.id}`);
    const pending = res.playbooks ?? [], teams = res.playbookTeams ?? [], scope = dynastyScope(d.id);
    console.log(`DID ${d.id}: ${pending.length} pending book edit(s), ${teams.length} team book(s) on the site`);
    for (const e of pending) {
      if (e.side !== 'off') { tally.pendingDef++; console.log(`  team ${e.tgid} defense: the console side for defensive books is not built yet (Supersim uses them); left pending`); continue; }
      try {
        const r = writePrivateBook(rpcs3, { team: e.tgid, edits: e.edits as BookEdits, scope, dryRun: o.dryRun, tool: 'ncaa-bridge playbook sync', mapFile: o.mapFile, log: (s) => console.log(`  ${s}`) });
        if (r.book === 'dry-run') continue;
        tally[r.book]++;
        await api.json('POST', `/api/bridge/web-edits/${e.id}/delivered?kind=playbook`, { sha: r.sha });
        console.log(`  ${r.team}: "${r.name}" ${r.book === 'written' ? 'written' : 'already on the console'} (BGID ${r.slot.bgid}); acked with sha ${r.sha.slice(0, 12)}`);
      } catch (err) { tally.failed++; console.error(`  team ${e.tgid}: ${(err as Error).message}`); }
    }
    // teams whose edits are gone from the site: their consoles go back to the stock book
    for (const key of Object.keys(readPrivateMap(o.mapFile))) {
      const k = parseSlotKey(key); if (!k || k.scope !== scope || teams.some((t) => t.tgid === k.tgid && t.side === k.side)) continue;
      try { if (releasePrivateBook(rpcs3, key, { dryRun: o.dryRun, mapFile: o.mapFile, log: (s) => console.log(`  ${s}`) })) tally.released++; } catch (err) { tally.failed++; console.error(`  ${key}: ${(err as Error).message}`); }
    }
  }
  console.log(`${o.dryRun ? 'dry run: ' : ''}${tally.written} written, ${tally.already} already current, ${tally.released} pointed back at the stock book, ${tally.failed} failed${tally.pendingDef ? `, ${tally.pendingDef} defensive edit(s) left pending` : ''}${tally.written || tally.released ? '\nnext: build a release (installer/build.mjs) so every member gets the same books; od watch points the dynasty files' : ''}`);
  return tally;
}

// the pack a release ships (installer/build.mjs runs this): manifest JSON + the entries' bytes
export function playbookExport(rpcs3: string, o: { out: string; blob: string }): void {
  const { manifest, blob } = exportPlaybookPack(rpcs3);
  writeFileSync(o.out, JSON.stringify(manifest)); writeFileSync(o.blob, blob);
  for (const s of manifest.skipped) console.log(`skipped: ${s}`);
  console.log(`playbooks exported: ${manifest.books.length} book(s), ${blob.length} bytes: ${packSummary(manifest)}`);
}

// rewriteDb's backups (USR-DATA.orig / qkl_boot.<off>.orig + .json) put back, after the archive entries of the manifest
function restoreDbBackups(dir: string): string[] {
  const notes: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.orig.json'))) {
    const m = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { target: string; path: string; off: number; len: number }; const orig = readFileSync(join(dir, f.replace(/\.json$/, '')));
    if (orig.length !== m.len) throw new Error(`${f}: backup is ${orig.length} bytes, manifest says ${m.len}`);
    const fd = openSync(m.path, 'r+'); try { writeSync(fd, orig, 0, orig.length, m.off); } finally { closeSync(fd); }
    notes.push(`${m.target}: ${m.len} bytes put back at ${m.off}`);
  }
  return notes;
}

export function playbookRestore(opts: { backup?: string; force?: boolean } = {}): void {
  let dir = opts.backup;
  if (!dir) { const all = existsSync(STDA_BACKUP_ROOT) ? readdirSync(STDA_BACKUP_ROOT).filter((d) => d.endsWith('-playbook') && existsSync(join(STDA_BACKUP_ROOT, d, 'manifest.json'))).sort() : []; if (!all.length) throw new Error(`no playbook backup under ${STDA_BACKUP_ROOT}`); dir = join(STDA_BACKUP_ROOT, all[all.length - 1]!); }
  const items = (JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as EntryManifest).items;
  if (rpcs3RunningOver(items.map((i) => i.archive))) throw new Error('RPCS3 is running from this install: close RPCS3 before touching the game archives');
  console.log(`restoring from ${dir}`);
  for (const n of restoreEntries(dir, { force: opts.force })) console.log(n);
  for (const n of restoreDbBackups(dir)) console.log(n);
}

export async function playbookCli(sub: string | undefined, flags: Map<string, string>, cfg?: () => BridgeConfig): Promise<void> {
  const rpcs3 = flags.get('rpcs3') ?? process.env.NCAA_RPCS3 ?? rpcs3RootFromConfig();
  const root = () => { if (!rpcs3) throw new Error('no RPCS3 folder: pass --rpcs3 DIR (or set rpcs3Root in ~/.ncaa-bridge/config.json)'); return rpcs3; };
  const int = (k: string) => { const v = Number(flags.get(k)); if (!Number.isInteger(v)) throw new Error(`--${k} needs a whole number`); return v; };
  if (sub === 'status' || sub === undefined) playbookStatus(root(), { team: flags.get('team'), set: flags.get('set'), count: flags.has('count') ? int('count') : undefined });
  else if (sub === 'poke' && flags.has('plyl') && flags.has('name')) playbookPoke(root(), { plyl: int('plyl'), name: flags.get('name')!, slot: flags.has('slot') ? int('slot') : undefined, yards: flags.has('yards') ? int('yards') : undefined, dryRun: flags.has('dry-run') });
  else if (sub === 'poke-book' && flags.has('plyl') && flags.has('name')) playbookPokeBook(root(), { plyl: int('plyl'), name: flags.get('name')!, slot: flags.has('slot') ? int('slot') : undefined, yards: flags.has('yards') ? int('yards') : undefined, dryRun: flags.has('dry-run'), team: flags.get('team') });
  else if (sub === 'add-play' && flags.has('set') && flags.has('draw')) playbookAddPlay(root(), { team: flags.get('team'), set: flags.get('set')!, draw: flags.get('draw')!, name: flags.get('name'), ord: flags.has('ord') ? int('ord') : undefined, dryRun: flags.has('dry-run') });
  else if (sub === 'private' && flags.has('edits')) playbookPrivate(root(), { team: flags.get('team'), edits: flags.get('edits')!, scope: flags.get('scope'), donor: flags.has('donor') ? int('donor') : undefined, dryRun: flags.has('dry-run') });
  else if (sub === 'sync') { if (!cfg) throw new Error('playbook sync needs the bridge config'); const t = await playbookSync(cfg(), root(), { did: flags.has('did') ? int('did') : undefined, dryRun: flags.has('dry-run') }); if (t.failed) process.exitCode = 1; }
  else if (sub === 'export' && flags.has('out') && flags.has('blob')) playbookExport(root(), { out: flags.get('out')!, blob: flags.get('blob')! });
  else if (sub === 'restore') playbookRestore({ backup: flags.get('backup'), force: flags.has('force') });
  else console.log('usage: ncaa-bridge playbook status [--team "Holy Cross"] [--set "5WR Trio"] [--count 12] | playbook poke --plyl N --name "ZZ TEST" [--slot P --yards 5] [--dry-run] | playbook poke-book --plyl N --name "ZZ TEST" [--slot P --yards 5] [--team "Holy Cross"] [--dry-run] | playbook add-play --set "5WR Trio" --draw play.json [--name "ZZ Drawn"] [--ord 1] [--team "Holy Cross"] [--dry-run] | playbook private --edits edits.json [--team "Holy Cross"] [--scope <dynasty>] [--donor BGID] [--dry-run] | playbook sync [--did N] [--dry-run] | playbook export --out pack.json --blob pack.bin | playbook restore [--backup DIR] [--force]   [--rpcs3 DIR]');
}
