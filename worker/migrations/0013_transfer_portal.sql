-- Transfer Portal: players' leaving flags and the dynasty's transfer list as imported from the dynasty file, plus the
-- commissioner's pending transfer edits. PLAY.PLFL is the leaving reason (9 leaving, 10/11 playing time, 14 coach leaving,
-- 15 homesick, 19-26 draft/graduation, 28 stays), PLAY.PTYP 0 staying / 1 transferring (also kept by earlier transfers)
-- / 3 removed. TRAN = one row per transfer (PTID destination, TRYR, TRAC), PLSS.WTLS joined in.
ALTER TABLE players ADD COLUMN leave_flag INTEGER;
ALTER TABLE players ADD COLUMN leave_type INTEGER;

CREATE TABLE transfers (
  dynasty_id INTEGER NOT NULL, pgid INTEGER NOT NULL, snapshot_id INTEGER NOT NULL,
  to_tgid INTEGER, tryr INTEGER, trac INTEGER, wtls INTEGER,
  PRIMARY KEY (dynasty_id, pgid)
);

-- One pending edit per player and week: action 'transfer' (to_tgid + reason = PLFL code) or 'stay'. The bridge turns
-- pending rows into the change tables the console pulls when the dynasty loads (PLYZ flags, TRAZ destination, PLSZ)
-- and acks them once the console reflects them or the dynasty has left that week.
CREATE TABLE web_transfer_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dynasty_id INTEGER NOT NULL, pgid INTEGER NOT NULL, from_tgid INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('transfer', 'stay')), to_tgid INTEGER, reason INTEGER,
  season_year INTEGER NOT NULL, week INTEGER NOT NULL, updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), delivered_at TEXT,
  UNIQUE (dynasty_id, pgid, season_year, week)
);
CREATE INDEX web_transfer_edits_pending ON web_transfer_edits(dynasty_id, delivered_at);
