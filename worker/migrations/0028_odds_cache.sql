-- Simulated betting lines (pages/odds.ts, packages/ncaa14/src/odds.ts): each team's unit grades, computed from the
-- current snapshot's rosters and depth charts the first time a page asks for them and kept until the next import
-- changes current_snapshot_id. One JSON document per dynasty, written by the Worker (worker/src/odds.ts); the bridge
-- import does not touch it. 2026-11-10.
-- Create only: a migration never writes to a table it creates (see 0023).
CREATE TABLE IF NOT EXISTS odds_cache (
  dynasty_id INTEGER NOT NULL PRIMARY KEY,
  snapshot_id INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
