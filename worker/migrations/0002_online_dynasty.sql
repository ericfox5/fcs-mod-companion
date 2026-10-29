-- Online dynasties: the Blaze stub's DynastyOnDemand store mirrored by `ncaa-bridge od` (members, uploaded results,
-- the dynasty file id the console is on). Offline-save dynasties keep od_id NULL.
ALTER TABLE dynasties ADD COLUMN od_id INTEGER;
ALTER TABLE dynasties ADD COLUMN abbr TEXT;
ALTER TABLE dynasties ADD COLUMN description TEXT;
ALTER TABLE dynasties ADD COLUMN state INTEGER;
ALTER TABLE dynasties ADD COLUMN week_type INTEGER;
ALTER TABLE dynasties ADD COLUMN od_file_id INTEGER;
ALTER TABLE dynasties ADD COLUMN od_file_saved_at INTEGER;
ALTER TABLE dynasties ADD COLUMN od_created_at INTEGER;
CREATE UNIQUE INDEX dynasties_od ON dynasties(od_id);
ALTER TABLE snapshots ADD COLUMN week_type INTEGER;
CREATE TABLE od_members (
  dynasty_id INTEGER NOT NULL, blaze_id INTEGER NOT NULL,
  persona TEXT, ncid INTEGER, tgid INTEGER, ccid INTEGER, commissioner INTEGER NOT NULL DEFAULT 0, team_file_id INTEGER,
  PRIMARY KEY (dynasty_id, blaze_id)
);
CREATE TABLE od_results (
  dynasty_id INTEGER NOT NULL, week INTEGER NOT NULL, home_tgid INTEGER NOT NULL, away_tgid INTEGER NOT NULL,
  home_score INTEGER, away_score INTEGER, overtime INTEGER, quarters_json TEXT, uploaded_by INTEGER, uploaded_at INTEGER,
  PRIMARY KEY (dynasty_id, week, home_tgid, away_tgid)
);
