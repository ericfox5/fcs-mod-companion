-- Per-game box score lines from the save's B* tables (BTES team stats, BOFF/BDEF/BKIC/BKPR/BOLN player lines), keyed by
-- week + game number; pgid holds the TGID for BTES rows.
CREATE TABLE game_logs (
  dynasty_id INTEGER NOT NULL, season_year INTEGER NOT NULL, kind TEXT NOT NULL, week INTEGER NOT NULL, game_no INTEGER NOT NULL, pgid INTEGER NOT NULL,
  snapshot_id INTEGER NOT NULL, tgid INTEGER, stats_json TEXT,
  PRIMARY KEY (dynasty_id, season_year, kind, week, game_no, pgid)
);
CREATE INDEX game_logs_game ON game_logs(dynasty_id, season_year, week, game_no);
