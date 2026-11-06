-- The FCS playoff bracket the bridge runs inside the console's dynasty file: seeds, the rows each round was written
-- to and their results, one JSON document per dynasty and season (pages/bracket.ts shows it; before it exists the page
-- projects the field from the polls and standings).
CREATE TABLE IF NOT EXISTS playoff_state (
  dynasty_id INTEGER NOT NULL,
  season_year INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (dynasty_id, season_year)
);
