-- Team and conference logos: logo_key = R2 object under logos/ (teams/<espn id>.png, conf/<id>.png), set at import from
-- the bridge's name mapping (bridge/data/logos.json).
ALTER TABLE teams ADD COLUMN logo_key TEXT;
ALTER TABLE conferences ADD COLUMN logo_key TEXT;
