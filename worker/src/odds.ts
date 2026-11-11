// Simulated betting lines for the site: every team's unit grades (@ncaa/ncaa14 odds.ts) from the current snapshot's
// rosters and depth charts, cached per snapshot (odds_cache, migration 0028, and per isolate), and this season's
// results as form. A page then prices any game with plain arithmetic. Everything here fails soft: without the cache
// table, or if the league cannot be read, pages simply show no lines.
import { ODDS_KEYS, matchupOdds, seasonForm, teamUnits, type Odds, type OddsChartRow, type OddsPlayer, type TeamUnits } from '@ncaa/ncaa14';
import type { Dynasty, GameRow } from './db/queries.js';
import { getGames, getTeams } from './db/queries.js';
import { autoDepthChart, syntheticRoster } from './supersim/generic.js';

export interface LeagueOdds { units: Map<number, TeamUnits>; form: Map<number, number> }
const memo = new Map<string, Map<number, TeamUnits>>();
const VERSION = 1; // bump when the unit grades change, so cached documents are rebuilt

async function computeUnits(db: D1Database, dyn: Dynasty): Promise<Map<number, TeamUnits>> {
  const cols = ODDS_KEYS.map((k) => `json_extract(ratings_json, '$.${k}') AS ${k}`).join(', ');
  const [players, chart, teams] = await Promise.all([
    db.prepare(`SELECT pgid, tgid, pos, overall, ${cols} FROM players WHERE dynasty_id = ? AND redshirt <> 1`).bind(dyn.id).all<Record<string, number>>(),
    db.prepare('SELECT tgid, pos, depth, pgid FROM depth_chart WHERE dynasty_id = ? AND snapshot_id = ?').bind(dyn.id, dyn.current_snapshot_id ?? 0).all<{ tgid: number; pos: number; depth: number; pgid: number }>(),
    getTeams(db, dyn.id),
  ]);
  const byTeam = new Map<number, OddsPlayer[]>(); const charts = new Map<number, OddsChartRow[]>();
  for (const r of players.results) {
    const ratings: Record<string, number> = {}; for (const k of ODDS_KEYS) ratings[k] = Number(r[k]) || 0;
    const tgid = r['tgid']!; (byTeam.get(tgid) ?? byTeam.set(tgid, []).get(tgid)!).push({ id: r['pgid']!, pos: r['pos']!, overall: r['overall']!, ratings });
  }
  for (const r of chart.results) (charts.get(r.tgid) ?? charts.set(r.tgid, []).get(r.tgid)!).push({ pos: r.pos, depth: r.depth, pgid: r.pgid });
  const out = new Map<number, TeamUnits>();
  for (const t of teams) {
    let ps = byTeam.get(t.tgid) ?? []; let ch = charts.get(t.tgid) ?? [];
    // the generic FCS slots have no roster in the game: the same placeholders Supersim plays them with
    if (ps.length < 22) { const synth = syntheticRoster(t.tgid, `${dyn.id}:${dyn.season_year}`); ps = synth.map((p) => ({ id: p.id, pos: p.pos, overall: p.overall, ratings: p.ratings })); ch = autoDepthChart(synth); }
    out.set(t.tgid, teamUnits(ps, ch));
  }
  return out;
}

export async function leagueOdds(db: D1Database, dyn: Dynasty): Promise<LeagueOdds | null> {
  try {
    const snapshot = dyn.current_snapshot_id ?? 0; const key = `${dyn.id}:${snapshot}:${VERSION}`;
    let units = memo.get(key);
    if (!units) {
      const row = await db.prepare('SELECT snapshot_id, data_json FROM odds_cache WHERE dynasty_id = ?').bind(dyn.id).first<{ snapshot_id: number; data_json: string }>().catch(() => null);
      if (row && row.snapshot_id === snapshot) { try { const doc = JSON.parse(row.data_json) as { v: number; units: [number, TeamUnits][] }; if (doc.v === VERSION) units = new Map(doc.units); } catch { /* rebuilt below */ } }
      if (!units) {
        units = await computeUnits(db, dyn);
        // no table yet (migration 0028 not applied): the grades live in this isolate only
        await db.prepare("INSERT INTO odds_cache (dynasty_id, snapshot_id, data_json, updated_at) VALUES (?,?,?, datetime('now')) ON CONFLICT(dynasty_id) DO UPDATE SET snapshot_id = excluded.snapshot_id, data_json = excluded.data_json, updated_at = datetime('now')")
          .bind(dyn.id, snapshot, JSON.stringify({ v: VERSION, units: [...units] })).run().catch(() => undefined);
      }
      if (memo.size > 8) memo.clear();
      memo.set(key, units);
    }
    const played = await getGames(db, dyn.id, dyn.season_year, { playedOnly: true });
    const form = seasonForm(played.map((g) => ({ home: g.home_tgid, away: g.away_tgid, homeScore: g.home_score, awayScore: g.away_score })));
    return { units, form };
  } catch (e) { console.error('odds unavailable', (e as Error)?.message ?? e); return null; }
}

// the line for one game, or null when a side is not a real team yet (a playoff slot still to be decided)
export function gameOdds(lo: LeagueOdds | null, g: Pick<GameRow, 'home_tgid' | 'away_tgid'>, opts: { neutral?: boolean } = {}): Odds | null {
  if (!lo) return null; const h = lo.units.get(g.home_tgid), a = lo.units.get(g.away_tgid);
  if (!h || !a || g.home_tgid === 1023 || g.away_tgid === 1023 || g.home_tgid >= 300 || g.away_tgid >= 300) return null;
  return matchupOdds(h, a, { neutral: opts.neutral, homeForm: lo.form.get(g.home_tgid) ?? 0, awayForm: lo.form.get(g.away_tgid) ?? 0 });
}

// ---- closing lines (game_lines, migration 0029) -------------------------------------------------------------------------
export interface LineRow { week: number; game_no: number; spread: number; total: number; home_win: number; home_money: number; away_money: number }
// Price this week's and next week's unplayed games and keep the lines: called after an import commit and at a Supersim
// kickoff, so the last row written before a game is played is the line it closed at. Fails soft (no table, no league).
export async function recordLines(db: D1Database, dyn: Dynasty): Promise<number> {
  try {
    const lo = await leagueOdds(db, dyn); if (!lo) return 0;
    const week = dyn.week ?? 0; const games = (await getGames(db, dyn.id, dyn.season_year)).filter((g) => g.status < 2 && g.week >= week && g.week <= week + 1);
    const rows: (number)[][] = [];
    for (const g of games) { const o = gameOdds(lo, g); if (o) rows.push([g.week, g.game_no, o.spread, o.total, Math.round(o.homeWin * 1000) / 1000, o.homeMoney, o.awayMoney]); }
    if (!rows.length) return 0;
    await db.prepare(`INSERT INTO game_lines (dynasty_id, season_year, week, game_no, spread, total, home_win, home_money, away_money, snapshot_id, updated_at)
      SELECT ?1, ?2, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'), ?3, datetime('now') FROM json_each(?4) WHERE true
      ON CONFLICT(dynasty_id, season_year, week, game_no) DO UPDATE SET spread = excluded.spread, total = excluded.total, home_win = excluded.home_win, home_money = excluded.home_money, away_money = excluded.away_money, snapshot_id = excluded.snapshot_id, updated_at = excluded.updated_at`)
      .bind(dyn.id, dyn.season_year, dyn.current_snapshot_id ?? 0, JSON.stringify(rows)).run();
    return rows.length;
  } catch (e) { console.error('closing lines not recorded', (e as Error)?.message ?? e); return 0; }
}
// the stored lines of one week (or one game), by game number; empty without the table
export async function storedLines(db: D1Database, dyn: Dynasty, week: number, gameNo?: number): Promise<Map<number, LineRow>> {
  try {
    const q = gameNo === undefined
      ? db.prepare('SELECT week, game_no, spread, total, home_win, home_money, away_money FROM game_lines WHERE dynasty_id = ? AND season_year = ? AND week = ?').bind(dyn.id, dyn.season_year, week)
      : db.prepare('SELECT week, game_no, spread, total, home_win, home_money, away_money FROM game_lines WHERE dynasty_id = ? AND season_year = ? AND week = ? AND game_no = ?').bind(dyn.id, dyn.season_year, week, gameNo);
    return new Map((await q.all<LineRow>()).results.map((r) => [r.game_no, r]));
  } catch { return new Map(); }
}
