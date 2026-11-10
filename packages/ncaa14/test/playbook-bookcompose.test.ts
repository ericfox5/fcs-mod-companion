// The site's book edits turned into a compiled per-book DB: reordered sets, a dropped set and play, a formation and a
// play taken from another book, a drawn play; the result must re-extract to composeBook's book (composeBookDb checks
// that itself) and keep the CPU weights and audibles pointing at plays that exist. Needs the per-book fixtures (see
// playbook-extract.test.ts: book-NCAA_Spread.db, book-NCAA_Air_Raid.db, boot-360.db, misc-7.db); skipped without them.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTdb } from '@ncaa/tdb';
import { PlaybookDb, extractBook, stockEdits, composeBookDb, bookDiff, CUSTOM_ID_BASE, type BookEdits, type DrawnPlay } from '../src/playbook/index.js';

const FIXTURES = join(import.meta.dirname, '../../../fixtures/real/playbook');
const SPREAD = join(FIXTURES, 'book-NCAA_Spread.db'), AIR = join(FIXTURES, 'book-NCAA_Air_Raid.db'), MISC = join(FIXTURES, 'misc-7.db'), BOOT = join(FIXTURES, 'boot-360.db');
const have = [SPREAD, AIR, MISC, BOOT].every((f) => existsSync(f));
const load = (f: string) => parseTdb(new Uint8Array(readFileSync(f)));

describe.skipIf(!have)('composing a team book as a per-book DB', () => {
  const shared = have ? { boot: load(BOOT), master: load(MISC) } : {};
  const books = () => new Map([[106, load(SPREAD)], [472, load(AIR)]]);
  const view = (db: ReturnType<typeof parseTdb>, id: number) => extractBook(new PlaybookDb(db, id, shared), id, { bgid: 0, side: 'off', name: String(id) })!;
  const spread = have ? view(load(SPREAD), 106) : null!, air = have ? view(load(AIR), 472) : null!;
  const line = Array.from({ length: 5 }, () => ({ k: 'pblock' }));
  const drawn: DrawnPlay = { n: 'ZZ Drawn Mesh', t: 0, set: 376, prog: [[2, 0], [3, 0]], slots: [{ k: 'qb', o: { drop: 0 } }, { k: 'route', p: [[0, 6], [10, 6]] }, { k: 'route', p: [[0, 4], [12, 5]] }, { k: 'route', p: [[0, 5], [-12, 6]] }, { k: 'route', p: [[0, 15]] }, { k: 'route', p: [[0, 12], [-4, 12]] }, ...line] };

  it('reproduces a stock book from its stock edits', () => {
    const r = composeBookDb({ edits: stockEdits(spread), books: books(), shared });
    expect(r.added).toEqual([]); expect(r.notes).toEqual([]);
    expect(bookDiff(spread, view(parseTdb(new Uint8Array(r.bytes)), 106), new Set())).toEqual([]);
    expect(r.bytes.length).toBe(161884); // same tables, same sizes
  });

  it('applies reorders, drops, a borrowed formation, a borrowed play and a drawn play, and the DB re-extracts to the composed book', () => {
    const e: BookEdits = stockEdits(spread);
    const shotgun = e.formations.find((f) => f.id === 12238)!;
    shotgun.sets.reverse(); // sets in the opposite order
    const trio = shotgun.sets.find((s) => s.id === 376)!; trio.plays = ['c1', ...trio.plays.filter((p) => p !== 12389)]; // drawn play first, QB Blast dropped
    shotgun.sets = shotgun.sets.filter((s) => s.id !== 643 && s.id !== 586); // two sets dropped (Slot is in Wildcat; 586 Quads Trio here)
    const split = shotgun.sets.find((s) => s.id === 364)!; split.plays.push(15058); // Air Raid's Z Slant Y Corner into Split Offset
    e.formations.splice(1, 0, { id: 11858, from: 472, sets: air.formations.find((f) => f.id === 11858)!.sets.map((s) => ({ id: s.id, plays: [...s.plays] })) }); // Air Raid's Ace
    e.custom = { c1: drawn }; e.name = 'Holy Cross Spread';
    const r = composeBookDb({ edits: e, books: books(), shared });
    expect(r.added.map((a) => a.plyl)).toEqual([CUSTOM_ID_BASE]);
    expect(r.notes.some((n) => /formation Ace \(11858\) copied from book 472/.test(n))).toBe(true);
    expect(r.notes.some((n) => /play Z Slant Y Corner \(15058\) copied from book 472/.test(n))).toBe(true);
    const b = view(parseTdb(new Uint8Array(r.bytes)), 106);
    expect(bookDiff(r.composed, b, new Set())).toEqual([]);
    // the game's menu order: formations by type group then the edits' order; Ace right after Shotgun
    expect(b.formations.map((f) => f.n)).toEqual(['Shotgun', 'Ace', 'Wildcat', 'Goal Line', 'Hail Mary', 'Special Teams', 'Kickoff', 'Safety Punt']);
    const sg = b.formations.find((f) => f.n === 'Shotgun')!;
    expect(sg.sets.map((s) => s.id)).toEqual(shotgun.sets.map((s) => s.id));
    expect(sg.sets.find((s) => s.id === 376)!.plays.slice(0, 2)).toEqual([CUSTOM_ID_BASE, 8714]); expect(sg.sets.find((s) => s.id === 376)!.plays).not.toContain(12389);
    expect(sg.sets.find((s) => s.id === 364)!.plays.at(-1)).toBe(15058); expect(b.plays['15058']!.n).toBe('Z Slant Y Corner');
    expect(b.plays[String(CUSTOM_ID_BASE)]!.n).toBe('ZZ Drawn Mesh');
    const ace = b.formations.find((f) => f.n === 'Ace')!; expect(ace.sets.map((s) => s.id)).toEqual(air.formations.find((f) => f.id === 11858)!.sets.map((s) => s.id));
    expect(ace.sets[0]!.slots).toEqual(air.formations.find((f) => f.id === 11858)!.sets[0]!.slots);
    // CPU weights and audibles point at plays in the list; the dropped play's rows are gone
    const db = parseTdb(new Uint8Array(r.bytes)); const pbpl = new Set([...db.table('PBPL').rows()].map((x) => x.PBPL));
    for (const row of db.table('PBAI').rows()) expect(pbpl.has(row.PBPL), `PBAI -> PBPL ${row.PBPL}`).toBe(true);
    for (const row of db.table('PBAU').rows()) expect(pbpl.has(row.PBPL), `PBAU -> PBPL ${row.PBPL}`).toBe(true);
    expect([...db.table('PBPL').rows()].some((x) => x.PLYL === 12389)).toBe(false);
    expect([...db.table('PBAI').rows()].some((x) => x.PLYT === 103 && x.SETL === 11858)).toBe(false); // (sanity: PBAI keys by set id, not formation)
    const plyl = db.table('PLYL'); expect([...plyl.rows()].some((x) => x.PLYL === 15058 && x.SETL === 364)).toBe(true);
    expect(r.bytes.length).toBeGreaterThan(161884);
  });

  it('refuses edits that name a set or play no loaded book has', () => {
    const e = stockEdits(spread); e.formations[0]!.sets[0]!.plays.push(999999);
    expect(() => composeBookDb({ edits: e, books: books(), shared })).toThrow(/exists in no loaded book/);
    const e2 = stockEdits(spread); e2.formations.push({ id: 11858, from: 472, sets: [{ id: 5555, plays: [] }] });
    expect(() => composeBookDb({ edits: e2, books: books(), shared })).toThrow(/set 5555/);
  });
});
