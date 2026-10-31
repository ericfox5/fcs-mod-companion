// Coaching-engine invariants over whole CPU-vs-CPU games with the real playbooks (skipped when the extracted books
// are absent: run `npx tsx tools/playbooks-extract.mts` first).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { newGame, runPlay, mulberry32, lineup, findPlay } from '../src/supersim/coach/engine.js';
import { cpuOffense, cpuDefense } from '../src/supersim/coach/cpu.js';
import { buildEnvelope } from '../src/supersim/coach/result.js';
import type { Book, GameInput, PlayerInput, TeamInput, GameState } from '../src/supersim/coach/types.js';

const dir = new URL('../public/data/playbooks/', import.meta.url);
const have = existsSync(new URL('236.json', dir)) && existsSync(new URL('109.json', dir)) && existsSync(new URL('105.json', dir)) && existsSync(new URL('112.json', dir));
const book = (id: number) => JSON.parse(readFileSync(new URL(`${id}.json`, dir), 'utf8')) as Book;
const KEYS = ['PSPD', 'PACC', 'PAGI', 'PSTR', 'PAWR', 'PCTH', 'PCAR', 'PBTK', 'PTHA', 'PTHP', 'PPBK', 'PRBK', 'PTAK', 'PBSH', 'PPMV', 'PFMV', 'PMCV', 'PZCV', 'PRTR', 'PKAC', 'PKPR', 'PBCV'];
function roster(tgid: number, rng: () => number, offBook: number, defBook: number): TeamInput {
  const counts: Record<number, number> = { 0: 2, 1: 3, 2: 1, 3: 5, 4: 2, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 1, 12: 3, 13: 1, 14: 2, 15: 1, 16: 4, 17: 1, 18: 1, 19: 1, 20: 1 };
  const players: PlayerInput[] = []; const depthChart: TeamInput['depthChart'] = []; let id = tgid * 1000;
  for (const [pos, n] of Object.entries(counts)) for (let d = 0; d < n; d++) { const ovr = Math.round(74 - d * 6 + (rng() - 0.5) * 8); const ratings: Record<string, number> = {}; for (const k of KEYS) ratings[k] = Math.max(30, Math.min(99, Math.round(ovr + (rng() - 0.5) * 20))); players.push({ id: ++id, name: `P${id}`, number: 1 + (id % 98), pos: Number(pos), overall: ovr, ratings }); depthChart.push({ pos: Number(pos), depth: d, pgid: id }); }
  const wr = players.find((p) => p.pos === 3)!; depthChart.push({ pos: 21, depth: 0, pgid: wr.id }, { pos: 22, depth: 0, pgid: wr.id }, { pos: 23, depth: 0, pgid: players.find((p) => p.pos === 19)!.id }, { pos: 24, depth: 0, pgid: players.find((p) => p.pos === 7)!.id });
  return { id: tgid, name: `Team ${tgid}`, abbr: `T${tgid}`, logo: '', offBook, defBook, players, depthChart };
}
describe.skipIf(!have)('coaching engine', () => {
  const books = new Map<number, Book>(); if (have) for (const id of [236, 109, 105, 112]) books.set(id, book(id));
  it('fills every slot of every set from the depth chart without repeats', () => {
    const rng = mulberry32(5); const team = roster(1, rng, 236, 109);
    for (const id of [236, 109]) for (const f of books.get(id)!.formations) for (const s of f.sets) { const eleven = lineup(team, s); expect(eleven).toHaveLength(s.slots.length); expect(new Set(eleven.map((p) => p.id)).size).toBe(eleven.length); }
  });
  it('plays whole games to a final with sane totals and a valid envelope', () => {
    const rng = mulberry32(11); let totalPts = 0, totalPlays = 0;
    for (let g = 0; g < 4; g++) {
      const input: GameInput = { dynasty: 't', dynastyId: 1, season: 2013, week: 2, gameNo: 1, gameId: 'g', snapshot: 1, ownedTeamId: 1, quarterSeconds: 600, teams: [roster(1, rng, 236, 109), roster(2, rng, 105, 112)], backUrl: '/', home: 2, away: 1 };
      const st: GameState = newGame(input, 100 + g, `r${g}`); let guard = 0;
      while (!st.final && guard++ < 500) {
        const off = st.phase === 'kickoff' ? st.kicking! : st.off; const def = (1 - off) as 0 | 1;
        const ob = books.get(input.teams[off].offBook)!, db = books.get(input.teams[def].defBook)!;
        const calls = { off: cpuOffense(ob, st, input, off, rng), def: cpuDefense(db, st, input, def, rng) };
        expect(findPlay(ob, calls.off)).not.toBeNull(); expect(findPlay(db, calls.def)).not.toBeNull();
        const d = runPlay(st, input, { off: ob, def: db }, calls, rng);
        expect(d.anim.actors).toHaveLength(22); for (const a of d.anim.actors) for (let i = 1; i < a.path.length; i++) expect(a.path[i]![0]!).toBeGreaterThanOrEqual(a.path[i - 1]![0]!);
        expect(st.ball).toBeGreaterThanOrEqual(0); expect(st.ball).toBeLessThanOrEqual(100); expect(st.down).toBeGreaterThanOrEqual(1); expect(st.down).toBeLessThanOrEqual(4);
      }
      expect(st.final).toBe(true); expect(st.winner).not.toBeNull(); totalPts += st.score[0] + st.score[1]; totalPlays += st.n;
      const env = buildEnvelope(st, input, { runId: 'x', blazeId: 1, odId: 1 });
      expect(env.gameResult.ATSC).toBe(st.score[0]); expect(env.gameResult.HTSC).toBe(st.score[1]); expect(env.gameResult.AQ1S! + env.gameResult.AQ2S! + env.gameResult.AQ3S! + env.gameResult.AQ4S! + env.gameResult.AOTS!).toBe(st.score[0]);
      expect(env.boxScores.filter((b) => b.kind === 'BTES')).toHaveLength(2);
    }
    expect(totalPts / 8).toBeGreaterThan(8); expect(totalPts / 8).toBeLessThan(60); expect(totalPlays / 4).toBeGreaterThan(80);
  });
});
