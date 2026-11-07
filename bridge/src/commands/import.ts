import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseTdb } from '@ncaa/tdb';
import { exportDynasty, isPlayed, type DynastyExport } from '@ncaa/ncaa14';
import { WorkerApi } from '../api.js';
import type { BridgeConfig } from '../config.js';
import { loadPhotoIndex, attachPhotoKeys, photoDirsOf } from '../photos.js';
import { attachLogoKeys } from '../logos.js';

const CHUNK = 400;
// Sets added after the Worker's import specs; an older deployment answers "unknown table" for them.
const OPTIONAL_SETS = new Set(['transfers', 'formationSubs']);

// A player's identity across seasons: PGID is a roster slot (TGID * PGID_STRIDE + n, packages/ncaa14 roster.ts) that changes when he transfers and is
// reused by the recruit who takes his slot, while POID ("Org. Player ID") stays with him; POID plus hometown (RCHD)
// tells him apart from a later occupant of the same original slot. Stat lines carry the uid of the player who held the
// PGID in the same file, so a season's lines stay with the right person after transfers and graduations.
export function playerUids(ex: DynastyExport): Map<number, string> {
  return new Map(ex.players.map((p) => [p.pgid, `${p.ratings?.POID ?? p.pgid}:${p.ratings?.RCHD ?? 0}`]));
}
export function withUids(rows: Record<string, unknown>[], uids: Map<number, string>): Record<string, unknown>[] {
  return rows.map((r) => ({ ...r, uid: uids.get(Number(r.PGID)) ?? null }));
}

// Sends every row set of a decoded dynasty to an open import, in chunks.
export async function pushExport(api: WorkerApi, importId: number, ex: DynastyExport, opts: { quiet?: boolean } = {}): Promise<void> {
  const uids = playerUids(ex);
  // season stat tables may keep earlier seasons (SEYR = season offset): only the current season is (re)sent, earlier
  // seasons were stored during their own season with that season's player identities
  const statRows: Record<string, unknown>[] = Object.entries(ex.playerSeasonStats).flatMap(([kind, rows]) => rows.map((r) => ({ ...r, kind })));
  const current = statRows.filter((r) => r.SEYR === undefined || Number(r.SEYR) === ex.season.yearOffset);
  if (current.length < statRows.length && !opts.quiet) console.log(`  playerSeasonStats: ${statRows.length - current.length} row(s) from other seasons (SEYR != ${ex.season.yearOffset}) left as stored`);
  const sets: [string, unknown[]][] = [
    ['calendar', ex.calendar], ['conferences', ex.conferences], ['divisions', ex.divisions], ['teams', ex.teams], ['players', ex.players],
    ['coaches', ex.coaches], ['depthChart', ex.depthChart], ['formationSubs', ex.formationSubs], ['schedule', ex.schedule], ['stories', ex.stories], ['heisman', ex.heisman],
    ['allAmericans', ex.allAmericans], ['teamSeasonStats', ex.teamSeasonStats], ['teamHistory', ex.teamHistory],
    ['playerSeasonStats', withUids(current, uids)],
    ['recruits', ex.recruits], ['recruitInterest', ex.recruitInterest], ['recruitingBoard', ex.recruitingBoard], ['recruitVisits', ex.recruitVisits], ['transfers', ex.transfers],
    ['gameLogs', withUids(Object.entries(ex.gameLogs).flatMap(([kind, rows]) => rows.map((r) => ({ ...r, kind }))), uids)],
  ];
  for (const [table, rows] of sets) {
    let sent = 0;
    try {
      for (let i = 0; i < rows.length; i += CHUNK) {
        await api.json('PUT', `/api/bridge/import/${importId}/rows`, { table, rows: rows.slice(i, i + CHUNK) });
        sent += Math.min(CHUNK, rows.length - i);
      }
    } catch (e) { // a set newer than the deployed Worker: skip it rather than fail the whole import
      if (OPTIONAL_SETS.has(table) && /unknown table/.test((e as Error).message)) { if (!opts.quiet) console.log(`  ${table.padEnd(18)} skipped (the site does not know this table yet)`); continue; }
      throw e;
    }
    if (!opts.quiet) console.log(`  ${table.padEnd(18)} ${String(sent).padStart(6)} rows`);
  }
}

export async function importSave(cfg: BridgeConfig, usrData: string, opts: { note?: string; files?: boolean } = {}) {
  const bytes = new Uint8Array(readFileSync(usrData));
  const file = parseTdb(bytes);
  const ex = exportDynasty(file);
  attachPhotoKeys(ex, loadPhotoIndex(photoDirsOf(cfg)));
  attachLogoKeys(ex);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const api = new WorkerApi(cfg);
  const t0 = Date.now();
  await api.json('POST', '/api/bridge/dynasties', { slug: cfg.dynastySlug, name: cfg.dynastyName ?? cfg.dynastySlug });
  const { importId } = await api.json('POST', '/api/bridge/import', {
    slug: cfg.dynastySlug, seasonYear: ex.season.year, week: ex.season.week, stage: ex.season.stage, weekType: ex.season.weekType, sha256, dbSize: file.header.dbSize,
    tableCounts: Object.fromEntries(ex.tables.map((t) => [t.name, t.records])), note: opts.note,
  });
  console.log(`import #${importId}: season ${ex.season.year} week ${ex.season.week}, ${ex.schedule.filter((g) => isPlayed(g.status)).length} games played`);
  try {
    await pushExport(api, importId, ex);
    if (opts.files !== false) {
      await api.putFile(`/api/bridge/import/${importId}/file/USR-DATA`, bytes);
      const dir = usrData.replace(/[\/][^\/]+$/, '');
      for (const extra of ['HED-DATA', 'PARAM.SFO']) { const p = join(dir, extra); if (existsSync(p)) await api.putFile(`/api/bridge/import/${importId}/file/${extra}`, new Uint8Array(readFileSync(p))); }
      console.log('  save files stored in R2');
    }
    await api.json('POST', `/api/bridge/import/${importId}/commit`, {});
    console.log(`committed import #${importId} in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${cfg.workerUrl}/d/${cfg.dynastySlug}`);
  } catch (e) {
    await api.json('POST', `/api/bridge/import/${importId}/abort`, {}).catch(() => {});
    throw e;
  }
  return ex as DynastyExport;
}
