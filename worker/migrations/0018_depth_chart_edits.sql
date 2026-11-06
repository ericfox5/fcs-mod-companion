-- Depth chart and formation subs edited on the site (one pending row per team and week). chart_json: {"<pos>": [pgid, ...]}
-- for every depth-chart position (the game's DCHT, 88 slots per team); subs_json: [{"side": "off"|"def", "set": <set id>,
-- "slot": 0..10, "pgid": n}] (PLSU). The bridge writes them into the copy of the dynasty file the league server hands
-- the console at its next load (dynasty-patch.ts) and acks them when the console uploads a newer file.
CREATE TABLE web_depth_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dynasty_id INTEGER NOT NULL, tgid INTEGER NOT NULL, season_year INTEGER NOT NULL, week INTEGER NOT NULL,
  chart_json TEXT NOT NULL, subs_json TEXT NOT NULL DEFAULT '[]', note TEXT, updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), delivered_at TEXT,
  UNIQUE (dynasty_id, tgid, season_year, week)
);
CREATE INDEX web_depth_edits_pending ON web_depth_edits(dynasty_id, delivered_at);

-- The console's own formation subs (PLSU), imported with each dynasty file: side 1 offense / 0 defense (PFIO), set_id
-- (PLFO, the playbook set), slot (PFPI, 0..10), pgid.
CREATE TABLE formation_subs (
  dynasty_id INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, tgid INTEGER NOT NULL, side INTEGER NOT NULL, set_id INTEGER NOT NULL, slot INTEGER NOT NULL, pgid INTEGER NOT NULL,
  PRIMARY KEY (dynasty_id, tgid, side, set_id, slot)
);
