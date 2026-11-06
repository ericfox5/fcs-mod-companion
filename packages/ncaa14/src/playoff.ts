// FCS-style 24-team playoff: field selection (conference champions + at-large by the polls), seeding and the bracket
// (top 8 seeds bye the first round; the higher seed hosts through the semifinals). Pure functions shared by the bridge,
// which writes the rounds into the console's dynasty file, and the companion site's Bracket page.

export interface PlayoffTeamInput {
  tgid: number; name?: string; cgid: number; teamType: number;
  wins: number; losses: number; confWins: number; confLosses: number;
  rankCoaches: number; rankMedia: number; overall?: number;
}
export interface SelectionOptions { size?: number; byes?: number; autoBidConfs: number[] }
export interface Seed { seed: number; tgid: number; autoBid: number | null }
export interface Selection { seeds: Seed[]; champions: { cgid: number; tgid: number }[]; size: number; byes: number }
export const PLAYOFF_ROUNDS = ['First Round', 'Second Round', 'Quarterfinals', 'Semifinals', 'Championship'] as const;

const pct = (w: number, l: number) => (w + l ? w / (w + l) : 0);
const ranked = (r: number) => (r >= 1 && r <= 25 ? r : 99);
// polls first (coaches, then media as the tiebreak), then record; the game ranks only 25 teams so the rest go by record
export function powerOrder<T extends PlayoffTeamInput>(teams: T[]): T[] {
  return [...teams].sort((a, b) => ranked(a.rankCoaches) - ranked(b.rankCoaches) || pct(b.wins, b.losses) - pct(a.wins, a.losses) || b.wins - a.wins || ranked(a.rankMedia) - ranked(b.rankMedia) || (b.overall ?? 0) - (a.overall ?? 0) || a.tgid - b.tgid);
}
// best conference record, then conference win percentage, then overall record, then the polls
export function conferenceChampion<T extends PlayoffTeamInput>(teams: T[], cgid: number): T | null {
  const members = teams.filter((t) => t.cgid === cgid && t.teamType === 0);
  if (members.length < 2) return null;
  return [...members].sort((a, b) => (b.confWins - b.confLosses) - (a.confWins - a.confLosses) || pct(b.confWins, b.confLosses) - pct(a.confWins, a.confLosses) || pct(b.wins, b.losses) - pct(a.wins, a.losses) || ranked(a.rankCoaches) - ranked(b.rankCoaches) || ranked(a.rankMedia) - ranked(b.rankMedia) || (b.overall ?? 0) - (a.overall ?? 0) || a.tgid - b.tgid)[0]!;
}
export function selectPlayoffField(teams: PlayoffTeamInput[], opts: SelectionOptions): Selection {
  const size = opts.size ?? 24, byes = opts.byes ?? 8;
  const eligible = teams.filter((t) => t.teamType === 0 && t.tgid > 0);
  const champions: { cgid: number; tgid: number }[] = [];
  for (const cgid of opts.autoBidConfs) { const c = conferenceChampion(eligible, cgid); if (c) champions.push({ cgid, tgid: c.tgid }); }
  const inField = new Set(champions.map((c) => c.tgid));
  for (const t of powerOrder(eligible)) { if (inField.size >= size) break; inField.add(t.tgid); }
  const order = powerOrder(eligible.filter((t) => inField.has(t.tgid)));
  const seeds = order.map((t, i) => ({ seed: i + 1, tgid: t.tgid, autoBid: champions.find((c) => c.tgid === t.tgid)?.cgid ?? null }));
  return { seeds, champions, size, byes };
}

// ---- bracket ----
// a slot is a seed number or the winner of an earlier game; rounds are 1-based (1 = first round, 5 = championship)
export type SlotRef = { seed: number } | { game: [number, number] };
export interface BracketGame { round: number; idx: number; a: SlotRef; b: SlotRef }
// First round pairs are ordered so that second-round game i pairs bye seed BYES[i] with first-round winner i; the
// quarterfinals pair second-round games (0,1), (2,3)... and so on up the bracket.
const R1_PAIRS: [number, number][] = [[9, 24], [16, 17], [12, 21], [13, 20], [11, 22], [14, 19], [10, 23], [15, 18]];
const R2_BYES = [8, 1, 5, 4, 6, 3, 7, 2];
export function bracket24(): BracketGame[] {
  const games: BracketGame[] = [];
  R1_PAIRS.forEach(([hi, lo], i) => games.push({ round: 1, idx: i, a: { seed: hi }, b: { seed: lo } }));
  R2_BYES.forEach((bye, i) => games.push({ round: 2, idx: i, a: { seed: bye }, b: { game: [1, i] } }));
  for (let i = 0; i < 4; i++) games.push({ round: 3, idx: i, a: { game: [2, 2 * i] }, b: { game: [2, 2 * i + 1] } });
  for (let i = 0; i < 2; i++) games.push({ round: 4, idx: i, a: { game: [3, 2 * i] }, b: { game: [3, 2 * i + 1] } });
  games.push({ round: 5, idx: 0, a: { game: [4, 0] }, b: { game: [4, 1] } });
  return games;
}
export interface ResolvedGame extends BracketGame { home: number | null; away: number | null; homeSeed: number | null; awaySeed: number | null; winner: number | null }
export type WinnerLookup = (round: number, idx: number) => number | null; // tgid of the winner once played
// Fills every slot that is known: seeds from the selection, later slots from winners. The better seed is the home team
// (hosts) in rounds 1-4; the championship keeps the better seed as "home" for bookkeeping only.
export function resolveBracket(seeds: Seed[], winnerOf: WinnerLookup): ResolvedGame[] {
  const bySeed = new Map(seeds.map((s) => [s.seed, s.tgid])), seedOf = new Map(seeds.map((s) => [s.tgid, s.seed]));
  const out: ResolvedGame[] = []; const done = new Map<string, ResolvedGame>();
  const team = (ref: SlotRef): number | null => ('seed' in ref ? bySeed.get(ref.seed) ?? null : done.get(ref.game.join(':'))?.winner ?? null);
  for (const g of bracket24()) {
    const ta = team(g.a), tb = team(g.b);
    let home: number | null = null, away: number | null = null;
    if (ta !== null && tb !== null) { const sa = seedOf.get(ta) ?? 99, sb = seedOf.get(tb) ?? 99; [home, away] = sa <= sb ? [ta, tb] : [tb, ta]; }
    const winner = home !== null && away !== null ? winnerOf(g.round, g.idx) : null;
    const r: ResolvedGame = { ...g, home, away, homeSeed: home !== null ? seedOf.get(home) ?? null : null, awaySeed: away !== null ? seedOf.get(away) ?? null : null, winner: winner !== null && (winner === home || winner === away) ? winner : null };
    done.set(`${g.round}:${g.idx}`, r); out.push(r);
  }
  return out;
}
export const roundName = (round: number) => PLAYOFF_ROUNDS[round - 1] ?? `Round ${round}`;
// Conferences that get an automatic bid by default: every real conference with at least four playing teams; the
// Independents, the generic slots and the game's unused placeholder conferences get none. A league can override by name.
const NO_AUTO_BID = /^(Independents|Generic|Historic|Fantasy|High School|Division\d*)$/i;
export function defaultAutoBidConfs(confs: { cgid: number; name: string }[], teams: PlayoffTeamInput[], override?: string[] | null): number[] {
  if (override && override.length) { const want = new Set(override.map((s) => s.trim().toLowerCase())); return confs.filter((c) => want.has(c.name.trim().toLowerCase())).map((c) => c.cgid); }
  return confs.filter((c) => !NO_AUTO_BID.test(c.name.trim()) && teams.filter((t) => t.cgid === c.cgid && t.teamType === 0).length >= 4).map((c) => c.cgid);
}

// ---- where the bracket lives in the console's postseason schedule (shared by the bridge and the site) ----
// The game keeps 37 postseason rows (SGNM 0-36): rows 0-2 are the FCS mod's conference championship games in week 16,
// the rest are bowls in weeks 18-20 and the championship in week 21. The bracket takes 23 of them, each round shown in
// its own week (quarterfinals and semifinals share week 20); the other 11 stay bowl games.
export const BRACKET_WEEKS: Record<number, number> = { 1: 18, 2: 19, 3: 20, 4: 20, 5: 21 };
export const BRACKET_ROWS: Record<number, number[]> = { 1: [3, 4, 5, 6, 19, 20, 21, 22], 2: [7, 8, 9, 10, 11, 12, 13, 14], 3: [17, 18, 23, 24], 4: [25, 26], 5: [36] };
export const PLAYOFF_ROW_SET: ReadonlySet<number> = new Set(Object.values(BRACKET_ROWS).flat());
export const roundOfRow = (sgnm: number): number | null => { for (const [r, rows] of Object.entries(BRACKET_ROWS)) if (rows.includes(sgnm)) return Number(r); return null; };
