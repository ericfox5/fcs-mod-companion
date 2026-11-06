-- Site-wide accounts, part 2 of 4 (see 0023): one account per console persona (its newest row's username/password), one
-- per web player; every console persona linked to every dynasty it is a member of; invites re-pointed at the new ids.
-- Then the old accounts and sessions tables go (sessions are dropped: everyone signs in once more).

-- console personas: the newest row per blaze_id; a username another, earlier persona (by its first row) already uses
-- gets "-<blaze id>". Written without a CTE so the remote API's statement check sees only real tables.
INSERT INTO accounts_v2 (username, pass_hash, salt, blaze_id, created_at)
SELECT CASE WHEN EXISTS (
         SELECT 1 FROM accounts q
         WHERE q.blaze_id > 0 AND q.blaze_id <> p.blaze_id AND q.username = p.username
           AND q.id = (SELECT MAX(id) FROM accounts c WHERE c.blaze_id = q.blaze_id)
           AND (SELECT MIN(id) FROM accounts c WHERE c.blaze_id = q.blaze_id) < (SELECT MIN(id) FROM accounts c WHERE c.blaze_id = p.blaze_id))
       THEN p.username || '-' || p.blaze_id ELSE p.username END,
       p.pass_hash, p.salt, p.blaze_id, p.created_at
FROM accounts p
WHERE p.blaze_id > 0 AND p.id = (SELECT MAX(id) FROM accounts c WHERE c.blaze_id = p.blaze_id)
ORDER BY (SELECT MIN(id) FROM accounts c WHERE c.blaze_id = p.blaze_id);

-- web players: one account per row (they were per dynasty anyway); a taken username gets "-<dynasty id>"
INSERT INTO accounts_v2 (username, pass_hash, salt, blaze_id, created_at)
SELECT CASE WHEN EXISTS (SELECT 1 FROM accounts_v2 v WHERE v.username = a.username)
              OR EXISTS (SELECT 1 FROM accounts b WHERE b.blaze_id < 0 AND b.username = a.username AND b.id < a.id)
            THEN a.username || '-' || a.dynasty_id ELSE a.username END,
       a.pass_hash, a.salt, NULL, a.created_at
FROM accounts a WHERE a.blaze_id < 0 ORDER BY a.id;

INSERT INTO acct_map (old_id, new_id) SELECT a.id, v.id FROM accounts a JOIN accounts_v2 v ON v.blaze_id = a.blaze_id WHERE a.blaze_id > 0;
INSERT INTO acct_map (old_id, new_id) SELECT a.id, v.id FROM accounts a JOIN accounts_v2 v ON v.blaze_id IS NULL AND v.salt = a.salt AND v.pass_hash = a.pass_hash WHERE a.blaze_id < 0;

-- links: a console persona in every dynasty it is a member of; a web player in the dynasty its account was made in
INSERT OR IGNORE INTO account_members (account_id, dynasty_id, blaze_id)
  SELECT v.id, m.dynasty_id, m.blaze_id FROM accounts_v2 v JOIN od_members m ON m.blaze_id = v.blaze_id AND m.web_only = 0 WHERE v.blaze_id IS NOT NULL;
INSERT OR IGNORE INTO account_members (account_id, dynasty_id, blaze_id)
  SELECT k.new_id, a.dynasty_id, a.blaze_id FROM accounts a JOIN acct_map k ON k.old_id = a.id WHERE a.blaze_id < 0;

UPDATE invites SET created_by_account_id = (SELECT new_id FROM acct_map WHERE old_id = invites.created_by_account_id) WHERE created_by_account_id IS NOT NULL;
UPDATE invites SET used_by_account_id = (SELECT new_id FROM acct_map WHERE old_id = invites.used_by_account_id) WHERE used_by_account_id IS NOT NULL;

DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS acct_map;
DROP TABLE IF EXISTS accounts;
