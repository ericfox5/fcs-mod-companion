import { describe, it, expect } from 'vitest';
import { compileDrawn, compiledToBook, compileCustom, compileProblems, composeBook, stockEdits, cutStep, dirUnits, holeOf, playType, simplifyPath, CompileError, type Book, type DrawnPlay, type SetDef, type SlotDraw } from '../src/playbook/index.js';

// a shotgun set the way the game lays one out: skill players first (QB 0, HB 1, WR 2-5), the line 6-10
const set: SetDef = {
  id: 10, n: 'Trey Open', slots: [
    { i: 0, pos: 0, depth: 0, x: 0, y: -5 }, { i: 1, pos: 1, depth: 0, x: -2, y: -6.2 }, { i: 2, pos: 3, depth: 0, x: 12.8, y: -2.2 }, { i: 3, pos: 3, depth: 1, x: -17.5, y: -0.8 }, { i: 4, pos: 3, depth: 2, x: 17.5, y: -2.2 }, { i: 5, pos: 4, depth: 0, x: 8.5, y: -0.8 },
    { i: 6, pos: 5, depth: 0, x: -3.3, y: -1.2 }, { i: 7, pos: 6, depth: 0, x: -1.7, y: -0.9 }, { i: 8, pos: 7, depth: 0, x: 0, y: -0.6 }, { i: 9, pos: 8, depth: 0, x: 1.7, y: -0.9 }, { i: 10, pos: 9, depth: 0, x: 3.3, y: -1.2 },
  ], plays: [],
};
const line: SlotDraw[] = Array.from({ length: 5 }, () => ({ k: 'pblock' }));
const pass = (over: Partial<DrawnPlay> = {}): DrawnPlay => ({
  n: 'Smash Dig', t: 0, set: 10, prog: [[2, 0], [4, 0], [1, 0]],
  slots: [{ k: 'qb', o: { drop: 0 } }, { k: 'route', p: [[4, 1]] }, { k: 'route', p: [[0, 5], [0, 5.01], [-1, 5.5]], o: { sit: 1 } }, { k: 'route', p: [[0, 12], [15, 12]] }, { k: 'route', p: [[0, 7], [-5, 12], [-5, 25]] }, { k: 'route', p: [[0, 10], [-9, 10]] }, ...line],
  ...over,
});

describe('play compiler', () => {
  it('units: directions in 1/128 turns counter-clockwise from the right, cuts by turn size and sense', () => {
    expect(dirUnits(1, 0)).toBe(0); expect(dirUnits(0, 1)).toBe(32); expect(dirUnits(-1, 0)).toBe(64); expect(dirUnits(0, -1)).toBe(96);
    expect(cutStep(32)).toEqual([9, 2, 2, 0]); // 90° to the left
    expect(cutStep(-16)).toEqual([9, 1, 1, 0]); // 45° to the right
    expect(cutStep(-50)).toEqual([9, 1, 7, 0]); // comeback
    expect(cutStep(1)).toBeNull();
    expect(holeOf(0)).toBe(0); expect(holeOf(2.5)).toBe(2); expect(holeOf(-2.5)).toBe(1); expect(holeOf(7)).toBe(6); expect(holeOf(-12)).toBe(7);
  });
  it('simplifies a drawn path to the art budget', () => {
    const many = Array.from({ length: 40 }, (_, i) => [i * 0.3, i * 0.5]); // a straight line drawn as 40 points
    expect(simplifyPath(many)).toEqual([[11.7, 19.5]]);
    const zig = [[0, 5], [3, 5], [3, 10], [6, 10], [6, 15], [9, 15], [9, 20], [12, 20], [12, 25], [15, 25]];
    expect(simplifyPath(zig).length).toBeLessThanOrEqual(8);
  });
  it('compiles a drop-back pass: route legs, cuts, sits, the quarterback drop, pass blocks, a progression', () => {
    const c = compileDrawn(pass(), set);
    expect(c.plyt).toBe(103); // the shotgun pass type
    expect(c.slots[0]!.steps).toEqual([[3, 8, 96, 254], [7, 35, 0, 0], [255, 0, 0, 0]]);
    expect(c.slots[0]!.role).toBe(40);
    // the dig: 12 yards up, a 90° cut to the right, 15 across, get open
    expect(c.slots[3]!.steps).toEqual([[8, 96, 32, 254], [9, 1, 2, 0], [8, 120, 0, 254], [10, 0, 0, 0], [255, 0, 0, 0]]);
    // the hitch: 5 up (the 1 cm point is dropped), a small cut, settle one second, get open
    expect(c.slots[2]!.steps.map((s) => s[0])).toEqual([8, 9, 8, 25, 10, 255]); expect(c.slots[2]!.steps[3]).toEqual([25, 32, 0, 0]);
    // the post: three legs, the second cut back to straight
    expect(c.slots[4]!.steps.map((s) => s[0])).toEqual([8, 9, 8, 9, 8, 10, 255]);
    expect(c.slots[6]!.steps).toEqual([[14, 0, 0, 0], [255, 0, 0, 0]]); expect(c.slots[6]!.role).toBe(1);
    // art: feet, screen-down, cap on the last segment only
    expect(c.slots[3]!.art).toEqual([{ at: 0, ct: 0, ax: 0, ay: -36, au: 0, av: 0, sp: 15 }, { at: 0, ct: 2, ax: 45, ay: -36, au: 0, av: 0, sp: 15 }]);
    expect(c.slots[6]!.art[0]!.ct).toBe(1);
    expect(c.prog).toEqual([[2, 75], [4, 55], [1, 45]]);
    expect(c.hole).toBeUndefined();
    for (const s of c.slots) expect(s.steps.length).toBeLessThanOrEqual(16);
  });
  it('the site sees the compiled play through the extractor classifier', () => {
    const { play, asg } = compiledToBook(compileDrawn(pass(), set));
    expect(play.t).toBe(103); expect(play.prog).toEqual([[2, 75], [4, 55], [1, 45]]);
    expect(asg.map((a) => a.k)).toEqual(['qb', 'route', 'route', 'route', 'route', 'route', 'pblock', 'pblock', 'pblock', 'pblock', 'pblock']);
    expect(asg[3]!.p).toEqual([[0, 0], [0, 12], [15, 12]]); expect(asg[3]!.c).toBe(2);
    expect(asg[6]!.p).toEqual([[0, 0], [0, 1]]); expect(asg[6]!.c).toBe(1);
    expect(asg[0]!.p).toBeUndefined();
  });
  it('compiles a run: handoff to the back, the carrier track with the lateral step, stalk blocks, the hole', () => {
    const run: DrawnPlay = { n: 'Inside Zone', t: 0, set: 10, slots: [{ k: 'handoff' }, { k: 'carry', p: [[3, 2], [4, 6], [6, 14]] }, { k: 'stalk', p: [[0, 6]] }, { k: 'stalk' }, { k: 'route', p: [[0, 15]] }, { k: 'block', p: [[2, 2], [4, 3]] }, ...Array.from({ length: 5 }, () => ({ k: 'block' }))] };
    const c = compileDrawn(run, set);
    expect(c.plyt).toBe(151); expect(c.hole).toBe(2); // crosses the line about 2.5 yd right of centre
    expect(c.slots[0]!.steps).toEqual([[38, 2, 32, 0], [39, 1, 1, 2], [5, 32, 0, 0], [255, 0, 0, 0]]); // gun, the mesh to the QB's right
    expect(c.slots[1]!.steps[0]).toEqual([26, 22, 0, 0]); expect(c.slots[1]!.steps[1]![0]).toBe(13); expect(c.slots[1]!.steps[2]![0]).toBe(3); expect(c.slots[1]!.steps.slice(-2).map((s) => s[0])).toEqual([1, 255]);
    expect(c.slots[2]!.steps).toEqual([[8, 48, 32, 254], [33, 12, 0, 0], [18, 2, 32, 254], [15, 0, 0, 0], [255, 0, 0, 0]]);
    expect(c.slots[5]!.steps.map((s) => s[0])).toEqual([18, 9, 18, 255]); // a tight end's lead block along his path
    expect(c.slots[6]!.steps).toEqual([[15, 0, 0, 0], [255, 0, 0, 0]]);
    const { play, asg } = compiledToBook(c);
    expect(play.h).toBe(2); expect(asg.map((a) => a.k)).toEqual(['handoff', 'carry', 'route', 'route', 'route', 'block', 'block', 'block', 'block', 'block', 'block']);
    expect(asg[1]!.c).toBe(2); expect(asg[2]!.c).toBe(1);
  });
  it('play action, rollouts, screens, RPO and the read option pick their types and shapes', () => {
    const pa = compileDrawn(pass({ prog: [[2, 0], [4, 0]], slots: [{ k: 'qbpa', o: { fake: 1 } }, { k: 'fake', p: [[3, 1]] }, { k: 'route', p: [[0, 15]] }, { k: 'route', p: [[0, 10], [8, 10]] }, { k: 'route', p: [[0, 20]] }, { k: 'route', p: [[0, 4], [-4, 4]] }, ...line] }), set);
    expect(pa.plyt).toBe(4); expect(pa.slots[0]!.steps).toEqual([[38, 2, 32, 0], [40, 1, 1, 2], [7, 0, 0, 0], [255, 0, 0, 0]]); expect(pa.slots[1]!.steps.map((s) => s[0])).toEqual([26, 13, 14, 255]);
    expect(compiledToBook(pa).asg.map((a) => a.k).slice(0, 2)).toEqual(['qbpa', 'pblock']);
    const roll = compileDrawn(pass({ slots: [{ k: 'qb', o: { drop: 3 } }, ...pass().slots.slice(1)] }), set);
    expect(roll.plyt).toBe(7); expect(roll.slots[0]!.steps[0]).toEqual([3, 33, 113, 254]); expect(compiledToBook(roll).asg[0]!.p!.length).toBe(3); // the engine reads the roll spot from a 3-point path
    const scr = compileDrawn(pass({ slots: [{ k: 'qb', o: { drop: 5 } }, { k: 'route', p: [[-3, -1], [-6, 0]] }, { k: 'route', p: [[0, 10]] }, { k: 'route', p: [[0, 10]] }, { k: 'route', p: [[0, 10]] }, { k: 'route', p: [[0, 10]] }, { k: 'release', p: [[-4, 1], [-8, 3]] }, { k: 'release', p: [[-4, 1]] }, { k: 'pblock' }, { k: 'pblock' }, { k: 'pblock' }] }), set);
    expect(scr.plyt).toBe(5); expect(scr.slots[6]!.steps.map((s) => s[0])).toEqual([14, 3, 18, 14, 255]); expect(scr.slots[7]!.steps.map((s) => s[0])).toEqual([14, 18, 14, 255]);
    expect(compiledToBook(scr).asg[6]!.k).toBe('block');
    const rpo = compileDrawn(pass({ prog: [[2, 0], [4, 0]], slots: [{ k: 'qb', o: { drop: 6 } }, { k: 'carry', p: [[3, 2], [4, 8]] }, ...pass().slots.slice(2)] }), set);
    expect(rpo.plyt).toBe(6); expect(rpo.slots[0]!.steps[1]![1]).toBe(31);
    const opt = compileDrawn({ n: 'Zone Read', t: 0, set: 10, slots: [{ k: 'qbopt', p: [[-4, 1], [-8, 8]] }, { k: 'carry', p: [[3, 2], [4, 8]] }, { k: 'stalk' }, { k: 'stalk' }, { k: 'stalk' }, { k: 'block' }, ...Array.from({ length: 5 }, () => ({ k: 'block' }))] }, set);
    expect(opt.plyt).toBe(169); expect(opt.slots[0]!.steps).toEqual([[12, 1, 12, 2], [1, 0, 0, 0], [255, 0, 0, 0]]); expect(compiledToBook(opt).asg[0]!.k).toBe('qbopt');
  });
  it('refuses what the game cannot hold and says why', () => {
    const bad = (over: Partial<DrawnPlay>) => { try { compileDrawn(pass(over), set); return []; } catch (e) { return (e as CompileError).problems; } };
    expect(bad({ n: '' })).toContain('the play needs a name');
    expect(bad({ slots: [{ k: 'handoff' }, ...pass().slots.slice(1)] }).join(' ')).toMatch(/needs a ball carrier/);
    expect(bad({ slots: [{ k: 'qb' }, { k: 'carry', p: [[0, 3]] }, { k: 'carry', p: [[0, 3]] }, ...pass().slots.slice(3)] })).toContain('one ball carrier per play');
    expect(bad({ slots: [{ k: 'qb' }, { k: 'route', p: [[0, 50]] }, ...pass().slots.slice(2)] }).join(' ')).toMatch(/too far for the play art/);
    expect(bad({ prog: [[9, 0]] }).join(' ')).toMatch(/progression/);
    expect(bad({ slots: [{ k: 'qb' }, { k: 'route', p: Array.from({ length: 9 }, (_, i) => [i % 2 ? 3 : 0, (i + 1) * 3]) }, ...pass().slots.slice(2)] }).join(' ')).toMatch(/steps|art/);
    const nameless = { ...pass(), n: '' }; expect(compileCustom('c1', nameless, set)).toBeNull();
    expect(compileProblems({ c1: nameless, c2: { ...pass(), set: 99 } }, (id) => (id === 10 ? set : undefined))).toEqual(['c1: the play needs a name', 'c2 "Smash Dig": its set 99 is not in the book']);
  });
  it('composes into a book Supersim can run', () => {
    const base: Book = { id: 106, bgid: 121, side: 'off', name: 'Spread', formations: [{ id: 1, n: 'Shotgun', t: 1, sets: [{ ...set, plays: [100] }] }], plays: { 100: { id: 100, n: 'Four Verts', t: 103, sit: 2, f: 33, v: 4, a: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2] } }, asg: [{ r: 40, k: 'qb' }, { r: 98, k: 'route', p: [[0, 0], [0, 20]], c: 2 }, { r: 1, k: 'pblock', c: 1 }], ai: {} };
    const e = stockEdits(base); e.formations[0]!.sets[0]!.plays.push('c1'); e.custom['c1'] = pass();
    const book = composeBook(e, new Map([[106, base]]), { custom: compileCustom });
    const ids = book.formations[0]!.sets[0]!.plays; expect(ids).toEqual([100, 30000]);
    const p = book.plays['30000']!; expect(p.n).toBe('Smash Dig'); expect(p.t).toBe(103); expect(p.a.length).toBe(11);
    expect(p.a.map((i) => book.asg[i]!.k)).toEqual(['qb', 'route', 'route', 'route', 'route', 'route', 'pblock', 'pblock', 'pblock', 'pblock', 'pblock']);
    expect(playType(pass())).toBe(103);
  });
});
