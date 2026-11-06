-- Site-wide accounts, part 3 of 4 (see 0023): the final accounts table (the shape of the accounts_v2 staging table) and
-- the site-wide sessions table (no dynasty_id). Created in a file of their own because the old tables of the same names
-- were dropped by the previous file.
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  pass_hash TEXT NOT NULL, salt TEXT NOT NULL,
  blaze_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL
);
CREATE INDEX sessions_account ON sessions(account_id);
