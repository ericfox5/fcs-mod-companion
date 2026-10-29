-- NCAA Online Dynasty 14 revival: core schema (M1 viewer + import). Later milestones add members/transactions/sim.
CREATE TABLE dynasties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  season_year INTEGER,
  week INTEGER,
  stage INTEGER,
  current_snapshot_id INTEGER,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dynasty_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'importing',
  season_year INTEGER,
  week INTEGER,
  stage INTEGER,
  sha256 TEXT,
  db_size INTEGER,
  r2_prefix TEXT,
  table_counts_json TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  committed_at TEXT
);
CREATE INDEX snapshots_dynasty ON snapshots(dynasty_id, id);

CREATE TABLE calendar (dynasty_id INTEGER NOT NULL, week INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, stage INTEGER, period INTEGER, PRIMARY KEY (dynasty_id, week));
CREATE TABLE conferences (dynasty_id INTEGER NOT NULL, cgid INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, name TEXT, league_id INTEGER, PRIMARY KEY (dynasty_id, cgid));
CREATE TABLE divisions (dynasty_id INTEGER NOT NULL, dgid INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, cgid INTEGER, name TEXT, short_name TEXT, PRIMARY KEY (dynasty_id, dgid));
CREATE TABLE teams (
  dynasty_id INTEGER NOT NULL, tgid INTEGER NOT NULL, snapshot_id INTEGER NOT NULL,
  name TEXT, long_name TEXT, mascot TEXT, abbr TEXT, conf_label TEXT, cgid INTEGER, dgid INTEGER, team_type INTEGER, asset_slot TEXT,
  stadium_id INTEGER, wins INTEGER, losses INTEGER, conf_wins INTEGER, conf_losses INTEGER, streak INTEGER,
  rank_bcs INTEGER, rank_coaches INTEGER, rank_media INTEGER, prestige INTEGER, overall INTEGER, raw_json TEXT,
  PRIMARY KEY (dynasty_id, tgid)
);
CREATE TABLE players (
  dynasty_id INTEGER NOT NULL, pgid INTEGER NOT NULL, snapshot_id INTEGER NOT NULL,
  tgid INTEGER, first_name TEXT, last_name TEXT, pos INTEGER, year INTEGER, redshirt INTEGER, jersey INTEGER, overall INTEGER,
  height INTEGER, weight INTEGER, games_played INTEGER, ratings_json TEXT,
  PRIMARY KEY (dynasty_id, pgid)
);
CREATE INDEX players_team ON players(dynasty_id, tgid);
CREATE TABLE coaches (
  dynasty_id INTEGER NOT NULL, ccid INTEGER NOT NULL, snapshot_id INTEGER NOT NULL,
  tgid INTEGER, first_name TEXT, last_name TEXT, position_code INTEGER, user_controlled INTEGER, age INTEGER, prestige INTEGER,
  off_playbook INTEGER, sim_rp_off INTEGER, sim_rp_def INTEGER, career_wins INTEGER, career_losses INTEGER, season_wins INTEGER, season_losses INTEGER, raw_json TEXT,
  PRIMARY KEY (dynasty_id, ccid)
);
CREATE INDEX coaches_team ON coaches(dynasty_id, tgid);
CREATE TABLE depth_chart (dynasty_id INTEGER NOT NULL, tgid INTEGER NOT NULL, pos INTEGER NOT NULL, depth INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, pgid INTEGER, PRIMARY KEY (dynasty_id, tgid, pos, depth));
CREATE TABLE games (
  dynasty_id INTEGER NOT NULL, season_year INTEGER NOT NULL, week INTEGER NOT NULL, game_no INTEGER NOT NULL, snapshot_id INTEGER NOT NULL,
  status INTEGER, home_tgid INTEGER, away_tgid INTEGER, home_score INTEGER, away_score INTEGER, stadium_id INTEGER, kickoff_minutes INTEGER,
  day_of_week INTEGER, week_type INTEGER, overtime INTEGER, user_played INTEGER, user_team_game INTEGER, cpu_pick INTEGER, home_pick INTEGER,
  source TEXT NOT NULL DEFAULT 'game',
  PRIMARY KEY (dynasty_id, season_year, week, game_no)
);
CREATE INDEX games_home ON games(dynasty_id, season_year, home_tgid);
CREATE INDEX games_away ON games(dynasty_id, season_year, away_tgid);
CREATE TABLE stories (
  dynasty_id INTEGER NOT NULL, season_year INTEGER NOT NULL, idx INTEGER NOT NULL, snapshot_id INTEGER NOT NULL,
  week INTEGER, game_no INTEGER, headline TEXT, text TEXT, tgid INTEGER, pgid INTEGER, layout INTEGER, story_week INTEGER,
  PRIMARY KEY (dynasty_id, season_year, idx)
);
CREATE INDEX stories_week ON stories(dynasty_id, season_year, week);
CREATE TABLE heisman (dynasty_id INTEGER NOT NULL, season_year INTEGER NOT NULL, rank INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, pgid INTEGER, raw_json TEXT, PRIMARY KEY (dynasty_id, season_year, rank));
CREATE TABLE all_americans (dynasty_id INTEGER NOT NULL, season_year INTEGER NOT NULL, pgid INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, cgid INTEGER, pos INTEGER, team_type INTEGER, PRIMARY KEY (dynasty_id, season_year, pgid));
CREATE TABLE team_season_stats (dynasty_id INTEGER NOT NULL, season_year INTEGER NOT NULL, tgid INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, stats_json TEXT, PRIMARY KEY (dynasty_id, season_year, tgid));
CREATE TABLE team_history (dynasty_id INTEGER NOT NULL, tgid INTEGER NOT NULL, season_year INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, wins INTEGER, losses INTEGER, PRIMARY KEY (dynasty_id, tgid, season_year));
CREATE TABLE player_season_stats (dynasty_id INTEGER NOT NULL, season_year INTEGER NOT NULL, kind TEXT NOT NULL, pgid INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, stats_json TEXT, PRIMARY KEY (dynasty_id, season_year, kind, pgid));
CREATE TABLE recruits (
  dynasty_id INTEGER NOT NULL, prsi INTEGER NOT NULL, snapshot_id INTEGER NOT NULL,
  first_name TEXT, last_name TEXT, pos INTEGER, stars INTEGER, rank INTEGER, committed INTEGER, pre_scout_overall INTEGER, overall INTEGER,
  state_code INTEGER, hometown_id INTEGER, importances_json TEXT, height INTEGER, weight INTEGER, raw_json TEXT,
  PRIMARY KEY (dynasty_id, prsi)
);
CREATE TABLE recruit_interest (dynasty_id INTEGER NOT NULL, prsi INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, committed_tgid INTEGER, points_to_commit INTEGER, teams_json TEXT, PRIMARY KEY (dynasty_id, prsi));
CREATE TABLE recruiting_board (
  dynasty_id INTEGER NOT NULL, tgid INTEGER NOT NULL, prsi INTEGER NOT NULL, snapshot_id INTEGER NOT NULL,
  points_this_week INTEGER, points_last_week INTEGER, scout_points INTEGER, board_order INTEGER, playing_time INTEGER, user_selected INTEGER,
  PRIMARY KEY (dynasty_id, tgid, prsi)
);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, dynasty_id INTEGER, actor TEXT, action TEXT NOT NULL, detail_json TEXT, at TEXT NOT NULL DEFAULT (datetime('now')));
