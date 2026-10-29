-- Player headshots: photo_key = R2 object under photos/ (the league's real player photos, matched by team + name at
-- import); head_id = the game's face art id (PGHE) used as the fallback portrait for players and recruits.
ALTER TABLE players ADD COLUMN photo_key TEXT;
ALTER TABLE players ADD COLUMN head_id INTEGER;
ALTER TABLE recruits ADD COLUMN head_id INTEGER;
