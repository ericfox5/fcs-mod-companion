// Maps normalized import rows (as produced by @ncaa/ncaa14 exportDynasty) onto D1 columns.
// Each spec: SQL table, columns, and a function turning one row into column values (dynasty_id, snapshot_id are prepended).
export interface TableSpec { table: string; columns: string[]; values: (r: any, ctx: Ctx) => unknown[]; seasonScoped?: boolean }
export interface Ctx { seasonYear: number }
const j = (v: unknown) => JSON.stringify(v);
const b = (v: unknown) => (v ? 1 : 0);

export const IMPORT_TABLES: Record<string, TableSpec> = {
  calendar: { table: 'calendar', columns: ['week', 'stage', 'period'], values: (r) => [r.week, r.stage, r.period] },
  conferences: { table: 'conferences', columns: ['cgid', 'name', 'league_id', 'logo_key'], values: (r) => [r.cgid, r.name, r.leagueId, r.logoKey ?? null] },
  divisions: { table: 'divisions', columns: ['dgid', 'cgid', 'name', 'short_name'], values: (r) => [r.dgid, r.cgid, r.name, r.shortName] },
  teams: {
    table: 'teams',
    columns: ['tgid', 'name', 'long_name', 'mascot', 'abbr', 'conf_label', 'cgid', 'dgid', 'team_type', 'asset_slot', 'stadium_id', 'wins', 'losses', 'conf_wins', 'conf_losses', 'streak', 'rank_bcs', 'rank_coaches', 'rank_media', 'prestige', 'overall', 'raw_json', 'logo_key'],
    values: (r) => [r.tgid, r.name, r.longName, r.mascot, r.abbr, r.conferenceLabel, r.cgid, r.dgid, r.teamType, r.assetSlot, r.stadiumId, r.wins, r.losses, r.confWins, r.confLosses, r.streak, r.rankBcs, r.rankCoaches, r.rankMedia, r.prestige, r.overall, j(r.raw), r.logoKey ?? null],
  },
  players: {
    table: 'players',
    columns: ['pgid', 'tgid', 'first_name', 'last_name', 'pos', 'year', 'redshirt', 'jersey', 'overall', 'height', 'weight', 'games_played', 'ratings_json', 'photo_key', 'head_id'],
    values: (r) => [r.pgid, r.tgid, r.firstName, r.lastName, r.pos, r.year, r.redshirt, r.jersey, r.overall, r.heightInches, r.weight, r.gamesPlayed, j(r.ratings), r.photoKey ?? null, r.headId ?? null],
  },
  coaches: {
    table: 'coaches',
    columns: ['ccid', 'tgid', 'first_name', 'last_name', 'position_code', 'user_controlled', 'age', 'prestige', 'off_playbook', 'sim_rp_off', 'sim_rp_def', 'career_wins', 'career_losses', 'season_wins', 'season_losses', 'raw_json'],
    values: (r) => [r.ccid, r.tgid, r.firstName, r.lastName, r.positionCode, b(r.userControlled), r.age, r.prestige, r.offPlaybook, r.simRunPassOff, r.simRunPassDef, r.careerWins, r.careerLosses, r.seasonWins, r.seasonLosses, j(r.raw)],
  },
  depthChart: { table: 'depth_chart', columns: ['tgid', 'pos', 'depth', 'pgid'], values: (r) => [r.tgid, r.pos, r.depth, r.pgid] },
  schedule: {
    table: 'games', seasonScoped: true,
    columns: ['season_year', 'week', 'game_no', 'status', 'home_tgid', 'away_tgid', 'home_score', 'away_score', 'stadium_id', 'kickoff_minutes', 'day_of_week', 'week_type', 'overtime', 'user_played', 'user_team_game', 'cpu_pick', 'home_pick', 'source'],
    values: (r, c) => [c.seasonYear, r.week, r.gameNo, r.status, r.homeTgid, r.awayTgid, r.homeScore, r.awayScore, r.stadiumId, r.kickoffMinutes, r.dayOfWeek, r.weekType, b(r.overtime), b(r.userPlayed), b(r.userTeamGame), r.cpuPick, r.homePick, r.source ?? 'game'],
  },
  stories: {
    table: 'stories', seasonScoped: true,
    columns: ['season_year', 'idx', 'week', 'game_no', 'headline', 'text', 'tgid', 'pgid', 'layout', 'story_week'],
    values: (r, c) => [c.seasonYear, r.index, r.week, r.gameNo, r.headline, r.text, r.tgid, r.pgid, r.layout, r.storyWeek],
  },
  heisman: { table: 'heisman', seasonScoped: true, columns: ['season_year', 'rank', 'pgid', 'raw_json'], values: (r, c) => [c.seasonYear, r.rank, r.pgid, j(r.raw)] },
  allAmericans: { table: 'all_americans', seasonScoped: true, columns: ['season_year', 'pgid', 'cgid', 'pos', 'team_type'], values: (r, c) => [c.seasonYear, r.raw.PGID, r.raw.CGID, r.raw.PPOS, r.raw.TTYP] },
  teamSeasonStats: { table: 'team_season_stats', seasonScoped: true, columns: ['season_year', 'tgid', 'stats_json'], values: (r, c) => [c.seasonYear, r.TGID, j(r)] },
  teamHistory: { table: 'team_history', columns: ['tgid', 'season_year', 'wins', 'losses'], values: (r) => [r.TGID, 2013 + r.SEYR, r.WINS, r.LOSE] },
  playerSeasonStats: { table: 'player_season_stats', seasonScoped: true, columns: ['season_year', 'kind', 'pgid', 'stats_json'], values: (r, c) => [c.seasonYear, r.kind, r.PGID, j(r)] },
  recruitVisits: { table: 'recruit_visits', columns: ['tgid', 'prsi', 'week', 'value', 'mvp', 'nfgz', 'nfgm'], values: (r) => [r.tgid, r.prsi, r.week, r.value, r.mvp, r.nfgz, r.nfgm] },
  gameLogs: {
    table: 'game_logs', seasonScoped: true,
    columns: ['season_year', 'kind', 'week', 'game_no', 'pgid', 'tgid', 'stats_json'],
    values: (r, c) => [c.seasonYear, r.kind, r.SEWN, r.SGNM, r.PGID ?? r.TGID ?? 0, r.TGID ?? null, j(r)],
  },
  recruits: {
    table: 'recruits',
    columns: ['prsi', 'first_name', 'last_name', 'pos', 'stars', 'rank', 'committed', 'pre_scout_overall', 'overall', 'state_code', 'hometown_id', 'importances_json', 'height', 'weight', 'raw_json', 'head_id'],
    values: (r) => [r.prsi, r.firstName, r.lastName, r.pos, r.stars, r.rank, b(r.committed), r.preScoutOverall, r.overall, r.stateCode, r.hometownId, j(r.importances), r.heightInches, r.weight, j(r.raw), r.raw?.PGHE ?? null],
  },
  recruitInterest: { table: 'recruit_interest', columns: ['prsi', 'committed_tgid', 'points_to_commit', 'teams_json'], values: (r) => [r.prsi, r.committedTgid, r.pointsToCommit, j(r.teams)] },
  recruitingBoard: { table: 'recruiting_board', columns: ['tgid', 'prsi', 'points_this_week', 'points_last_week', 'scout_points', 'board_order', 'playing_time', 'user_selected'], values: (r) => [r.tgid, r.prsi, r.pointsThisWeek, r.pointsLastWeek, r.scoutPoints, r.order, r.playingTime, b(r.userSelected)] },
};

const MAX_PARAMS = 100;

// Build INSERT OR REPLACE statements for a chunk of rows (multi-row VALUES, bounded by D1's parameter limit).
export function buildInserts(db: D1Database, spec: TableSpec, rows: unknown[], dynastyId: number, snapshotId: number, ctx: Ctx): D1PreparedStatement[] {
  const cols = ['dynasty_id', 'snapshot_id', ...spec.columns];
  const perRow = cols.length;
  const rowsPerStmt = Math.max(1, Math.floor(MAX_PARAMS / perRow));
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += rowsPerStmt) {
    const slice = rows.slice(i, i + rowsPerStmt);
    const placeholders = slice.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
    const sql = `INSERT OR REPLACE INTO ${spec.table} (${cols.join(',')}) VALUES ${placeholders}`;
    const params: unknown[] = [];
    for (const r of slice) params.push(dynastyId, snapshotId, ...spec.values(r, ctx).map((v) => (v === undefined ? null : v)));
    stmts.push(db.prepare(sql).bind(...params));
  }
  return stmts;
}
