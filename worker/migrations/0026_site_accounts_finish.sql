-- Site-wide accounts, part 4 of 4 (see 0023): the rows move from the staging table into accounts with the same ids, so
-- account_members and invites keep pointing at them, and the staging table goes.
INSERT INTO accounts (id, username, pass_hash, salt, blaze_id, created_at)
  SELECT id, username, pass_hash, salt, blaze_id, created_at FROM accounts_v2 ORDER BY id;
DROP TABLE IF EXISTS accounts_v2;
