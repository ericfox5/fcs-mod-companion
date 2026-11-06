-- In-game Dynasty Wire (the console's Story Center, served by the league server's Sports World / XMS stand-in):
-- delivery state of member stories, and the stories the console uploads itself (game recaps, weekly recaps, user stories).
ALTER TABLE web_stories ADD COLUMN wire_version TEXT;
ALTER TABLE web_stories ADD COLUMN wire_xms_id INTEGER;
ALTER TABLE web_stories ADD COLUMN wire_delivered_at TEXT;

CREATE TABLE console_stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dynasty_id INTEGER NOT NULL, xms_id INTEGER NOT NULL, story_type INTEGER, kind TEXT NOT NULL,
  team_tgid INTEGER, season INTEGER, week INTEGER, title TEXT, headline TEXT, caption TEXT, body TEXT, texts_json TEXT, table_blocks INTEGER,
  photo_key TEXT, author_persona TEXT, author_blaze_id INTEGER, created_at TEXT, received_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- a game recap's text written on the site ("Tell everyone your side of the story"), delivered into the console's recap
  recap_text TEXT, recap_by TEXT, recap_at TEXT, recap_delivered_at TEXT,
  UNIQUE (dynasty_id, xms_id)
);
CREATE INDEX console_stories_dyn ON console_stories(dynasty_id, id);
