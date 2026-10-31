// Recruit visits edited on the site and in-game photo captures (kept apart from queries.ts to avoid edit collisions).
import type { Dynasty } from './queries.js';

const all = async <T>(stmt: D1PreparedStatement): Promise<T[]> => (await stmt.all<T>()).results;

// RECV-shaped: the console fills VMVP/NFGZ/NFGM after the visit; OFGP is the visit's expected value (copied from a
// typical scheduled visit when the site adds one).
export interface VisitRow { VMVP: number; TGID: number; PRSI: number; OFGP: number; RCWK: number; NFGZ: number; NFGM: number }
export interface WebVisits { id: number; dynasty_id: number; tgid: number; season_year: number; week: number; rows_json: string; note: string | null; updated_by: number | null; updated_at: string; delivered_at: string | null }
export interface VisitImport { tgid: number; prsi: number; week: number; value: number; mvp: number; nfgz: number; nfgm: number }

export const getWebVisits = (db: D1Database, d: number, tgid: number, year: number, week: number) => db.prepare('SELECT * FROM web_visits WHERE dynasty_id = ? AND tgid = ? AND season_year = ? AND week = ?').bind(d, tgid, year, week).first<WebVisits>();
export const upsertWebVisits = (db: D1Database, d: number, tgid: number, year: number, week: number, rows: VisitRow[], by: number | null, note: string | null) =>
  db.prepare("INSERT INTO web_visits (dynasty_id, tgid, season_year, week, rows_json, note, updated_by, updated_at, delivered_at) VALUES (?,?,?,?,?,?,?, datetime('now'), NULL) ON CONFLICT(dynasty_id, tgid, season_year, week) DO UPDATE SET rows_json = excluded.rows_json, note = excluded.note, updated_by = excluded.updated_by, updated_at = datetime('now'), delivered_at = NULL").bind(d, tgid, year, week, JSON.stringify(rows), note, by).run();
export const deleteWebVisits = (db: D1Database, d: number, tgid: number, year: number, week: number) => db.prepare('DELETE FROM web_visits WHERE dynasty_id = ? AND tgid = ? AND season_year = ? AND week = ?').bind(d, tgid, year, week).run();
export const listPendingWebVisits = (db: D1Database, d: number) => all<WebVisits>(db.prepare('SELECT * FROM web_visits WHERE dynasty_id = ? AND delivered_at IS NULL ORDER BY week, tgid').bind(d));
export const markWebVisitsDelivered = (db: D1Database, id: number) => db.prepare("UPDATE web_visits SET delivered_at = datetime('now') WHERE id = ? AND delivered_at IS NULL").bind(id).run();
// the console's own visit rows, imported with the recruiting tables
export const getTeamVisits = (db: D1Database, d: number, tgid: number) => all<VisitImport>(db.prepare('SELECT tgid, prsi, week, value, mvp, nfgz, nfgm FROM recruit_visits WHERE dynasty_id = ? AND tgid = ? ORDER BY week').bind(d, tgid));

export interface CaptureRow { id: number; dynasty_id: number; source_name: string; image_key: string; taken_at: string | null; season_year: number | null; week: number | null; home_tgid: number | null; away_tgid: number | null; home_score: number | null; away_score: number | null; quarter: number | null; clock: string | null; play_text: string | null; width: number | null; height: number | null; created_at: string }
export const listCaptures = (db: D1Database, d: number, limit = 60) => all<CaptureRow>(db.prepare('SELECT * FROM captures WHERE dynasty_id = ? ORDER BY id DESC LIMIT ?').bind(d, limit));
export const getCapture = (db: D1Database, d: number, id: number) => db.prepare('SELECT * FROM captures WHERE dynasty_id = ? AND id = ?').bind(d, id).first<CaptureRow>();
export const hasCapture = (db: D1Database, d: number, sourceName: string) => db.prepare('SELECT id FROM captures WHERE dynasty_id = ? AND source_name = ?').bind(d, sourceName).first<{ id: number }>();
export const insertCapture = (db: D1Database, c: Omit<CaptureRow, 'id' | 'created_at'>) =>
  db.prepare('INSERT INTO captures (dynasty_id, source_name, image_key, taken_at, season_year, week, home_tgid, away_tgid, home_score, away_score, quarter, clock, play_text, width, height) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dynasty_id, source_name) DO UPDATE SET image_key = excluded.image_key, play_text = excluded.play_text')
    .bind(c.dynasty_id, c.source_name, c.image_key, c.taken_at, c.season_year, c.week, c.home_tgid, c.away_tgid, c.home_score, c.away_score, c.quarter, c.clock, c.play_text, c.width, c.height).run();
export type { Dynasty };
