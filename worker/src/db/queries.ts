export interface Dynasty {
  id: number; slug: string; name: string; season_year: number; week: number; stage: number; week_type: number | null; current_snapshot_id: number | null; updated_at: string | null;
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
export const listDynasties = (db: D1Database) => all<Dynasty>(db.prepare('SELECT d.*, (SELECT COUNT(*) FROM od_members m WHERE m.dynasty_id = d.id) AS member_count FROM dynasties d ORDER BY updated_at DESC'));
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
  let sql = 'SELECT * FROM games WHERE dynasty_id = ? AND season_year = ?';
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
export const getGame = (db: D1Database, d: number, year: number, week: number, gameNo: number) => db.prepare('SELECT * FROM games WHERE dynasty_id = ? AND season_year = ? AND week = ? AND game_no = ?').bind(d, year, week, gameNo).first<GameRow>();
export const getGameLogs = (db: D1Database, d: number, year: number, week: number, gameNo: number) => all<GameLogRow>(db.prepare('SELECT kind, week, game_no, pgid, tgid, stats_json FROM game_logs WHERE dynasty_id = ? AND season_year = ? AND week = ? AND game_no = ?').bind(d, year, week, gameNo));
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

// News Wire stories written by members; the game's own headlines live in `stories`.
export interface WebStory { id: number; dynasty_id: number; season_year: number; week: number; author_blaze_id: number; author_persona: string; title: string; body: string; image_key: string | null; tgid: number | null; game_week: number | null; game_no: number | null; created_at: string; updated_at: string | null }
export interface WebStoryInput { title: string; body: string; tgid: number | null; game_week: number | null; game_no: number | null }
export const listWebStories = (db: D1Database, d: number, limit = 100) => all<WebStory>(db.prepare('SELECT * FROM web_stories WHERE dynasty_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').bind(d, limit));
export const getWebStory = (db: D1Database, d: number, id: number) => db.prepare('SELECT * FROM web_stories WHERE dynasty_id = ? AND id = ?').bind(d, id).first<WebStory>();
export const insertWebStory = async (db: D1Database, d: number, year: number, week: number, by: { blaze_id: number; persona: string }, s: WebStoryInput): Promise<number> =>
  Number((await db.prepare('INSERT INTO web_stories (dynasty_id, season_year, week, author_blaze_id, author_persona, title, body, tgid, game_week, game_no) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(d, year, week, by.blaze_id, by.persona, s.title, s.body, s.tgid, s.game_week, s.game_no).run()).meta.last_row_id);
export const updateWebStory = (db: D1Database, d: number, id: number, s: WebStoryInput) =>
  db.prepare("UPDATE web_stories SET title = ?, body = ?, tgid = ?, game_week = ?, game_no = ?, updated_at = datetime('now') WHERE dynasty_id = ? AND id = ?").bind(s.title, s.body, s.tgid, s.game_week, s.game_no, d, id).run();
export const setWebStoryImage = (db: D1Database, d: number, id: number, key: string | null) => db.prepare('UPDATE web_stories SET image_key = ? WHERE dynasty_id = ? AND id = ?').bind(key, d, id).run();
export const deleteWebStory = (db: D1Database, d: number, id: number) => db.prepare('DELETE FROM web_stories WHERE dynasty_id = ? AND id = ?').bind(d, id).run();
