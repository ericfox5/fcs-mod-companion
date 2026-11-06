-- Recruit edits also carry the face (head art id, RCPT.PGHE 1..246); NULL = unchanged.
ALTER TABLE web_recruit_edits ADD COLUMN head_id INTEGER;
