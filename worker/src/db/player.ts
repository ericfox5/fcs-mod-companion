// Player profile data (pages/player.ts): every season line and game line a player has, and the best player at a set of
// positions per team for the "Switch player" pickers. Indexed by migrations 0015/0016.
const all = async <T>(stmt: D1PreparedStatement): Promise<T[]> => (await stmt.all<T>()).results;

// A player's history is read by uid ("POID:hometown", migration 0016) so it follows him through transfers and is not
// handed to the next occupant of his roster slot; rows stored before uids existed match by PGID in the current season.
// rows come oldest import first, so a newer copy of a season (e.g. after a transfer re-keyed it) wins in the page
export interface SeasonLine { season_year: number; kind: string; stats_json: string }
export const playerSeasonLines = (db: D1Database, d: number, uid: string, pgid: number, year: number) =>
  all<SeasonLine>(db.prepare('SELECT season_year, kind, stats_json FROM player_season_stats WHERE dynasty_id = ?1 AND (uid = ?2 OR (uid IS NULL AND pgid = ?3 AND season_year = ?4)) ORDER BY season_year, snapshot_id').bind(d, uid, pgid, year));

// Game lines of every season: the console's (game_logs; BTES rows are team lines, excluded) plus Supersim finals from
// their envelopes for the games a Supersim result decided, under the rule of the supersim_* views (migration 0017): the
// Supersim result applies while the console has not finished the game or agrees with its final; otherwise the console's
// lines stand. An envelope names the player by the PGID he had that season, found through his season stat rows (or his
// current PGID this season).
const SUPERSIM_IN_EFFECT = "(g.status < 2 OR (g.home_score = json_extract(s.result_json, '$.score[1]') AND g.away_score = json_extract(s.result_json, '$.score[0]')))";
export interface GameLine { season_year: number; kind: string; week: number; game_no: number; tgid: number | null; stats_json: string }
export const playerGameLines = (db: D1Database, d: number, uid: string, pgid: number, year: number) =>
  all<GameLine>(db.prepare(`SELECT l.season_year, l.kind, l.week, l.game_no, l.tgid, l.stats_json FROM game_logs l
    WHERE l.dynasty_id = ?1 AND l.kind <> 'BTES' AND (l.uid = ?2 OR (l.uid IS NULL AND l.pgid = ?3 AND l.season_year = ?4))
      AND NOT EXISTS (SELECT 1 FROM supersim_games s JOIN games g ON g.dynasty_id = s.dynasty_id AND g.season_year = s.season_year AND g.week = s.week AND g.game_no = s.game_no
        WHERE s.dynasty_id = l.dynasty_id AND s.season_year = l.season_year AND s.week = l.week AND s.game_no = l.game_no AND ${SUPERSIM_IN_EFFECT})
    UNION ALL
    SELECT s.season_year, json_extract(j.value, '$.kind'), s.week, s.game_no, json_extract(j.value, '$.tgid'), json_extract(j.value, '$.stats')
    FROM supersim_games s JOIN games g ON g.dynasty_id = s.dynasty_id AND g.season_year = s.season_year AND g.week = s.week AND g.game_no = s.game_no, json_each(s.envelope_json, '$.boxScores') j
    WHERE s.dynasty_id = ?1 AND json_extract(j.value, '$.kind') <> 'BTES' AND ${SUPERSIM_IN_EFFECT}
      AND (json_extract(j.value, '$.pgid') IN (SELECT p.pgid FROM player_season_stats p WHERE p.dynasty_id = ?1 AND p.uid = ?2 AND p.season_year = s.season_year)
        OR (s.season_year = ?4 AND json_extract(j.value, '$.pgid') = ?3))
    ORDER BY 1, 3, 4`).bind(d, uid, pgid, year));

// The highest-rated player at any of `positions` on each of `tgids` (SQLite returns the row that holds the MAX).
export function topAtPositions(db: D1Database, d: number, tgids: number[], positions: number[]) {
  if (!tgids.length || !positions.length) return Promise.resolve([] as { tgid: number; pgid: number }[]);
  return all<{ tgid: number; pgid: number }>(db.prepare(`SELECT tgid, pgid, MAX(overall) AS ovr FROM players WHERE dynasty_id = ? AND tgid IN (${tgids.map(() => '?').join(',')}) AND pos IN (${positions.map(() => '?').join(',')}) GROUP BY tgid`)
    .bind(d, ...tgids, ...positions));
}
