// Bridge API: authenticated with the BRIDGE_TOKEN secret. Imports a dynasty export in chunks into D1 and stores raw save
// files in R2. Online dynasties (the Blaze stub's store) also carry their members and uploaded results.
import type { Env } from '../env.js';
import { json } from '../html.js';
import { IMPORT_TABLES, buildInserts } from '../db/import-tables.js';
import { handlePhotos } from './photos.js';
import { listPendingWebBoards, markWebBoardDelivered, getDynastyByOdId, listPendingPlayerEdits, markPlayerEditDelivered } from '../db/queries.js';

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function bridgeAuthorized(req: Request, env: Env): Promise<boolean> {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || !env.BRIDGE_TOKEN) return false;
  const [a, b] = await Promise.all([sha256Hex(token), sha256Hex(env.BRIDGE_TOKEN)]);
  return a === b;
}

async function readJson(req: Request): Promise<any> {
  if (req.headers.get('x-content-encoding') === 'gzip' && req.body) {
    const ds = new DecompressionStream('gzip');
    const text = await new Response(req.body.pipeThrough(ds)).text();
    return JSON.parse(text);
  }
  return req.json();
}

const slugOf = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
const num = (v: unknown, dflt: number | null = null) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

// Online dynasty registration: keyed by the stub's DID so the slug (and every link) stays stable across re-imports.
async function upsertOnlineDynasty(db: D1Database, body: any): Promise<Response> {
  const od = body.od;
  let slug = slugOf(body.slug);
  if (!slug) return json({ error: 'slug required' }, 400);
  const existing = await db.prepare('SELECT id, slug FROM dynasties WHERE od_id = ?').bind(od.id).first<{ id: number; slug: string }>();
  if (existing) slug = existing.slug;
  else if (await db.prepare('SELECT id FROM dynasties WHERE slug = ?').bind(slug).first()) slug = `${slug}-od${od.id}`;
  await db.prepare(`INSERT INTO dynasties (slug, name, od_id, abbr, description, state, od_file_id, od_file_saved_at, od_created_at, settings_json, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET name = excluded.name, od_id = excluded.od_id, abbr = excluded.abbr, description = excluded.description, state = excluded.state,
      od_file_id = excluded.od_file_id, od_file_saved_at = excluded.od_file_saved_at, od_created_at = excluded.od_created_at, settings_json = excluded.settings_json, updated_at = datetime('now')`)
    .bind(slug, String(body.name ?? slug), od.id, od.abbr ?? null, od.description ?? null, num(od.state), num(od.fileId), num(od.fileSavedAt), num(od.createdAt), JSON.stringify(od.settings ?? {})).run();
  const row = await db.prepare('SELECT * FROM dynasties WHERE slug = ?').bind(slug).first<{ id: number }>();
  if (!row) return json({ error: 'dynasty vanished' }, 500);
  const stmts = [db.prepare('DELETE FROM od_members WHERE dynasty_id = ?').bind(row.id), db.prepare('DELETE FROM od_results WHERE dynasty_id = ?').bind(row.id)];
  for (const m of od.members ?? []) {
    stmts.push(db.prepare('INSERT INTO od_members (dynasty_id, blaze_id, persona, ncid, tgid, ccid, commissioner, team_file_id) VALUES (?,?,?,?,?,?,?,?)')
      .bind(row.id, num(m.blazeId, 0), String(m.persona ?? ''), num(m.ncId, 0), num(m.team, 0), num(m.coach, 0), m.commissioner ? 1 : 0, num(m.teamFileId, 0)));
  }
  for (const [week, list] of Object.entries(od.games ?? {})) {
    for (const g of list as any[]) {
      const quarters = { home: [g.HQ1S, g.HQ2S, g.HQ3S, g.HQ4S, g.HOTS].map((v) => num(v, 0)), away: [g.AQ1S, g.AQ2S, g.AQ3S, g.AQ4S, g.AOTS].map((v) => num(v, 0)) };
      stmts.push(db.prepare('INSERT OR REPLACE INTO od_results (dynasty_id, week, home_tgid, away_tgid, home_score, away_score, overtime, quarters_json, uploaded_by, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .bind(row.id, Number(week), num(g.HTID, 0), num(g.ATID, 0), num(g.HTSC, 0), num(g.ATSC, 0), g.OTFL ? 1 : 0, JSON.stringify(quarters), num(g.by), num(g.at)));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return json({ dynasty: row });
}

export async function handleBridge(req: Request, env: Env, path: string[]): Promise<Response> {
  if (!(await bridgeAuthorized(req, env))) return json({ error: 'unauthorized' }, 401);
  const [resource, id, sub, name] = path; // e.g. ['import', '12', 'rows'] or ['import','12','file','USR-DATA']
  const db = env.DB;

  if (resource === 'ping') return json({ ok: true, now: new Date().toISOString() });
  if (resource === 'photos') return handlePhotos(req, env);
  if (resource === 'logos') return handlePhotos(req, env, 'logos');
  if (resource === 'web-edits') { // pending site edits for one online dynasty (by DID), and delivery acks
    if (req.method === 'GET') {
      const odId = Number(new URL(req.url).searchParams.get('od'));
      const dyn = Number.isFinite(odId) ? await getDynastyByOdId(db, odId) : null;
      if (!dyn) return json({ boards: [], players: [] });
      const boards = (await listPendingWebBoards(db, dyn.id)).map((b) => ({ id: b.id, tgid: b.tgid, week: b.week, seasonYear: b.season_year, note: b.note, updatedAt: b.updated_at, rows: JSON.parse(b.rows_json) }));
      const players = (await listPendingPlayerEdits(db, dyn.id)).map((p) => ({ id: p.id, tgid: p.tgid, pgid: p.pgid, week: p.week, seasonYear: p.season_year, jersey: p.jersey, pos: p.pos, redshirt: p.redshirt, firstName: p.first_name, lastName: p.last_name, note: p.note, updatedAt: p.updated_at }));
      return json({ dynastyWeek: dyn.week, boards, players });
    }
    if (req.method === 'POST' && id && sub === 'delivered') { // ?kind=player acks a player edit; a board otherwise
      if (new URL(req.url).searchParams.get('kind') === 'player') await markPlayerEditDelivered(db, Number(id)); else await markWebBoardDelivered(db, Number(id));
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  }

  if (resource === 'dynasties' && req.method === 'POST') {
    const body = await readJson(req);
    if (body.od && typeof body.od.id === 'number') return upsertOnlineDynasty(db, body);
    const slug = slugOf(body.slug);
    if (!slug) return json({ error: 'slug required' }, 400);
    await db.prepare('INSERT INTO dynasties (slug, name) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET name = excluded.name, updated_at = datetime(\'now\')').bind(slug, body.name ?? slug).run();
    const row = await db.prepare('SELECT * FROM dynasties WHERE slug = ?').bind(slug).first();
    return json({ dynasty: row });
  }

  if (resource === 'import' && !id && req.method === 'POST') {
    const body = await readJson(req);
    const dyn = await db.prepare('SELECT id FROM dynasties WHERE slug = ?').bind(body.slug).first<{ id: number }>();
    if (!dyn) return json({ error: 'unknown dynasty' }, 404);
    const r = await db.prepare('INSERT INTO snapshots (dynasty_id, season_year, week, stage, week_type, sha256, db_size, table_counts_json, note) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(dyn.id, body.seasonYear, body.week, body.stage, num(body.weekType), body.sha256 ?? null, body.dbSize ?? null, JSON.stringify(body.tableCounts ?? null), body.note ?? null).run();
    const snapshotId = r.meta.last_row_id;
    await db.prepare('UPDATE snapshots SET r2_prefix = ? WHERE id = ?').bind(`snapshots/${body.slug}/${snapshotId}`, snapshotId).run();
    return json({ importId: snapshotId, dynastyId: dyn.id });
  }

  if (resource === 'import' && id) {
    const snap = await db.prepare('SELECT * FROM snapshots WHERE id = ?').bind(Number(id)).first<any>();
    if (!snap) return json({ error: 'unknown import' }, 404);
    if (snap.status !== 'importing' && sub !== 'status') return json({ error: `import is ${snap.status}` }, 409);

    if (sub === 'rows' && req.method === 'PUT') {
      const body = await readJson(req);
      const spec = IMPORT_TABLES[body.table as string];
      if (!spec) return json({ error: `unknown table ${body.table}` }, 400);
      const rows: unknown[] = body.rows ?? [];
      const stmts = buildInserts(db, spec, rows, snap.dynasty_id, snap.id, { seasonYear: snap.season_year });
      for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
      return json({ ok: true, table: body.table, rows: rows.length, statements: stmts.length });
    }

    if (sub === 'file' && name && req.method === 'PUT') {
      const key = `${snap.r2_prefix}/${name.replace(/[^A-Za-z0-9._;-]/g, '_')}`;
      await env.SAVES.put(key, req.body, { httpMetadata: { contentType: 'application/octet-stream' } });
      return json({ ok: true, key });
    }

    if (sub === 'commit' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const d = snap.dynasty_id, s = snap.id, y = snap.season_year;
      const purge: D1PreparedStatement[] = [];
      const seen = new Set<string>();
      for (const spec of Object.values(IMPORT_TABLES)) {
        if (seen.has(spec.table)) continue;
        seen.add(spec.table);
        if (body.tables && !body.tables.includes(spec.table)) continue;
        purge.push(spec.seasonScoped
          ? db.prepare(`DELETE FROM ${spec.table} WHERE dynasty_id = ? AND season_year = ? AND snapshot_id <> ?`).bind(d, y, s)
          : db.prepare(`DELETE FROM ${spec.table} WHERE dynasty_id = ? AND snapshot_id <> ?`).bind(d, s));
      }
      purge.push(db.prepare("UPDATE snapshots SET status = 'committed', committed_at = datetime('now') WHERE id = ?").bind(s));
      purge.push(db.prepare("UPDATE dynasties SET current_snapshot_id = ?, season_year = ?, week = ?, stage = ?, week_type = ?, updated_at = datetime('now') WHERE id = ?").bind(s, y, snap.week, snap.stage, snap.week_type ?? null, d));
      purge.push(db.prepare("INSERT INTO audit_log (dynasty_id, actor, action, detail_json) VALUES (?, 'bridge', 'import.commit', ?)").bind(d, JSON.stringify({ snapshotId: s, seasonYear: y, week: snap.week })));
      await db.batch(purge);
      return json({ ok: true, snapshotId: s });
    }

    if (sub === 'abort' && req.method === 'POST') {
      await db.prepare("UPDATE snapshots SET status = 'aborted' WHERE id = ?").bind(snap.id).run();
      return json({ ok: true });
    }

    if (sub === 'status') return json({ snapshot: snap });
  }
  return json({ error: 'not found' }, 404);
}
