// Turns a finished coaching-mode game into the official result row + envelope the league server already understands
// (same gameResult / boxScores shape as the v1 Supersim outbox: GameResultsData fields, B* box-score field names).
import type { GameInput, GameState, PStat, Side } from './types.js';
import { ENGINE_VERSION } from './engine.js';

export function buildResult(st: GameState, input: GameInput) {
  const [away, home] = input.teams;
  const quarters: [number[], number[]] = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
  let prev: [number, number] = [0, 0];
  for (const e of st.log) { const q = Math.min(4, e.q - 1); for (const s of [0, 1] as const) quarters[s][q]! += e.s[s] - prev[s]; prev = e.s; }
  const overtime = st.ot ? st.ot.period : 0;
  return { version: ENGINE_VERSION, seed: st.seed, complete: st.final, winner: st.winner, score: st.score, overtime, quarters, plays: st.n, teams: [away.id, home.id], drives: st.drives, events: st.log, stats: st.stats, teamStats: st.team, finishedAt: new Date().toISOString() };
}

export function buildEnvelope(st: GameState, input: GameInput, { runId, blazeId, odId }: { runId: string; blazeId: number; odId: number }) {
  if (!st.final || st.winner === null) throw new Error('Incomplete games cannot be committed.');
  const r = buildResult(st, input); const [away, home] = input.teams;
  const gameResult: Record<string, number> = { ATID: away.id, HTID: home.id, ATSC: st.score[0], HTSC: st.score[1], GMWK: input.week, OTFL: r.overtime ? 1 : 0, TMID: input.ownedTeamId, CRCT: 0, STCT: 0, FLID: 0 };
  for (const [prefix, side] of [['A', 0], ['H', 1]] as const) { for (let q = 1; q <= 4; q++) gameResult[`${prefix}Q${q}S`] = r.quarters[side][q - 1]!; gameResult[`${prefix}OTS`] = r.quarters[side][4]!; }
  const boxScores: { kind: string; pgid: number; tgid: number; stats: Record<string, number> }[] = [];
  const defensiveReturns: { tgid: number; pgid: number; interceptions: number; returnYards: number; touchdowns: number }[] = [];
  for (const side of [0, 1] as const) {
    const tgid = input.teams[side].id; const t = st.team[side]; const players = Object.entries(st.stats[side]) as [string, PStat][];
    const sum = (k: keyof PStat) => players.reduce((n, [, p]) => n + p[k], 0);
    boxScores.push({ kind: 'BTES', pgid: tgid, tgid, stats: { ts1d: t.fd, tsoy: t.yds, tsop: t.py, tsor: t.ry, tspc: t.pc, tspa: t.pa, tsra: t.ra, ts3d: t.t3a, ts3c: t.t3c, tspi: sum('pi'), tsfl: sum('fum'), tspe: t.pen, tsPy: t.peny } });
    for (const [id, p] of players) {
      const pgid = Number(id), base = { pgid, tgid };
      if (p.pa || p.ra || p.rec) boxScores.push({ ...base, kind: 'BOFF', stats: { gaat: p.pa, gacm: p.pc, gaya: p.py, gatd: p.ptd, gain: p.pi, guat: p.ra, guya: p.ry, gutd: p.rtd, gufu: p.fum, gcca: p.rec, gcya: p.rey, gctd: p.retd, galN: p.lp, gulN: p.lr, gcrL: p.lc } });
      if (p.tk || p.sk || p.int) boxScores.push({ ...base, kind: 'BDEF', stats: { gdta: p.tk, glsk: p.sk, gsin: p.int } });
      if (p.fga || p.xpa || p.pt) boxScores.push({ ...base, kind: 'BKIC', stats: { gkfa: p.fga, gkfm: p.fgm, gkea: p.xpa, gkem: p.xpm, gpat: p.pt, gpya: p.pty } });
      if (p.int) defensiveReturns.push({ tgid, pgid, interceptions: p.int, returnYards: p.iry, touchdowns: p.dtd });
    }
  }
  return { version: 3, engineVersion: ENGINE_VERSION, runId, dynastyId: input.dynastyId, odId, seasonYear: input.season, week: input.week, gameNo: input.gameNo, snapshot: input.snapshot, ownedTeamId: input.ownedTeamId, blazeId, seed: st.seed, gameResult, boxScores, defensiveReturns, detail: gameDetail(st, input, r.quarters) };
}

// Everything the league server needs to build the console's per-game tables (GINF, TSGA, PG*, UWQS) for this game:
// full player lines with snaps and a starter flag, both teams' totals and the quarter scores.
// Starters: depth-chart slots a base 11 uses (2 DT, 2 CB, 3 WR; one of everything else incl. K and P).
const STARTERS: Record<number, number> = { 0: 1, 1: 1, 2: 1, 3: 3, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 1, 12: 2, 13: 1, 14: 1, 15: 1, 16: 2, 17: 1, 18: 1, 19: 1, 20: 1 };
function gameDetail(st: GameState, input: GameInput, quarters: [number[], number[]]) {
  const teams = ([0, 1] as const).map((side) => {
    const T = input.teams[side]; const starters = new Set(T.depthChart.filter((d) => d.depth < (STARTERS[d.pos] ?? 0)).map((d) => d.pgid));
    const ids = new Set([...Object.keys(st.stats[side]).map(Number), ...T.players.map((p) => p.id).filter((id) => (st.usage[String(id)] ?? 0) > 0)]);
    const pos = new Map(T.players.map((p) => [p.id, p.pos]));
    const players = [...ids].map((pgid) => ({ pgid, pos: pos.get(pgid) ?? -1, snaps: st.usage[String(pgid)] ?? 0, starter: starters.has(pgid) ? 1 : 0, ...(st.stats[side][String(pgid)] ?? {}) }));
    return { tgid: T.id, stats: st.team[side], players };
  });
  // v2: player positions, the PStat detail fields and the scoring summary (engine ScoreEv rows, side = team index)
  return { v: 2, overtime: st.ot ? st.ot.period : 0, quarters, teams, scoring: (st.sc ?? []).map((e) => ({ ...e, tgid: input.teams[e.side].id })) };
}
export const sideOf = (input: GameInput, tgid: number): Side | null => (input.teams[0].id === tgid ? 0 : input.teams[1].id === tgid ? 1 : null);
