-- Individual player edits made on the site (jersey, position, redshirt, name): one pending row per player and week.
-- The bridge folds them into the console's last roster push (PLYZ) for the next advance and acks them once the
-- dynasty has moved past that week.
CREATE TABLE web_player_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dynasty_id INTEGER NOT NULL, tgid INTEGER NOT NULL, pgid INTEGER NOT NULL, season_year INTEGER NOT NULL, week INTEGER NOT NULL,
  jersey INTEGER, pos INTEGER, redshirt INTEGER, first_name TEXT, last_name TEXT, note TEXT, updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), delivered_at TEXT,
  UNIQUE (dynasty_id, pgid, season_year, week)
);
CREATE INDEX web_player_edits_pending ON web_player_edits(dynasty_id, delivered_at);

-- News Wire stories written by members (the game's own headlines stay in `stories`). Images live in R2 under
-- stories/<dynasty_id>/<story_id>-<timestamp>.<ext>.
CREATE TABLE web_stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dynasty_id INTEGER NOT NULL, season_year INTEGER NOT NULL, week INTEGER NOT NULL,
  author_blaze_id INTEGER NOT NULL, author_persona TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, image_key TEXT,
  tgid INTEGER, game_week INTEGER, game_no INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
);
CREATE INDEX web_stories_dyn ON web_stories(dynasty_id, created_at);
