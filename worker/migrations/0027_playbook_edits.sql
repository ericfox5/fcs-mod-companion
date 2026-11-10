-- A team's playbook edits made on the site (one row per team and side, kept until the coach resets it). edits_json is the
-- BookEdits of packages/ncaa14/src/playbook/model.ts: the stock book it starts from (base), the formations / sets / plays
-- it keeps or takes from other stock books, and the plays drawn on the site. The site composes the team's book from it
-- (Supersim, the Depth Chart and Playbook pages); the bridge writes the same book into the game's playbook database as the
-- team's private book and acks the row with the sha of what it wrote (delivered_sha). A later save puts delivered_at back
-- to NULL so the bridge delivers it again. Create only: a migration never writes to a table it creates (see 0023).
CREATE TABLE web_playbook_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dynasty_id INTEGER NOT NULL, tgid INTEGER NOT NULL, side TEXT NOT NULL CHECK (side IN ('off','def')),
  edits_json TEXT NOT NULL, note TEXT, updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), delivered_at TEXT, delivered_sha TEXT,
  UNIQUE (dynasty_id, tgid, side)
);
CREATE INDEX web_playbook_edits_pending ON web_playbook_edits(dynasty_id, delivered_at);
