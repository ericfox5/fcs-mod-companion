import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseTdb } from '@ncaa/tdb';
import { exportDynasty, isPlayed, type DynastyExport } from '@ncaa/ncaa14';
import { WorkerApi } from '../api.js';
import type { BridgeConfig } from '../config.js';
import { loadPhotoIndex, attachPhotoKeys } from '../photos.js';
import { attachLogoKeys } from '../logos.js';

const CHUNK = 400;

// Sends every row set of a decoded dynasty to an open import, in chunks.
export async function pushExport(api: WorkerApi, importId: number, ex: DynastyExport, opts: { quiet?: boolean } = {}): Promise<void> {
  const sets: [string, unknown[]][] = [
    ['calendar', ex.calendar], ['conferences', ex.conferences], ['divisions', ex.divisions], ['teams', ex.teams], ['players', ex.players],
    ['coaches', ex.coaches], ['depthChart', ex.depthChart], ['schedule', ex.schedule], ['stories', ex.stories], ['heisman', ex.heisman],
    ['allAmericans', ex.allAmericans], ['teamSeasonStats', ex.teamSeasonStats], ['teamHistory', ex.teamHistory],
    ['playerSeasonStats', Object.entries(ex.playerSeasonStats).flatMap(([kind, rows]) => rows.map((r) => ({ ...r, kind })))],
    ['recruits', ex.recruits], ['recruitInterest', ex.recruitInterest], ['recruitingBoard', ex.recruitingBoard],
    ['gameLogs', Object.entries(ex.gameLogs).flatMap(([kind, rows]) => rows.map((r) => ({ ...r, kind })))],
  ];
  for (const [table, rows] of sets) {
    let sent = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await api.json('PUT', `/api/bridge/import/${importId}/rows`, { table, rows: rows.slice(i, i + CHUNK) });
      sent += Math.min(CHUNK, rows.length - i);
    }
    if (!opts.quiet) console.log(`  ${table.padEnd(18)} ${String(sent).padStart(6)} rows`);
  }
}

export async function importSave(cfg: BridgeConfig, usrData: string, opts: { note?: string; files?: boolean } = {}) {
  const bytes = new Uint8Array(readFileSync(usrData));
  const file = parseTdb(bytes);
  const ex = exportDynasty(file);
  attachPhotoKeys(ex, loadPhotoIndex(cfg.photosDir));
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
