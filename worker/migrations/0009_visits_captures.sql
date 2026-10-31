-- Recruit visits scheduled on the site (one desired visit set per team and week, RECV-shaped rows) and in-game photo
-- captures decoded by the bridge for News Wire stories.
CREATE TABLE web_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dynasty_id INTEGER NOT NULL, tgid INTEGER NOT NULL, season_year INTEGER NOT NULL, week INTEGER NOT NULL,
  rows_json TEXT NOT NULL, note TEXT, updated_by INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now')), delivered_at TEXT,
  UNIQUE (dynasty_id, tgid, season_year, week)
);
CREATE TABLE captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dynasty_id INTEGER NOT NULL, source_name TEXT NOT NULL, image_key TEXT NOT NULL,
  taken_at TEXT, season_year INTEGER, week INTEGER, home_tgid INTEGER, away_tgid INTEGER, home_score INTEGER, away_score INTEGER,
  quarter INTEGER, clock TEXT, play_text TEXT, width INTEGER, height INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (dynasty_id, source_name)
);
CREATE INDEX captures_dynasty ON captures(dynasty_id, id);
-- the console's own scheduled/completed visits (RECV), imported with the recruiting tables
CREATE TABLE recruit_visits (
  dynasty_id INTEGER NOT NULL, tgid INTEGER NOT NULL, prsi INTEGER NOT NULL, snapshot_id INTEGER NOT NULL,
  week INTEGER, value INTEGER, mvp INTEGER, nfgz INTEGER, nfgm INTEGER,
  PRIMARY KEY (dynasty_id, tgid, prsi)
);
