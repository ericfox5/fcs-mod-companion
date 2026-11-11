// Simulated betting lines from rosters. A team is reduced to nine unit grades built from the players the depth chart
// actually puts on the field (starters, with the second string counting a little), each unit graded on the ratings
// that decide its job. A matchup sets each offense against the other defense, pass game against pass defense and run
// game against run defense, to get the points each side is expected to score; the spread, the total, the win
// probability and the moneylines follow from those. The scale (points per rating point, the spread of results around
// the expectation) is fitted to Supersim games on real rosters by tools/odds-calibrate.mts, so the lines describe the
// games the site actually plays. For entertainment only.

export interface OddsPlayer { id: number; pos: number; overall: number; ratings: Record<string, number> }
export interface OddsChartRow { pos: number; depth: number; pgid: number }
export interface TeamUnits {
  qb: number; rushing: number; receiving: number; passBlock: number; runBlock: number; // offense
  passRush: number; runDefense: number; coverage: number; // defense
  kicking: number; overall: number;
}
// the rating keys the unit grades read (the Worker selects only these from ratings_json)
export const ODDS_KEYS = ['PTHA', 'PTHP', 'PAWR', 'PSPD', 'PACC', 'PAGI', 'PBTK', 'PBCV', 'PTRK', 'PCTH', 'PRTR', 'PPBK', 'PRBK', 'PSTR', 'PPMV', 'PFMV', 'PBSH', 'PTAK', 'PPRC', 'PMCV', 'PZCV', 'PKAC', 'PKPR'] as const;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));

export function teamUnits(players: OddsPlayer[], chart: OddsChartRow[]): TeamUnits {
  const byId = new Map(players.map((p) => [p.id, p]));
  const v = (p: OddsPlayer, k: string) => { const n = p.ratings[k]; return Number.isFinite(n) && (n as number) > 0 ? (n as number) : p.overall; };
  // the first `n` at a position by the depth chart (then by overall when the chart is short), and the `n` after them
  const at = (pos: number, n: number): [OddsPlayer[], OddsPlayer[]] => {
    const listed = chart.filter((d) => d.pos === pos).sort((a, b) => a.depth - b.depth).map((d) => byId.get(d.pgid)).filter((p): p is OddsPlayer => !!p);
    const rest = players.filter((p) => p.pos === pos && !listed.includes(p)).sort((a, b) => b.overall - a.overall);
    const all = [...new Set([...listed, ...rest])];
    return [all.slice(0, n), all.slice(n, n * 2)];
  };
  // a unit grade: 85% the starters, 15% the men behind them (a missing second string counts as ten points worse)
  const grade = (groups: [number, number][], f: (p: OddsPlayer) => number, weights?: number[]) => {
    const first: number[] = [], second: number[] = [];
    for (const [pos, n] of groups) { const [a, b] = at(pos, n); first.push(...a.map(f)); second.push(...b.map(f)); }
    if (!first.length) return 55;
    const w = weights && weights.length === first.length ? weights : null;
    const top = w ? first.reduce((s, x, i) => s + x * w[i]!, 0) / w.reduce((a, b) => a + b, 0) : mean(first);
    return 0.85 * top + 0.15 * (second.length ? mean(second) : top - 10);
  };
  const qb = grade([[0, 1]], (p) => v(p, 'PTHA') * 0.34 + v(p, 'PTHP') * 0.18 + v(p, 'PAWR') * 0.26 + v(p, 'PSPD') * 0.1 + p.overall * 0.12);
  const rushing = grade([[1, 1]], (p) => v(p, 'PSPD') * 0.28 + v(p, 'PACC') * 0.12 + v(p, 'PBTK') * 0.22 + v(p, 'PBCV') * 0.18 + v(p, 'PTRK') * 0.1 + p.overall * 0.1);
  const receiving = grade([[3, 3], [4, 1]], (p) => v(p, 'PCTH') * 0.38 + v(p, 'PRTR') * 0.27 + v(p, 'PSPD') * 0.25 + p.overall * 0.1, [1.2, 1, 0.8, 0.8]);
  const line: [number, number][] = [[5, 1], [6, 1], [7, 1], [8, 1], [9, 1]];
  const passBlock = grade(line, (p) => v(p, 'PPBK') * 0.65 + v(p, 'PSTR') * 0.2 + v(p, 'PAWR') * 0.15);
  const runBlock = grade([...line, [4, 1]], (p) => v(p, 'PRBK') * 0.65 + v(p, 'PSTR') * 0.25 + v(p, 'PAWR') * 0.1, [1, 1, 1, 1, 1, 0.5]);
  const front: [number, number][] = [[10, 1], [11, 1], [12, 2]];
  const passRush = grade(front, (p) => Math.max(v(p, 'PPMV'), v(p, 'PFMV')) * 0.5 + v(p, 'PSTR') * 0.2 + v(p, 'PSPD') * 0.2 + v(p, 'PACC') * 0.1);
  const runDefense = grade([...front, [13, 1], [14, 1], [15, 1]], (p) => v(p, 'PBSH') * 0.35 + v(p, 'PTAK') * 0.35 + v(p, 'PPRC') * 0.15 + v(p, 'PSTR') * 0.15);
  const coverage = grade([[16, 2], [17, 1], [18, 1], [13, 1], [14, 1], [15, 1]], (p) => (v(p, 'PMCV') + v(p, 'PZCV')) * 0.33 + v(p, 'PSPD') * 0.24 + v(p, 'PAWR') * 0.1, [1.2, 1.2, 1, 1, 0.4, 0.4, 0.4]);
  const kicking = grade([[19, 1]], (p) => v(p, 'PKAC') * 0.6 + v(p, 'PKPR') * 0.4);
  const overall = mean(players.map((p) => p.overall).sort((a, b) => b - a).slice(0, 22));
  const r = (n: number) => Math.round(n * 10) / 10;
  return { qb: r(qb), rushing: r(rushing), receiving: r(receiving), passBlock: r(passBlock), runBlock: r(runBlock), passRush: r(passRush), runDefense: r(runDefense), coverage: r(coverage), kicking: r(kicking), overall: r(overall) };
}

// the offense's edge over a defense, in rating points: the pass game against pass defense and the run game against run defense
export const passOffense = (t: TeamUnits) => 0.45 * t.qb + 0.3 * t.receiving + 0.25 * t.passBlock;
export const runOffense = (t: TeamUnits) => 0.5 * t.rushing + 0.5 * t.runBlock;
export const passDefense = (t: TeamUnits) => 0.55 * t.coverage + 0.45 * t.passRush;
export const offenseEdge = (off: TeamUnits, def: TeamUnits) => 0.55 * (passOffense(off) - passDefense(def)) + 0.45 * (runOffense(off) - def.runDefense);

export interface OddsParams {
  base: number; // points for an offense with no edge
  perPoint: number; // points per rating point of edge
  homeField: number; // points; the real FCS average home edge (Massey), not something the engine simulates
  sd: number; // standard deviation of the final margin around the expected margin
  vig: number; // the book's cut per side on a moneyline (0.0476 = -110 on an even game)
}
// fitted by tools/odds-calibrate.mts: 300 Supersim games on the FCS 2026 roster, engine 4.0.0 (2026-11-10): favourites
// won 71%, and the win-probability bands came in at 48 / 63 / 70 / 79 / 98% for 50-60 / 60-70 / 70-80 / 80-90 / 90%+
export const ODDS_PARAMS: OddsParams = { base: 13.6, perPoint: 3.0, homeField: 2.3, sd: 16.5, vig: 0.0476 };

export interface Edge { side: 'home' | 'away'; label: string; by: number }
export interface Odds {
  homePoints: number; awayPoints: number; margin: number; // expected, home minus away
  spread: number; // the line on the home team: negative = home favoured, in half points (0 = pick'em)
  total: number; // over/under, in half points
  homeWin: number; awayWin: number; // probabilities
  homeMoney: number; awayMoney: number; // American odds
  edges: Edge[]; // the biggest unit mismatches, largest first
}
// the standard normal distribution function (Abramowitz-Stegun 7.1.26)
function phi(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
export function moneyline(p: number, vig = ODDS_PARAMS.vig): number {
  const q = clamp(p * (1 + vig), 0.02, 0.985);
  const raw = q >= 0.5 ? (-100 * q) / (1 - q) : (100 * (1 - q)) / q;
  const step = Math.abs(raw) >= 1000 ? 50 : Math.abs(raw) >= 300 ? 10 : 5;
  const n = Math.round(raw / step) * step;
  return n > -100 && n < 100 ? (q >= 0.5 ? -100 : 100) : clamp(n, -5000, 5000);
}
const half = (n: number) => Math.round(n * 2) / 2;

// form: points to add to a team's expected margin from its results so far this season (see seasonForm); neutral: no home edge
export function matchupOdds(home: TeamUnits, away: TeamUnits, opts: { neutral?: boolean; homeForm?: number; awayForm?: number; params?: OddsParams } = {}): Odds {
  const P = opts.params ?? ODDS_PARAMS; const hfa = opts.neutral ? 0 : P.homeField; const form = (opts.homeForm ?? 0) - (opts.awayForm ?? 0);
  const eh = offenseEdge(home, away), ea = offenseEdge(away, home);
  const kick = (home.kicking - away.kicking) * 0.03; // a better kicker is worth a point or so over a game
  const homePoints = clamp(P.base + P.perPoint * eh + hfa / 2 + form / 2 + kick / 2, 3, 70), awayPoints = clamp(P.base + P.perPoint * ea - hfa / 2 - form / 2 - kick / 2, 3, 70);
  const margin = homePoints - awayPoints; const homeWin = clamp(phi(margin / P.sd), 0.01, 0.99);
  const pairs: [string, number, 'home' | 'away'][] = [
    ['pass game against the pass defense', passOffense(home) - passDefense(away), 'home'], ['pass game against the pass defense', passOffense(away) - passDefense(home), 'away'],
    ['run game against the run defense', runOffense(home) - away.runDefense, 'home'], ['run game against the run defense', runOffense(away) - home.runDefense, 'away'],
    ['pass rush against the pass protection', home.passRush - away.passBlock, 'home'], ['pass rush against the pass protection', away.passRush - home.passBlock, 'away'],
    ['quarterback', home.qb - away.qb, 'home'], ['quarterback', away.qb - home.qb, 'away'],
    ['kicking game', home.kicking - away.kicking, 'home'], ['kicking game', away.kicking - home.kicking, 'away'],
  ];
  // an offense-against-defense pair is judged against the league-typical gap, so only real mismatches show
  const edges = pairs.map(([label, by, side]) => ({ side, label, by: Math.round(by * 10) / 10 })).filter((e) => e.by >= 2).sort((a, b) => b.by - a.by)
    .filter((e, i, all) => all.findIndex((x) => x.label === e.label) === i).slice(0, 3);
  return {
    homePoints: Math.round(homePoints * 10) / 10, awayPoints: Math.round(awayPoints * 10) / 10, margin: Math.round(margin * 10) / 10,
    spread: half(-margin) || 0, total: half(homePoints + awayPoints), homeWin: Math.round(homeWin * 1000) / 1000, awayWin: Math.round((1 - homeWin) * 1000) / 1000,
    homeMoney: moneyline(homeWin, P.vig), awayMoney: moneyline(1 - homeWin, P.vig), edges,
  };
}

// Results so far, as points of margin per game against expectation-free average: a team's mean margin, shrunk toward
// zero until it has played about six games and capped, so one blowout does not move a line by two touchdowns.
export function seasonForm(games: { home: number; away: number; homeScore: number; awayScore: number }[]): Map<number, number> {
  const sum = new Map<number, [number, number]>();
  for (const g of games) { for (const [t, m] of [[g.home, g.homeScore - g.awayScore], [g.away, g.awayScore - g.homeScore]] as const) { const cur = sum.get(t) ?? [0, 0]; sum.set(t, [cur[0] + clamp(m, -35, 35), cur[1] + 1]); } }
  return new Map([...sum].map(([t, [m, n]]) => [t, Math.round(clamp((m / n) * (n / (n + 6)) * 0.5, -8, 8) * 10) / 10]));
}
export const spreadLabel = (spread: number, homeAbbr: string, awayAbbr: string) => (spread === 0 ? 'Pick’em' : spread < 0 ? `${homeAbbr} ${spread.toFixed(1)}` : `${awayAbbr} ${(-spread).toFixed(1)}`);
export const moneyLabel = (n: number) => (n > 0 ? `+${n}` : String(n));
