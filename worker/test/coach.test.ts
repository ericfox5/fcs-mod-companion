// Coaching-engine invariants over whole CPU-vs-CPU games with the real playbooks (skipped when the extracted books
// are absent: run `npx tsx tools/playbooks-extract.mts` first).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { newGame, runPlay, mulberry32, lineup, findPlay, expirePlayClock } from '../src/supersim/coach/engine.js';
import { cpuOffense, cpuDefense } from '../src/supersim/coach/cpu.js';
import { buildEnvelope } from '../src/supersim/coach/result.js';
import type { Book, GameInput, PlayerInput, TeamInput, GameState } from '../src/supersim/coach/types.js';
import { syntheticRoster, autoDepthChart, isSynthetic } from '../src/supersim/generic.js';
import { DEPTH_SLOTS } from '@ncaa/ncaa14';

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
  it('plays a generic-slot team on a generated roster and keeps its placeholders out of the console envelope', () => {
    const rng = mulberry32(7);
    const players = syntheticRoster(162, '8:2025');
    expect(players).toHaveLength(54); expect(new Set(players.map((p) => p.id)).size).toBe(54); expect(players.every((p) => isSynthetic(p.id))).toBe(true);
    expect(syntheticRoster(162, '8:2025')).toEqual(players); // deterministic per dynasty/season/team
    const chart = autoDepthChart(players);
    for (const [pos, slots] of Object.entries(DEPTH_SLOTS)) expect(chart.filter((d) => d.pos === Number(pos)).length, `pos ${pos}`).toBe(slots);
    const generic: TeamInput = { id: 162, name: 'Wagner', abbr: 'WAG', logo: '', offBook: 105, defBook: 112, players, depthChart: chart, synthetic: true };
    const input: GameInput = { dynasty: 't', dynastyId: 8, season: 2025, week: 2, gameNo: 1, gameId: 'g', snapshot: 1, ownedTeamId: 1, quarterSeconds: 600, teams: [roster(1, rng, 236, 109), generic], backUrl: '/', home: 162, away: 1 };
    const st: GameState = newGame(input, 77, 'r'); let guard = 0;
    while (!st.final && guard++ < 500) {
      const off = st.phase === 'kickoff' ? st.kicking! : st.off; const def = (1 - off) as 0 | 1;
      const ob = books.get(input.teams[off].offBook)!, db = books.get(input.teams[def].defBook)!;
      runPlay(st, input, { off: ob, def: db }, { off: cpuOffense(ob, st, input, off, rng), def: cpuDefense(db, st, input, def, rng) }, rng);
    }
    expect(st.final).toBe(true);
    const env = buildEnvelope(st, input, { runId: 'x', blazeId: 1, odId: 8 });
    expect(env.boxScores.filter((b) => b.tgid === 162)).toHaveLength(1); // team totals only
    expect(env.boxScores.filter((b) => b.tgid === 162)[0]!.kind).toBe('BTES');
    expect(env.boxScores.some((b) => isSynthetic(b.pgid))).toBe(false); expect(env.defensiveReturns.some((d) => d.tgid === 162)).toBe(false);
    const d = env.detail as { teams: { tgid: number; players: unknown[]; synthetic?: boolean }[] };
    expect(d.teams.find((t) => t.tgid === 162)!.players).toHaveLength(0); expect(d.teams.find((t) => t.tgid === 162)!.synthetic).toBe(true);
    expect(d.teams.find((t) => t.tgid === 1)!.players.length).toBeGreaterThan(10);
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
  it('reports the board before and after each play, charges the play clock the coach used, and flags a delay of game', () => {
    const rng = mulberry32(21);
    const input: GameInput = { dynasty: 't', dynastyId: 1, season: 2013, week: 2, gameNo: 1, gameId: 'g', snapshot: 1, ownedTeamId: 1, quarterSeconds: 600, teams: [roster(1, rng, 236, 109), roster(2, rng, 105, 112)], backUrl: '/', home: 2, away: 1 };
    const st: GameState = newGame(input, 7, 'r'); expect(st.pc).toBe(25);
    const pair = (off: 0 | 1) => ({ off: books.get(input.teams[off].offBook)!, def: books.get(input.teams[1 - off].defBook)! });
    const call = () => { const off = st.phase === 'kickoff' ? st.kicking! : st.off; const b = pair(off); return { b, calls: { off: cpuOffense(b.off, st, input, off, rng), def: cpuDefense(b.def, st, input, (1 - off) as 0 | 1, rng) } }; };
    let guard = 0, checked = 0;
    while (st.phase !== 'snap' && guard++ < 20) { const { b, calls } = call(); runPlay(st, input, b, calls, rng); }
    while (checked < 6 && guard++ < 200 && !st.final) {
      const before = { phase: st.phase, down: st.down, toGo: st.toGo, ball: st.ball, clock: st.clock, running: st.running, pc: st.pc };
      const { b, calls } = call(); const d = runPlay(st, input, b, calls, rng, 'normal', { pcLeft: 7 });
      if (d.kind === 'clock') continue;
      expect(d.pre).toMatchObject({ phase: before.phase, down: before.down, toGo: before.toGo, ball: before.ball }); expect(d.post).toMatchObject({ down: st.down, toGo: st.toGo, ball: st.ball, clock: st.clock, score: st.score });
      if (before.phase === 'snap' && before.running) { expect(d.snap).toBe(before.clock - Math.min(before.clock, (before.pc ?? 40) - 7)); expect(d.pc).toBe(7); expect(d.pcLen).toBe(before.pc); checked++; }
      if (st.phase === 'snap' && st.q === 1) expect([25, 40]).toContain(st.pc);
    }
    expect(checked).toBe(6);
    // a delay of game from the coach's own 30 with the clock stopped: 5 yards, the down replayed, a 25-second play clock
    st.phase = 'snap'; st.ball = 30; st.down = 2; st.toGo = 6; st.running = false; st.clock = 300; st.pc = 40; st.ot = null; st.final = false; st.q = 1;
    const d = expirePlayClock(st, input);
    expect(d.kind).toBe('penalty'); expect(d.headline).toBe('DELAY OF GAME'); expect(d.yards).toBe(-5); expect(d.anim.actors).toHaveLength(0);
    expect(st.ball).toBe(25); expect(st.down).toBe(2); expect(st.toGo).toBe(11); expect(st.pc).toBe(25); expect(st.clock).toBe(300);
    // with the clock running, the game clock runs through the whole play clock first
    st.running = true; st.clock = 30; st.pc = 40; const d2 = expirePlayClock(st, input);
    expect(d2.kind).toBe('clock'); expect(st.q).toBe(2); expect(st.clock).toBe(600);
    st.running = true; st.clock = 300; st.pc = 40; st.ball = 4; st.toGo = 10; const d3 = expirePlayClock(st, input);
    expect(d3.kind).toBe('penalty'); expect(st.clock).toBe(260); expect(st.ball).toBe(2); expect(st.toGo).toBe(12);
  });
  // plays whole games; onPlay sees each detail with the state before and after it
  const playGames = (input: GameInput, rng: () => number, games: number, onPlay: (d: ReturnType<typeof runPlay>, st: GameState, before: { score: number[]; q: number; off: 0 | 1; def: 0 | 1 }) => void, until: () => boolean = () => false) => {
    for (let g = 0; g < games && !until(); g++) {
      const st: GameState = newGame(input, 300 + g, `r${g}`); let guard = 0;
      while (!st.final && guard++ < 500) {
        const off = st.phase === 'kickoff' ? st.kicking! : st.off; const def = (1 - off) as 0 | 1;
        const ob = books.get(input.teams[off].offBook)!, db = books.get(input.teams[def].defBook)!;
        const calls = { off: cpuOffense(ob, st, input, off, rng), def: cpuDefense(db, st, input, def, rng) };
        const before = { score: [...st.score], q: st.q, off, def };
        onPlay(runPlay(st, input, { off: ob, def: db }, calls, rng), st, before);
      }
    }
  };
  it('plays every punt out through the coverage and keeps a quarter that turns over in the huddle straight', () => {
    const rng = mulberry32(31);
    const input: GameInput = { dynasty: 't', dynastyId: 1, season: 2013, week: 2, gameNo: 1, gameId: 'g', snapshot: 1, ownedTeamId: 1, quarterSeconds: 600, teams: [roster(1, rng, 236, 109), roster(2, rng, 105, 112)], backUrl: '/', home: 2, away: 1 };
    let fair = 0, ret = 0, rolled = 0;
    playGames(input, rng, 20, (d, st, before) => {
      if (d.kind === 'punt' && !/BLOCKED/.test(d.text)) {
        // the whole kick is played out: the kicking team runs down the field even when it ends in a fair catch
        const covered = d.anim.actors.filter((a) => a.s === 'o').filter((a) => Math.abs(a.path[a.path.length - 1]![1]! - a.path[0]![1]!) > 15).length;
        expect(covered).toBeGreaterThanOrEqual(5);
        if (/fair catch/.test(d.text)) { fair++; expect(d.anim.events.some((e) => e.k === 'faircatch')).toBe(true); expect(d.anim.events.some((e) => e.k === 'catch')).toBe(false); }
        if (/returned/.test(d.text)) ret++;
      }
      // the clock ran out in the huddle and the quarter turned over: the play belongs to the new quarter
      if (d.pq !== before.q && d.kind !== 'clock') { rolled++; expect(d.pre?.q).toBe(d.pq); expect(d.clk0).toBe(d.snap); expect(d.anim.actors.length).toBe(22); }
      if (st.final) expect(d.post?.final).toBe(true);
    }, () => fair > 3 && ret > 3 && rolled > 0);
    expect(fair).toBeGreaterThan(0); expect(ret).toBeGreaterThan(0); expect(rolled).toBeGreaterThan(0);
  });
  it('credits a punt return touchdown and a pick six to the defense', () => {
    const rng = mulberry32(37);
    // a fast, slippery team against a slow one that cannot tackle or throw: returns and interceptions go the distance
    const fast = roster(1, rng, 236, 109), slow = roster(2, rng, 105, 112);
    for (const p of fast.players) Object.assign(p.ratings, { PSPD: 97, PACC: 97, PAGI: 97, PBTK: 95, PESV: 95, PJMV: 95, PSMV: 95, PCTH: 95, PMCV: 95, PZCV: 95, PPRS: 95, PBCV: 95 });
    for (const p of slow.players) Object.assign(p.ratings, { PSPD: 35, PACC: 35, PAGI: 35, PTAK: 25, PHIT: 25, PPRS: 30, PTHA: 30, PAWR: 30, PKPR: 50 });
    const input: GameInput = { dynasty: 't', dynastyId: 1, season: 2013, week: 2, gameNo: 1, gameId: 'g', snapshot: 1, ownedTeamId: 1, quarterSeconds: 600, teams: [fast, slow], backUrl: '/', home: 2, away: 1 };
    let prTd = 0, pick6 = 0;
    playGames(input, rng, 12, (d, st, before) => {
      const { off, def } = before;
      if (d.headline === 'PUNT RETURN TD') { prTd++; expect(st.score[def]).toBe(before.score[def]! + 6); expect(st.score[off]).toBe(before.score[off]); expect(d.scoring).toContain('punt return touchdown'); expect(st.patTeam).toBe(def); expect(st.sc?.at(-1)?.side).toBe(def); }
      if (d.headline === 'PICK SIX') { pick6++; expect(st.score[def]).toBe(before.score[def]! + 6); expect(st.score[off]).toBe(before.score[off]); expect(d.scoring).toContain('defensive touchdown'); expect(st.patTeam).toBe(def); }
    }, () => prTd > 0 && pick6 > 0);
    expect(prTd).toBeGreaterThan(0); expect(pick6).toBeGreaterThan(0);
  });
});
