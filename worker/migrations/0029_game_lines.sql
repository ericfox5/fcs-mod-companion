-- Closing lines (worker/src/odds.ts recordLines, pages/odds.ts closingLine): the simulated line of each game as it stood
-- the last time it was priced before being played. Rows for the current and the next week's unplayed games are rewritten at
-- every import commit and at a Supersim kickoff; once a game is played its row is left alone, so a played game's page can
-- show the line it closed at and whether the favourite covered. Games played before this table existed have no row.
-- spread is on the home team (negative = home favoured). 2026-11-11.
-- Create only: a migration never writes to a table it creates (see 0023).
CREATE TABLE IF NOT EXISTS game_lines (
  dynasty_id INTEGER NOT NULL,
  season_year INTEGER NOT NULL,
  week INTEGER NOT NULL,
  game_no INTEGER NOT NULL,
  spread REAL NOT NULL,
  total REAL NOT NULL,
  home_win REAL NOT NULL,
  home_money INTEGER NOT NULL,
  away_money INTEGER NOT NULL,
  snapshot_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (dynasty_id, season_year, week, game_no)
);
