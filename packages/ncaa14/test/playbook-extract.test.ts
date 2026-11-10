// The playbook extractor against the stock databases: the per-book DBs the game plays from (qkl_fe2ig.ast entries
// PLAYBOOK_<PBAN>: Holy Cross's Spread and the 4-2-5), the misc #7 master playbook DB and the boot #360 base / #356 PLAB
// list, pulled out of the game archives with
//   npx tsx bridge/src/cli.ts generic extract --archive "<USRDIR>/qkl_fe2ig.ast" --out fixtures/real/playbook/book-NCAA_Spread.db --hash d2e18fc66f2c9098
//   npx tsx bridge/src/cli.ts generic extract --archive "<USRDIR>/qkl_fe2ig.ast" --out fixtures/real/playbook/book-NCAA_4-2-5.db --hash fcdbf08c081ec300
//   npx tsx bridge/src/cli.ts generic extract --archive "<USRDIR>/qkl_misc.ast" --out fixtures/real/playbook/misc-7.db --hash 4e226c292cd63322
//   npx tsx bridge/src/cli.ts generic extract --archive "<USRDIR>/qkl_boot.ast" --out fixtures/real/playbook/boot-360.db --hash b0ccfdf2435c3916
//   npx tsx bridge/src/cli.ts generic extract --archive "<USRDIR>/qkl_boot.ast" --out fixtures/real/playbook/boot-356.db --hash 1d4509dc8d1a528e
// fixtures/real is gitignored (EA data), so these suites are skipped without them. The generated JSON under
// worker/public/data/playbooks is EA data too; the deep-equal against it runs only when that folder is there.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTdb } from '@ncaa/tdb';
import { PlaybookDb, extractBook, extractIndex, offenseKind, defenseKind, artPath, ROLE_KIND, type Book } from '../src/playbook/index.js';
import { playbookEntryHash, playbookEntryName } from '../src/fnv.js';

const FIXTURES = join(import.meta.dirname, '../../../fixtures/real/playbook');
const MISC = join(FIXTURES, 'misc-7.db'), BOOT = join(FIXTURES, 'boot-360.db'), PLAB = join(FIXTURES, 'boot-356.db');
const SPREAD = join(FIXTURES, 'book-NCAA_Spread.db'), D425 = join(FIXTURES, 'book-NCAA_4-2-5.db');
const BOOKS = join(import.meta.dirname, '../../../worker/public/data/playbooks');
const have = existsSync(MISC) && existsSync(BOOT) && existsSync(PLAB);
const haveBooks = existsSync(SPREAD) && existsSync(D425) && existsSync(PLAB);
// the archive entry may wrap the DB: the extractor looks for the DB\0\x08 magic in the first 4 KB
const loadDb = (file: string) => { const b = readFileSync(file); const k = b[0] === 0x44 && b[1] === 0x42 ? 0 : b.indexOf(Buffer.from([0x44, 0x42, 0x00, 0x08])); if (k < 0 || k > 4096) throw new Error(`${file}: no DB magic`); return parseTdb(new Uint8Array(b.subarray(k))); };
const json = <T,>(o: T): T => JSON.parse(JSON.stringify(o)); // the files hold JSON: -0 (from -yd(0) at the art origin) is written as 0
const KINDS_OFF = new Set(['qb', 'qbpa', 'qbopt', 'handoff', 'carry', 'route', 'screen', 'block', 'pblock', 'kick', 'hold', 'punt', 'kneel', 'spike', 'cover', 'move', 'ret', 'recover']);
const KINDS_DEF = new Set(['rush', 'man', 'under', 'deep', 'ret', 'block', 'recover', 'kick', 'hold', 'punt', 'kneel', 'spike', 'cover']);

describe.skipIf(!have)('playbook extraction from the stock databases', () => {
  const misc = have ? loadDb(MISC) : null!, boot = have ? loadDb(BOOT) : null!, books = have ? loadDb(PLAB) : null!;
  const db = have ? new PlaybookDb(misc, boot) : null!;
  const plab = have ? [...books.table('PLAB').rows()] : [];
  const holyCross = plab.find((r) => r.PBGI === 106);

  it('merges the tables (misc first, boot as the base) and lists every book PGPL holds', () => {
    expect(plab).toHaveLength(143);
    expect(holyCross).toMatchObject({ PBGI: 106, BGID: 121, BOFF: 1, BNAM: 'Spread' });
    expect(db.books()).toContain(106);
    expect(db.PBFM.size).toBeGreaterThan(0); expect(db.SETL.size).toBeGreaterThan(0); expect(db.PBPL.size).toBeGreaterThan(0);
    expect(db.SGFF.size).toBeGreaterThan(0); // misc SGFF + boot 'SGF ' (trailing space)
    expect(db.PSAL.size).toBeGreaterThan(0); // boot's step programs
    for (const bokl of db.books()) expect(plab.some((r) => r.PBGI === bokl), `BOKL ${bokl} is in PLAB`).toBe(true);
  });

  it("extracts Holy Cross's Spread (BOKL 106) as a well-formed book", () => {
    const book = extractBook(db, 106, { bgid: 121, side: 'off', name: 'Spread' });
    expect(book).not.toBeNull();
    const b = book!;
    expect(b).toMatchObject({ id: 106, bgid: 121, side: 'off', name: 'Spread' });
    expect(b.formations.map((f) => f.n)).toContain('Special Teams');
    expect(Object.keys(b.plays).length).toBeGreaterThan(100);
    for (const f of b.formations) for (const s of f.sets) {
      expect(s.slots).toHaveLength(11); expect(s.slots.map((x) => x.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(s.plays.length).toBeGreaterThan(0);
      for (const id of s.plays) expect(b.plays[String(id)], `play ${id} of set ${s.id}`).toBeDefined();
    }
    for (const p of Object.values(b.plays)) { expect(p.a).toHaveLength(11); for (const i of p.a) expect(i === -1 || b.asg[i] !== undefined, `asg ${i}`).toBe(true); }
    for (const a of b.asg) expect(KINDS_OFF.has(a.k), `kind ${a.k}`).toBe(true);
    expect(new Set(b.asg.map((a) => JSON.stringify(a))).size).toBe(b.asg.length); // interned: no duplicates
    for (const rows of Object.values(b.ai)) for (const [play] of rows) expect(b.plays[String(play)]).toBeDefined();
  });

  it('extracts a defensive book with defensive kinds only', () => {
    const row = plab.find((r) => r.BOFF === 0)!;
    const b = extractBook(db, row.PBGI as number, { bgid: row.BGID as number, side: 'def', name: String(row.BNAM) })!;
    expect(b.side).toBe('def');
    for (const a of b.asg) expect(KINDS_DEF.has(a.k), `kind ${a.k}`).toBe(true);
    expect(b.asg.some((a) => a.k === 'man' && a.t !== undefined)).toBe(true);
    expect(b.asg.some((a) => a.k === 'deep' && a.z !== undefined)).toBe(true);
  });

  it('returns null for a book id PGPL does not list', () => {
    expect(extractBook(db, 999999, { bgid: 0, side: 'off', name: 'none' })).toBeNull();
  });

  it('builds index.json entries offense first, then by name', () => {
    const two: Book[] = [extractBook(db, 106, { bgid: 121, side: 'off', name: 'Spread' })!, extractBook(db, plab.find((r) => r.BOFF === 0)!.PBGI as number, { bgid: 0, side: 'def', name: 'Any' })!];
    const idx = extractIndex([two[1]!, two[0]!], '2026-01-01T00:00:00.000Z');
    expect(idx.generated).toBe('2026-01-01T00:00:00.000Z');
    expect(idx.books.map((b) => b.side)).toEqual(['off', 'def']);
    expect(idx.books[0]).toEqual({ id: 106, bgid: 121, side: 'off', name: 'Spread', plays: Object.keys(two[0]!.plays).length, formations: two[0]!.formations.map((f) => f.n) });
  });

});

describe.skipIf(!haveBooks || !have)('playbook extraction from the per-book DBs the game plays (qkl_fe2ig.ast PLAYBOOK_<PBAN>)', () => {
  const plab = haveBooks ? [...loadDb(PLAB).table('PLAB').rows()] : [];
  const shared = have ? { boot: loadDb(BOOT), master: loadDb(MISC) } : {};
  const spread = haveBooks ? new PlaybookDb(loadDb(SPREAD), 106, shared) : null!, d425 = haveBooks ? new PlaybookDb(loadDb(D425), 109, shared) : null!;

  it('names the entries PLAYBOOK_<PBAN> and hashes them as the archive does', () => {
    const hc = plab.find((r) => r.PBGI === 106)!, d = plab.find((r) => r.PBGI === 109)!;
    expect(hc.PBAN).toBe('NCAA_Spread'); expect(playbookEntryName('NCAA_Spread')).toBe('PLAYBOOK_NCAA_Spread');
    expect(playbookEntryHash(String(hc.PBAN)).toString(16)).toBe('d2e18fc66f2c9098');
    expect(playbookEntryHash(String(d.PBAN)).toString(16)).toBe('fcdbf08c081ec300');
  });

  it('presents one compiled book through the same views (PLYL as play info, PBST as the set list, PBAI by PBPL id)', () => {
    expect(spread.books()).toEqual([106]);
    expect(spread.PGFM.get(106)!.length).toBe(8); expect(spread.STID.get(106)!.every((r) => r.SETL !== 0)).toBe(true);
    expect(spread.PGPL.get(106)!.length).toBe(359);
    expect(spread.PBPL.get(8714)).toMatchObject({ name: 'Spacing', PLYT: 103 }); // the stock play; the master has CFBR's "*Spacing"
    expect(spread.steps(243).map((s) => s.code)).toEqual([8, 9, 25, 10, 255]);
    for (const r of spread.PBA.get(106)!) expect(spread.PBPL.has(r.PLYL as number), `AI row for play ${r.PLYL}`).toBe(true);
  });

  it("extracts Holy Cross's Spread as a well-formed book with the stock plays", () => {
    const b = extractBook(spread, 106, { bgid: 121, side: 'off', name: 'Spread' })!;
    expect(b).toMatchObject({ id: 106, bgid: 121, side: 'off', name: 'Spread' });
    expect(Object.keys(b.plays)).toHaveLength(359);
    // the game's menu order: formations by type group then ord_, sets by their ord_
    expect(b.formations.map((f) => `${f.id}:${f.n}`)).toEqual(['12238:Shotgun', '13171:Wildcat', '12376:Goal Line', '13107:Hail Mary', '12199:Special Teams', '10413:Kickoff', '1351:Safety Punt']);
    expect(b.formations[0]!.sets.slice(0, 4).map((s) => s.n)).toEqual(['Split Offset', 'Ace Twins', 'Normal Offset', 'Normal HB Wk']);
    const special = b.formations.find((f) => f.n === 'Special Teams')!; // the book's punt set plus the shared sets from BSMO/DPSF
    expect(special.sets.map((s) => s.id)).toEqual([12, 69, 66, 38, 456, 73, 471, 71, 455]);
    const trio = b.formations.find((f) => f.n === 'Shotgun')!.sets.find((s) => s.id === 376)!;
    expect(trio.n).toBe('5WR Trio'); expect(trio.plays[0]).toBe(8714); expect(b.plays['8714']!.n).toBe('Spacing');
    for (const f of b.formations) for (const s of f.sets) { expect(s.slots).toHaveLength(11); for (const id of s.plays) expect(b.plays[String(id)], `play ${id}`).toBeDefined(); }
    for (const p of Object.values(b.plays)) { expect(p.a).toHaveLength(11); expect(p.n.length).toBeLessThanOrEqual(24); }
    for (const a of b.asg) expect(KINDS_OFF.has(a.k), `kind ${a.k}`).toBe(true);
    expect(b.asg.some((a) => a.k === 'route' && a.p && a.p.length > 1)).toBe(true);
    for (const rows of Object.values(b.ai)) for (const [play] of rows) expect(b.plays[String(play)]).toBeDefined();
  });

  it('extracts the 4-2-5 with defensive kinds', () => {
    const b = extractBook(d425, 109, { bgid: 3, side: 'def', name: '4-2-5' })!;
    expect(b.side).toBe('def'); expect(Object.keys(b.plays).length).toBeGreaterThan(150);
    for (const a of b.asg) expect(KINDS_DEF.has(a.k), `kind ${a.k}`).toBe(true);
    expect(b.asg.some((a) => a.k === 'man' && a.t !== undefined)).toBe(true);
    expect(b.asg.some((a) => a.k === 'deep' && a.z !== undefined)).toBe(true);
  });

  describe.skipIf(!have)('against the master DB', () => {
    it('shares the formation and set structure with the master view of the same book', () => {
      const m = extractBook(new PlaybookDb(loadDb(MISC), loadDb(BOOT)), 106, { bgid: 121, side: 'off', name: 'Spread' })!;
      const b = extractBook(spread, 106, { bgid: 121, side: 'off', name: 'Spread' })!;
      const ids = (x: Book) => x.formations.map((f) => f.id).sort(), setIds = (x: Book) => x.formations.flatMap((f) => f.sets.map((s) => s.id)).sort();
      const slots = (x: Book) => Object.fromEntries(x.formations.flatMap((f) => f.sets.map((s) => [s.id, s.slots.map((q) => [q.i, q.pos, q.depth])])));
      expect(ids(b)).toEqual(ids(m)); expect(setIds(b)).toEqual(setIds(m)); // the same book, in the game's menu order instead of the master's row order
      expect(slots(b)).toEqual(slots(m)); // positions and depths; a set's alignment can differ (CFBR moved receivers in the master's Trio HB Wk)
      expect(Object.keys(b.plays).sort()).toEqual(Object.keys(m.plays).sort());
      const differ = Object.keys(b.plays).filter((k) => b.plays[k]!.n !== m.plays[k]!.n);
      expect(differ.length).toBeGreaterThan(50); // CFBR's in-place edits in the master, absent from what the game plays
    });
  });

  describe.skipIf(!existsSync(join(BOOKS, '106.json')))('against the shipped JSON', () => {
    it('Holy Cross (106.json) deep-equals the per-book extraction, key order included', () => {
      const shipped = readFileSync(join(BOOKS, '106.json'), 'utf8');
      const book = extractBook(spread, 106, { bgid: 121, side: 'off', name: 'Spread' })!;
      expect(json(book)).toEqual(JSON.parse(shipped));
      expect(JSON.stringify(book)).toBe(shipped);
    });
  });
});

describe('assignment classifiers', () => {
  const st = (...codes: number[]) => codes.map((code, step) => ({ step, code, val1: 0, val2: 0, val3: 0 }));
  it('offense: roles first, then the step codes', () => {
    expect(ROLE_KIND[24]).toBe('kick');
    expect(offenseKind(st(3, 8, 10), 24, 5)).toBe('kick');
    expect(offenseKind(st(3, 7), 40, 0)).toBe('qb');
    expect(offenseKind(st(38, 3, 7), 41, 0)).toBe('qbpa');
    expect(offenseKind(st(1), 43, 0)).toBe('qbopt');
    expect(offenseKind(st(38), 111, 0)).toBe('handoff');
    expect(offenseKind(st(1, 13), 70, 1)).toBe('carry');
    expect(offenseKind(st(36), 70, 2)).toBe('screen');
    expect(offenseKind(st(8, 9, 10), 74, 3)).toBe('route');
    expect(offenseKind(st(14), 1, 4)).toBe('pblock');
    expect(offenseKind(st(14, 15), 1, 4)).toBe('block');
    expect(offenseKind(st(18), 74, 3)).toBe('block');
    expect(offenseKind(st(48), 74, 3)).toBe('move');
  });
  it('defense: rush / man (receiver) / deep (zone) / under, then art cap and slot position', () => {
    expect(defenseKind(st(41), 0, 10, 5)).toEqual({ k: 'rush' });
    expect(defenseKind([{ step: 0, code: 19, val1: 2, val2: 0, val3: 0 }], 0, 16, 133)).toEqual({ k: 'man', t: 2 });
    expect(defenseKind([{ step: 0, code: 23, val1: 7, val2: 0, val3: 0 }], 0, 17, 9)).toEqual({ k: 'deep', z: 7 });
    expect(defenseKind(st(21), 0, 13, 0)).toEqual({ k: 'under' });
    expect(defenseKind(st(48), 4, 17, 0)).toEqual({ k: 'deep' });
    expect(defenseKind(st(48), 2, 11, 0)).toEqual({ k: 'rush' });
    expect(defenseKind(st(48), 0, 14, 0)).toEqual({ k: 'under' });
    expect(defenseKind([], 0, 21, 105)).toEqual({ k: 'ret' });
  });
  it('art: feet to yards, screen-down flipped, duplicate points dropped, detached pieces kept', () => {
    expect(artPath(undefined)).toEqual({ p: [], cap: 0 });
    const art = { acnt: 2, au01: 0, av01: 0, ax01: 0, ay01: -30, at01: 0, ct01: 0, au02: 9, av02: -45, ax02: 0, ay02: -30, at02: 1, ct02: 2 };
    expect(json(artPath(art))).toEqual({ p: [[0, 0], [0, 10], [3, 15]], cap: 2 });
    expect(artPath({ acnt: 1, au01: 0, av01: 0, ax01: 0, ay01: 0, at01: 0, ct01: 1 })).toEqual({ p: [], cap: 0 });
  });
});
