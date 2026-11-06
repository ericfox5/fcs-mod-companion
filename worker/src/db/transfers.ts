// Transfer Portal data (kept apart from queries.ts to avoid edit collisions): the imported transfer list and leaving
// flags, and the commissioner's pending transfer edits (web_transfer_edits, folded into the console's change tables by
// the bridge).
import type { PlayerRow } from './queries.js';

const all = async <T>(stmt: D1PreparedStatement): Promise<T[]> => (await stmt.all<T>()).results;

// PLAY.PLFL codes that mean "transferring out" (the user's list: 9 leaving, 10/11 playing time, 14 coach leaving, 15
// homesick). PTYP 1 alone is not enough: it stays set on players who transferred in earlier (PLFL 28, no TRAN row).
export const TRANSFER_REASONS: [number, string, string][] = [
  [9, 'Transfer (Leaving)', 'Leaving'], [10, 'Transfer (Playing Time)', 'Playing time'], [11, 'Transfer (Playing Time)', 'Playing time'],
  [14, 'Transfer (Coach Leaving)', 'Coach leaving'], [15, 'Transfer (Home Sick)', 'Homesick'],
];
export const TRANSFER_FLAGS = TRANSFER_REASONS.map(([c]) => c);
export const reasonLabel = (code: number | null | undefined, short = true) => TRANSFER_REASONS.find(([c]) => c === code)?.[short ? 2 : 1] ?? (code ? `Code ${code}` : '—');

export interface PortalPlayer extends PlayerRow { leave_flag: number | null; leave_type: number | null; to_tgid: number | null; trac: number | null; wtls: number | null }
export interface WebTransferEdit { id: number; dynasty_id: number; pgid: number; from_tgid: number; action: 'transfer' | 'stay'; to_tgid: number | null; reason: number | null; season_year: number; week: number; updated_by: number | null; updated_at: string; delivered_at: string | null }

const FLAG_LIST = TRANSFER_FLAGS.join(',');
// Players transferring out right now: an active TRAN row, or a transfer reason in PLFL.
export const listTransfers = (db: D1Database, d: number) => all<PortalPlayer>(db.prepare(
  `SELECT p.*, t.to_tgid, t.trac, t.wtls FROM players p LEFT JOIN transfers t ON t.dynasty_id = p.dynasty_id AND t.pgid = p.pgid
   WHERE p.dynasty_id = ? AND ((t.pgid IS NOT NULL AND t.trac = 1) OR p.leave_flag IN (${FLAG_LIST})) ORDER BY p.overall DESC`).bind(d));
export const getPortalPlayer = (db: D1Database, d: number, pgid: number) => db.prepare(
  'SELECT p.*, t.to_tgid, t.trac, t.wtls FROM players p LEFT JOIN transfers t ON t.dynasty_id = p.dynasty_id AND t.pgid = p.pgid WHERE p.dynasty_id = ? AND p.pgid = ?').bind(d, pgid).first<PortalPlayer>();
export async function getPortalPlayers(db: D1Database, d: number, ids: number[]): Promise<PortalPlayer[]> {
  const out: PortalPlayer[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const slice = ids.slice(i, i + 90);
    out.push(...(await all<PortalPlayer>(db.prepare(`SELECT p.*, t.to_tgid, t.trac, t.wtls FROM players p LEFT JOIN transfers t ON t.dynasty_id = p.dynasty_id AND t.pgid = p.pgid WHERE p.dynasty_id = ? AND p.pgid IN (${slice.map(() => '?').join(',')})`).bind(d, ...slice))));
  }
  return out;
}
export const isTransferring = (p: Pick<PortalPlayer, 'leave_flag' | 'to_tgid' | 'trac'>) => (p.to_tgid !== null && p.trac === 1) || (p.leave_flag !== null && TRANSFER_FLAGS.includes(p.leave_flag));
// Whether the import carries leaving data at all (imports before migration 0013 leave the columns NULL).
export const hasLeaveData = async (db: D1Database, d: number) => !!(await db.prepare('SELECT 1 FROM players WHERE dynasty_id = ? AND leave_flag IS NOT NULL LIMIT 1').bind(d).first());
// Departure counts by PLFL (26 graduating, 19-25 draft, 1-7 projected rounds).
export const leaveCounts = (db: D1Database, d: number) => all<{ leave_flag: number; n: number }>(db.prepare('SELECT leave_flag, COUNT(*) AS n FROM players WHERE dynasty_id = ? AND leave_flag IS NOT NULL GROUP BY leave_flag').bind(d));
// Players for the "make a transfer" picker: one team's roster, or a name search across the league.
export const teamRosterForPortal = (db: D1Database, d: number, tgid: number) => all<PortalPlayer>(db.prepare(
  'SELECT p.*, t.to_tgid, t.trac, t.wtls FROM players p LEFT JOIN transfers t ON t.dynasty_id = p.dynasty_id AND t.pgid = p.pgid WHERE p.dynasty_id = ? AND p.tgid = ? ORDER BY p.pos, p.overall DESC').bind(d, tgid));
export function searchPortalPlayers(db: D1Database, d: number, q: string, limit = 25) {
  const words = q.trim().split(/\s+/).filter(Boolean).slice(0, 3);
  const where = words.map(() => "(p.first_name || ' ' || p.last_name) LIKE ?").join(' AND ');
  return all<PortalPlayer>(db.prepare(`SELECT p.*, t.to_tgid, t.trac, t.wtls FROM players p LEFT JOIN transfers t ON t.dynasty_id = p.dynasty_id AND t.pgid = p.pgid WHERE p.dynasty_id = ? AND ${where || '1'} ORDER BY p.overall DESC LIMIT ?`)
    .bind(d, ...words.map((w) => `%${w.replace(/[%_]/g, '')}%`), limit));
}

export const listTransferEdits = (db: D1Database, d: number, year: number, week: number) => all<WebTransferEdit>(db.prepare('SELECT * FROM web_transfer_edits WHERE dynasty_id = ? AND season_year = ? AND week = ? AND delivered_at IS NULL ORDER BY updated_at DESC, id DESC').bind(d, year, week));
export const listPendingTransferEdits = (db: D1Database, d: number) => all<WebTransferEdit>(db.prepare('SELECT * FROM web_transfer_edits WHERE dynasty_id = ? AND delivered_at IS NULL ORDER BY week, pgid').bind(d));
export const upsertTransferEdit = (db: D1Database, d: number, e: { pgid: number; from_tgid: number; action: 'transfer' | 'stay'; to_tgid: number | null; reason: number | null }, year: number, week: number, by: number | null) =>
  db.prepare("INSERT INTO web_transfer_edits (dynasty_id, pgid, from_tgid, action, to_tgid, reason, season_year, week, updated_by, updated_at, delivered_at) VALUES (?,?,?,?,?,?,?,?,?, datetime('now'), NULL) ON CONFLICT(dynasty_id, pgid, season_year, week) DO UPDATE SET from_tgid = excluded.from_tgid, action = excluded.action, to_tgid = excluded.to_tgid, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = datetime('now'), delivered_at = NULL")
    .bind(d, e.pgid, e.from_tgid, e.action, e.to_tgid, e.reason, year, week, by).run();
export const deleteTransferEdit = (db: D1Database, d: number, pgid: number, year: number, week: number) => db.prepare('DELETE FROM web_transfer_edits WHERE dynasty_id = ? AND pgid = ? AND season_year = ? AND week = ? AND delivered_at IS NULL').bind(d, pgid, year, week).run();
export const markTransferEditDelivered = (db: D1Database, id: number) => db.prepare("UPDATE web_transfer_edits SET delivered_at = datetime('now') WHERE id = ? AND delivered_at IS NULL").bind(id).run();
// The newest season of stats each player has (in the offseason that is the season just played), by kind.
export async function latestSeasonStats(db: D1Database, d: number, ids: number[]): Promise<Map<number, { year: number; stats: Record<string, Record<string, number>> }>> {
  const out = new Map<number, { year: number; stats: Record<string, Record<string, number>> }>();
  for (let i = 0; i < ids.length; i += 90) {
    const slice = ids.slice(i, i + 90);
    const rows = await all<{ season_year: number; kind: string; pgid: number; stats_json: string }>(db.prepare(`SELECT season_year, kind, pgid, stats_json FROM player_season_stats WHERE dynasty_id = ? AND pgid IN (${slice.map(() => '?').join(',')})`).bind(d, ...slice));
    for (const r of rows) {
      const cur = out.get(r.pgid);
      if (cur && cur.year > r.season_year) continue;
      const e = cur && cur.year === r.season_year ? cur : { year: r.season_year, stats: {} };
      try { e.stats[r.kind] = JSON.parse(r.stats_json || '{}'); } catch { /* skip */ }
      out.set(r.pgid, e);
    }
  }
  return out;
}
