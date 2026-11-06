import { describe, it, expect } from 'vitest';
import { selectPlayoffField, resolveBracket, bracket24, powerOrder, conferenceChampion, defaultAutoBidConfs, type PlayoffTeamInput } from '../src/playoff.js';

// 40 teams in 5 conferences of 8; ranks for the first 25 by overall strength
function league(): PlayoffTeamInput[] {
  const out: PlayoffTeamInput[] = [];
  for (let i = 0; i < 40; i++) {
    const wins = 11 - Math.floor(i / 4), losses = 11 - wins; const cw = Math.max(0, 7 - (i % 8)), cl = 7 - cw;
    out.push({ tgid: 100 + i, name: `T${i}`, cgid: i % 5, teamType: 0, wins, losses, confWins: cw, confLosses: cl, rankCoaches: i < 25 ? i + 1 : 0, rankMedia: i < 25 ? i + 1 : 0, overall: 90 - i });
  }
  out.push({ tgid: 162, name: 'Generic', cgid: 17, teamType: 1, wins: 12, losses: 0, confWins: 0, confLosses: 0, rankCoaches: 0, rankMedia: 0, overall: 99 });
  return out;
}
describe('FCS playoff', () => {
  it('seeds 24 teams with every auto-bid champion in and generic slots out', () => {
    const teams = league();
    const sel = selectPlayoffField(teams, { autoBidConfs: [0, 1, 2, 3, 4] });
    expect(sel.seeds).toHaveLength(24); expect(sel.champions).toHaveLength(5);
    expect(sel.seeds.map((s) => s.seed)).toEqual([...Array(24)].map((_, i) => i + 1));
    expect(new Set(sel.seeds.map((s) => s.tgid)).size).toBe(24);
    expect(sel.seeds.some((s) => s.tgid === 162)).toBe(false);
    for (const c of sel.champions) expect(sel.seeds.some((s) => s.tgid === c.tgid && s.autoBid === c.cgid)).toBe(true);
    expect(sel.seeds[0]!.tgid).toBe(100); // the #1 ranked team is the 1 seed
    expect(sel.seeds.filter((s) => s.autoBid === null)).toHaveLength(19);
  });
  it('orders by the coaches poll first, then record, and picks conference champions by conference record', () => {
    const teams = league();
    const order = powerOrder(teams); expect(order[0]!.rankCoaches).toBe(1); expect(order[24]!.rankCoaches).toBe(25); expect(order[25]!.rankCoaches).toBe(0);
    const champ = conferenceChampion(teams, 2)!; expect(champ.confWins).toBe(7);
    expect(conferenceChampion(teams, 17)).toBeNull(); // one generic team is not a conference race
  });
  it('builds a 24-team bracket whose byes meet first-round winners and resolves it round by round', () => {
    const sel = selectPlayoffField(league(), { autoBidConfs: [0, 1, 2, 3, 4] });
    const games = bracket24(); expect(games).toHaveLength(23);
    expect(games.filter((g) => g.round === 1)).toHaveLength(8); expect(games.filter((g) => g.round === 5)).toHaveLength(1);
    const results = new Map<string, number>();
    const winnerOf = (r: number, i: number) => results.get(`${r}:${i}`) ?? null;
    let state = resolveBracket(sel.seeds, winnerOf);
    const r1 = state.filter((g) => g.round === 1); expect(r1.every((g) => g.home !== null && g.away !== null)).toBe(true);
    expect(r1.map((g) => `${g.homeSeed}v${g.awaySeed}`)).toEqual(['9v24', '16v17', '12v21', '13v20', '11v22', '14v19', '10v23', '15v18']);
    expect(state.filter((g) => g.round === 2).every((g) => g.away === null)).toBe(true); // byes wait for winners
    for (let round = 1; round <= 5; round++) {
      for (const g of state.filter((x) => x.round === round)) results.set(`${round}:${g.idx}`, g.home!); // home (better seed) wins every game
      state = resolveBracket(sel.seeds, winnerOf);
      if (round < 5) expect(state.filter((x) => x.round === round + 1).every((g) => g.home !== null && g.away !== null)).toBe(true);
    }
    const final = state.find((g) => g.round === 5)!; expect(final.homeSeed).toBe(1); expect(final.awaySeed).toBe(2); expect(final.winner).toBe(sel.seeds[0]!.tgid);
    const r2 = state.filter((g) => g.round === 2); expect(r2.map((g) => g.homeSeed)).toEqual([8, 1, 5, 4, 6, 3, 7, 2]);
    expect(r2[1]!.awaySeed).toBe(16); // 1 seed meets the 16/17 winner
  });
  it('ignores a winner that is not one of the two teams', () => {
    const sel = selectPlayoffField(league(), { autoBidConfs: [0] });
    const state = resolveBracket(sel.seeds, () => 999);
    expect(state.every((g) => g.winner === null)).toBe(true);
  });
  it('gives automatic bids to real conferences with four or more teams unless overridden', () => {
    const teams = league();
    const confs = [{ cgid: 0, name: 'CAA' }, { cgid: 1, name: 'Big Sky' }, { cgid: 2, name: 'MVFC' }, { cgid: 3, name: 'Independents' }, { cgid: 4, name: 'Ivy League' }, { cgid: 17, name: 'Generic' }, { cgid: 20, name: 'Division4' }];
    expect(defaultAutoBidConfs(confs, teams)).toEqual([0, 1, 2, 4]);
    expect(defaultAutoBidConfs(confs, teams, ['caa', 'MVFC'])).toEqual([0, 2]);
  });
});
