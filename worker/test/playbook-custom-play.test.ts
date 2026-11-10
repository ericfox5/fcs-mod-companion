// Drawn plays through the whole chain: compiled by the play creator's compiler, composed into a team's book, called in the
// coaching engine against a stock defense (skipped when the extracted books are absent: `npx tsx tools/playbooks-extract.mts`).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { newGame, runPlay, mulberry32, findPlay } from '../src/supersim/coach/engine.js';
import { cpuOffense, cpuDefense } from '../src/supersim/coach/cpu.js';
import type { Book, GameInput, PlayerInput, TeamInput, GameState } from '../src/supersim/coach/types.js';
import { composeBook, stockEdits, compileCustom, CUSTOM_ID_BASE, type DrawnPlay } from '@ncaa/ncaa14';

const dir = new URL('../public/data/playbooks/', import.meta.url);
const have = existsSync(new URL('106.json', dir)) && existsSync(new URL('109.json', dir));
const book = (id: number) => JSON.parse(readFileSync(new URL(`${id}.json`, dir), 'utf8')) as Book;
const KEYS = ['PSPD', 'PACC', 'PAGI', 'PSTR', 'PAWR', 'PCTH', 'PCAR', 'PBTK', 'PTHA', 'PTHP', 'PPBK', 'PRBK', 'PTAK', 'PBSH', 'PPMV', 'PFMV', 'PMCV', 'PZCV', 'PRTR', 'PKAC', 'PKPR', 'PBCV'];
function roster(tgid: number, rng: () => number, offBook: number, defBook: number): TeamInput {
  const counts: Record<number, number> = { 0: 2, 1: 3, 2: 1, 3: 5, 4: 2, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 1, 12: 3, 13: 1, 14: 2, 15: 1, 16: 4, 17: 1, 18: 1, 19: 1, 20: 1 };
  const players: PlayerInput[] = []; const depthChart: TeamInput['depthChart'] = []; let id = tgid * 1000;
  for (const [pos, n] of Object.entries(counts)) for (let d = 0; d < n; d++) { const ovr = Math.round(74 - d * 6 + (rng() - 0.5) * 8); const ratings: Record<string, number> = {}; for (const k of KEYS) ratings[k] = Math.max(30, Math.min(99, Math.round(ovr + (rng() - 0.5) * 20))); players.push({ id: ++id, name: `P${id}`, number: 1 + (id % 98), pos: Number(pos), overall: ovr, ratings }); depthChart.push({ pos: Number(pos), depth: d, pgid: id }); }
  const wr = players.find((p) => p.pos === 3)!; depthChart.push({ pos: 21, depth: 0, pgid: wr.id }, { pos: 22, depth: 0, pgid: wr.id }, { pos: 23, depth: 0, pgid: players.find((p) => p.pos === 19)!.id }, { pos: 24, depth: 0, pgid: players.find((p) => p.pos === 7)!.id });
  return { id: tgid, name: `Team ${tgid}`, abbr: `T${tgid}`, logo: '', offBook, defBook, players, depthChart };
}

describe.skipIf(!have)('drawn plays in Supersim', () => {
  const spread = have ? book(106) : null!, d425 = have ? book(109) : null!;
  const form = spread?.formations.find((f) => f.n === 'Shotgun'), set = form?.sets.find((s) => s.n === 'Trey Open Offset');
  const line = Array.from({ length: 5 }, () => ({ k: 'pblock' })), runLine = Array.from({ length: 5 }, () => ({ k: 'block' }));
  const drawn: Record<string, DrawnPlay> = {
    c1: { n: 'Drawn Smash Dig', t: 0, set: set?.id ?? 0, prog: [[2, 0], [4, 0], [5, 0]], slots: [{ k: 'qb', o: { drop: 0 } }, { k: 'pblock' }, { k: 'route', p: [[0, 12], [-10, 12]] }, { k: 'route', p: [[0, 5], [1, 4]], o: { sit: 1.5 } }, { k: 'route', p: [[0, 10], [-6, 20]] }, { k: 'route', p: [[0, 8], [8, 8]] }, ...line] },
    c2: { n: 'Drawn Inside Zone', t: 0, set: set?.id ?? 0, slots: [{ k: 'handoff' }, { k: 'carry', p: [[3, 2], [4, 6], [6, 14]] }, { k: 'stalk' }, { k: 'stalk' }, { k: 'stalk' }, { k: 'block' }, ...runLine] },
    c3: { n: 'Drawn Zone Read', t: 0, set: set?.id ?? 0, slots: [{ k: 'qbopt', p: [[-4, 1], [-8, 8]] }, { k: 'carry', p: [[3, 2], [4, 8]] }, { k: 'stalk' }, { k: 'stalk' }, { k: 'route', p: [[0, 15]] }, { k: 'block', p: [[-2, 1], [-4, 3]] }, ...runLine] },
    c4: { n: 'Drawn PA Boot', t: 0, set: set?.id ?? 0, prog: [[5, 0], [2, 0]], slots: [{ k: 'qbpa', o: { fake: 1 } }, { k: 'fake', p: [[3, 1]] }, { k: 'route', p: [[0, 15], [-8, 18]] }, { k: 'route', p: [[0, 10], [8, 10]] }, { k: 'route', p: [[0, 20]] }, { k: 'route', p: [[0, 3], [-10, 4]] }, ...line] },
  };
  it('composes the drawn plays into the team book', () => {
    const e = stockEdits(spread); const fe = e.formations.find((f) => f.id === form!.id)!.sets.find((s) => s.id === set!.id)!; fe.plays.unshift('c1', 'c2', 'c3', 'c4'); e.custom = drawn;
    const b = composeBook(e, new Map([[106, spread]]), { custom: compileCustom });
    const ids = [0, 1, 2, 3].map((i) => CUSTOM_ID_BASE + i);
    for (const id of ids) { const f = findPlay(b, id); expect(f, `play ${id}`).toBeTruthy(); expect(f!.set.id).toBe(set!.id); expect(f!.play.a).toHaveLength(11); }
    expect(b.plays[String(ids[0])]!.t).toBe(103); expect(b.plays[String(ids[1])]!.t).toBe(151); expect(b.plays[String(ids[2])]!.t).toBe(169); expect(b.plays[String(ids[3])]!.t).toBe(4);
  });
  it('runs each drawn play in the engine against the stock 4-2-5 with a sane result', () => {
    const e = stockEdits(spread); const fe = e.formations.find((f) => f.id === form!.id)!.sets.find((s) => s.id === set!.id)!; fe.plays.unshift('c1', 'c2', 'c3', 'c4'); e.custom = drawn;
    const ob = composeBook(e, new Map([[106, spread]]), { custom: compileCustom }); const db = d425;
    const rng = mulberry32(21);
    const input: GameInput = { dynasty: 't', dynastyId: 1, season: 2013, week: 2, gameNo: 1, gameId: 'g', snapshot: 1, ownedTeamId: 1, quarterSeconds: 600, teams: [roster(1, rng, 106, 109), roster(2, rng, 106, 109)], backUrl: '/', home: 2, away: 1 };
    const kinds: Record<string, string[]> = {};
    for (let rep = 0; rep < 6; rep++) for (let i = 0; i < 4; i++) {
      const st: GameState = newGame(input, 300 + rep * 4 + i, `c${i}`); let guard = 0;
      // play CPU ball until team 0 has a scrimmage snap, then call the drawn play
      while (!(st.phase === 'snap' && st.off === 0) && !st.final && guard++ < 60) { const off = st.phase === 'kickoff' ? st.kicking! : st.off; const def = (1 - off) as 0 | 1; const o = off === 0 ? ob : spread; runPlay(st, input, { off: o, def: db }, { off: cpuOffense(o, st, input, off, rng), def: cpuDefense(db, st, input, def, rng) }, rng); }
      expect(st.phase).toBe('snap');
      const d = runPlay(st, input, { off: ob, def: db }, { off: CUSTOM_ID_BASE + i, def: cpuDefense(db, st, input, 1, rng) }, rng);
      expect(d.offPlay.n).toBe(drawn[`c${i + 1}`]!.n); expect(d.text.length).toBeGreaterThan(10); expect(Number.isFinite(d.yards)).toBe(true);
      expect(d.anim.actors.filter((a) => a.s === 'o')).toHaveLength(11); for (const a of d.anim.actors) expect(a.path.length).toBeGreaterThan(1);
      (kinds[`c${i + 1}`] ??= []).push(d.kind);
    }
    // the pass plays throw (or get sacked / flagged), the runs run
    expect(kinds['c1']!.every((k) => ['pass', 'incomplete', 'interception', 'sack', 'scramble', 'penalty'].includes(k)), kinds['c1']!.join()).toBe(true);
    expect(kinds['c4']!.every((k) => ['pass', 'incomplete', 'interception', 'sack', 'scramble', 'penalty'].includes(k)), kinds['c4']!.join()).toBe(true);
    expect(kinds['c2']!.every((k) => ['run', 'scramble', 'penalty', 'fumble'].includes(k)), kinds['c2']!.join()).toBe(true);
    expect(kinds['c3']!.every((k) => ['run', 'scramble', 'penalty', 'fumble'].includes(k)), kinds['c3']!.join()).toBe(true);
  });
});
