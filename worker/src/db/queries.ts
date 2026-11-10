import type { BookEdits } from '@ncaa/ncaa14';

export interface Dynasty {
  id: number; slug: string; name: string; season_year: number; start_year: number | null; week: number; stage: number; week_type: number | null; current_snapshot_id: number | null; updated_at: string | null;
  // online dynasty (Blaze stub) fields; NULL for dynasties imported from an offline save
  od_id: number | null; abbr: string | null; description: string | null; state: number | null; od_file_id: number | null; od_file_saved_at: number | null; od_created_at: number | null; settings_json: string;
  member_count?: number;
}
export interface MemberRow { blaze_id: number; persona: string; ncid: number; tgid: number; ccid: number; commissioner: number; team_file_id: number }
export interface ResultRow { week: number; home_tgid: number; away_tgid: number; home_score: number; away_score: number; overtime: number; quarters_json: string; uploaded_by: number | null; uploaded_at: number | null }
export interface TeamRow { tgid: number; name: string; long_name: string; mascot: string; abbr: string; conf_label: string; cgid: number; dgid: number; team_type: number; asset_slot: string; stadium_id: number; wins: number; losses: number; conf_wins: number; conf_losses: number; streak: number; rank_bcs: number; rank_coaches: number; rank_media: number; prestige: number; overall: number; logo_key: string | null; raw_json: string }
export interface GameRow { season_year: number; week: number; game_no: number; status: number; home_tgid: number; away_tgid: number; home_score: number; away_score: number; stadium_id: number; kickoff_minutes: number; day_of_week: number; week_type: number; overtime: number; user_played: number; user_team_game: number; source: string }
export interface PlayerRow { pgid: number; tgid: number; first_name: string; last_name: string; pos: number; year: number; redshirt: number; jersey: number; overall: number; height: number; weight: number; games_played: number; ratings_json: string; photo_key: string | null; head_id: number | null }
export interface CoachRow { ccid: number; tgid: number; first_name: string; last_name: string; position_code: number; user_controlled: number; age: number; prestige: number; career_wins: number; career_losses: number; season_wins: number; season_losses: number }
export interface StoryRow { idx: number; week: number; game_no: number; headline: string; text: string; tgid: number; pgid: number; layout: number; story_week: number }
export interface ConfRow { cgid: number; name: string; logo_key: string | null }
export interface DivRow { dgid: number; cgid: number; name: string; short_name: string }
export interface RecruitRow { prsi: number; first_name: string; last_name: string; pos: number; stars: number; rank: number; committed: number; pre_scout_overall: number; overall: number; state_code: number; height: number; weight: number; committed_tgid: number | null; points_to_commit: number | null; teams_json: string | null; head_id: number | null }
export interface BoardRow extends RecruitRow { points_this_week: number; points_last_week: number; board_order: number; playing_time: number }
export interface StatRow { pgid: number; stats_json: string; first_name: string; last_name: string; pos: number; tgid: number; year: number; redshirt: number; photo_key: string | null; head_id: number | null }
export interface GameLogRow { kind: string; week: number; game_no: number; pgid: number; tgid: number | null; stats_json: string }

const all = async <T>(stmt: D1PreparedStatement): Promise<T[]> => (await stmt.all<T>()).results;

export const getDynasty = (db: D1Database, slug: string) => db.prepare('SELECT * FROM dynasties WHERE slug = ?').bind(slug).first<Dynasty>();
// A league-server dynasty with no members is retired (everyone left it on the console, so the server's member list is
// empty and the sync mirrors that): the landing page does not list it, though its pages stay reachable by URL and it
// comes back as soon as someone is in it again. Offline-save imports have no member list and are always listed.
export const listDynasties = (db: D1Database) => all<Dynasty>(db.prepare('SELECT d.*, (SELECT COUNT(*) FROM od_members m WHERE m.dynasty_id = d.id) AS member_count FROM dynasties d WHERE d.od_id IS NULL OR EXISTS (SELECT 1 FROM od_members m WHERE m.dynasty_id = d.id) ORDER BY updated_at DESC'));
export const getMembers = (db: D1Database, d: number) => all<MemberRow>(db.prepare('SELECT * FROM od_members WHERE dynasty_id = ? ORDER BY commissioner DESC, persona').bind(d));
export const getResults = (db: D1Database, d: number, week?: number) =>
  week === undefined
    ? all<ResultRow>(db.prepare('SELECT * FROM od_results WHERE dynasty_id = ? ORDER BY week, uploaded_at').bind(d))
    : all<ResultRow>(db.prepare('SELECT * FROM od_results WHERE dynasty_id = ? AND week = ? ORDER BY uploaded_at').bind(d, week));

// TGID 300/400 are the game's internal copies of the user team (1-0 placeholders); real teams stay below 300.
export const getTeams = (db: D1Database, d: number) => all<TeamRow>(db.prepare('SELECT * FROM teams WHERE dynasty_id = ? AND tgid < 300 ORDER BY name').bind(d));
export const getTeam = (db: D1Database, d: number, tgid: number) => db.prepare('SELECT * FROM teams WHERE dynasty_id = ? AND tgid = ?').bind(d, tgid).first<TeamRow>();
export const getConferences = (db: D1Database, d: number) => all<ConfRow>(db.prepare('SELECT cgid, name, logo_key FROM conferences WHERE dynasty_id = ? ORDER BY cgid').bind(d));
export const getDivisions = (db: D1Database, d: number) => all<DivRow>(db.prepare('SELECT dgid, cgid, name, short_name FROM divisions WHERE dynasty_id = ? ORDER BY dgid').bind(d));

export function getGames(db: D1Database, d: number, year: number, opts: { week?: number; tgid?: number; playedOnly?: boolean } = {}) {
  let sql = 'SELECT * FROM supersim_schedule WHERE dynasty_id = ? AND season_year = ?'; // games overlaid with official Supersim results
  const params: unknown[] = [d, year];
  if (opts.week !== undefined) { sql += ' AND week = ?'; params.push(opts.week); }
  if (opts.tgid !== undefined) { sql += ' AND (home_tgid = ? OR away_tgid = ?)'; params.push(opts.tgid, opts.tgid); }
  if (opts.playedOnly) sql += ' AND status >= 2';
  sql += ' ORDER BY week, game_no';
  return all<GameRow>(db.prepare(sql).bind(...params));
}

export const getWeeks = (db: D1Database, d: number, year: number) => all<{ week: number }>(db.prepare('SELECT DISTINCT week FROM games WHERE dynasty_id = ? AND season_year = ? ORDER BY week').bind(d, year));
export const getPlayers = (db: D1Database, d: number, tgid: number) => all<PlayerRow>(db.prepare('SELECT * FROM players WHERE dynasty_id = ? AND tgid = ? ORDER BY pos, overall DESC').bind(d, tgid));
export const getPlayer = (db: D1Database, d: number, pgid: number) => db.prepare('SELECT * FROM players WHERE dynasty_id = ? AND pgid = ?').bind(d, pgid).first<PlayerRow>();
// Season stat lines (all kinds) for a set of players, in chunks of 90 ids (D1 allows 100 bound parameters).
export async function getSeasonStatsFor(db: D1Database, d: number, year: number, ids: number[]): Promise<{ kind: string; pgid: number; stats_json: string }[]> {
  const out: { kind: string; pgid: number; stats_json: string }[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const slice = ids.slice(i, i + 90);
    out.push(...await all<{ kind: string; pgid: number; stats_json: string }>(db.prepare(`SELECT kind, pgid, stats_json FROM player_season_stats WHERE dynasty_id = ? AND season_year = ? AND pgid IN (${slice.map(() => '?').join(',')})`).bind(d, year, ...slice)));
  }
  return out;
}
export async function getPlayersByIds(db: D1Database, d: number, ids: number[]): Promise<PlayerRow[]> {
  const out: PlayerRow[] = [];
  for (let i = 0; i < ids.length; i += 90) { // D1 allows at most 100 bound parameters per statement
    const slice = ids.slice(i, i + 90);
    out.push(...(await all<PlayerRow>(db.prepare(`SELECT * FROM players WHERE dynasty_id = ? AND pgid IN (${slice.map(() => '?').join(',')})`).bind(d, ...slice))));
  }
  return out;
}
export const getCoaches = (db: D1Database, d: number, tgid?: number) =>
  tgid === undefined
    ? all<CoachRow>(db.prepare('SELECT * FROM coaches WHERE dynasty_id = ? ORDER BY tgid, position_code').bind(d))
    : all<CoachRow>(db.prepare('SELECT * FROM coaches WHERE dynasty_id = ? AND tgid = ? ORDER BY position_code').bind(d, tgid));
export const getUserTeams = (db: D1Database, d: number) => all<{ tgid: number }>(db.prepare('SELECT DISTINCT tgid FROM coaches WHERE dynasty_id = ? AND user_controlled = 1').bind(d));

export function getStories(db: D1Database, d: number, year: number, opts: { week?: number; limit?: number; tgid?: number } = {}) {
  let sql = 'SELECT * FROM stories WHERE dynasty_id = ? AND season_year = ?';
  const params: unknown[] = [d, year];
  if (opts.week !== undefined) { sql += ' AND week = ?'; params.push(opts.week); }
  if (opts.tgid !== undefined) { sql += ' AND tgid = ?'; params.push(opts.tgid); }
  sql += ' ORDER BY week DESC, idx ASC';
  if (opts.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }
  return all<StoryRow>(db.prepare(sql).bind(...params));
}

export const getHeisman = (db: D1Database, d: number, year: number) => all<{ rank: number; pgid: number; raw_json: string }>(db.prepare('SELECT rank, pgid, raw_json FROM heisman WHERE dynasty_id = ? AND season_year = ? ORDER BY rank').bind(d, year));
export const getAllAmericans = (db: D1Database, d: number, year: number) => all<{ pgid: number; cgid: number; pos: number; team_type: number }>(db.prepare('SELECT pgid, cgid, pos, team_type FROM all_americans WHERE dynasty_id = ? AND season_year = ? ORDER BY team_type, pos').bind(d, year));
const STAT_SELECT = 'SELECT s.pgid, s.stats_json, p.first_name, p.last_name, p.pos, p.tgid, p.year, p.redshirt, p.photo_key, p.head_id FROM player_season_stats s JOIN players p ON p.dynasty_id = s.dynasty_id AND p.pgid = s.pgid WHERE s.dynasty_id = ? AND s.season_year = ? AND s.kind = ?';
export const getPlayerSeasonStats = (db: D1Database, d: number, year: number, kind: string) => all<StatRow>(db.prepare(STAT_SELECT).bind(d, year, kind));
export const getTeamPlayerSeasonStats = (db: D1Database, d: number, year: number, kind: string, tgid: number) => all<StatRow>(db.prepare(STAT_SELECT + ' AND p.tgid = ?').bind(d, year, kind, tgid));
export const getGame = (db: D1Database, d: number, year: number, week: number, gameNo: number) => db.prepare('SELECT * FROM supersim_schedule WHERE dynasty_id = ? AND season_year = ? AND week = ? AND game_no = ?').bind(d, year, week, gameNo).first<GameRow>();
export const getGameLogs = (db: D1Database, d: number, year: number, week: number, gameNo: number) => all<GameLogRow>(db.prepare('SELECT kind, week, game_no, pgid, tgid, stats_json FROM supersim_game_logs WHERE dynasty_id = ? AND season_year = ? AND week = ? AND game_no = ?').bind(d, year, week, gameNo));
export const getTeamSeasonStats = (db: D1Database, d: number, year: number) => all<{ tgid: number; stats_json: string }>(db.prepare('SELECT tgid, stats_json FROM team_season_stats WHERE dynasty_id = ? AND season_year = ?').bind(d, year));

export function getRecruits(db: D1Database, d: number, opts: { limit?: number; pos?: number; stars?: number } = {}) {
  let sql = 'SELECT r.*, i.committed_tgid, i.points_to_commit, i.teams_json FROM recruits r LEFT JOIN recruit_interest i ON i.dynasty_id = r.dynasty_id AND i.prsi = r.prsi WHERE r.dynasty_id = ?';
  const params: unknown[] = [d];
  if (opts.pos !== undefined) { sql += ' AND r.pos = ?'; params.push(opts.pos); }
  if (opts.stars !== undefined) { sql += ' AND r.stars = ?'; params.push(opts.stars); }
  sql += ' ORDER BY r.rank LIMIT ?';
  params.push(opts.limit ?? 100);
  return all<RecruitRow>(db.prepare(sql).bind(...params));
}
// Prospects (of a board) that have committed anywhere.
export async function getCommittedPrsis(db: D1Database, d: number, prsis: number[]): Promise<Set<number>> {
  if (!prsis.length) return new Set();
  const rows = await all<{ prsi: number }>(db.prepare(`SELECT prsi FROM recruits WHERE dynasty_id = ? AND committed = 1 AND prsi IN (${prsis.map(() => '?').join(',')})`).bind(d, ...prsis.slice(0, 90)));
  return new Set(rows.map((r) => r.prsi));
}
export const getBoard = (db: D1Database, d: number, tgid: number) =>
  all<BoardRow>(db.prepare('SELECT b.points_this_week, b.points_last_week, b.board_order, b.playing_time, r.*, i.committed_tgid, i.points_to_commit, i.teams_json FROM recruiting_board b JOIN recruits r ON r.dynasty_id = b.dynasty_id AND r.prsi = b.prsi LEFT JOIN recruit_interest i ON i.dynasty_id = r.dynasty_id AND i.prsi = r.prsi WHERE b.dynasty_id = ? AND b.tgid = ? ORDER BY b.board_order').bind(d, tgid));

export interface WebBoardRow { PRSI: number; PPSC: number; PPSL: number; PSCP: number; PROR: number; PEPV: number; USEL: number; TGID: number }
export interface WebBoard { id: number; dynasty_id: number; tgid: number; season_year: number; week: number; rows_json: string; note: string | null; updated_by: number | null; updated_at: string; delivered_at: string | null }
export const getWebBoard = (db: D1Database, d: number, tgid: number, year: number, week: number) => db.prepare('SELECT * FROM web_boards WHERE dynasty_id = ? AND tgid = ? AND season_year = ? AND week = ?').bind(d, tgid, year, week).first<WebBoard>();
export const upsertWebBoard = (db: D1Database, d: number, tgid: number, year: number, week: number, rows: WebBoardRow[], by: number | null, note: string | null) =>
  db.prepare("INSERT INTO web_boards (dynasty_id, tgid, season_year, week, rows_json, note, updated_by, updated_at, delivered_at) VALUES (?,?,?,?,?,?,?, datetime('now'), NULL) ON CONFLICT(dynasty_id, tgid, season_year, week) DO UPDATE SET rows_json = excluded.rows_json, note = excluded.note, updated_by = excluded.updated_by, updated_at = datetime('now'), delivered_at = NULL").bind(d, tgid, year, week, JSON.stringify(rows), note, by).run();
export const deleteWebBoard = (db: D1Database, d: number, tgid: number, year: number, week: number) => db.prepare('DELETE FROM web_boards WHERE dynasty_id = ? AND tgid = ? AND season_year = ? AND week = ?').bind(d, tgid, year, week).run();
export const listPendingWebBoards = (db: D1Database, d: number) => all<WebBoard>(db.prepare('SELECT * FROM web_boards WHERE dynasty_id = ? AND delivered_at IS NULL ORDER BY week, tgid').bind(d));
export const markWebBoardDelivered = (db: D1Database, id: number) => db.prepare("UPDATE web_boards SET delivered_at = datetime('now') WHERE id = ? AND delivered_at IS NULL").bind(id).run();
export const getDynastyByOdId = (db: D1Database, odId: number) => db.prepare('SELECT * FROM dynasties WHERE od_id = ?').bind(odId).first<Dynasty>();
export const teamMap = (teams: TeamRow[]) => new Map(teams.map((t) => [t.tgid, t]));

// Individual player edits made on the site (jersey / position / redshirt / name), one pending row per player and week.
export interface WebPlayerEdit { id: number; dynasty_id: number; tgid: number; pgid: number; season_year: number; week: number; jersey: number | null; pos: number | null; redshirt: number | null; first_name: string | null; last_name: string | null; note: string | null; updated_by: number | null; updated_at: string; delivered_at: string | null }
export interface PlayerEditValues { jersey: number | null; pos: number | null; redshirt: number | null; first_name: string | null; last_name: string | null }
export const getPendingPlayerEdit = (db: D1Database, d: number, pgid: number, year: number, week: number) =>
  db.prepare('SELECT * FROM web_player_edits WHERE dynasty_id = ? AND pgid = ? AND season_year = ? AND week = ? AND delivered_at IS NULL').bind(d, pgid, year, week).first<WebPlayerEdit>();
export const upsertPlayerEdit = (db: D1Database, d: number, tgid: number, pgid: number, year: number, week: number, v: PlayerEditValues, by: number | null, note: string | null) =>
  db.prepare("INSERT INTO web_player_edits (dynasty_id, tgid, pgid, season_year, week, jersey, pos, redshirt, first_name, last_name, note, updated_by, updated_at, delivered_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'), NULL) ON CONFLICT(dynasty_id, pgid, season_year, week) DO UPDATE SET tgid = excluded.tgid, jersey = excluded.jersey, pos = excluded.pos, redshirt = excluded.redshirt, first_name = excluded.first_name, last_name = excluded.last_name, note = excluded.note, updated_by = excluded.updated_by, updated_at = datetime('now'), delivered_at = NULL")
    .bind(d, tgid, pgid, year, week, v.jersey, v.pos, v.redshirt, v.first_name, v.last_name, note, by).run();
export const deletePlayerEdit = (db: D1Database, d: number, pgid: number, year: number, week: number) => db.prepare('DELETE FROM web_player_edits WHERE dynasty_id = ? AND pgid = ? AND season_year = ? AND week = ?').bind(d, pgid, year, week).run();
export const listPendingPlayerEdits = (db: D1Database, d: number) => all<WebPlayerEdit>(db.prepare('SELECT * FROM web_player_edits WHERE dynasty_id = ? AND delivered_at IS NULL ORDER BY tgid, pgid').bind(d));
export const listPendingPlayerEditPgids = (db: D1Database, d: number, tgid: number, year: number, week: number) => all<{ pgid: number }>(db.prepare('SELECT pgid FROM web_player_edits WHERE dynasty_id = ? AND tgid = ? AND season_year = ? AND week = ? AND delivered_at IS NULL').bind(d, tgid, year, week));
export const markPlayerEditDelivered = (db: D1Database, id: number) => db.prepare("UPDATE web_player_edits SET delivered_at = datetime('now') WHERE id = ? AND delivered_at IS NULL").bind(id).run();

// Depth chart and formation subs edited on the site (migration 0018): one pending row per team and week.
export interface DepthChartRow { pos: number; depth: number; pgid: number }
export interface FormationSubRow { side: number; set_id: number; slot: number; pgid: number }
export interface FormationSub { side: 'off' | 'def'; set: number; slot: number; pgid: number }
export interface WebDepthEdit { id: number; dynasty_id: number; tgid: number; season_year: number; week: number; chart_json: string; subs_json: string; note: string | null; updated_by: number | null; updated_at: string; delivered_at: string | null }
export const getDepthChart = (db: D1Database, d: number, tgid: number, snapshot: number | null) => all<DepthChartRow>(db.prepare('SELECT pos, depth, pgid FROM depth_chart WHERE dynasty_id = ? AND tgid = ? AND snapshot_id = ? ORDER BY pos, depth').bind(d, tgid, snapshot ?? 0));
export const getFormationSubs = (db: D1Database, d: number, tgid: number, snapshot: number | null) => all<FormationSubRow>(db.prepare('SELECT side, set_id, slot, pgid FROM formation_subs WHERE dynasty_id = ? AND tgid = ? AND snapshot_id = ? ORDER BY side DESC, set_id, slot').bind(d, tgid, snapshot ?? 0));
export const getPendingDepthEdit = (db: D1Database, d: number, tgid: number, year: number, week: number) =>
  db.prepare('SELECT * FROM web_depth_edits WHERE dynasty_id = ? AND tgid = ? AND season_year = ? AND week = ? AND delivered_at IS NULL').bind(d, tgid, year, week).first<WebDepthEdit>();
export const upsertDepthEdit = (db: D1Database, d: number, tgid: number, year: number, week: number, chart: Record<string, number[]>, subs: FormationSub[], by: number | null, note: string | null) =>
  db.prepare("INSERT INTO web_depth_edits (dynasty_id, tgid, season_year, week, chart_json, subs_json, note, updated_by, updated_at, delivered_at) VALUES (?,?,?,?,?,?,?,?, datetime('now'), NULL) ON CONFLICT(dynasty_id, tgid, season_year, week) DO UPDATE SET chart_json = excluded.chart_json, subs_json = excluded.subs_json, note = excluded.note, updated_by = excluded.updated_by, updated_at = datetime('now'), delivered_at = NULL")
    .bind(d, tgid, year, week, JSON.stringify(chart), JSON.stringify(subs), note, by).run();
export const deleteDepthEdit = (db: D1Database, d: number, tgid: number, year: number, week: number) => db.prepare('DELETE FROM web_depth_edits WHERE dynasty_id = ? AND tgid = ? AND season_year = ? AND week = ?').bind(d, tgid, year, week).run();
export const listPendingDepthEdits = (db: D1Database, d: number) => all<WebDepthEdit>(db.prepare('SELECT * FROM web_depth_edits WHERE dynasty_id = ? AND delivered_at IS NULL ORDER BY tgid').bind(d));
export const markDepthEditDelivered = (db: D1Database, id: number) => db.prepare("UPDATE web_depth_edits SET delivered_at = datetime('now') WHERE id = ? AND delivered_at IS NULL").bind(id).run();

// A team's playbook edits made on the site (migration 0027): one row per team and side, kept until the coach resets it.
// edits_json is the BookEdits of @ncaa/ncaa14 (playbook/model.ts); the site composes the book from it (supersim/coach/
// books.ts loadTeamBook) and the bridge writes it into the game's playbook database, acking the row with the sha of what
// it wrote. A new save clears delivered_at (delivered_sha stays: what the console last got) so the bridge delivers again.
export type PlaybookSide = 'off' | 'def';
export interface WebPlaybookEdit { id: number; dynasty_id: number; tgid: number; side: PlaybookSide; edits_json: string; note: string | null; updated_by: number | null; updated_at: string; delivered_at: string | null; delivered_sha: string | null }
export const getPlaybookEdit = (db: D1Database, d: number, tgid: number, side: PlaybookSide) => db.prepare('SELECT * FROM web_playbook_edits WHERE dynasty_id = ? AND tgid = ? AND side = ?').bind(d, tgid, side).first<WebPlaybookEdit>();
export const listPlaybookEditTeams = (db: D1Database, d: number) => all<{ tgid: number; side: PlaybookSide; updated_at: string }>(db.prepare('SELECT tgid, side, updated_at FROM web_playbook_edits WHERE dynasty_id = ? ORDER BY tgid, side').bind(d));
export const upsertPlaybookEdit = (db: D1Database, d: number, tgid: number, side: PlaybookSide, edits: BookEdits, by: number | null, note: string | null) =>
  db.prepare("INSERT INTO web_playbook_edits (dynasty_id, tgid, side, edits_json, note, updated_by, updated_at, delivered_at) VALUES (?,?,?,?,?,?, datetime('now'), NULL) ON CONFLICT(dynasty_id, tgid, side) DO UPDATE SET edits_json = excluded.edits_json, note = excluded.note, updated_by = excluded.updated_by, updated_at = datetime('now'), delivered_at = NULL")
    .bind(d, tgid, side, JSON.stringify(edits), note, by).run();
export const deletePlaybookEdit = (db: D1Database, d: number, tgid: number, side: PlaybookSide) => db.prepare('DELETE FROM web_playbook_edits WHERE dynasty_id = ? AND tgid = ? AND side = ?').bind(d, tgid, side).run();
export const listPendingPlaybookEdits = (db: D1Database, d: number) => all<WebPlaybookEdit>(db.prepare('SELECT * FROM web_playbook_edits WHERE dynasty_id = ? AND delivered_at IS NULL ORDER BY tgid, side').bind(d));
export const markPlaybookEditDelivered = (db: D1Database, id: number, sha: string | null) => db.prepare("UPDATE web_playbook_edits SET delivered_at = datetime('now'), delivered_sha = ? WHERE id = ? AND delivered_at IS NULL").bind(sha, id).run();

// Recruit edits made on the site (migration 0019): name, position, height, weight and stars of a prospect, one pending
// row per prospect and season; the bridge writes them into the dynasty-file copy and acks them once a console file
// carries the values. Weight is in pounds (the game stores PWGT + 160).
export interface WebRecruitEdit { id: number; dynasty_id: number; prsi: number; season_year: number; week: number; first_name: string | null; last_name: string | null; pos: number | null; height: number | null; weight: number | null; stars: number | null; head_id: number | null; note: string | null; updated_by: number | null; updated_at: string; delivered_at: string | null }
export interface RecruitEditValues { first_name: string; last_name: string; pos: number; height: number; weight: number; stars: number; head_id: number }
export const getRecruit = (db: D1Database, d: number, prsi: number) =>
  db.prepare('SELECT r.*, i.committed_tgid, i.points_to_commit, i.teams_json FROM recruits r LEFT JOIN recruit_interest i ON i.dynasty_id = r.dynasty_id AND i.prsi = r.prsi WHERE r.dynasty_id = ? AND r.prsi = ?').bind(d, prsi).first<RecruitRow>();
export const getPendingRecruitEdit = (db: D1Database, d: number, prsi: number, year: number) =>
  db.prepare('SELECT * FROM web_recruit_edits WHERE dynasty_id = ? AND prsi = ? AND season_year = ? AND delivered_at IS NULL').bind(d, prsi, year).first<WebRecruitEdit>();
export const upsertRecruitEdit = (db: D1Database, d: number, prsi: number, year: number, week: number, v: RecruitEditValues, by: number | null, note: string | null) =>
  db.prepare("INSERT INTO web_recruit_edits (dynasty_id, prsi, season_year, week, first_name, last_name, pos, height, weight, stars, head_id, note, updated_by, updated_at, delivered_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'), NULL) ON CONFLICT(dynasty_id, prsi, season_year) DO UPDATE SET week = excluded.week, first_name = excluded.first_name, last_name = excluded.last_name, pos = excluded.pos, height = excluded.height, weight = excluded.weight, stars = excluded.stars, head_id = excluded.head_id, note = excluded.note, updated_by = excluded.updated_by, updated_at = datetime('now'), delivered_at = NULL")
    .bind(d, prsi, year, week, v.first_name, v.last_name, v.pos, v.height, v.weight, v.stars, v.head_id, note, by).run();
export const deleteRecruitEdit = (db: D1Database, d: number, prsi: number, year: number) => db.prepare('DELETE FROM web_recruit_edits WHERE dynasty_id = ? AND prsi = ? AND season_year = ?').bind(d, prsi, year).run();
export const listPendingRecruitEdits = (db: D1Database, d: number) => all<WebRecruitEdit>(db.prepare('SELECT * FROM web_recruit_edits WHERE dynasty_id = ? AND delivered_at IS NULL ORDER BY prsi').bind(d));
export const listPendingRecruitEditPrsis = async (db: D1Database, d: number, year: number): Promise<Set<number>> => new Set((await all<{ prsi: number }>(db.prepare('SELECT prsi FROM web_recruit_edits WHERE dynasty_id = ? AND season_year = ? AND delivered_at IS NULL').bind(d, year))).map((r) => r.prsi));
export const markRecruitEditDelivered = (db: D1Database, id: number) => db.prepare("UPDATE web_recruit_edits SET delivered_at = datetime('now') WHERE id = ? AND delivered_at IS NULL").bind(id).run();

// A commissioner's request to re-generate the recruiting class with Fang's Recruit Overhaul (migration 0019).
export interface OverhaulRequest { id: number; dynasty_id: number; season_year: number; requested_by: number | null; status: 'pending' | 'done' | 'failed'; message: string | null; created_at: string; done_at: string | null }
export const getLatestOverhaulRequest = (db: D1Database, d: number, year: number) => db.prepare('SELECT * FROM web_overhaul_requests WHERE dynasty_id = ? AND season_year = ? ORDER BY id DESC LIMIT 1').bind(d, year).first<OverhaulRequest>();
export const insertOverhaulRequest = (db: D1Database, d: number, year: number, by: number | null) => db.prepare('INSERT INTO web_overhaul_requests (dynasty_id, season_year, requested_by) VALUES (?,?,?)').bind(d, year, by).run();
export const listPendingOverhaulRequests = (db: D1Database, d: number) => all<OverhaulRequest>(db.prepare("SELECT * FROM web_overhaul_requests WHERE dynasty_id = ? AND status = 'pending' ORDER BY id").bind(d));
export const finishOverhaulRequest = (db: D1Database, id: number, status: 'done' | 'failed', message: string) => db.prepare("UPDATE web_overhaul_requests SET status = ?, message = ?, done_at = datetime('now') WHERE id = ? AND status = 'pending'").bind(status, message, id).run();

// News Wire stories written by members; the game's own headlines live in `stories`.
export interface WebStory { id: number; dynasty_id: number; season_year: number; week: number; author_blaze_id: number; author_persona: string; title: string; body: string; image_key: string | null; tgid: number | null; game_week: number | null; game_no: number | null; created_at: string; updated_at: string | null; wire_version?: string | null; wire_xms_id?: number | null; wire_delivered_at?: string | null }
export interface WebStoryInput { title: string; body: string; tgid: number | null; game_week: number | null; game_no: number | null }
export const listWebStories = (db: D1Database, d: number, limit = 100) => all<WebStory>(db.prepare('SELECT * FROM web_stories WHERE dynasty_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').bind(d, limit));
export const getWebStory = (db: D1Database, d: number, id: number) => db.prepare('SELECT * FROM web_stories WHERE dynasty_id = ? AND id = ?').bind(d, id).first<WebStory>();
export const insertWebStory = async (db: D1Database, d: number, year: number, week: number, by: { blaze_id: number; persona: string }, s: WebStoryInput): Promise<number> =>
  Number((await db.prepare('INSERT INTO web_stories (dynasty_id, season_year, week, author_blaze_id, author_persona, title, body, tgid, game_week, game_no) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(d, year, week, by.blaze_id, by.persona, s.title, s.body, s.tgid, s.game_week, s.game_no).run()).meta.last_row_id);
export const updateWebStory = (db: D1Database, d: number, id: number, s: WebStoryInput) =>
  db.prepare("UPDATE web_stories SET title = ?, body = ?, tgid = ?, game_week = ?, game_no = ?, updated_at = datetime('now') WHERE dynasty_id = ? AND id = ?").bind(s.title, s.body, s.tgid, s.game_week, s.game_no, d, id).run();
export const setWebStoryImage = (db: D1Database, d: number, id: number, key: string | null) => db.prepare('UPDATE web_stories SET image_key = ? WHERE dynasty_id = ? AND id = ?').bind(key, d, id).run();
export const deleteWebStory = (db: D1Database, d: number, id: number) => db.prepare('DELETE FROM web_stories WHERE dynasty_id = ? AND id = ?').bind(d, id).run();

// Member accounts, invite codes and login sessions (migrations 0008 and 0023). An account is site-wide: one username and
// password (unique site-wide, case-insensitively) that owns at most one league-server persona (blaze_id > 0, the RPCN
// user the console signs in with). account_members links it to the member it acts as in each dynasty: console personas
// are linked by the bridge's member sync (linkPersonaStatements, api/bridge.ts) and lazily by session.ts, so the person
// who creates or joins an online dynasty on the console is recognised here with the session they already have; web
// players are linked by their invite. Password hashing and session tokens live in session.ts.
export interface MemberRow { team_name?: string | null; team_abbr?: string | null } // filled by getMembersWithTeams for the top bar
export interface AccountRow { id: number; username: string; pass_hash: string; salt: string; blaze_id: number | null; created_at: string }
export interface AccountSummary { id: number; blaze_id: number; username: string; created_at: string } // blaze_id: the member it is linked to in the dynasty asked about
export interface PersonaAccount { id: number; username: string; blaze_id: number; created_at: string }
export interface InviteRow { code: string; dynasty_id: number; blaze_id: number; created_by_account_id: number | null; note: string | null; created_at: string; used_at: string | null; used_by_account_id: number | null }
export interface SessionRow { token_hash: string; account_id: number; created_at: string; expires_at: string; username: string; persona_blaze_id: number | null }
export const getMembersWithTeams = (db: D1Database, d: number) =>
  all<MemberRow>(db.prepare('SELECT m.*, t.name AS team_name, t.abbr AS team_abbr FROM od_members m LEFT JOIN teams t ON t.dynasty_id = m.dynasty_id AND t.tgid = m.tgid WHERE m.dynasty_id = ? ORDER BY m.commissioner DESC, m.persona').bind(d));
export const countAccounts = async (db: D1Database, d: number): Promise<number> => Number((await db.prepare('SELECT COUNT(*) AS n FROM account_members WHERE dynasty_id = ?').bind(d).first<{ n: number }>())?.n ?? 0);
export const listAccounts = (db: D1Database, d: number) => all<AccountSummary>(db.prepare('SELECT a.id, l.blaze_id, a.username, a.created_at FROM account_members l JOIN accounts a ON a.id = l.account_id WHERE l.dynasty_id = ? ORDER BY a.username').bind(d));
export const getAccountByUsername = (db: D1Database, username: string) => db.prepare('SELECT * FROM accounts WHERE username = ?').bind(username).first<AccountRow>();
export const getAccountById = (db: D1Database, id: number) => db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<AccountRow>();
export const getAccountForMember = (db: D1Database, d: number, blazeId: number) =>
  db.prepare('SELECT a.id, l.blaze_id, a.username, a.created_at FROM account_members l JOIN accounts a ON a.id = l.account_id WHERE l.dynasty_id = ? AND l.blaze_id = ?').bind(d, blazeId).first<AccountSummary>();
// The account that owns a console persona (anywhere on the site), if any.
export const getAccountForPersona = (db: D1Database, blazeId: number) =>
  blazeId > 0 ? db.prepare('SELECT id, username, blaze_id, created_at FROM accounts WHERE blaze_id = ?').bind(blazeId).first<PersonaAccount>() : Promise.resolve(null);
export const linkedMemberId = async (db: D1Database, accountId: number, d: number): Promise<number | null> =>
  (await db.prepare('SELECT blaze_id FROM account_members WHERE account_id = ? AND dynasty_id = ?').bind(accountId, d).first<{ blaze_id: number }>())?.blaze_id ?? null;
export const linkMember = (db: D1Database, accountId: number, d: number, blazeId: number) =>
  db.prepare('INSERT OR IGNORE INTO account_members (account_id, dynasty_id, blaze_id) VALUES (?,?,?)').bind(accountId, d, blazeId).run();
// Statements that link every console member of a dynasty whose persona owns an account and drop the links of members who
// left; api/bridge.ts runs them after each member sync, so a new online dynasty recognises its creator and joiners at once.
export const linkPersonaStatements = (db: D1Database, d: number) => [
  db.prepare('INSERT OR IGNORE INTO account_members (account_id, dynasty_id, blaze_id) SELECT a.id, m.dynasty_id, m.blaze_id FROM od_members m JOIN accounts a ON a.blaze_id = m.blaze_id WHERE m.dynasty_id = ? AND m.web_only = 0').bind(d),
  db.prepare('DELETE FROM account_members WHERE dynasty_id = ? AND blaze_id > 0 AND blaze_id NOT IN (SELECT blaze_id FROM od_members WHERE dynasty_id = ?)').bind(d, d),
];
// An account that owns a console persona is linked wherever that persona is a member.
export const linkPersonaEverywhere = (db: D1Database, accountId: number, blazeId: number) =>
  db.prepare('INSERT OR IGNORE INTO account_members (account_id, dynasty_id, blaze_id) SELECT ?, m.dynasty_id, m.blaze_id FROM od_members m WHERE m.blaze_id = ? AND m.web_only = 0').bind(accountId, blazeId).run();
export const deleteAccount = (db: D1Database, id: number) => db.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
// Creates the account and claims the invite in one transaction, then links the member (and, for a console persona, every
// dynasty that persona is in); returns the account id, or null when the invite was already used (a concurrent join).
// personaBlazeId is the console persona the account will own, null for a web player. Unique-constraint violations
// (username or persona taken) throw.
export async function createAccountFromInvite(db: D1Database, d: number, blazeId: number, personaBlazeId: number | null, username: string, passHash: string, salt: string, code: string): Promise<number | null> {
  const [ins, upd] = await db.batch([
    db.prepare('INSERT INTO accounts (username, pass_hash, salt, blaze_id) VALUES (?,?,?,?)').bind(username, passHash, salt, personaBlazeId),
    db.prepare("UPDATE invites SET used_at = datetime('now'), used_by_account_id = last_insert_rowid() WHERE code = ? AND dynasty_id = ? AND used_at IS NULL").bind(code, d),
  ]);
  const id = Number(ins?.meta.last_row_id);
  if (!upd?.meta.changes) { await deleteAccount(db, id); return null; }
  await linkMember(db, id, d, blazeId);
  if (personaBlazeId !== null) await linkPersonaEverywhere(db, id, personaBlazeId);
  return id;
}
// Uses an invite for an account that already exists (the browser is signed in from another dynasty): the member is linked
// to it; a console persona is claimed by the account, which must not own another one. Returns false when the invite was
// used meanwhile; throws on a unique-constraint violation (the persona just got an account).
export async function linkAccountFromInvite(db: D1Database, accountId: number, d: number, blazeId: number, personaBlazeId: number | null, code: string): Promise<boolean> {
  if (personaBlazeId !== null) {
    const acct = await getAccountById(db, accountId);
    if (!acct) return false;
    if (acct.blaze_id !== null && acct.blaze_id !== personaBlazeId) throw new Error(`${acct.username} already stands for another console persona`);
  }
  const upd = await db.prepare("UPDATE invites SET used_at = datetime('now'), used_by_account_id = ? WHERE code = ? AND dynasty_id = ? AND used_at IS NULL").bind(accountId, code, d).run();
  if (!upd.meta.changes) return false;
  if (personaBlazeId !== null) { await db.prepare('UPDATE accounts SET blaze_id = ? WHERE id = ? AND blaze_id IS NULL').bind(personaBlazeId, accountId).run(); await linkPersonaEverywhere(db, accountId, personaBlazeId); }
  await linkMember(db, accountId, d, blazeId);
  return true;
}
export const getInvite = (db: D1Database, code: string) => db.prepare('SELECT * FROM invites WHERE code = ?').bind(code).first<InviteRow>();
export const listOpenInvites = (db: D1Database, d: number) => all<InviteRow>(db.prepare('SELECT * FROM invites WHERE dynasty_id = ? AND used_at IS NULL ORDER BY created_at DESC').bind(d));
export const insertInvite = (db: D1Database, code: string, d: number, blazeId: number, createdBy: number | null, note: string | null) =>
  db.prepare('INSERT INTO invites (code, dynasty_id, blaze_id, created_by_account_id, note) VALUES (?,?,?,?,?)').bind(code, d, blazeId, createdBy, note).run();
export const deleteOpenInvite = async (db: D1Database, d: number, code: string): Promise<boolean> => !!(await db.prepare('DELETE FROM invites WHERE dynasty_id = ? AND code = ? AND used_at IS NULL').bind(d, code).run()).meta.changes;
export const insertSession = (db: D1Database, tokenHash: string, accountId: number, expiresAt: string) =>
  db.prepare('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?,?,?)').bind(tokenHash, accountId, expiresAt).run();
export const getSession = (db: D1Database, tokenHash: string) =>
  db.prepare("SELECT s.*, a.username, a.blaze_id AS persona_blaze_id FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > datetime('now')").bind(tokenHash).first<SessionRow>();
export const touchSession = (db: D1Database, tokenHash: string, expiresAt: string) => db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(expiresAt, tokenHash).run();
export const deleteSession = (db: D1Database, tokenHash: string) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
export const purgeExpiredSessions = (db: D1Database) => db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
// The viewer's sign-in state rides along on the member rows: pages hand `member`/`members` to layout() unchanged, so the
// top bar can show Sign in / Sign out without every page learning about accounts. Stamped by session.ts currentMember.
export interface MemberAuth { locked: boolean; account: { id: number; username: string } | null }
export interface MemberRow { auth?: MemberAuth }

// Web-only members and Ready (migration 0014). A web member is an od_members row with web_only = 1 and a negative
// blaze_id the bridge's member sync never touches; ids are never reused (history in invites / supersim_games keeps them).
export interface MemberRow { web_only?: number }
export async function addWebMember(db: D1Database, d: number, persona: string, tgid: number): Promise<number> {
  const low = (t: string) => `COALESCE((SELECT MIN(blaze_id) FROM ${t} WHERE dynasty_id = ?), 0) - 1`;
  const id = Number((await db.prepare(`SELECT MIN(-1, ${low('od_members')}, ${low('invites')}, ${low('supersim_games')}) AS id`).bind(d, d, d).first<{ id: number }>())?.id ?? -1);
  await db.prepare('INSERT INTO od_members (dynasty_id, blaze_id, persona, ncid, tgid, ccid, commissioner, team_file_id, web_only) VALUES (?,?,?,0,?,0,0,0,1)').bind(d, id, persona, tgid).run();
  return id;
}
export const setWebMemberTeam = (db: D1Database, d: number, blazeId: number, tgid: number) => db.prepare('UPDATE od_members SET tgid = ? WHERE dynasty_id = ? AND blaze_id = ? AND web_only = 1').bind(tgid, d, blazeId).run();
// Removes the member with its account link, open invites and ready flags; past Supersim results stay. The account itself
// goes too when it was only this web player's (no console persona, no other dynasty), with its sign-ins.
export const removeWebMember = (db: D1Database, d: number, blazeId: number) => db.batch([
  db.prepare('DELETE FROM account_members WHERE dynasty_id = ? AND blaze_id = ?').bind(d, blazeId),
  db.prepare('DELETE FROM accounts WHERE blaze_id IS NULL AND id NOT IN (SELECT account_id FROM account_members)'),
  db.prepare('DELETE FROM sessions WHERE account_id NOT IN (SELECT id FROM accounts)'),
  db.prepare('DELETE FROM invites WHERE dynasty_id = ? AND blaze_id = ? AND used_at IS NULL').bind(d, blazeId),
  db.prepare('DELETE FROM member_ready WHERE dynasty_id = ? AND blaze_id = ?').bind(d, blazeId),
  db.prepare('DELETE FROM od_members WHERE dynasty_id = ? AND blaze_id = ? AND web_only = 1').bind(d, blazeId),
]);
export interface ReadyRow { blaze_id: number; ready_at: string }
export const listReady = (db: D1Database, d: number, fileId: number) => all<ReadyRow>(db.prepare('SELECT blaze_id, ready_at FROM member_ready WHERE dynasty_id = ? AND file_id = ?').bind(d, fileId));
export const setReady = (db: D1Database, d: number, blazeId: number, fileId: number, year: number, week: number, on: boolean) => on
  ? db.prepare('INSERT OR IGNORE INTO member_ready (dynasty_id, blaze_id, file_id, season_year, week) VALUES (?,?,?,?,?)').bind(d, blazeId, fileId, year, week).run()
  : db.prepare('DELETE FROM member_ready WHERE dynasty_id = ? AND blaze_id = ? AND file_id = ?').bind(d, blazeId, fileId).run();
// Supersim games being coached right now: score [away, home], quarter and clock straight from the stored state.
export interface LiveSimRow { game_no: number; home_tgid: number; away_tgid: number; away_score: number; home_score: number; q: number; clock: number }
export const listLiveSims = (db: D1Database, d: number, year: number, week: number) => all<LiveSimRow>(db.prepare(
  "SELECT game_no, home_tgid, away_tgid, json_extract(state_json, '$.score[0]') AS away_score, json_extract(state_json, '$.score[1]') AS home_score, json_extract(state_json, '$.q') AS q, json_extract(state_json, '$.clock') AS clock FROM supersim_live WHERE dynasty_id = ? AND season_year = ? AND week = ? AND status = 'live'").bind(d, year, week));

// ---- the FCS playoff (migration 0021): one JSON state per dynasty and season, written by the bridge ----
export interface PlayoffStateRow { state_json: string; updated_at: string }
export const getPlayoffState = (db: D1Database, d: number, year: number) => db.prepare('SELECT state_json, updated_at FROM playoff_state WHERE dynasty_id = ? AND season_year = ?').bind(d, year).first<PlayoffStateRow>();
export const putPlayoffState = (db: D1Database, d: number, year: number, json: string) =>
  db.prepare("INSERT INTO playoff_state (dynasty_id, season_year, state_json, updated_at) VALUES (?,?,?, datetime('now')) ON CONFLICT(dynasty_id, season_year) DO UPDATE SET state_json = excluded.state_json, updated_at = datetime('now')").bind(d, year, json).run();
