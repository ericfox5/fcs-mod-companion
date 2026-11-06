-- A player's identity across seasons (bridge playerUids): PGID is a roster slot that changes when he transfers and is
-- reused by whoever takes the slot, so stat lines also carry uid = "POID:hometown" of the player who held the PGID in
-- the same dynasty file. Player pages read a player's history by uid; lines stored before this have uid NULL until the
-- next import / `ncaa-bridge od backfill-logs` refills them.
ALTER TABLE game_logs ADD COLUMN uid TEXT;
ALTER TABLE player_season_stats ADD COLUMN uid TEXT;
CREATE INDEX IF NOT EXISTS game_logs_uid ON game_logs(dynasty_id, uid);
CREATE INDEX IF NOT EXISTS player_season_stats_uid ON player_season_stats(dynasty_id, uid);
