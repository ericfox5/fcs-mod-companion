-- The calendar year a dynasty began (SEAI.SSYE + 2013, what the hub's "Year N" counts from). "Nth season" labels count
-- from it, so a dynasty moved to 2026 by the Year Changer is in its 1st season, not its 14th. NULL = 2013 (old imports).
ALTER TABLE dynasties ADD COLUMN start_year INTEGER;
