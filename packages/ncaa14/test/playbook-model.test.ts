import { describe, it, expect } from 'vitest';
import { composeBook, stockEdits, validateEdits, booksNeeded, playsForSet, CUSTOM_ID_BASE, type Book, type BookEdits } from '../src/playbook/index.js';

// two small stock books sharing a set and a play, the way the game's ids work (same PBFM / SETL / PLYL everywhere)
const slots = (n: number) => Array.from({ length: n }, (_, i) => ({ i, pos: i === 0 ? 0 : 3, depth: 0, x: i * 2, y: -1 }));
const A: Book = {
  id: 106, bgid: 121, side: 'off', name: 'Spread',
  formations: [
    { id: 1, n: 'Shotgun', t: 1, sets: [{ id: 10, n: 'Trips', slots: slots(3), plays: [100, 101] }, { id: 11, n: 'Spread Flex', slots: slots(3), plays: [102] }] },
    { id: 2, n: 'Pistol', t: 1, sets: [{ id: 20, n: 'Normal', slots: slots(3), plays: [103] }] },
  ],
  plays: {
    100: { id: 100, n: 'Four Verts', t: 103, sit: 0, f: 0, v: 1, prog: [[1, 60], [2, 40]], a: [0, 1, 1] },
    101: { id: 101, n: 'HB Dive', t: 151, sit: 0, f: 0, v: 1, h: 4, a: [2, 3, 3] },
    102: { id: 102, n: 'Slants', t: 101, sit: 0, f: 0, v: 1, a: [0, 4, 4] },
    103: { id: 103, n: 'Pistol Zone', t: 151, sit: 0, f: 0, v: 1, a: [2, 3, 3] },
  },
  asg: [{ r: 40, k: 'qb', p: [[0, -5]] }, { r: 74, k: 'route', p: [[0, 20]], c: 2 }, { r: 111, k: 'handoff' }, { r: 1, k: 'block', c: 1 }, { r: 74, k: 'route', p: [[3, 5]], c: 2 }],
  ai: { 1: [[100, 30], [101, 70]], 2: [[102, 50]] },
};
const B: Book = {
  id: 107, bgid: 122, side: 'off', name: 'Air Raid',
  formations: [
    { id: 1, n: 'Shotgun', t: 1, sets: [{ id: 10, n: 'Trips', slots: slots(3), plays: [100, 200] }] },
    { id: 3, n: 'Empty', t: 1, sets: [{ id: 30, n: 'Trey', slots: slots(3), plays: [201] }] },
  ],
  plays: {
    100: { id: 100, n: 'Four Verts', t: 103, sit: 0, f: 0, v: 1, prog: [[1, 60], [2, 40]], a: [1, 0, 0] }, // same play, other interning
    200: { id: 200, n: 'Mesh', t: 102, sit: 0, f: 0, v: 1, a: [1, 2, 2] },
    201: { id: 201, n: 'Stick', t: 101, sit: 0, f: 0, v: 1, a: [1, 2, 2] },
  },
  asg: [{ r: 74, k: 'route', p: [[0, 20]], c: 2 }, { r: 40, k: 'qb', p: [[0, -5]] }, { r: 74, k: 'route', p: [[4, 6]], c: 2 }],
  ai: { 1: [[200, 90]] },
};
const books = new Map([[A.id, A], [B.id, B]]);

describe('playbook edits', () => {
  it('stock edits reproduce the stock book', () => {
    const e = stockEdits(A);
    expect(validateEdits(e, books)).toEqual([]);
    const out = composeBook(e, books);
    expect(out.name).toBe('Spread');
    expect(out.formations.map((f) => [f.id, f.sets.map((s) => [s.id, s.plays])])).toEqual(A.formations.map((f) => [f.id, f.sets.map((s) => [s.id, s.plays])]));
    expect(Object.keys(out.plays).map(Number).sort()).toEqual([100, 101, 102, 103]);
    // assignments resolve to the same entries
    for (const id of [100, 101, 102, 103]) expect(out.plays[id]!.a.map((i) => out.asg[i])).toEqual(A.plays[id]!.a.map((i) => A.asg[i]));
    expect(out.ai).toEqual(A.ai);
  });
  it('reorders, drops and borrows a formation from another book, re-interning its assignments', () => {
    const e: BookEdits = { v: 1, base: 106, name: 'Holy Cross', custom: {}, formations: [
      { id: 3, from: 107, sets: [{ id: 30, plays: [201] }] },
      { id: 1, sets: [{ id: 10, plays: [200, 100] }] }, // 200 is not in A's set 10, but exists in B's copy of the same set
    ] };
    expect(booksNeeded(e)).toEqual([106, 107]);
    expect(validateEdits(e, books)).toEqual([]);
    const out = composeBook(e, books);
    expect(out.name).toBe('Holy Cross');
    expect(out.formations.map((f) => f.id)).toEqual([3, 1]);
    expect(out.formations[1]!.sets[0]!.plays).toEqual([200, 100]);
    expect(Object.keys(out.plays).map(Number).sort()).toEqual([100, 200, 201]);
    expect(out.plays[200]!.a.map((i) => out.asg[i])).toEqual(B.plays[200]!.a.map((i) => B.asg[i]));
    expect(out.plays[100]!.a.map((i) => out.asg[i])).toEqual(A.plays[100]!.a.map((i) => A.asg[i])); // the base's copy wins
    expect(out.asg.length).toBe(new Set(out.asg.map((a) => JSON.stringify(a))).size); // interned once each
    expect(out.ai).toEqual({ 1: [[200, 90], [100, 30]] });
  });
  it('rejects ids that exist nowhere and oversize books', () => {
    const e: BookEdits = { v: 1, base: 106, name: 'X', custom: {}, formations: [{ id: 9, sets: [] }, { id: 1, sets: [{ id: 10, plays: [999] }, { id: 99, plays: [] }] }] };
    const p = validateEdits(e, books);
    expect(p).toContain('formation 9 is not in book 106');
    expect(p).toContain('play 999 exists in no loaded book');
    expect(p).toContain('set 99 is not in formation 1 of book 106');
    expect(() => composeBook(e, books)).toThrow(/playbook edits/);
    const big: BookEdits = { ...stockEdits(A), formations: Array.from({ length: 16 }, (_, i) => ({ id: i, sets: [] })) };
    expect(validateEdits(big, books).some((x) => /16 formations/.test(x))).toBe(true);
  });
  it('places compiled custom plays above every stock id, or drops them without a compiler', () => {
    const e: BookEdits = { ...stockEdits(A), custom: { c1: { n: 'My Play', t: 102, set: 10, slots: [{ k: 'qb' }, { k: 'route', p: [[0, 8]] }, { k: 'route', p: [[2, 4]] }] } } };
    e.formations[0]!.sets[0]!.plays.push('c1');
    expect(validateEdits(e, books)).toEqual([]);
    expect(composeBook(e, books).formations[0]!.sets[0]!.plays).toEqual([100, 101]);
    const out = composeBook(e, books, { custom: (_cid, d) => ({ play: { n: d.n, t: d.t, sit: 0, f: 0, v: 1 }, asg: d.slots.map((s) => ({ r: 74, k: s.k, ...(s.p ? { p: s.p, c: 2 } : {}) })) }) });
    const id = CUSTOM_ID_BASE;
    expect(out.formations[0]!.sets[0]!.plays).toEqual([100, 101, id]);
    expect(out.plays[id]!.n).toBe('My Play');
    expect(out.plays[id]!.a.length).toBe(3);
  });
  it('lists the plays any book runs from a set', () => {
    expect(playsForSet(books, 10).map((x) => x.play.id).sort()).toEqual([100, 101, 200]);
  });
});
