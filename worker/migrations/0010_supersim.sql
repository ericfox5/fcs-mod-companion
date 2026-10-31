-- Immutable official result/outbox, intentionally outside the bridge import's purge list.
CREATE TABLE supersim_games (
 id TEXT PRIMARY KEY,
 dynasty_id INTEGER NOT NULL,
 season_year INTEGER NOT NULL,
 week INTEGER NOT NULL,
 game_no INTEGER NOT NULL,
 snapshot_id INTEGER NOT NULL,
 blaze_id INTEGER NOT NULL,
 owned_tgid INTEGER NOT NULL,
 home_tgid INTEGER NOT NULL,
 away_tgid INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','synced','conflict')),
 seed INTEGER NOT NULL,
 input_json TEXT NOT NULL,
 result_json TEXT NOT NULL,
 envelope_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 accepted_at TEXT,
 synced_at TEXT,
 receipt_json TEXT,
 UNIQUE(dynasty_id, season_year, week, game_no)
);
CREATE INDEX supersim_outbox ON supersim_games(status,dynasty_id);
-- The outbox remains authoritative until the console has merged the game.
-- Pending runs must block advance/play in the adapter; do not delete to allow a reroll.

-- Read projections make the official result visible immediately and survive bridge re-imports.
-- Original imported tables remain untouched. A conflict stays visible as the locked result for review.
CREATE VIEW supersim_schedule AS
SELECT g.dynasty_id,g.season_year,g.week,g.game_no,g.snapshot_id,
 CASE WHEN s.id IS NULL THEN g.status WHEN json_extract(s.result_json,'$.winner')=1 THEN 3 ELSE 2 END AS status,
 g.home_tgid,g.away_tgid,
 COALESCE(json_extract(s.result_json,'$.score[1]'),g.home_score) AS home_score,
 COALESCE(json_extract(s.result_json,'$.score[0]'),g.away_score) AS away_score,
 g.stadium_id,g.kickoff_minutes,g.day_of_week,g.week_type,
 CASE WHEN s.id IS NULL THEN g.overtime ELSE json_extract(s.result_json,'$.overtime')>0 END AS overtime,
 CASE WHEN s.id IS NULL THEN g.user_played ELSE 1 END AS user_played,
 g.user_team_game,g.cpu_pick,g.home_pick,CASE WHEN s.id IS NULL THEN g.source ELSE 'supersim' END AS source
FROM games g LEFT JOIN supersim_games s ON s.dynasty_id=g.dynasty_id AND s.season_year=g.season_year AND s.week=g.week AND s.game_no=g.game_no;
CREATE VIEW supersim_game_logs AS
SELECT l.* FROM game_logs l WHERE NOT EXISTS(SELECT 1 FROM supersim_games s WHERE s.dynasty_id=l.dynasty_id AND s.season_year=l.season_year AND s.week=l.week AND s.game_no=l.game_no)
UNION ALL
SELECT s.dynasty_id,s.season_year,json_extract(j.value,'$.kind'),s.week,s.game_no,json_extract(j.value,'$.pgid'),s.snapshot_id,json_extract(j.value,'$.tgid'),json_extract(j.value,'$.stats')
FROM supersim_games s,json_each(s.envelope_json,'$.boxScores') j;
