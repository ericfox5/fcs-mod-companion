-- Coaching-mode Supersim: one live game per scheduled game, resolved one play at a time. The state is the engine's
-- whole GameState (score, clock, drives, play log, stats, pending call). `version` guards concurrent calls: every
-- POST sends the version it saw and the UPDATE only applies when it still matches. When the game ends the final is
-- copied into supersim_games (the outbox the league server polls) and status becomes 'final'.
CREATE TABLE supersim_live (
 dynasty_id INTEGER NOT NULL,
 season_year INTEGER NOT NULL,
 week INTEGER NOT NULL,
 game_no INTEGER NOT NULL,
 snapshot_id INTEGER NOT NULL,
 home_tgid INTEGER NOT NULL,
 away_tgid INTEGER NOT NULL,
 started_by INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'live' CHECK(status IN ('live','final','abandoned')),
 version INTEGER NOT NULL DEFAULT 1,
 input_json TEXT NOT NULL,
 state_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (dynasty_id, season_year, week, game_no)
);
