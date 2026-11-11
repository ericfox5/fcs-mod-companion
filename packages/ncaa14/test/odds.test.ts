import { describe, it, expect } from 'vitest';
import { matchupOdds, moneyline, seasonForm, spreadLabel, teamUnits, ODDS_KEYS, type OddsChartRow, type OddsPlayer } from '../src/odds.js';

// a full two-deep at every position, every rating at `level` (the second string eight points lower)
function team(level: number, tweak: (p: OddsPlayer) => void = () => {}): { players: OddsPlayer[]; chart: OddsChartRow[] } {
  const counts: Record<number, number> = { 0: 1, 1: 1, 3: 3, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 1, 12: 2, 13: 1, 14: 1, 15: 1, 16: 2, 17: 1, 18: 1, 19: 1 };
  const players: OddsPlayer[] = [], chart: OddsChartRow[] = []; let id = 1;
  for (const [pos, n] of Object.entries(counts)) for (let d = 0; d < n * 2; d++) {
    const ovr = d < n ? level : level - 8; const p: OddsPlayer = { id: id++, pos: Number(pos), overall: ovr, ratings: Object.fromEntries(ODDS_KEYS.map((k) => [k, ovr])) };
    tweak(p); players.push(p); chart.push({ pos: Number(pos), depth: d, pgid: p.id });
  }
  return { players, chart };
}
const units = (level: number, tweak?: (p: OddsPlayer) => void) => { const t = team(level, tweak); return teamUnits(t.players, t.chart); };

describe('team unit grades', () => {
  it('grades a flat roster at its level, a little under for the second string', () => {
    const u = units(80);
    for (const k of ['qb', 'rushing', 'receiving', 'passBlock', 'runBlock', 'passRush', 'runDefense', 'coverage', 'kicking'] as const) { expect(u[k]).toBeGreaterThan(78); expect(u[k]).toBeLessThanOrEqual(80); }
  });
  it('follows the depth chart: the listed starter counts, not the best player on the roster', () => {
    const t = team(75); const qbs = t.players.filter((p) => p.pos === 0); qbs[1]!.overall = 95; for (const k of ODDS_KEYS) qbs[1]!.ratings[k] = 95;
    const benched = teamUnits(t.players, t.chart).qb;
    const started = teamUnits(t.players, t.chart.map((c) => (c.pos === 0 ? { ...c, depth: 1 - c.depth } : c))).qb;
    expect(started).toBeGreaterThan(benched + 10);
  });
  it('only moves the unit a rating belongs to', () => {
    const base = units(78), rush = units(78, (p) => { if (p.pos >= 10 && p.pos <= 12) { p.ratings['PPMV'] = 95; p.ratings['PFMV'] = 95; } });
    expect(rush.passRush).toBeGreaterThan(base.passRush + 5); expect(rush.coverage).toBe(base.coverage); expect(rush.qb).toBe(base.qb);
  });
});

describe('matchup odds', () => {
  it('prices an even game by the home edge alone and a neutral one as a pick', () => {
    const a = units(78), o = matchupOdds(a, a);
    expect(o.margin).toBeCloseTo(2.3, 1); expect(o.spread).toBe(-2.5); expect(o.homeWin).toBeGreaterThan(0.5); expect(o.homeWin).toBeLessThan(0.6);
    const n = matchupOdds(a, a, { neutral: true });
    expect(n.spread).toBe(0); expect(n.homeWin).toBe(0.5); expect(n.homeMoney).toBe(n.awayMoney); expect(n.homeMoney).toBe(-110);
    expect(spreadLabel(n.spread, 'HOME', 'AWAY')).toBe('Pick’em');
  });
  it('favours the better roster, more the bigger the gap, and mirrors when the sides swap', () => {
    const strong = units(86), mid = units(80), weak = units(72);
    const close = matchupOdds(strong, mid, { neutral: true }), wide = matchupOdds(strong, weak, { neutral: true }), flipped = matchupOdds(weak, strong, { neutral: true });
    expect(close.spread).toBeLessThan(0); expect(wide.spread).toBeLessThan(close.spread); expect(wide.homeWin).toBeGreaterThan(close.homeWin);
    expect(flipped.spread).toBe(-wide.spread); expect(flipped.homeWin).toBeCloseTo(wide.awayWin, 3); expect(flipped.total).toBe(wide.total);
    expect(spreadLabel(wide.spread, 'HOME', 'AWAY')).toMatch(/^HOME -\d+\.\d$/); expect(spreadLabel(flipped.spread, 'HOME', 'AWAY')).toMatch(/^AWAY -\d+\.\d$/);
  });
  it('keeps the probabilities and moneylines consistent', () => {
    const o = matchupOdds(units(80), units(78));
    expect(o.homeWin + o.awayWin).toBeCloseTo(1, 3); expect(o.homeMoney).toBeLessThan(-100); expect(o.awayMoney).toBeGreaterThan(100);
    expect(o.spread * 2).toBe(Math.round(o.spread * 2)); expect(o.total * 2).toBe(Math.round(o.total * 2));
    // the favourite's price implies more than his true chance (the book's cut), and prices are monotone in probability
    expect(-o.homeMoney / (100 - o.homeMoney)).toBeGreaterThan(o.homeWin);
    const ps = [0.05, 0.2, 0.4, 0.5, 0.6, 0.8, 0.95].map((p) => moneyline(p)); const implied = ps.map((m) => (m < 0 ? -m / (100 - m) : 100 / (100 + m)));
    for (let i = 1; i < implied.length; i++) expect(implied[i]!).toBeGreaterThan(implied[i - 1]!);
  });
  it('names the real mismatches and moves the line with form', () => {
    const passers = units(78, (p) => { if (p.pos === 0 || p.pos === 3) for (const k of ODDS_KEYS) p.ratings[k] = 96; }), plain = units(78);
    const o = matchupOdds(passers, plain, { neutral: true });
    expect(o.edges[0]!.side).toBe('home'); expect(o.edges.map((e) => e.label)).toContain('quarterback'); expect(o.edges.length).toBeLessThanOrEqual(3);
    expect(matchupOdds(plain, plain, { neutral: true, homeForm: 6 }).spread).toBe(-6);
  });
});

describe('season form', () => {
  it('shrinks a short record and caps a long one', () => {
    const blowout = seasonForm([{ home: 1, away: 2, homeScore: 63, awayScore: 0 }]);
    expect(blowout.get(1)!).toBeGreaterThan(0); expect(blowout.get(1)!).toBeLessThan(4); expect(blowout.get(2)).toBe(-blowout.get(1)!);
    const season = seasonForm(Array.from({ length: 10 }, () => ({ home: 1, away: 2, homeScore: 45, awayScore: 10 })));
    expect(season.get(1)).toBe(8); expect(season.get(2)).toBe(-8);
  });
});
