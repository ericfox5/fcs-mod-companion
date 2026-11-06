// The FCS playoff. The console cannot play a bracket round by round: NCAA 14 fills every bowl row itself at the advance
// into week 16 (the conference-championship week in this mod) and again at the advance into week 18 ("Bowl Season"),
// and then simulates the whole bowl season (weeks 18-21) in one advance (DID 8, 2026-11-02: 18 -> 23 in one step,
// SGIN listing all 28 remaining games). So the bracket is played on the site (Supersim, coached or auto) while the
// console sits at week 18, and the console gets the finished bracket in one copy of its dynasty file: 23 bowl rows
// renamed, re-weeked and filled with the playoff matchups and their results, the other 11 bowls kept free of playoff
// teams, the title game in the game's championship row. The league server holds the advance (CheckAdvanceWeekStatus
// ALLW 0) until the bracket is final and the console has loaded that copy.
import type { TdbFile, TdbTable } from '@ncaa/tdb';
import { selectPlayoffField, resolveBracket, defaultAutoBidConfs, roundName, isPlayed, BRACKET_ROWS, BRACKET_WEEKS, roundOfRow, type Seed, type PlayoffTeamInput, type DynastyExport, type Game } from '@ncaa/ncaa14';

export const PLAYOFF_SIZE = 24, PLAYOFF_BYES = 8, TBD = 1023, SGIN_DETACHED = 127;
export const CCG_WEEK = 16; // the mod's three conference championship games (rows 0-2), never touched
export const BOWL_SEASON_WEEK = 18; // SEAI.SEWN while the console sits at "Bowl Season": its bowl selection is final
export const SEASON_OVER_WEEK = 23; // the first offseason week
// the week each round is shown in, with that week's SEWT code and a date for the bowl row (quarterfinals and
// semifinals share week 20 on different days; the console plays weeks 18-21 in one advance anyway)
export const ROUND_WEEKS: Record<number, { week: number; sewt: number; mon: number; day: number }> = { 1: { week: 18, sewt: 30, mon: 11, day: 29 }, 2: { week: 19, sewt: 31, mon: 12, day: 6 }, 3: { week: 20, sewt: 32, mon: 12, day: 13 }, 4: { week: 20, sewt: 32, mon: 12, day: 20 }, 5: { week: 21, sewt: 40, mon: 1, day: 5 } };
// postseason schedule rows (SGNM) that host each round, in bracket order; the other 11 bowls stay bowl games
export const ROUND_ROWS: Record<number, number[]> = BRACKET_ROWS; // packages/ncaa14/src/playoff.ts (shared with the site)
export const BOWL_NAMES: Record<number, string> = { 1: 'FCS Playoffs First Round', 2: 'FCS Playoffs Second Round', 3: 'FCS Playoffs Quarterfinal', 4: 'FCS Playoffs Semifinal', 5: 'FCS National Championship' };
export const PLAYOFF_ROWS = new Set(Object.values(ROUND_ROWS).flat());
for (const [r, w] of Object.entries(ROUND_WEEKS)) if (BRACKET_WEEKS[Number(r)] !== w.week) throw new Error(`playoff round ${r}: week ${w.week} differs from the shared layout`);
export { roundOfRow };
// the mod's own postseason rows (FCS mod, file 204): week, SEWT, bowl name and date; what a row goes back to when the
// playoff does not use it (an earlier layout had moved rows 23-27 to week 16 and renamed the championship games)
export const ORIGINAL_ROWS: Record<number, { week: number; sewt: number; name: string; mon: number; day: number }> = {
  0: { week: 16, sewt: 16, name: 'SEC Championship', mon: 12, day: 7 }, 1: { week: 16, sewt: 16, name: 'ACC Championship', mon: 12, day: 7 }, 2: { week: 16, sewt: 16, name: 'Pac-12 Championship', mon: 12, day: 7 },
  3: { week: 18, sewt: 30, name: 'New Mexico Bowl', mon: 12, day: 15 }, 4: { week: 18, sewt: 30, name: 'Famous Idaho Potato Bowl', mon: 12, day: 15 }, 5: { week: 18, sewt: 30, name: 'Barstool Arizona Bowl', mon: 12, day: 20 }, 6: { week: 18, sewt: 30, name: 'Union Home Gasparilla Bowl', mon: 12, day: 21 },
  7: { week: 19, sewt: 31, name: 'SRS Las Vegas Bowl', mon: 12, day: 22 }, 8: { week: 19, sewt: 31, name: 'R+L Carriers New Orleans Bowl', mon: 12, day: 22 }, 9: { week: 19, sewt: 31, name: "EasyPost Hawai'i Bowl", mon: 12, day: 24 }, 10: { week: 19, sewt: 31, name: 'Quick Lane Bowl', mon: 12, day: 26 },
  11: { week: 19, sewt: 31, name: 'Military Bowl', mon: 12, day: 27 }, 12: { week: 19, sewt: 31, name: "Duke's Mayo Bowl", mon: 12, day: 27 }, 13: { week: 19, sewt: 31, name: 'SDCCU Holiday Bowl', mon: 12, day: 27 }, 14: { week: 19, sewt: 31, name: 'Pop-Tarts Bowl', mon: 12, day: 28 },
  15: { week: 19, sewt: 31, name: 'Radiance Independence Bowl', mon: 12, day: 28 }, 16: { week: 19, sewt: 31, name: 'TaxAct Texas Bowl', mon: 12, day: 28 },
  17: { week: 20, sewt: 32, name: 'Lockheed Armed Forces Bowl', mon: 12, day: 29 }, 18: { week: 20, sewt: 32, name: 'LA Bowl', mon: 12, day: 29 }, 19: { week: 20, sewt: 32, name: 'Valero Alamo Bowl', mon: 12, day: 29 }, 20: { week: 20, sewt: 32, name: 'Guaranteed Rate Bowl', mon: 12, day: 29 },
  21: { week: 20, sewt: 32, name: 'Tony the Tiger Sun Bowl', mon: 12, day: 31 }, 22: { week: 20, sewt: 32, name: 'TransPerfect Music City Bowl', mon: 12, day: 31 }, 23: { week: 20, sewt: 32, name: 'AutoZone Liberty Bowl', mon: 12, day: 31 }, 24: { week: 20, sewt: 32, name: 'Chick-fil-A Peach Bowl', mon: 12, day: 31 },
  25: { week: 20, sewt: 32, name: 'Servpro First Responder Bowl', mon: 1, day: 1 }, 26: { week: 20, sewt: 32, name: 'ReliaQuest Bowl', mon: 1, day: 1 }, 27: { week: 20, sewt: 32, name: 'Cheez-It Citrus Bowl', mon: 1, day: 1 }, 28: { week: 20, sewt: 32, name: 'Rose Bowl', mon: 1, day: 1 },
  29: { week: 20, sewt: 32, name: 'TaxSlayer Gator Bowl', mon: 1, day: 1 }, 30: { week: 20, sewt: 32, name: 'Vrbo Fiesta Bowl', mon: 1, day: 1 }, 31: { week: 20, sewt: 32, name: 'Allstate Sugar Bowl', mon: 1, day: 2 }, 32: { week: 20, sewt: 32, name: 'Goodyear Cotton Bowl', mon: 1, day: 3 },
  33: { week: 20, sewt: 32, name: 'Capital One Orange Bowl', mon: 1, day: 3 }, 34: { week: 20, sewt: 32, name: 'Birmingham Bowl', mon: 1, day: 4 }, 35: { week: 20, sewt: 31, name: 'LendingTree Bowl', mon: 1, day: 5 }, 36: { week: 21, sewt: 40, name: 'CFP National Championship', mon: 1, day: 6 },
};
// where every postseason row belongs under the playoff layout
export function rowLayout(sgnm: number): { week: number; sewt: number; name: string; mon: number; day: number } | null {
  const round = roundOfRow(sgnm); const orig = ORIGINAL_ROWS[sgnm];
  if (round === null) return orig ?? null;
  const w = ROUND_WEEKS[round]!; const k = ROUND_ROWS[round]!.indexOf(sgnm);
  return { week: w.week, sewt: w.sewt, name: BOWL_NAMES[round]!, mon: w.mon, day: Math.min(31, w.day + Math.floor(k / 4)) };
}

export type PlayoffPhase = 'pending' | 'live' | 'final' | 'delivered' | 'skipped';
// one bracket game: its schedule row, teams (home = the higher seed, hosts through the semifinals), the host's stadium
// and, once the site has played it, the result (status 2 away win / 3 home win, like GSTA)
export interface PlayoffGame { round: number; idx: number; sgnm: number; home: number; away: number; stadium: number | null; status: number; hs: number; as: number; ot?: boolean }
export interface ConsolationWrite { sgnm: number; home: number; away: number }
// what the dynasty-file copy changes: the row layout (weeks, bowl names, dates) whenever it is off, and in the final
// phase every bracket game with its result plus the bowl rows that still held a playoff team. requireLoad marks the
// copy the console must load before it may advance (the league server holds the advance until it has).
export interface PlayoffPatch { weeks: boolean; games: PlayoffGame[]; consolation: ConsolationWrite[]; requireLoad?: boolean }
export interface PlayoffMemo {
  year: number; enabled: boolean; autoBidConfs?: string[] | null; phase: PlayoffPhase;
  seeds?: Seed[]; selectedAt?: number; games: PlayoffGame[]; champion?: number | null; pushedKey?: string; note?: string;
  delivered?: { file: number; matched: number; total: number };
}

export interface PostRow { i: number; sgnm: number; week: number; sewt: number; home: number; away: number; status: number; hs: number; as: number; stadium: number; ot: boolean }
export function postseasonRows(file: TdbFile): PostRow[] {
  const t = file.table('SCHD'); const out: PostRow[] = [];
  for (let i = 0; i < t.recordCount; i++) {
    const week = Number(t.get(i, 'SEWN')); if (week < CCG_WEEK) continue;
    out.push({ i, sgnm: Number(t.get(i, 'SGNM')), week, sewt: Number(t.get(i, 'SEWT')), home: Number(t.get(i, 'GHTG')), away: Number(t.get(i, 'GATG')), status: Number(t.get(i, 'GSTA')), hs: Number(t.get(i, 'GHSC')), as: Number(t.get(i, 'GASC')), stadium: Number(t.get(i, 'SGID')), ot: Number(t.get(i, 'GFOT')) === 1 });
  }
  return out.sort((a, b) => a.sgnm - b.sgnm);
}
export const weeksApplied = (rows: PostRow[]): boolean => rows.every((r) => { const l = rowLayout(r.sgnm); return !l || l.week === r.week; });
export const fieldFilled = (rows: PostRow[]): boolean => rows.length > 0 && rows.every((r) => r.home !== TBD && r.away !== TBD);
export const toPlayoffTeams = (ex: DynastyExport): PlayoffTeamInput[] => ex.teams.map((t) => ({ tgid: t.tgid, name: t.name, cgid: t.cgid, teamType: t.teamType, wins: t.wins, losses: t.losses, confWins: t.confWins, confLosses: t.confLosses, rankCoaches: t.rankCoaches, rankMedia: t.rankMedia, overall: t.overall }));
export const autoBids = (ex: DynastyExport, override?: string[] | null) => defaultAutoBidConfs(ex.conferences.map((c) => ({ cgid: c.cgid, name: c.name })), toPlayoffTeams(ex), override);
export const selectField = (ex: DynastyExport, override?: string[] | null) => selectPlayoffField(toPlayoffTeams(ex), { size: PLAYOFF_SIZE, byes: PLAYOFF_BYES, autoBidConfs: autoBids(ex, override) });

// winners of the bracket games the site has played
export const winnerOf = (memo: PlayoffMemo) => (round: number, idx: number): number | null => {
  const g = memo.games.find((x) => x.round === round && x.idx === idx);
  return !g || !(g.status >= 2) ? null : g.status === 3 ? g.home : g.away; // a memo from before the results had no status
};
// the next round whose matchups are all known but not in the memo yet (higher seed hosts, final at the title venue)
export function nextRoundGames(file: TdbFile, memo: PlayoffMemo): PlayoffGame[] {
  if (!memo.seeds) return [];
  const resolved = resolveBracket(memo.seeds, winnerOf(memo));
  const stadiumOf = new Map<number, number>(); const team = file.table('TEAM');
  for (let i = 0; i < team.recordCount; i++) stadiumOf.set(Number(team.get(i, 'TGID')), Number(team.get(i, 'SGID')));
  for (let round = 1; round <= 5; round++) {
    if (memo.games.some((g) => g.round === round)) continue;
    const games = resolved.filter((g) => g.round === round);
    if (!games.every((g) => g.home !== null && g.away !== null)) return [];
    return games.map((g) => ({ round, idx: g.idx, sgnm: ROUND_ROWS[round]![g.idx]!, home: g.home!, away: g.away!, stadium: round < 5 ? stadiumOf.get(g.home!) ?? null : null, status: 1, hs: 0, as: 0 }));
  }
  return [];
}
// results the site recorded (its playoff_state games) copied onto the memo's games; true when something changed
export interface SiteGame { round: number; idx: number; home: number; away: number; status: number; homeScore: number; awayScore: number; ot?: boolean }
export function mergeSiteResults(memo: PlayoffMemo, site: SiteGame[]): boolean {
  let changed = false;
  for (const s of site) {
    const g = memo.games.find((x) => x.round === s.round && x.idx === s.idx);
    if (!g || g.status >= 2 || s.status < 2 || s.home !== g.home || s.away !== g.away) continue;
    if (!Number.isInteger(s.homeScore) || !Number.isInteger(s.awayScore) || s.homeScore === s.awayScore) continue;
    g.status = s.homeScore > s.awayScore ? 3 : 2; g.hs = s.homeScore; g.as = s.awayScore; if (s.ot) g.ot = true; changed = true;
  }
  return changed;
}
// bowl rows (the 11 the playoff does not use) must not hold a playoff team, a team twice, or TBD once the field is set
export function consolationFixes(rows: PostRow[], ex: DynastyExport, playoffTgids: Set<number>): ConsolationWrite[] {
  const bowls = rows.filter((r) => !PLAYOFF_ROWS.has(r.sgnm) && r.week !== CCG_WEEK && r.status < 2);
  const used = new Set<number>(playoffTgids);
  const spare = toPlayoffTeams(ex).filter((t) => t.teamType === 0 && !playoffTgids.has(t.tgid));
  const order = [...spare].sort((a, b) => (b.wins - b.losses) - (a.wins - a.losses) || b.wins - a.wins || (b.overall ?? 0) - (a.overall ?? 0));
  const out: ConsolationWrite[] = [];
  for (const b of bowls) {
    const fix = (tgid: number) => { if (tgid === TBD || used.has(tgid)) { const n = order.find((t) => !used.has(t.tgid)); if (!n) return tgid; used.add(n.tgid); return n.tgid; } used.add(tgid); return tgid; };
    const home = fix(b.home), away = fix(b.away);
    if (home !== b.home || away !== b.away) out.push({ sgnm: b.sgnm, home, away });
  }
  return out;
}
// how the console's own file compares with the bracket: rows the console shows as played, and how many carry our result
export function consoleOutcome(rows: PostRow[], memo: PlayoffMemo): { total: number; played: number; matched: number } {
  let played = 0, matched = 0;
  for (const g of memo.games) {
    const r = rows.find((x) => x.sgnm === g.sgnm); if (!r || r.status < 2) continue;
    played++;
    if (r.home === g.home && r.away === g.away && r.status === g.status && r.hs === g.hs && r.as === g.as) matched++;
  }
  return { total: memo.games.length, played, matched };
}
// everything the console's current file still lacks: the layout at any time, the finished bracket in the final phase
export function playoffDiff(file: TdbFile, ex: DynastyExport, memo: PlayoffMemo): PlayoffPatch | null {
  const rows = postseasonRows(file); if (!rows.length) return null;
  const weeks = !weeksApplied(rows);
  if (memo.phase !== 'final' || !memo.seeds) return weeks ? { weeks, games: [], consolation: [] } : null;
  const games = memo.games.filter((g) => { const r = rows.find((x) => x.sgnm === g.sgnm); return !!r && r.status < 2; });
  const consolation = consolationFixes(rows, ex, new Set(memo.seeds.map((s) => s.tgid)));
  return weeks || games.length || consolation.length ? { weeks, games, consolation, requireLoad: true } : null;
}

// ---- applied to the file copy (dynasty-patch.ts calls this) ----
const rowBySgnm = (t: TdbTable, sgnm: number, postseason: boolean): number => { for (let i = 0; i < t.recordCount; i++) if (Number(t.get(i, 'SGNM')) === sgnm && (!postseason || Number(t.get(i, 'SEWN')) >= CCG_WEEK)) return i; return -1; };
const detach = (sgin: TdbTable | null, sgnm: number) => { if (sgin) for (let s = 0; s < sgin.recordCount; s++) if (Number(sgin.get(s, 'SGNM')) === sgnm) sgin.set(s, 'SGNM', SGIN_DETACHED); };
export function applyPlayoff(file: TdbFile, patch: PlayoffPatch, changes: string[]): void {
  const schd = file.table('SCHD'), bowl = file.hasTable('BOWL') ? file.table('BOWL') : null, sgin = file.hasTable('SGIN') ? file.table('SGIN') : null;
  if (patch.weeks) {
    let moved = 0, renamed = 0;
    for (let sgnm = 0; sgnm <= 36; sgnm++) {
      const l = rowLayout(sgnm); if (!l) continue;
      const i = rowBySgnm(schd, sgnm, true); if (i < 0) continue;
      if (Number(schd.get(i, 'SEWN')) !== l.week) { moved++; schd.set(i, 'SEWN', l.week); schd.set(i, 'SEWT', l.sewt); schd.set(i, 'GDAT', 5); schd.set(i, 'GTOD', Math.min(1260, 720 + (sgnm % 8) * 60)); detach(sgin, sgnm); }
      if (bowl) {
        const b = rowBySgnm(bowl, sgnm, false); if (b < 0) continue;
        if (Number(bowl.get(b, 'SEWN')) !== l.week) bowl.set(b, 'SEWN', l.week);
        const cur = String(bowl.get(b, 'BNME')).trim();
        // playoff rows take the round's name; a row the playoff does not use goes back to the mod's name only if we
        // had renamed it (a name the mod's own files never carry)
        if (cur !== l.name && (PLAYOFF_ROWS.has(sgnm) || /^FCS (Playoffs|National)/.test(cur))) { bowl.set(b, 'BNME', l.name); bowl.set(b, 'BMON', l.mon); bowl.set(b, 'BDAY', l.day); renamed++; }
      }
    }
    changes.push(`playoff layout: ${moved} row(s) re-weeked, ${renamed} bowl name(s) set`);
  }
  for (const g of patch.games) {
    const i = rowBySgnm(schd, g.sgnm, true); if (i < 0) { changes.push(`playoff ${roundName(g.round)} game ${g.idx + 1}: row ${g.sgnm} missing`); continue; }
    schd.set(i, 'GHTG', g.home); schd.set(i, 'GATG', g.away); if (g.stadium !== null) schd.set(i, 'SGID', g.stadium);
    if (g.status >= 2) { schd.set(i, 'GSTA', g.status); schd.set(i, 'GHSC', g.hs); schd.set(i, 'GASC', g.as); schd.set(i, 'GFOT', g.ot ? 1 : 0); schd.set(i, 'GFHU', 0); }
    detach(sgin, g.sgnm);
    changes.push(`playoff ${roundName(g.round)} game ${g.idx + 1} (row ${g.sgnm}, week ${ROUND_WEEKS[g.round]!.week}): ${g.away} at ${g.home}${g.status >= 2 ? ` final ${g.as}-${g.hs}` : ''}`);
  }
  for (const c of patch.consolation) {
    const i = rowBySgnm(schd, c.sgnm, true); if (i < 0) continue;
    schd.set(i, 'GHTG', c.home); schd.set(i, 'GATG', c.away); detach(sgin, c.sgnm);
    changes.push(`bowl row ${c.sgnm}: ${c.away} at ${c.home} (playoff teams moved out)`);
  }
}
// read-back check for patchDynasty
export function verifyPlayoff(file: TdbFile, patch: PlayoffPatch): string | null {
  const rows = postseasonRows(file);
  if (patch.weeks && !weeksApplied(rows)) return 'playoff layout did not read back';
  for (const g of patch.games) {
    const r = rows.find((x) => x.sgnm === g.sgnm); if (!r || r.home !== g.home || r.away !== g.away) return `playoff game row ${g.sgnm} did not read back`;
    if (g.status >= 2 && (r.status !== g.status || r.hs !== g.hs || r.as !== g.as)) return `playoff result on row ${g.sgnm} did not read back`;
  }
  for (const c of patch.consolation) { const r = rows.find((x) => x.sgnm === c.sgnm); if (!r || r.home !== c.home || r.away !== c.away) return `bowl row ${c.sgnm} did not read back`; }
  return null;
}
// the state the site shows and plays from: seeds, every bracket game with its row and result, the champion, the phase
export function siteState(memo: PlayoffMemo) {
  const games = memo.games.map((g) => ({ round: g.round, idx: g.idx, sgnm: g.sgnm, week: ROUND_WEEKS[g.round]!.week, home: g.home, away: g.away, status: g.status, homeScore: g.hs, awayScore: g.as, ...(g.ot ? { ot: true } : {}) }));
  return { seasonYear: memo.year, size: PLAYOFF_SIZE, byes: PLAYOFF_BYES, phase: memo.phase, seeds: memo.seeds ?? [], games, champion: memo.champion ?? null, ...(memo.note ? { note: memo.note } : {}), ...(memo.delivered ? { delivered: memo.delivered } : {}) };
}
// The site's view of the postseason while the bracket is open: bracket rows carry the matchups and the site's results,
// rows of rounds not yet known are TBD, the other bowls lose their playoff teams. Team records count the site's
// results while the console has not played those rows itself. Returns how many games were laid over.
export function overlayPlayoff(ex: DynastyExport, memo: PlayoffMemo | undefined): number {
  if (!memo?.seeds || memo.phase === 'skipped' || memo.phase === 'pending') return 0;
  const teams = new Map(ex.teams.map((t) => [t.tgid, t]));
  const row = (sgnm: number): Game | undefined => ex.schedule.find((x) => x.week >= CCG_WEEK && x.gameNo === sgnm);
  let laid = 0;
  for (const g of memo.games) {
    const r = row(g.sgnm); if (!r) continue;
    const consolePlayed = isPlayed(r.status) && r.homeTgid === g.home && r.awayTgid === g.away;
    const l = rowLayout(g.sgnm); if (l) { r.week = l.week; r.weekType = l.sewt; }
    r.homeTgid = g.home; r.awayTgid = g.away; if (g.stadium !== null) r.stadiumId = g.stadium;
    (r as Game & { source?: string }).source = 'playoff';
    if (g.status >= 2 && !consolePlayed) {
      r.status = g.status; r.homeScore = g.hs; r.awayScore = g.as; r.overtime = !!g.ot; r.userPlayed = false;
      const h = teams.get(g.home), a = teams.get(g.away); const [w, l2] = g.status === 3 ? [h, a] : [a, h];
      if (w) { w.wins++; w.streak = w.streak > 0 ? w.streak + 1 : 1; }
      if (l2) { l2.losses++; l2.streak = l2.streak < 0 ? l2.streak - 1 : -1; }
    } else if (g.status < 2 && !consolePlayed) { r.status = 1; r.homeScore = 0; r.awayScore = 0; }
    laid++;
  }
  const written = new Set(memo.games.map((g) => g.sgnm));
  for (const sgnm of PLAYOFF_ROWS) { if (written.has(sgnm)) continue; const r = row(sgnm); if (r && !isPlayed(r.status)) { r.homeTgid = TBD; r.awayTgid = TBD; const l = rowLayout(sgnm); if (l) { r.week = l.week; r.weekType = l.sewt; } } }
  if (memo.phase === 'live' || memo.phase === 'final') {
    const rows: PostRow[] = ex.schedule.filter((x) => x.week >= CCG_WEEK).map((x, i) => ({ i, sgnm: x.gameNo, week: x.week, sewt: x.weekType, home: x.homeTgid, away: x.awayTgid, status: x.status, hs: x.homeScore, as: x.awayScore, stadium: x.stadiumId, ot: x.overtime }));
    for (const c of consolationFixes(rows, ex, new Set(memo.seeds.map((s) => s.tgid)))) { const r = row(c.sgnm); if (r) { r.homeTgid = c.home; r.awayTgid = c.away; } }
  }
  return laid;
}
