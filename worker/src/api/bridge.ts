// Bridge API: authenticated with the BRIDGE_TOKEN secret. Imports a dynasty export in chunks into D1 and stores raw save
// files in R2. Online dynasties (the Blaze stub's store) also carry their members and uploaded results.
import type { Env } from '../env.js';
import { json } from '../html.js';
import { IMPORT_TABLES, buildInserts } from '../db/import-tables.js';
import { handlePhotos } from './photos.js';
import { handleInvites } from './auth.js';
import { handleSupersimBridge, type SimEnv } from '../supersim/routes.js';
import { listPendingWebVisits, markWebVisitsDelivered, insertCapture } from '../db/visits.js';
import { listPendingWireStories, listLiveWebStoryIds, getWebStoryImageKey, markWireDelivered, wireHeadline, upsertConsoleStory, listPendingRecaps, markRecapDelivered } from '../db/wire.js';
import { loadPlayoff, mergeFromBridge, syncPlayoffGames, type PlayoffState } from '../playoff-state.js';
import { putPlayoffState, listPendingWebBoards, markWebBoardDelivered, getDynastyByOdId, listPendingPlayerEdits, markPlayerEditDelivered, listPendingDepthEdits, markDepthEditDelivered, listPendingRecruitEdits, markRecruitEditDelivered, listPendingOverhaulRequests, finishOverhaulRequest, getMembers, linkPersonaStatements } from '../db/queries.js';
import { listPendingTransferEdits, markTransferEditDelivered } from '../db/transfers.js';

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
  // console members are replaced wholesale; web-only members (migration 0014) exist only on the site and stay
  const stmts = [db.prepare('DELETE FROM od_members WHERE dynasty_id = ? AND web_only = 0').bind(row.id), db.prepare('DELETE FROM od_results WHERE dynasty_id = ?').bind(row.id)];
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
  stmts.push(...linkPersonaStatements(db, row.id)); // console personas with a site account act here at once (migration 0023)
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return json({ dynasty: row });
}

export async function handleBridge(req: Request, env: Env, path: string[]): Promise<Response> {
  if (!(await bridgeAuthorized(req, env))) return json({ error: 'unauthorized' }, 401);
  const [resource, id, sub, name] = path; // e.g. ['import', '12', 'rows'] or ['import','12','file','USR-DATA']
  const db = env.DB;

  if (resource === 'ping') return json({ ok: true, now: new Date().toISOString() });
  if (resource === 'supersim') return handleSupersimBridge(req, env as SimEnv, path); // official-game outbox + receipts
  if (resource === 'photos') return handlePhotos(req, env);
  if (resource === 'logos') return handlePhotos(req, env, 'logos');
  if (resource === 'invites') return handleInvites(req, env, path.slice(1));
  if (resource === 'captures' && req.method === 'PUT') { // an in-game screenshot from the bridge, captioned from the highlight log
    const body = await readJson(req);
    const dyn = await getDynastyByOdId(db, Number(body.od));
    if (!dyn) return json({ error: 'unknown dynasty' }, 404);
    const name = String(body.name ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
    if (!name || typeof body.b64 !== 'string') return json({ error: 'name and b64 required' }, 400);
    const keyR2 = `stories/${dyn.id}/cap-${name}.jpg`;
    await env.SAVES.put(keyR2, Uint8Array.from(atob(body.b64), (c) => c.charCodeAt(0)), { httpMetadata: { contentType: 'image/jpeg' } });
    await insertCapture(db, { dynasty_id: dyn.id, source_name: name, image_key: keyR2, taken_at: body.takenAt ?? null, season_year: dyn.season_year, week: num(body.week), home_tgid: num(body.homeTgid), away_tgid: num(body.awayTgid), home_score: num(body.homeScore), away_score: num(body.awayScore), quarter: num(body.quarter), clock: body.clock ?? null, play_text: body.playText ?? null, width: num(body.width), height: num(body.height) });
    return json({ ok: true, key: keyR2 });
  } // member invite codes (worker/src/api/auth.ts)
  if (resource === 'wire') { // member stories for the in-game Dynasty Wire (league server spike/blaze/server/wire.mjs), by DID
    const dyn = await getDynastyByOdId(db, Number(new URL(req.url).searchParams.get('od')));
    if (!dyn) return json({ error: 'unknown dynasty' }, 404);
    if (req.method === 'GET' && !id) {
      const [pending, live, recaps] = await Promise.all([listPendingWireStories(db, dyn.id), listLiveWebStoryIds(db, dyn.id), listPendingRecaps(db, dyn.id)]);
      return json({
        pending: pending.map((s) => ({ id: s.id, title: s.title, headline: wireHeadline(s.body), caption: s.title, body: s.body, tgid: s.tgid ?? 0, week: s.week, seasonYear: s.season_year, author: s.author_persona, authorBlazeId: s.author_blaze_id, createdAt: s.created_at, hasImage: !!s.image_key, version: s.version })),
        live,
        recaps: recaps.map((r) => ({ xmsId: r.xms_id, text: r.recap_text, at: r.recap_at })),
      });
    }
    if (req.method === 'POST' && id === 'recap' && name === 'delivered') { // ['wire', 'recap', <xmsId>, 'delivered']
      const body = await readJson(req);
      await markRecapDelivered(db, dyn.id, Number(sub), String(body.at ?? ''));
      return json({ ok: true });
    }
    if (req.method === 'GET' && sub === 'image') {
      const row = await getWebStoryImageKey(db, dyn.id, Number(id));
      const obj = row?.image_key ? await env.SAVES.get(row.image_key) : null;
      return obj ? new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream' } }) : json({ error: 'no image' }, 404);
    }
    if (req.method === 'POST' && sub === 'delivered') {
      const body = await readJson(req);
      await markWireDelivered(db, dyn.id, Number(id), num(body.xmsId), String(body.version ?? ''));
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  }
  if (resource === 'console-stories' && req.method === 'PUT') { // a story the console uploaded to its Dynasty Wire (recap or user story)
    const body = await readJson(req);
    const dyn = await getDynastyByOdId(db, Number(body.od));
    if (!dyn) return json({ error: 'unknown dynasty' }, 404);
    const xmsId = num(body.xmsId); if (xmsId === null) return json({ error: 'xmsId required' }, 400);
    let photoKey: string | null = null;
    if (typeof body.photoB64 === 'string' && body.photoB64) {
      photoKey = `stories/${dyn.id}/xms-${xmsId}.jpg`;
      await env.SAVES.put(photoKey, Uint8Array.from(atob(body.photoB64), (c) => c.charCodeAt(0)), { httpMetadata: { contentType: 'image/jpeg' } });
    }
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);
    await upsertConsoleStory(db, {
      dynasty_id: dyn.id, xms_id: xmsId, story_type: num(body.storyType), kind: String(body.kind ?? 'unknown').slice(0, 20), team_tgid: num(body.teamTgid), season: num(body.season),
      week: dyn.week ?? null, title: text(body.title, 200), headline: text(body.headline, 400), caption: text(body.caption, 200), body: text(body.body, 12000),
      texts_json: Array.isArray(body.texts) ? JSON.stringify(body.texts.slice(0, 20).map((t: unknown) => String(t).slice(0, 12000))) : null, table_blocks: num(body.tableBlocks),
      photo_key: photoKey, author_persona: text(body.author, 60), author_blaze_id: num(body.authorBlazeId), created_at: text(body.createdAt, 40),
    });
    return json({ ok: true, photoKey });
  }
  if (resource === 'playoff') { // the FCS playoff bracket (worker/src/playoff-state.ts): the bridge sets the field and reads the site's results
    const odId = Number(new URL(req.url).searchParams.get('od'));
    const dyn = Number.isFinite(odId) ? await getDynastyByOdId(db, odId) : null;
    if (!dyn) return json({ error: 'unknown dynasty' }, 404);
    if (req.method === 'GET') { const state = await loadPlayoff(db, dyn); return json({ seasonYear: dyn.season_year, state }); }
    if (req.method !== 'PUT') return json({ error: 'method not allowed' }, 405);
    const body = await readJson(req);
    const year = Number(body.seasonYear);
    if (!Number.isFinite(year) || !Array.isArray(body.seeds) || !Array.isArray(body.games)) return json({ error: 'seasonYear, seeds and games are required' }, 400);
    const prev = await loadPlayoff(db, dyn, year);
    const state = mergeFromBridge(prev, body as Partial<PlayoffState>, year);
    await putPlayoffState(db, dyn.id, year, JSON.stringify(state));
    const rows = year === dyn.season_year ? await syncPlayoffGames(db, dyn, state) : 0;
    return json({ ok: true, phase: state.phase, games: state.games.length, rows });
  }
  if (resource === 'recruits-preview' && req.method === 'PUT') { // the reshaped class (Fang's overhaul) shown on the site before the console has uploaded it: rows in the import's shape
    const odId = Number(new URL(req.url).searchParams.get('od'));
    const dyn = Number.isFinite(odId) ? await getDynastyByOdId(db, odId) : null;
    if (!dyn) return json({ error: 'unknown dynasty' }, 404);
    const body = await readJson(req);
    const spec = IMPORT_TABLES[body.table as string];
    if (!spec || !['recruits', 'recruit_interest'].includes(spec.table)) return json({ error: `not a recruit table: ${body.table}` }, 400);
    const rows: unknown[] = body.rows ?? [];
    const stmts = buildInserts(db, spec, rows, dyn.id, dyn.current_snapshot_id ?? 0, { seasonYear: dyn.season_year });
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
    return json({ ok: true, table: body.table, rows: rows.length });
  }
  if (resource === 'web-edits') { // pending site edits for one online dynasty (by DID), and delivery acks
    if (req.method === 'GET') {
      const odId = Number(new URL(req.url).searchParams.get('od'));
      const dyn = Number.isFinite(odId) ? await getDynastyByOdId(db, odId) : null;
      if (!dyn) return json({ boards: [], players: [], transfers: [] });
      const boards = (await listPendingWebBoards(db, dyn.id)).map((b) => ({ id: b.id, tgid: b.tgid, week: b.week, seasonYear: b.season_year, note: b.note, updatedAt: b.updated_at, rows: JSON.parse(b.rows_json) }));
      const players = (await listPendingPlayerEdits(db, dyn.id)).map((p) => ({ id: p.id, tgid: p.tgid, pgid: p.pgid, week: p.week, seasonYear: p.season_year, jersey: p.jersey, pos: p.pos, redshirt: p.redshirt, firstName: p.first_name, lastName: p.last_name, note: p.note, updatedAt: p.updated_at }));
      const visits = (await listPendingWebVisits(db, dyn.id)).map((v) => ({ id: v.id, tgid: v.tgid, week: v.week, seasonYear: v.season_year, note: v.note, updatedAt: v.updated_at, rows: JSON.parse(v.rows_json) }));
      // Transfer Portal changes: action 'transfer' (toTgid + reason = PLFL code) or 'stay'; fromTgid = the player's team
      const transfers = (await listPendingTransferEdits(db, dyn.id)).map((t) => ({ id: t.id, pgid: t.pgid, fromTgid: t.from_tgid, action: t.action, toTgid: t.to_tgid, reason: t.reason, seasonYear: t.season_year, week: t.week, updatedAt: t.updated_at }));
      // Depth chart + formation subs (migration 0018): the whole chart per team, written into the dynasty file copy
      const depth = (await listPendingDepthEdits(db, dyn.id)).map((e) => ({ id: e.id, tgid: e.tgid, seasonYear: e.season_year, week: e.week, chart: JSON.parse(e.chart_json), subs: JSON.parse(e.subs_json), note: e.note, updatedAt: e.updated_at }));
      // Recruit edits (migration 0019): written into the dynasty file copy by PRSI; weight in pounds
      const recruits = (await listPendingRecruitEdits(db, dyn.id)).map((e) => ({ id: e.id, prsi: e.prsi, seasonYear: e.season_year, week: e.week, firstName: e.first_name, lastName: e.last_name, pos: e.pos, height: e.height, weight: e.weight, stars: e.stars, headId: e.head_id ?? null, note: e.note, updatedAt: e.updated_at }));
      // the commissioner's "re-generate the class" requests (Fang's Recruit Overhaul, preseason only)
      const overhaul = (await listPendingOverhaulRequests(db, dyn.id)).map((r) => ({ id: r.id, seasonYear: r.season_year, requestedBy: r.requested_by, createdAt: r.created_at }));
      // members' teams: the transfer-eligibility rule un-redshirts the portal players the game sat down on them
      const memberTeams = [...new Set((await getMembers(db, dyn.id)).map((m) => m.tgid).filter((t) => t > 0))];
      return json({ dynastyWeek: dyn.week, visits, boards, players, transfers, depth, recruits, overhaul, memberTeams });
    }
    if (req.method === 'POST' && id && sub === 'delivered') { // ?kind=player / visit / transfer / depth / recruit acks that kind; a board otherwise
      const kind = new URL(req.url).searchParams.get('kind');
      if (kind === 'player') await markPlayerEditDelivered(db, Number(id)); else if (kind === 'visit') await markWebVisitsDelivered(db, Number(id)); else if (kind === 'transfer') await markTransferEditDelivered(db, Number(id)); else if (kind === 'depth') await markDepthEditDelivered(db, Number(id)); else if (kind === 'recruit') await markRecruitEditDelivered(db, Number(id)); else await markWebBoardDelivered(db, Number(id));
      return json({ ok: true });
    }
    if (req.method === 'POST' && id && sub === 'overhaul') { // the bridge's result for a re-generate request: {status: 'done'|'failed', message} (gzip JSON like every bridge body)
      const body = (await readJson(req).catch(() => ({}))) as { status?: string; message?: string };
      await finishOverhaulRequest(db, Number(id), body.status === 'done' ? 'done' : 'failed', String(body.message ?? '').slice(0, 500));
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  }

  // Game-line history (2026-11-02): the console empties a dynasty file's box-score lines in the offseason, so imports
  // replace only the weeks they carry (weekScoped) and `ncaa-bridge od backfill-logs` refills lost weeks from the files
  // each import stored in R2: list the snapshots, fetch a stored file, replace given weeks' lines.
  if (resource === 'snapshots' && req.method === 'GET') {
    if (!id) {
      const od = Number(new URL(req.url).searchParams.get('od'));
      const rows = await db.prepare("SELECT s.id, s.season_year, s.week, s.stage, s.r2_prefix, s.committed_at FROM snapshots s JOIN dynasties d ON d.id = s.dynasty_id WHERE d.od_id = ? AND s.status = 'committed' ORDER BY s.id").bind(od).all();
      return json({ snapshots: rows.results });
    }
    if (sub === 'file' && name) {
      const row = await db.prepare('SELECT r2_prefix FROM snapshots WHERE id = ?').bind(Number(id)).first<{ r2_prefix: string | null }>();
      const obj = row?.r2_prefix ? await env.SAVES.get(`${row.r2_prefix}/${name.replace(/[^A-Za-z0-9._;-]/g, '_')}`) : null;
      if (!obj) return json({ error: 'no such file' }, 404);
      return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream' } });
    }
  }
  if (resource === 'game-logs' && req.method === 'POST') { // { od, snapshotId, seasonYear, rows }: replaces the weeks the rows cover
    const body = await readJson(req);
    const dyn = await db.prepare('SELECT id FROM dynasties WHERE od_id = ?').bind(Number(body.od)).first<{ id: number }>();
    if (!dyn) return json({ error: 'unknown dynasty' }, 404);
    const rows: any[] = Array.isArray(body.rows) ? body.rows : [];
    const y = Number(body.seasonYear), snapId = Number(body.snapshotId);
    const weeks = [...new Set(rows.map((r) => Number(r.SEWN)).filter(Number.isInteger))];
    if (!Number.isInteger(y) || !Number.isInteger(snapId) || !weeks.length) return json({ error: 'seasonYear, snapshotId and rows with SEWN required' }, 400);
    const stmts = [db.prepare(`DELETE FROM game_logs WHERE dynasty_id = ? AND season_year = ? AND week IN (${weeks.map(() => '?').join(',')})`).bind(dyn.id, y, ...weeks), ...buildInserts(db, IMPORT_TABLES.gameLogs!, rows, dyn.id, snapId, { seasonYear: y })];
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
    return json({ ok: true, weeks, rows: rows.length });
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
    // the year the dynasty began (SEAI.SSYE): "Nth season" counts from it (migration 0022)
    if (typeof body.startYear === 'number' && Number.isFinite(body.startYear)) await db.prepare('UPDATE dynasties SET start_year = ? WHERE id = ?').bind(body.startYear, dyn.id).run();
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
        if (spec.keep) continue;
        purge.push(spec.weekScoped
          ? db.prepare(`DELETE FROM ${spec.table} WHERE dynasty_id = ? AND season_year = ? AND snapshot_id <> ? AND week IN (SELECT DISTINCT week FROM ${spec.table} WHERE dynasty_id = ? AND season_year = ? AND snapshot_id = ?)`).bind(d, y, s, d, y, s)
          : spec.seasonScoped
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
