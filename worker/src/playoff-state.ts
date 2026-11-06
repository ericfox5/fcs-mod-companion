// The FCS playoff as the site plays it (migration 0021 playoff_state, one row per dynasty and season). The bridge
// selects the field from the console's week-18 file and sends it here; the bracket games are then Supersim games on
// the postseason rows of the schedule (week = the round's week, game_no = the bowl row the bracket uses), coached by
// the members whose teams are in them or auto-played; every final lands here, the next round's matchups follow at
// once, and the bridge takes the results back to the console when the champion is known.
import { resolveBracket, BRACKET_ROWS, BRACKET_WEEKS, PLAYOFF_ROW_SET, roundOfRow, type Seed } from '@ncaa/ncaa14';
import { getPlayoffState, putPlayoffState, type Dynasty } from './db/queries.js';

export type PlayoffPhase = 'pending' | 'live' | 'final' | 'delivered' | 'skipped';
export interface StateGame { round: number; idx: number; sgnm: number; week: number; home: number; away: number; status: number; homeScore: number; awayScore: number; ot?: boolean; runId?: string }
export interface PlayoffState { seasonYear: number; size: number; byes: number; phase: PlayoffPhase; seeds: Seed[]; games: StateGame[]; champion: number | null; note?: string; delivered?: { file: number; matched: number; total: number } }
export const TBD = 1023;

export async function loadPlayoff(db: D1Database, dyn: Dynasty, year = dyn.season_year): Promise<PlayoffState | null> {
  const row = await getPlayoffState(db, dyn.id, year); if (!row) return null;
  try { const s = JSON.parse(row.state_json) as Partial<PlayoffState>; return normalize(s, year); } catch { return null; }
}
export function normalize(s: Partial<PlayoffState>, year: number): PlayoffState {
  const seeds = Array.isArray(s.seeds) ? s.seeds : [];
  const games = (Array.isArray(s.games) ? s.games : []).map((g) => ({ round: Number(g.round), idx: Number(g.idx), sgnm: Number(g.sgnm ?? BRACKET_ROWS[Number(g.round)]?.[Number(g.idx)] ?? -1), week: Number(g.week ?? BRACKET_WEEKS[Number(g.round)] ?? 0), home: Number(g.home), away: Number(g.away), status: Number(g.status) || 1, homeScore: Number(g.homeScore) || 0, awayScore: Number(g.awayScore) || 0, ...(g.ot ? { ot: true } : {}), ...(g.runId ? { runId: String(g.runId) } : {}) }));
  const phase: PlayoffPhase = (['pending', 'live', 'final', 'delivered', 'skipped'] as const).includes(s.phase as PlayoffPhase) ? (s.phase as PlayoffPhase) : seeds.length ? 'live' : 'pending';
  return { seasonYear: year, size: Number(s.size) || 24, byes: Number(s.byes) || 8, phase, seeds, games, champion: s.champion ?? null, ...(s.note ? { note: String(s.note) } : {}), ...(s.delivered ? { delivered: s.delivered } : {}) };
}
export const savePlayoff = (db: D1Database, dyn: Dynasty, state: PlayoffState) => putPlayoffState(db, dyn.id, state.seasonYear, JSON.stringify(state));
export const winnerOf = (state: PlayoffState) => (round: number, idx: number): number | null => { const g = state.games.find((x) => x.round === round && x.idx === idx); return !g || g.status < 2 ? null : g.status === 3 ? g.home : g.away; };
export const playoffGameAt = (state: PlayoffState | null, week: number, gameNo: number): StateGame | null => state?.games.find((g) => g.week === week && g.sgnm === gameNo) ?? null;
// a bracket game can be played when the field is set, its teams are known and it has no result
export const playoffGameOpen = (state: PlayoffState | null, g: StateGame | null): boolean => !!state && !!g && (state.phase === 'live') && g.home !== TBD && g.away !== TBD && g.status < 2;

// The bridge's state merged over what the site already holds: results the site recorded stay unless the bridge
// sends a final for the same matchup (it only does so from the console's own file).
export function mergeFromBridge(prev: PlayoffState | null, incoming: Partial<PlayoffState>, year: number): PlayoffState {
  const next = normalize(incoming, year);
  if (prev) {
    next.games = next.games.map((g) => {
      const p = prev.games.find((x) => x.round === g.round && x.idx === g.idx);
      if (p && p.status >= 2 && g.status < 2 && p.home === g.home && p.away === g.away) return { ...g, status: p.status, homeScore: p.homeScore, awayScore: p.awayScore, ...(p.ot ? { ot: true } : {}), ...(p.runId ? { runId: p.runId } : {}) };
      if (p?.runId && !g.runId) return { ...g, runId: p.runId };
      return g;
    });
    // rounds the site already resolved from its own results but the bridge has not seen yet
    for (const p of prev.games) if (!next.games.some((g) => g.round === p.round && g.idx === p.idx) && next.seeds.length) next.games.push(p);
    if (next.champion === null && prev.champion !== null && next.phase !== 'skipped') next.champion = prev.champion;
  }
  return fillNextRounds(next);
}
// every round whose matchups follow from the results so far, added as scheduled games
export function fillNextRounds(state: PlayoffState): PlayoffState {
  if (!state.seeds.length || state.phase === 'skipped') return state;
  const resolved = resolveBracket(state.seeds, winnerOf(state));
  for (let round = 1; round <= 5; round++) {
    if (state.games.some((g) => g.round === round)) continue;
    const games = resolved.filter((g) => g.round === round);
    if (!games.every((g) => g.home !== null && g.away !== null)) break;
    for (const g of games) state.games.push({ round, idx: g.idx, sgnm: BRACKET_ROWS[round]![g.idx]!, week: BRACKET_WEEKS[round]!, home: g.home!, away: g.away!, status: 1, homeScore: 0, awayScore: 0 });
  }
  const final = state.games.find((g) => g.round === 5 && g.idx === 0);
  if (final && final.status >= 2) { state.champion = final.status === 3 ? final.home : final.away; if (state.phase === 'live') state.phase = 'final'; }
  state.games.sort((a, b) => a.round - b.round || a.idx - b.idx);
  return state;
}
// A bracket game's final from Supersim: the state, the champion and the next round, then the schedule rows.
export async function recordPlayoffResult(db: D1Database, dyn: Dynasty, week: number, gameNo: number, r: { homeScore: number; awayScore: number; ot: boolean; runId: string }): Promise<PlayoffState | null> {
  const state = await loadPlayoff(db, dyn); const g = playoffGameAt(state, week, gameNo);
  if (!state || !g || !playoffGameOpen(state, g) || r.homeScore === r.awayScore) return null;
  g.status = r.homeScore > r.awayScore ? 3 : 2; g.homeScore = r.homeScore; g.awayScore = r.awayScore; if (r.ot) g.ot = true; g.runId = r.runId;
  fillNextRounds(state);
  await savePlayoff(db, dyn, state);
  await syncPlayoffGames(db, dyn, state);
  return state;
}
// The schedule rows the site shows: bracket games carry their teams and results (source 'playoff'), bracket rows of
// rounds still unknown show TBD. Rows come from the console's file (the bridge import, which lays the same bracket
// over them); a row the console already played with these teams keeps the console's result.
export async function syncPlayoffGames(db: D1Database, dyn: Dynasty, state: PlayoffState): Promise<number> {
  if (!state.seeds.length || state.phase === 'skipped' || state.phase === 'pending') return 0;
  const y = state.seasonYear;
  const rows = (await db.prepare('SELECT week, game_no, status, home_tgid, away_tgid, source FROM games WHERE dynasty_id=? AND season_year=? AND week>=16').bind(dyn.id, y).all<{ week: number; game_no: number; status: number; home_tgid: number; away_tgid: number; source: string }>()).results;
  const stmts: D1PreparedStatement[] = [];
  const move = (row: { week: number; game_no: number }, week: number) => {
    if (row.week === week) return;
    stmts.push(db.prepare(`INSERT OR REPLACE INTO games (dynasty_id, season_year, week, game_no, snapshot_id, status, home_tgid, away_tgid, home_score, away_score, stadium_id, kickoff_minutes, day_of_week, week_type, overtime, user_played, user_team_game, cpu_pick, home_pick, source)
      SELECT dynasty_id, season_year, ?, game_no, snapshot_id, status, home_tgid, away_tgid, home_score, away_score, stadium_id, kickoff_minutes, day_of_week, week_type, overtime, user_played, user_team_game, cpu_pick, home_pick, source FROM games WHERE dynasty_id=? AND season_year=? AND week=? AND game_no=?`).bind(week, dyn.id, y, row.week, row.game_no));
    stmts.push(db.prepare('DELETE FROM games WHERE dynasty_id=? AND season_year=? AND week=? AND game_no=?').bind(dyn.id, y, row.week, row.game_no));
  };
  let n = 0;
  for (const g of state.games) {
    const row = rows.find((x) => x.game_no === g.sgnm); if (!row) continue;
    const consolePlayed = row.status >= 2 && row.source !== 'playoff' && row.source !== 'supersim' && row.home_tgid === g.home && row.away_tgid === g.away;
    move(row, g.week);
    if (consolePlayed) { stmts.push(db.prepare("UPDATE games SET source='playoff' WHERE dynasty_id=? AND season_year=? AND week=? AND game_no=?").bind(dyn.id, y, g.week, g.sgnm)); n++; continue; }
    stmts.push(db.prepare("UPDATE games SET home_tgid=?, away_tgid=?, status=?, home_score=?, away_score=?, overtime=?, source='playoff' WHERE dynasty_id=? AND season_year=? AND week=? AND game_no=?")
      .bind(g.home, g.away, g.status >= 2 ? g.status : 1, g.status >= 2 ? g.homeScore : 0, g.status >= 2 ? g.awayScore : 0, g.ot ? 1 : 0, dyn.id, y, g.week, g.sgnm));
    n++;
  }
  const written = new Set(state.games.map((g) => g.sgnm));
  for (const row of rows) {
    if (!PLAYOFF_ROW_SET.has(row.game_no) || written.has(row.game_no) || row.status >= 2) continue;
    const round = roundOfRow(row.game_no)!; const week = BRACKET_WEEKS[round]!;
    move(row, week);
    stmts.push(db.prepare("UPDATE games SET home_tgid=?, away_tgid=?, status=1, home_score=0, away_score=0, source='playoff' WHERE dynasty_id=? AND season_year=? AND week=? AND game_no=?").bind(TBD, TBD, dyn.id, y, week, row.game_no));
  }
  if (stmts.length) await db.batch(stmts);
  return n;
}
