-- The Supersim overlay views (0010), rebuilt with two changes:
-- 1. Explicit columns: supersim_game_logs selected l.*, which broke every game page when 0016 added game_logs.uid
--    (the UNION ALL halves no longer had the same number of columns).
-- 2. The console is authoritative once it has played a game: a Supersim result applies while the console has not
--    finished the game, or when its final agrees (the console took the Supersim result as game data). When the
--    console re-simulated the game instead (2026-10-30, week 6, before game data existed), the console's final and box
--    score lines show, matching the season stats, standings and records the console keeps.
DROP VIEW IF EXISTS supersim_schedule;
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
FROM games g LEFT JOIN supersim_games s ON s.dynasty_id=g.dynasty_id AND s.season_year=g.season_year AND s.week=g.week AND s.game_no=g.game_no
 AND (g.status < 2 OR (g.home_score = json_extract(s.result_json,'$.score[1]') AND g.away_score = json_extract(s.result_json,'$.score[0]')));

DROP VIEW IF EXISTS supersim_game_logs;
CREATE VIEW supersim_game_logs AS
SELECT l.dynasty_id,l.season_year,l.kind,l.week,l.game_no,l.pgid,l.snapshot_id,l.tgid,l.stats_json FROM game_logs l
WHERE NOT EXISTS (SELECT 1 FROM supersim_games s JOIN games g ON g.dynasty_id=s.dynasty_id AND g.season_year=s.season_year AND g.week=s.week AND g.game_no=s.game_no
  WHERE s.dynasty_id=l.dynasty_id AND s.season_year=l.season_year AND s.week=l.week AND s.game_no=l.game_no
    AND (g.status < 2 OR (g.home_score = json_extract(s.result_json,'$.score[1]') AND g.away_score = json_extract(s.result_json,'$.score[0]'))))
UNION ALL
SELECT s.dynasty_id,s.season_year,json_extract(j.value,'$.kind'),s.week,s.game_no,json_extract(j.value,'$.pgid'),s.snapshot_id,json_extract(j.value,'$.tgid'),json_extract(j.value,'$.stats')
FROM supersim_games s JOIN games g ON g.dynasty_id=s.dynasty_id AND g.season_year=s.season_year AND g.week=s.week AND g.game_no=s.game_no, json_each(s.envelope_json,'$.boxScores') j
WHERE g.status < 2 OR (g.home_score = json_extract(s.result_json,'$.score[1]') AND g.away_score = json_extract(s.result_json,'$.score[0]'));
