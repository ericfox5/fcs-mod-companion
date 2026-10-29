-- Recruiting boards edited on the site: one desired board per team and week (full RECB-shaped rows). The bridge serves
-- pending boards to the console at the advance and marks them delivered once the dynasty has moved past that week.
CREATE TABLE web_boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dynasty_id INTEGER NOT NULL, tgid INTEGER NOT NULL, season_year INTEGER NOT NULL, week INTEGER NOT NULL,
  rows_json TEXT NOT NULL, note TEXT, updated_by INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now')), delivered_at TEXT,
  UNIQUE (dynasty_id, tgid, season_year, week)
);
CREATE INDEX web_boards_pending ON web_boards(dynasty_id, delivered_at);
