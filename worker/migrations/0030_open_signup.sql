-- Open sign-up and league credentials (2026-11-15). Anyone can create a site account on /signup, pick an in-game name
-- and get a league credential ("ticket") for the public league server. The site keeps only the credential's SHA-256;
-- the league server pulls the list from GET /api/bridge/league-registry (worker/src/api/league-registry.ts).
-- CREATE TABLE / CREATE INDEX only: remote D1 refuses (code 7403) a file that creates a table and then writes to it, so
-- any data change on these tables belongs in a later migration.

-- League user ids: userId = id + 799999, so the first one is 800000. AUTOINCREMENT never hands an id out twice, even
-- after a row is deleted, and an account keeps the id it was given for good.
CREATE TABLE league_user_ids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL UNIQUE,
  allocated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One league identity per account: the in-game name (unique whatever the case: the game maps some rows by name) and the
-- SHA-256 of the current credential. Regenerating replaces ticket_sha256, which revokes the old credential. Rows are
-- never deleted; a banned member is disabled = 1.
CREATE TABLE league_players (
  account_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE CHECK (user_id > 0 AND user_id <= 2147483647),
  online_id TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(online_id) BETWEEN 3 AND 16),
  ticket_sha256 TEXT NOT NULL UNIQUE CHECK (length(ticket_sha256) = 64),
  issued_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  disabled_at TEXT,
  disabled_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit trail: signup, credential_issue, credential_regenerate, member_disable, member_enable, password_change.
-- account_id is the account acted on, actor_account_id who did it (the same account, or an admin). ip_hash is a
-- truncated SHA-256 of the client address, never the address itself.
CREATE TABLE league_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  action TEXT NOT NULL,
  account_id INTEGER,
  user_id INTEGER,
  actor_account_id INTEGER,
  ip_hash TEXT,
  detail TEXT
);
CREATE INDEX league_audit_account ON league_audit(account_id, id);

-- Fixed-window counters for sign-up, sign-in and credential rate limits (worker/src/security.ts). key is
-- "<scope>:<hash of ip or account>"; window_start is epoch milliseconds.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX rate_limits_window ON rate_limits(window_start);
