// A team's edited book as a compiled per-book DB: the base book's DB (qkl_fe2ig.ast PLAYBOOK_<PBAN>) cloned, then the
// site's BookEdits applied row by row — formations and sets taken from other books copied in with their geometry,
// stock plays copied in with their programs and art, drawn plays compiled and appended (bookwrite.ts), the formation /
// set / play-list orders rewritten, dropped plays and sets removed from the lists, the CPU's weights and the audibles
// kept consistent. The result re-extracts (PlaybookDb + extractBook) to exactly what composeBook gives the site, which
// `composeBookDb` checks before returning: the console and Supersim run the same book by construction.
//
// Per-book tables touched: PBFM (book formations: ord_ within the FTYP menu group), FORM (formation families SETL.FORM
// points at), PBST (sets of the book: SETL, PBFM, ord_), SETL / SETP / SETG / SGF / SPKF / SPKG (set geometry and
// packages, copied whole for a set the base lacks), PLYL / PBPL / PLYS / PSAL / ARTL / PLPD / PLRD (plays), PBAI (CPU
// weights by PBPL id: rows of dropped plays go, copied plays bring theirs), PBAU (audibles by PBPL id: one that pointed
// at a dropped play is moved to the first play left in a set of the same formation type). Ids are the master's own and
// identical across books, so a row copied by id never collides with a different row.
import { parseTdb, serializeTdb, type TdbFile, type TdbTable } from '@ncaa/tdb';
import { addPlays, type AddPlayInput, type AddedPlay, BookWriteError } from './bookwrite.js';
import { compileDrawn, compiledToBook, CompileError } from './compile.js';
import { PlaybookDb, type PlaybookRow, type SharedPlaybookData } from './db.js';
import { extractBook } from './extract.js';
import { composeBook, isCustomRef, CUSTOM_ID_BASE, type BookEdits } from './model.js';
import type { Book } from './types.js';

type Row = PlaybookRow;
const num = (v: unknown) => Number(v);
const tableOf = (db: TdbFile, name: string): TdbTable => { const t = db.tables.find((x) => x.name.replace(/[\s\0]+$/, '') === name); if (!t) throw new Error(`no table ${name}`); return t; };
const rowsOf = (db: TdbFile, name: string): Row[] => [...tableOf(db, name).rows()] as Row[];
const groupBy = (rows: Row[], k: string) => { const m = new Map<number, Row[]>(); for (const r of rows) { const l = m.get(num(r[k])); if (l) l.push(r); else m.set(num(r[k]), [r]); } return m; };

export interface ComposeDbInput {
  edits: BookEdits;
  books: Map<number, TdbFile>; // the base and every `from` book, parsed
  shared: SharedPlaybookData; // boot base DB + master (special sets), as the extractor uses them
  side?: 'off' | 'def';
}
export interface ComposeDbResult { book: TdbFile; bytes: Uint8Array; composed: Book; added: AddedPlay[]; notes: string[] }

// the table's rows replaced by `rows`: grown when longer, shortened (zeroed tail, count lowered) when shorter
function rewrite(t: TdbTable, rows: Row[]): void {
  if (rows.length > t.header.maxRecords) t.growTable(rows.length);
  const fields = t.fields.map((f) => f.name);
  for (let i = 0; i < rows.length; i++) { if (i >= t.recordCount) t.appendRecord(); for (const k of fields) { const v = rows[i]![k]; if (v === undefined) throw new Error(`${t.name} row ${i} lacks ${k}`); t.set(i, k, v); } }
  if (rows.length < t.recordCount) { const L = t.header.lengthBytes; t.data.fill(0, rows.length * L, t.recordCount * L); t.header.currentRecords = rows.length; }
}

export function composeBookDb(input: ComposeDbInput): ComposeDbResult {
  const { edits, shared } = input, side = input.side ?? 'off', notes: string[] = [];
  const baseDb = input.books.get(edits.base); if (!baseDb) throw new Error(`base book ${edits.base} is not loaded`);
  // the site's view of every book, and the composed target
  const views = new Map<number, Book>();
  for (const [id, db] of input.books) { const v = extractBook(new PlaybookDb(db, id, shared), id, { bgid: 0, side, name: String(id) }); if (v) views.set(id, v); }
  const composed = composeBook(edits, views, { custom: (cid, draw, set) => { try { return compiledToBook(compileDrawn(draw, set)); } catch (e) { if (e instanceof CompileError) throw new Error(`custom play ${cid} "${draw.n}": ${e.problems.join('; ')}`); throw e; } } });
  // the shared special-teams sets (BSMO: field goal, kneel, spike, fakes) reach every book at run time: they are listed in
  // the site's view but never written into a per-book DB (no PBST / PBPL rows), unless the base itself lists one
  const special = new Set<number>(); if (shared.master) for (const r of rowsOf(shared.master, 'BSMO')) special.add(num(r.SETL));
  const baseSets = new Set(rowsOf(baseDb, 'PBST').map((r) => num(r.SETL)));
  const isShared = (setl: number) => special.has(setl) && !baseSets.has(setl) && ![...input.books.values()].some((b) => rowsOf(b, 'PBST').some((r) => num(r.SETL) === setl));
  // work on a copy of the base
  const book = parseTdb(serializeTdb(baseDb));
  const R = Object.fromEntries(['PBFM', 'FORM', 'PBST', 'SETL', 'SETP', 'SETG', 'SGF', 'SPKF', 'SPKG', 'PLYL', 'PBPL', 'PLYS', 'PSAL', 'ARTL', 'PLPD', 'PLRD', 'PBAI', 'PBAU'].map((n) => [n, rowsOf(book, n)])) as Record<string, Row[]>;
  const has = (name: string, k: string) => new Set(R[name]!.map((r) => num(r[k])));
  const copyRows = (name: string, src: TdbFile, pred: (r: Row) => boolean, key: string | null) => { const have = key ? has(name, key) : null; let n = 0; for (const r of rowsOf(src, name)) if (pred(r) && (!have || !have.has(num(r[key!])))) { R[name]!.push({ ...r }); have?.add(num(r[key!])); n++; } return n; };
  const copyProgramsAndArt = (src: TdbFile, plys: Row[]) => {
    const needP = new Set(plys.map((r) => num(r.PSAL))), needA = new Set(plys.map((r) => num(r.ARTL)));
    const haveP = has('PSAL', 'PSAL'), haveA = has('ARTL', 'ARTL');
    for (const r of rowsOf(src, 'PSAL')) if (needP.has(num(r.PSAL)) && !haveP.has(num(r.PSAL))) R.PSAL!.push({ ...r });
    for (const r of rowsOf(src, 'ARTL')) if (needA.has(num(r.ARTL)) && !haveA.has(num(r.ARTL))) R.ARTL!.push({ ...r });
  };
  // 1. formations and sets the base lacks: copy their geometry; sets of the base's own formations that the base lacks too
  const pbfmById = new Map(R.PBFM!.map((r) => [num(r.PBFM), r]));
  for (const f of edits.formations) {
    const srcId = f.from ?? edits.base, src = input.books.get(srcId)!;
    if (!pbfmById.has(f.id)) { const row = rowsOf(src, 'PBFM').find((r) => num(r.PBFM) === f.id); if (!row) throw new Error(`formation ${f.id} is not in book ${srcId}'s PBFM`); R.PBFM!.push({ ...row }); pbfmById.set(f.id, row); notes.push(`formation ${row.name} (${f.id}) copied from book ${srcId}`); }
    for (const s of f.sets) {
      if (isShared(s.id) || has('SETL', 'SETL').has(s.id)) continue;
      const setl = rowsOf(src, 'SETL').find((r) => num(r.SETL) === s.id); if (!setl) throw new Error(`set ${s.id} is not in book ${srcId}`);
      R.SETL!.push({ ...setl });
      copyRows('FORM', src, (r) => num(r.FORM) === num(setl.FORM), 'FORM');
      const setp = rowsOf(src, 'SETP').filter((r) => num(r.SETL) === s.id); R.SETP!.push(...setp.map((r) => ({ ...r })));
      const setpIds = new Set(setp.map((r) => num(r.SETP))); R.SETG!.push(...rowsOf(src, 'SETG').filter((r) => setpIds.has(num(r.SETP))).map((r) => ({ ...r })));
      R.SGF!.push(...rowsOf(src, 'SGF').filter((r) => num(r.SETL) === s.id).map((r) => ({ ...r })));
      const spkf = rowsOf(src, 'SPKF').filter((r) => num(r.SETL) === s.id); R.SPKF!.push(...spkf.map((r) => ({ ...r })));
      const spf = new Set(spkf.map((r) => num(r.SPF_))); copyRows('SPKG', src, (r) => spf.has(num(r.SPF_)), null);
      notes.push(`set ${setl.name} (${s.id}) copied from book ${srcId}`);
    }
  }
  // 2. stock plays the base lacks: copy the play, its slots, programs, art, progression, hole, CPU weights (by new PBPL id)
  const pbplOf = new Map(R.PBPL!.map((r) => [num(r.PLYL), r])); let nextPbpl = Math.max(0, ...R.PBPL!.map((r) => num(r.PBPL))) + 1;
  const pbstOfSet = new Map(R.PBST!.map((r) => [num(r.SETL), r]));
  const wantPlays = new Map<number, { setl: number; src: TdbFile }>();
  for (const f of edits.formations) for (const s of f.sets) if (!isShared(s.id)) for (const r of s.plays) if (!isCustomRef(r) && !wantPlays.has(num(r))) wantPlays.set(num(r), { setl: s.id, src: input.books.get(f.from ?? edits.base)! });
  for (const [plyl, { setl, src }] of wantPlays) {
    if (has('PLYL', 'PLYL').has(plyl)) continue;
    let from = src; if (!rowsOf(from, 'PLYL').some((r) => num(r.PLYL) === plyl)) { const other = [...input.books.values()].find((b) => rowsOf(b, 'PLYL').some((r) => num(r.PLYL) === plyl)); if (!other) throw new Error(`play ${plyl} is in no loaded book`); from = other; }
    const plylRow = rowsOf(from, 'PLYL').find((r) => num(r.PLYL) === plyl)!; R.PLYL!.push({ ...plylRow, SETL: setl });
    const plys = rowsOf(from, 'PLYS').filter((r) => num(r.PLYL) === plyl); R.PLYS!.push(...plys.map((r) => ({ ...r })));
    copyProgramsAndArt(from, plys);
    copyRows('PLPD', from, (r) => num(r.PLYL) === plyl, 'PLYL'); copyRows('PLRD', from, (r) => num(r.PLYL) === plyl, 'PLYL');
    const srcPbpl = rowsOf(from, 'PBPL').find((r) => num(r.PLYL) === plyl);
    const pbpl = nextPbpl++; const row: Row = { PKGE: 0, COMF: 0, PBPL: pbpl, PLYL: plyl, PBST: 0, ord_: 0, name: plylRow.name!, Flag: srcPbpl ? num(srcPbpl.Flag) : 0 };
    R.PBPL!.push(row); pbplOf.set(plyl, row);
    if (srcPbpl) for (const ai of rowsOf(from, 'PBAI').filter((r) => num(r.PBPL) === num(srcPbpl.PBPL))) R.PBAI!.push({ ...ai, PBPL: pbpl });
    notes.push(`play ${plylRow.name} (${plyl}) copied from book ${[...input.books.entries()].find(([, b]) => b === from)?.[0]}`);
  }
  // 3. drawn plays: compiled and appended with the ids composeBook gave them (first appearance order)
  const customIds = new Map<string, number>(); let next = CUSTOM_ID_BASE;
  for (const f of edits.formations) for (const s of f.sets) for (const r of s.plays) if (isCustomRef(r) && !customIds.has(r) && composed.plays[String(next)]) customIds.set(r, next++);
  // write the structural tables first (the plays' PBST links need the set rows), then add the drawn plays on the real tables
  // 4. PBFM order: the edits' order within each FTYP menu group; PBST: the edits' sets in order; both drop what is left out
  const ftypOf = new Map(R.PBFM!.map((r) => [num(r.PBFM), num(r.FTYP)]));
  const counters = new Map<number, number>(); const pbfmOut: Row[] = [];
  for (const f of edits.formations) { const row = pbfmById.get(f.id)!; const g = ftypOf.get(f.id)!; const ord = (counters.get(g) ?? 0) + 1; counters.set(g, ord); pbfmOut.push({ ...row, ord_: ord }); }
  for (const row of R.PBFM!) if (num(row.FTYP) === 4 && !pbfmOut.some((x) => num(x.PBFM) === num(row.PBFM))) pbfmOut.push(row); // the package pseudo-formation ("Normal", SETL 0 subs) stays
  let nextPbst = Math.max(0, ...R.PBST!.map((r) => num(r.PBST))) + 1; const pbstOut: Row[] = R.PBST!.filter((r) => num(r.SETL) === 0);
  for (const f of edits.formations) { let i = 0; for (const s of f.sets) {
    if (isShared(s.id)) continue;
    const old = pbstOfSet.get(s.id); const setl = R.SETL!.find((r) => num(r.SETL) === s.id)!;
    let pbst = old ? num(old.PBST) : 0; if (!old) { const srcRow = [...input.books.values()].flatMap((b) => rowsOf(b, 'PBST')).find((r) => num(r.SETL) === s.id); pbst = srcRow && !R.PBST!.some((r) => num(r.PBST) === num(srcRow.PBST)) ? num(srcRow.PBST) : nextPbst++; }
    pbstOut.push({ SETL: s.id, PBFM: f.id, PBST: pbst, ord_: ++i, name: setl.name! });
  } }
  const pbstIdOfSet = new Map(pbstOut.map((r) => [num(r.SETL), num(r.PBST)]));
  // 5. the play lists: per set in order; a stock play keeps its PBPL row (one per set it is listed in; a second listing
  // gets a row of its own), custom plays come from addPlays below
  const rowsOfPlay = new Map<number, Row[]>(); for (const r of R.PBPL!) { const l = rowsOfPlay.get(num(r.PLYL)); if (l) l.push(r); else rowsOfPlay.set(num(r.PLYL), [r]); }
  const pbplOut: Row[] = []; const keptPbpl = new Set<number>(); const pending: { set: number; ord: number; cid: string }[] = [];
  for (const f of edits.formations) for (const s of f.sets) {
    if (isShared(s.id)) { if (s.plays.some(isCustomRef)) throw new Error(`set ${s.id} is a shared special-teams set; drawn plays cannot go there`); continue; }
    let ord = 0; const pbst = pbstIdOfSet.get(s.id)!, seen = new Set<number>();
    for (const r of s.plays) {
      if (isCustomRef(r)) { if (customIds.has(r)) pending.push({ set: s.id, ord: ++ord, cid: r }); continue; }
      const plyl = num(r); if (seen.has(plyl)) continue; seen.add(plyl);
      const rows = rowsOfPlay.get(plyl) ?? []; const row = rows.find((x) => num(x.PBST) === pbst && !keptPbpl.has(num(x.PBPL))) ?? rows.find((x) => !keptPbpl.has(num(x.PBPL)));
      const id = row ? num(row.PBPL) : nextPbpl++; keptPbpl.add(id);
      const tmpl = row ?? rows[0] ?? { PKGE: 0, COMF: 0, PBPL: id, PLYL: plyl, PBST: pbst, ord_: 0, name: R.PLYL!.find((x) => num(x.PLYL) === plyl)?.name ?? '', Flag: 0 };
      pbplOut.push({ ...tmpl, PBPL: id, PLYL: plyl, PBST: pbst, ord_: ++ord });
    }
  }
  const pbaiOut = R.PBAI!.filter((r) => keptPbpl.has(num(r.PBPL)));
  // audibles pointing at a dropped play move to the first play left in a set of the same formation type
  const pbauOut = R.PBAU!.map((r) => { if (keptPbpl.has(num(r.PBPL))) return r; const ft = num(r.FTYP); const cand = pbplOut.find((p) => ftypOf.get(num(pbstOut.find((s) => num(s.PBST) === num(p.PBST))?.PBFM)) === ft); if (!cand) { notes.push(`audible ${r.PBAU} (type ${ft}) has no play left; kept as it was`); return r; } notes.push(`audible ${r.PBAU} moved to ${cand.name}`); return { ...r, PBPL: num(cand.PBPL) }; });
  const by = (k: string) => (a: Row, b: Row) => num(a[k]) - num(b[k]);
  R.PLYS!.sort(by('PSAL')); R.ARTL!.sort(by('ARTL')); R.PLYL!.sort(by('PLYL')); R.PLPD!.sort(by('PLYL')); R.PLRD!.sort(by('PLYL')); pbaiOut.sort(by('PBPL'));
  for (const [name, rows] of Object.entries({ PBFM: pbfmOut, FORM: R.FORM!, PBST: pbstOut, SETL: R.SETL!, SETP: R.SETP!, SETG: R.SETG!, SGF: R.SGF!, SPKF: R.SPKF!, SPKG: R.SPKG!, PLYL: R.PLYL!, PBPL: pbplOut, PLYS: R.PLYS!, PSAL: R.PSAL!, ARTL: R.ARTL!, PLPD: R.PLPD!, PLRD: R.PLRD!, PBAI: pbaiOut, PBAU: pbauOut })) rewrite(tableOf(book, name), rows);
  // 6. the drawn plays
  const adds: AddPlayInput[] = [];
  for (const p of pending) { const set = composed.formations.flatMap((f) => f.sets).find((s) => s.id === p.set)!; adds.push({ plyl: customIds.get(p.cid)!, setl: p.set, compiled: compileDrawn(edits.custom[p.cid]!, set), ord: p.ord }); }
  let added: AddedPlay[] = [];
  try { added = adds.length ? addPlays(book, adds) : []; } catch (e) { if (e instanceof BookWriteError) throw new Error(`drawn plays: ${e.problems.join('; ')}`); throw e; }
  // 7. the written book must re-extract to the composed book
  const bytes = serializeTdb(book);
  const check = extractBook(new PlaybookDb(parseTdb(new Uint8Array(bytes)), edits.base, shared), edits.base, { bgid: 0, side, name: edits.name });
  const diff = bookDiff(composed, check, special);
  if (diff.length) throw new Error(`the composed book does not re-extract to the site's book: ${diff.slice(0, 5).join('; ')}`);
  return { book, bytes, composed, added, notes };
}

// Differences that matter between the site's composed book and a book re-extracted from the DB: formations as a set
// (the game menus them by type group, the site in the edits' order), their sets in order with slots, each set's play
// list in order, every play's fields and assignments. The shared special-teams sets (`special`: field goal, kneel, spike,
// fakes) reach every console book whatever the edits say, so a console-only one is not a difference. The `ai` weights
// are not compared (the console's PBAI is the CPU's business), nor are id / bgid / name / side.
export function bookDiff(site: Book, console: Book | null, special = new Set<number>()): string[] {
  const out: string[] = [];
  if (!console) return ['no book extracted'];
  // the shared special sets sit where the game puts them, in its order, whatever the site lists: compared as a set of ids
  const own = (sets: { id: number }[]) => sets.filter((s) => !special.has(s.id)).map((s) => s.id);
  const cForms = console.formations.filter((f) => own(f.sets).length || site.formations.some((x) => x.id === f.id));
  const sIds = site.formations.map((f) => f.id).sort(), cIds = cForms.map((f) => f.id).sort();
  if (JSON.stringify(sIds) !== JSON.stringify(cIds)) out.push(`formations ${sIds.join(',')} vs ${cIds.join(',')}`);
  for (const f of site.formations) {
    const g = console.formations.find((x) => x.id === f.id); if (!g) continue;
    if (f.n !== g.n || f.t !== g.t) out.push(`formation ${f.id}: ${f.n}/${f.t} vs ${g.n}/${g.t}`);
    if (JSON.stringify(own(f.sets)) !== JSON.stringify(own(g.sets))) out.push(`formation ${f.id} sets ${own(f.sets).join(',')} vs ${own(g.sets).join(',')}`);
    const sSpecial = f.sets.filter((s) => special.has(s.id)).map((s) => s.id).sort(), cSpecial = g.sets.filter((s) => special.has(s.id)).map((s) => s.id).sort();
    for (const id of sSpecial) if (!cSpecial.includes(id)) out.push(`formation ${f.id}: special set ${id} missing on the console`);
    for (const s of f.sets) {
      const u = g.sets.find((x) => x.id === s.id); if (!u) continue;
      if (JSON.stringify(s.slots) !== JSON.stringify(u.slots)) out.push(`set ${s.id} slots differ`);
      if (JSON.stringify(s.plays) !== JSON.stringify(u.plays)) out.push(`set ${s.id} plays ${s.plays.join(',')} vs ${u.plays.join(',')}`);
    }
  }
  const norm = (b: Book, id: string) => { const p = b.plays[id]; if (!p) return null; return JSON.stringify({ n: p.n, t: p.t, sit: p.sit, f: p.f, v: p.v, h: p.h ?? null, prog: p.prog ?? null, a: p.a.map((i) => (i >= 0 ? b.asg[i] : null)) }); };
  for (const id of Object.keys(site.plays)) if (norm(site, id) !== norm(console, id)) out.push(`play ${id} "${site.plays[id]!.n}" differs${console.plays[id] ? '' : ' (missing)'}`);
  const extraPlays = new Set(console.formations.flatMap((f) => f.sets.filter((s) => special.has(s.id)).flatMap((s) => s.plays)));
  for (const id of Object.keys(console.plays)) if (!site.plays[id] && !extraPlays.has(Number(id))) out.push(`play ${id} "${console.plays[id]!.n}" is only in the console book`);
  return out;
}
