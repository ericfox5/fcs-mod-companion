-- Site-wide accounts, part 1 of 4 (2026-11-05). Until now an account belonged to one dynasty (UNIQUE (dynasty_id,
-- blaze_id)), so the same person made a new username + password for every online dynasty they created or joined. Now an
-- account is one username + password for the whole site that owns at most one league-server persona (accounts.blaze_id
-- > 0: the RPCN user the console signs in with). account_members says which member the account acts as in each dynasty:
--   * console personas are linked automatically whenever the bridge syncs a dynasty's member list (api/bridge.ts), so
--     whoever creates or joins an online dynasty on the console is recognised on the site at once, with the session they
--     already have (sessions are site-wide too: no dynasty_id);
--   * web players (negative, per-dynasty blaze ids) are linked when their invite is used.
-- The change is spread over migrations 0023-0026 because D1's remote query API (what `wrangler d1 migrations apply
-- --remote` posts each file to) refuses, as "not authorized [code: 7403]", any INSERT/UPDATE/DELETE/DROP/ALTER whose
-- table did not exist when the request began: a file may create tables, but only a later file can write to or drop them
-- (CREATE TABLE / CREATE INDEX are exempt). This file creates the staging tables; 0024 fills them from the old rows and
-- drops the old tables; 0025 creates the final accounts + sessions tables; 0026 moves the rows over and drops the staging.
CREATE TABLE accounts_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  pass_hash TEXT NOT NULL, salt TEXT NOT NULL,
  blaze_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE account_members (
  account_id INTEGER NOT NULL, dynasty_id INTEGER NOT NULL, blaze_id INTEGER NOT NULL,
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (dynasty_id, blaze_id)
);
CREATE INDEX account_members_acct ON account_members(account_id);
CREATE TABLE acct_map (old_id INTEGER PRIMARY KEY, new_id INTEGER NOT NULL);
