-- Player profile pages read one player's season lines and game lines across the league's tables; without these the
-- lookups scan a whole season (player_season_stats and game_logs are keyed by season and kind first).
CREATE INDEX IF NOT EXISTS player_season_stats_player ON player_season_stats(dynasty_id, pgid);
CREATE INDEX IF NOT EXISTS game_logs_player ON game_logs(dynasty_id, pgid, season_year);
