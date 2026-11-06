-- Web-only members (2026-11-01): league members without a console who coach their team's games in Supersim on the
-- site. A commissioner adds one on /members with a name and a team no console member controls; the row lives in
-- od_members with web_only = 1 and a negative blaze_id (Blaze ids are positive), so the bridge's member sync, which
-- replaces the console members, leaves it alone, and accounts / invites / Supersim / the top bar treat it like any
-- member. To the console the team stays a CPU team; the league server applies the Supersim final at the advance.
ALTER TABLE od_members ADD COLUMN web_only INTEGER NOT NULL DEFAULT 0;

-- Ready for the advance: a member marks ready for the dynasty file the league is on (dynasties.od_file_id). Each
-- advance uploads a new dynasty file, so every flag resets by itself; season_year/week are kept for display.
CREATE TABLE member_ready (
  dynasty_id INTEGER NOT NULL, blaze_id INTEGER NOT NULL, file_id INTEGER NOT NULL,
  season_year INTEGER NOT NULL, week INTEGER NOT NULL,
  ready_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (dynasty_id, blaze_id, file_id)
);
