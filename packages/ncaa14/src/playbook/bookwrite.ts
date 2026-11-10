// Writing drawn plays into a compiled per-book DB (a qkl_fe2ig.ast PLAYBOOK_<PBAN> entry parsed by @ncaa/tdb): the
// rows a play needs are appended to the book's own tables, which grow (every stock table is full), so the entry gets
// longer and is written back by appending it to the archive and repointing its TOC record (bridge/src/archive-entry.ts).
//
// A play in a per-book DB: one PLYL row (the play: set, type, situation, flags, name), one PBPL row (its place in a set's
// play list: PBST of the set, ord_ 1-based), eleven PLYS rows (slot -> program PSAL, art ARTL, role PLRR), the PSAL rows
// of each program (code val1 val2 val3 per step, 255-terminated), one ARTL row per drawn art (12 segments, feet, screen-
// down positive; ARTL 0 is the shared empty art every blocker uses), a PLPD row when the play has a progression, a PLRD
// row for a run's hole. No PBAI row: the console's CPU never calls a custom play, humans pick it from the set.
//
// Ids are the master's own, so new ones go above the book's maxima: PSAL / ARTL ids above max (13-bit fields), PLYL the
// site's id (CUSTOM_ID_BASE 30000 + n, inside the 15-bit field), PBPL id max + 1. A program or art identical to one the
// book already holds is reused (stock books share the pass-block program across every pass play the same way). Row
// orders the stock data keeps are kept: PLYS sorted by PSAL, ARTL by ARTL, PLYL / PLPD / PLRD by PLYL (new ids are the
// largest, so appending keeps them), PBPL grouped by set (the new row goes after the set's last), PSAL programs appended
// whole. Every value is checked against its field width before it is written.
import { FieldType, type TdbFile, type TdbTable } from '@ncaa/tdb';
import type { CompiledPlay } from './compile.js';
import { artRow, stepRows } from './compile.js';
import type { PlaybookRow } from './db.js';
import { LIMITS } from './model.js';

type Row = PlaybookRow;
export interface AddPlayInput { plyl: number; setl: number; compiled: CompiledPlay; ord?: number } // ord: 1-based place in the set (default: after the last)
export interface AddedPlay { plyl: number; pbpl: number; psal: number[]; artl: number[]; newPrograms: number; newArt: number }
export class BookWriteError extends Error { constructor(public problems: string[]) { super(problems.join('; ')); this.name = 'BookWriteError'; } }

const num = (v: unknown) => Number(v);
const rowsOf = (t: TdbTable): Row[] => [...t.rows()] as Row[];
const max = (rows: Row[], k: string) => rows.reduce((m, r) => Math.max(m, num(r[k])), 0);
const mode = (vals: number[], dflt: number) => { const m = new Map<number, number>(); for (const v of vals) m.set(v, (m.get(v) ?? 0) + 1); let best = dflt, n = 0; for (const [v, c] of m) if (c > n) { best = v; n = c; } return best; };

// a numeric value checked against the field's width (writeBits would wrap silently)
function checked(t: TdbTable, field: string, v: unknown, where: string): number {
  const f = t.field(field), n = Number(v), signed = f.type === FieldType.SInt, lo = signed ? -(2 ** (f.bits - 1)) : 0, hi = signed ? 2 ** (f.bits - 1) - 1 : 2 ** f.bits - 1;
  if (!Number.isInteger(n) || n < lo || n > hi) throw new BookWriteError([`${where}: ${t.name}.${field} = ${n} does not fit its ${f.bits}-bit ${signed ? 'signed' : 'unsigned'} field (${lo}..${hi})`]);
  return n;
}
// the table's rows replaced by `rows` (grown when needed); strings are set as they are, numbers width-checked
function rewrite(t: TdbTable, rows: Row[], where: string): void {
  if (rows.length > t.header.maxRecords) t.growTable(rows.length);
  const fields = t.fields.map((f) => f.name);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!; if (i >= t.recordCount) t.appendRecord();
    for (const k of fields) { const v = r[k]; if (v === undefined) throw new BookWriteError([`${where}: ${t.name} row ${i} lacks ${k}`]); t.set(i, k, typeof v === 'string' ? v : checked(t, k, v, where)); }
  }
}
const stepKey = (rows: Row[]) => JSON.stringify(rows.slice().sort((a, b) => num(a.step) - num(b.step)).map((r) => [num(r.code), num(r.val1), num(r.val2), num(r.val3)]));
const artKey = (r: Row) => JSON.stringify(Object.keys(r).filter((k) => k !== 'ARTL').sort().map((k) => [k, num(r[k])]));

// Append `plays` to the book. Throws BookWriteError (nothing changed) on a play the book cannot take.
export function addPlays(book: TdbFile, plays: AddPlayInput[]): AddedPlay[] {
  const T = { PLYL: book.table('PLYL'), PBPL: book.table('PBPL'), PBST: book.table('PBST'), PLYS: book.table('PLYS'), PSAL: book.table('PSAL'), ARTL: book.table('ARTL'), PLPD: book.table('PLPD'), PLRD: book.table('PLRD') };
  const R = { PLYL: rowsOf(T.PLYL), PBPL: rowsOf(T.PBPL), PBST: rowsOf(T.PBST), PLYS: rowsOf(T.PLYS), PSAL: rowsOf(T.PSAL), ARTL: rowsOf(T.ARTL), PLPD: rowsOf(T.PLPD), PLRD: rowsOf(T.PLRD) };
  const problems: string[] = [];
  const have = new Set(R.PLYL.map((r) => num(r.PLYL)));
  for (const p of plays) {
    if (have.has(p.plyl)) problems.push(`play ${p.plyl} "${p.compiled.name}": the book already holds PLYL ${p.plyl}`);
    if (!R.PBST.some((r) => num(r.SETL) === p.setl)) problems.push(`play ${p.plyl} "${p.compiled.name}": set ${p.setl} is not in the book`);
    if (p.compiled.name.length > LIMITS.nameChars) problems.push(`play ${p.plyl}: the name "${p.compiled.name}" is longer than ${LIMITS.nameChars} characters`);
    if (p.compiled.slots.length !== 11) problems.push(`play ${p.plyl} "${p.compiled.name}": ${p.compiled.slots.length} slots, not 11`);
    have.add(p.plyl);
  }
  if (problems.length) throw new BookWriteError(problems);
  // programs and art the book already has, by content
  const progById = new Map<number, Row[]>(); for (const r of R.PSAL) { const l = progById.get(num(r.PSAL)); if (l) l.push(r); else progById.set(num(r.PSAL), [r]); }
  const progByKey = new Map<string, number>(); for (const [id, rows] of progById) progByKey.set(stepKey(rows), id);
  const artByKey = new Map<string, number>(); for (const r of R.ARTL) artByKey.set(artKey(r), num(r.ARTL));
  let nextPsal = max(R.PSAL, 'PSAL') + 1, nextArt = max(R.ARTL, 'ARTL') + 1, nextPbpl = max(R.PBPL, 'PBPL') + 1;
  const plytOf = new Map(R.PLYL.map((r) => [num(r.PLYL), num(r.PLYT)]));
  const out: AddedPlay[] = [];
  for (const p of plays) {
    const c = p.compiled, where = `play ${p.plyl} "${c.name}"`;
    const added: AddedPlay = { plyl: p.plyl, pbpl: nextPbpl++, psal: [], artl: [], newPrograms: 0, newArt: 0 };
    // the slots: program (interned), art (interned; empty art -> the shared ARTL 0), role
    for (const s of c.slots.slice().sort((a, b) => a.poso - b.poso)) {
      const steps = stepRows(s.steps).map((r) => ({ ...r })); const key = stepKey(steps);
      let psal = progByKey.get(key);
      if (psal === undefined) { psal = nextPsal++; progByKey.set(key, psal); for (const r of steps) R.PSAL.push({ val1: r.val1!, val2: r.val2!, val3: r.val3!, PSAL: psal, code: r.code!, step: r.step! }); added.newPrograms++; }
      let artl = 0;
      if (s.art.length) { const row = artRow(s.art, 0); const k = artKey(row); const got = artByKey.get(k); if (got !== undefined) artl = got; else { artl = nextArt++; artByKey.set(k, artl); R.ARTL.push({ ...row, ARTL: artl }); added.newArt++; } }
      added.psal.push(psal); added.artl.push(artl);
      R.PLYS.push({ PSAL: psal, ARTL: artl, PLYL: p.plyl, PLRR: s.role, poso: s.poso });
    }
    // the play and its place in the set
    const same = R.PLYL.filter((r) => num(r.PLYT) === c.plyt);
    R.PLYL.push({ SETL: p.setl, PLYL: p.plyl, SRMM: c.srmm, SITT: c.sitt, PLYT: c.plyt, PLF_: c.plf, name: c.name, risk: mode(same.map((r) => num(r.risk)), 0), motn: mode(R.PLYL.map((r) => num(r.motn)), 1), phlp: mode(same.map((r) => num(r.phlp)), 7), vpos: c.vpos });
    const pbst = num(R.PBST.find((r) => num(r.SETL) === p.setl)!.PBST), inSet = R.PBPL.filter((r) => num(r.PBST) === pbst);
    const flag = mode(R.PBPL.filter((r) => plytOf.get(num(r.PLYL)) === c.plyt).map((r) => num(r.Flag)), 0);
    const ord = p.ord ?? max(inSet, 'ord_') + 1;
    if (p.ord !== undefined && inSet.some((r) => num(r.ord_) === ord)) for (const r of inSet) if (num(r.ord_) >= ord) r.ord_ = num(r.ord_) + 1; // make room (a caller that left the slot free keeps its numbering)
    const lastOfSet = R.PBPL.reduce((m, r, i) => (num(r.PBST) === pbst ? i : m), -1);
    R.PBPL.splice(lastOfSet + 1, 0, { PKGE: 0, COMF: 0, PBPL: added.pbpl, PLYL: p.plyl, PBST: pbst, ord_: ord, name: c.name, Flag: flag });
    plytOf.set(p.plyl, c.plyt);
    if (c.prog?.length) {
      const row: Row = { PLYL: p.plyl };
      for (let k = 1; k <= 5; k++) { const e = c.prog[k - 1]; row['per' + k] = e ? e[1]! : 0; row['rcv' + k] = e ? e[0]! : 0; row['icx' + k] = e ? mode(R.PLPD.map((r) => num(r['icx' + k])), 0) : 0; row['icy' + k] = e ? mode(R.PLPD.map((r) => num(r['icy' + k])), 11) : 0; }
      R.PLPD.push(row);
    }
    if (c.hole !== undefined) R.PLRD.push({ PLYL: p.plyl, hole: c.hole });
    out.push(added);
  }
  // the orders the stock data keeps
  const by = (k: string) => (a: Row, b: Row) => num(a[k]) - num(b[k]);
  R.PLYS.sort(by('PSAL')); R.ARTL.sort(by('ARTL')); R.PLYL.sort(by('PLYL')); R.PLPD.sort(by('PLYL')); R.PLRD.sort(by('PLYL'));
  for (const [name, rows] of Object.entries(R) as [keyof typeof T, Row[]][]) rewrite(T[name], rows, `${name}`);
  return out;
}

// What a book holds of a play, for checks and for `removePlays`.
export function playRows(book: TdbFile, plyl: number): { plyl: Row | undefined; pbpl: Row[]; plys: Row[] } {
  const f = (t: string) => rowsOf(book.table(t)).filter((r) => num(r.PLYL) === plyl);
  return { plyl: f('PLYL')[0], pbpl: f('PBPL'), plys: f('PLYS') };
}
