// Drawn plays written into a compiled per-book DB (the data the game plays): compile -> addPlays -> serialize -> parse ->
// extract again, and the book must show the new plays exactly as the site composes them. Needs the per-book fixtures
// (see playbook-extract.test.ts); skipped without them.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTdb, serializeTdb, verifyTdb } from '@ncaa/tdb';
import { PlaybookDb, extractBook, compileDrawn, compiledToBook, addPlays, playRows, BookWriteError, CUSTOM_ID_BASE, type DrawnPlay, type SetDef } from '../src/playbook/index.js';

const FIXTURES = join(import.meta.dirname, '../../../fixtures/real/playbook');
const SPREAD = join(FIXTURES, 'book-NCAA_Spread.db'), MISC = join(FIXTURES, 'misc-7.db'), BOOT = join(FIXTURES, 'boot-360.db');
const have = existsSync(SPREAD) && existsSync(MISC) && existsSync(BOOT);
const load = (f: string) => parseTdb(new Uint8Array(readFileSync(f)));
const json = <T,>(o: T): T => JSON.parse(JSON.stringify(o));

describe.skipIf(!have)('writing drawn plays into a per-book DB', () => {
  const shared = have ? { boot: load(BOOT), master: load(MISC) } : {};
  const view = (book: ReturnType<typeof parseTdb>) => extractBook(new PlaybookDb(book, 106, shared), 106, { bgid: 121, side: 'off', name: 'Spread' })!;
  const stock = have ? view(load(SPREAD)) : null!;
  const setOf = (id: number): SetDef => stock.formations.flatMap((f) => f.sets).find((s) => s.id === id)!;
  const line = Array.from({ length: 5 }, () => ({ k: 'pblock' })), runLine = Array.from({ length: 5 }, () => ({ k: 'block' }));
  const dig: DrawnPlay = { n: 'ZZ Drawn Dig', t: 0, set: 376, prog: [[3, 0], [2, 0], [5, 0]], slots: [{ k: 'qb', o: { drop: 0 } }, { k: 'route', p: [[0, 5], [1, 4]], o: { sit: 1.5 } }, { k: 'route', p: [[0, 10], [-6, 20]] }, { k: 'route', p: [[0, 12], [10, 12]] }, { k: 'route', p: [[0, 8], [-8, 8]] }, { k: 'route', p: [[0, 15]] }, ...line] };
  const zone: DrawnPlay = { n: 'ZZ Drawn Zone', t: 0, set: 952, slots: [{ k: 'handoff' }, { k: 'carry', p: [[3, 2], [4, 6], [6, 14]] }, { k: 'stalk' }, { k: 'stalk' }, { k: 'stalk' }, { k: 'block' }, ...runLine] };

  it('appends a pass and a run and re-extracts them as the site composes them', () => {
    const book = load(SPREAD);
    const counts = Object.fromEntries(book.tables.map((t) => [t.name, t.recordCount]));
    const c1 = compileDrawn(dig, setOf(376)), c2 = compileDrawn(zone, setOf(952));
    const added = addPlays(book, [{ plyl: CUSTOM_ID_BASE, setl: 376, compiled: c1 }, { plyl: CUSTOM_ID_BASE + 1, setl: 952, compiled: c2 }]);
    expect(added.map((a) => a.plyl)).toEqual([30000, 30001]);
    expect(added[0]!.psal).toHaveLength(11); expect(new Set(added[0]!.artl.slice(6)).size).toBe(1); expect(new Set(added[0]!.psal.slice(6)).size).toBe(1); // the five pass blockers share one program and one art
    expect(added[0]!.newPrograms).toBeGreaterThan(0); expect(added[0]!.newPrograms).toBeLessThan(11); // the drop-back and pass-block programs already exist in the book
    // table growth
    expect(book.table('PLYL').recordCount).toBe(counts.PLYL! + 2); expect(book.table('PBPL').recordCount).toBe(counts.PBPL! + 2); expect(book.table('PLYS').recordCount).toBe(counts.PLYS! + 22);
    expect(book.table('PLPD').recordCount).toBe(counts.PLPD! + 1); expect(book.table('PLRD').recordCount).toBe(counts.PLRD! + 1);
    expect(book.table('PSAL').recordCount).toBe(counts.PSAL! + c1.slots.filter((_, i) => added[0]!.psal.indexOf(added[0]!.psal[i]!) === i && added[0]!.psal[i]! > 5053).reduce((n, s) => n + s.steps.length, 0) + c2.slots.filter((_, i) => added[1]!.psal.indexOf(added[1]!.psal[i]!) === i && added[1]!.psal[i]! > 5053).reduce((n, s) => n + s.steps.length, 0));
    // serialize, verify, parse again
    const bytes = serializeTdb(book); expect(bytes.length).toBeGreaterThan(161884);
    expect(verifyTdb(bytes, book)).toEqual([]);
    const again = parseTdb(new Uint8Array(bytes));
    // row orders the game's data keeps
    const sorted = (t: string, k: string) => { const rows = [...again.table(t).rows()]; return rows.every((r, i) => i === 0 || Number(r[k]) >= Number(rows[i - 1]![k])); };
    expect(sorted('PLYS', 'PSAL')).toBe(true); expect(sorted('ARTL', 'ARTL')).toBe(true); expect(sorted('PLYL', 'PLYL')).toBe(true); expect(sorted('PLPD', 'PLYL')).toBe(true); expect(sorted('PLRD', 'PLYL')).toBe(true);
    const pbpl = [...again.table('PBPL').rows()]; const trioRows = pbpl.filter((r) => r.PBST === 43036); expect(trioRows[trioRows.length - 1]).toMatchObject({ PLYL: 30000, ord_: 16, name: 'ZZ Drawn Dig' });
    expect(pbpl.findIndex((r) => r.PLYL === 30000)).toBe(pbpl.findIndex((r) => r.PBST === 43036) + 15); // right after the set's stock plays
    // the re-extracted book shows the plays as the site composes them
    const b = view(again);
    const trio = b.formations.find((f) => f.n === 'Shotgun')!.sets.find((s) => s.id === 376)!; expect(trio.plays[trio.plays.length - 1]).toBe(30000);
    expect(b.formations.find((f) => f.n === 'Shotgun')!.sets.find((s) => s.id === 952)!.plays.at(-1)).toBe(30001);
    for (const [plyl, c] of [[30000, c1], [30001, c2]] as const) {
      const want = compiledToBook(c), got = b.plays[String(plyl)]!;
      expect(got).toMatchObject({ id: plyl, ...want.play });
      expect(json(got.a.map((i) => b.asg[i]))).toEqual(json(want.asg));
    }
    // the stock plays are untouched
    for (const k of Object.keys(stock.plays)) { const s = stock.plays[k]!, g = b.plays[k]!; expect(json(g.a.map((i) => b.asg[i]))).toEqual(json(s.a.map((i) => stock.asg[i]))); expect(g.n).toBe(s.n); }
    expect(playRows(again, 30000).plys).toHaveLength(11);
  });

  it('refuses a duplicate id, an unknown set and a long name, changing nothing', () => {
    const book = load(SPREAD); const before = serializeTdb(book);
    const c = compileDrawn(dig, setOf(376));
    expect(() => addPlays(book, [{ plyl: 8714, setl: 376, compiled: c }])).toThrow(BookWriteError);
    expect(() => addPlays(book, [{ plyl: 30000, setl: 999, compiled: c }])).toThrow(/set 999/);
    expect(() => addPlays(book, [{ plyl: 30000, setl: 376, compiled: { ...c, name: 'A name that is far longer than twenty-four' } }])).toThrow(/longer than 24/);
    expect(Buffer.from(serializeTdb(book)).equals(Buffer.from(before))).toBe(true);
  });

  it('places a play at a chosen spot in the set and shifts the others', () => {
    const book = load(SPREAD);
    addPlays(book, [{ plyl: 30000, setl: 376, compiled: compileDrawn(dig, setOf(376)), ord: 1 }]);
    const rows = [...book.table('PBPL').rows()].filter((r) => r.PBST === 43036).sort((a, b) => Number(a.ord_) - Number(b.ord_));
    expect(rows[0]).toMatchObject({ PLYL: 30000, ord_: 1 }); expect(rows[1]).toMatchObject({ PLYL: 8714, ord_: 2 }); expect(rows).toHaveLength(16);
    expect(view(book).formations.find((f) => f.n === 'Shotgun')!.sets.find((s) => s.id === 376)!.plays.slice(0, 2)).toEqual([30000, 8714]);
  });
});
