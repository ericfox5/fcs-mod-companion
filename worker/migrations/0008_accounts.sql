-- Member accounts: one per online member (od_members.blaze_id) per dynasty, created from an invite code. The first
-- invite of a dynasty comes from the bridge (`ncaa-bridge od invite`), so whoever bootstraps accounts has proven
-- control of the league server; after that a signed-in commissioner issues invites from /d/<slug>/members.
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dynasty_id INTEGER NOT NULL, blaze_id INTEGER NOT NULL,
  username TEXT NOT NULL COLLATE NOCASE, pass_hash TEXT NOT NULL, salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (dynasty_id, blaze_id), UNIQUE (dynasty_id, username)
);

-- Invite codes: each one is for a specific member; used_at/used_by_account_id are set when the account is created.
CREATE TABLE invites (
  code TEXT PRIMARY KEY, dynasty_id INTEGER NOT NULL, blaze_id INTEGER NOT NULL, created_by_account_id INTEGER, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), used_at TEXT, used_by_account_id INTEGER
);
CREATE INDEX invites_dyn ON invites(dynasty_id, used_at);

-- Login sessions: the cookie carries the random token, the table its SHA-256. Sliding 30-day expiry.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL, dynasty_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL
);
CREATE INDEX sessions_account ON sessions(account_id);
