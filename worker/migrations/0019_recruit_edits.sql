-- Recruit edits made on the site (name, position, height, weight, stars), one pending row per prospect and season.
-- The bridge writes them into the copy of the dynasty file the league server hands the console at its next load
-- (dynasty-patch.ts applyRecruitEdits) and acks a row once a console file carries the values.
CREATE TABLE web_recruit_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dynasty_id INTEGER NOT NULL, prsi INTEGER NOT NULL, season_year INTEGER NOT NULL, week INTEGER NOT NULL,
  first_name TEXT, last_name TEXT, pos INTEGER, height INTEGER, weight INTEGER, stars INTEGER, note TEXT, updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), delivered_at TEXT,
  UNIQUE (dynasty_id, prsi, season_year)
);
CREATE INDEX web_recruit_edits_pending ON web_recruit_edits(dynasty_id, delivered_at);

-- A commissioner's request to re-generate the recruiting class with Fang's Recruit Overhaul (preseason only). The
-- bridge runs the tool on the console's current dynasty file and reports back: status pending -> done | failed.
CREATE TABLE web_overhaul_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dynasty_id INTEGER NOT NULL, season_year INTEGER NOT NULL, requested_by INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', message TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), done_at TEXT
);
CREATE INDEX web_overhaul_requests_dyn ON web_overhaul_requests(dynasty_id, id);
