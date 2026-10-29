// ncaa-bridge od ...: mirrors the Blaze stub's online dynasties to the site. The dynasty file the console uploads at each
// advance is decoded like an offline save; results uploaded since (UploadGameResults) are laid over the schedule; the
// members and their teams come from the stub's registry.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exportDynasty, isPlayed, type DynastyExport, type Game } from '@ncaa/ncaa14';
import { WorkerApi } from '../api.js';
import type { BridgeConfig } from '../config.js';
import { loadOdStore, lockerIndex, readLockerBlob, openDynastyFile, odFingerprint, odSlug, odName, type OdDynasty, type OdGameResult } from '../od.js';
import { pushExport } from './import.js';
import { loadPhotoIndex, attachPhotoKeys } from '../photos.js';
import { attachLogoKeys } from '../logos.js';

const STATE_DIR = join(homedir(), '.ncaa-bridge');
const STATE_FILE = join(STATE_DIR, 'od-state.json');
interface OdState { [did: string]: { fingerprint: string; slug: string; importId: number; at: string } }
const loadState = (): OdState => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {});
const saveState = (s: OdState): void => { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); };
const stamp = () => new Date().toTimeString().slice(0, 8);
const sk = (cfg: BridgeConfig, d: OdDynasty) => `${cfg.workerUrl} #${d.id}`; // one sync state per site (local dev and production differ)

const REBZ_COLUMNS = { SINT: ['PSCP', 'PPSC', 'PPSL', 'TGID', 'PRSI'], TINT: ['USEL', 'PROR', 'PEPV'] };
interface PendingBoard { id: number; tgid: number; week: number; rows: Record<string, number>[]; note?: string | null; updatedAt?: string }
// D1 timestamps are "YYYY-MM-DD HH:MM:SS" in UTC; the stub's push timestamps are epoch seconds.
const epochOf = (iso: string | undefined) => (iso ? Math.floor(Date.parse(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z')) / 1000) : 0);
const loadPush = (odDir: string, did: number, table: string): { rows: Record<string, number | string>[]; updatedAt: number } | null => {
  const f = join(odDir, 'dynasty-tables', String(did), `${table}.json`);
  if (!existsSync(f)) return null;
  const t = JSON.parse(readFileSync(f, 'utf8')) as { rows?: Record<string, number | string>[]; meta?: { updatedAt?: number } };
  return { rows: t.rows ?? [], updatedAt: Number(t.meta?.updatedAt ?? 0) };
};
// A board counts as delivered when the console's RECB push is newer than the save and shows the same points and order.
const boardReflected = (odDir: string, did: number, b: PendingBoard): boolean => {
  const push = loadPush(odDir, did, 'RECB');
  if (!push || push.updatedAt <= epochOf(b.updatedAt)) return false;
  const mine = new Map(push.rows.filter((r) => r.TGID === b.tgid).map((r) => [r.PRSI as number, r]));
  if (mine.size !== b.rows.length) return false;
  return b.rows.every((r) => { const p = mine.get(r.PRSI ?? -1); return !!p && p.PPSC === r.PPSC && p.PROR === r.PROR; });
};
// PLYZ as the console pushes and pulls it (dynasty-tables/<did>/PLYZ.json has the same columns).
const PLYZ_COLUMNS = { SINT: ['PGID', 'TGID'], TINT: ['PLFL', 'PTEN', 'PTYP', 'PAWR', 'PPOS', 'PSTR', 'PSPD', 'PRSD', 'POVR', 'PJEN', 'PACC', 'PLCR'], STRC: ['PLNA', 'PFNA'] };
const PLYZ_EDITED = ['PJEN', 'PPOS', 'PRSD', 'PFNA', 'PLNA'] as const;
interface PendingPlayerEdit { id: number; tgid: number; pgid: number; week: number; jersey: number | null; pos: number | null; redshirt: number | null; firstName: string | null; lastName: string | null; note?: string | null; updatedAt?: string }
// A player edit counts as delivered when the console's PLYZ push is newer than the edit and carries every edited value.
const playerReflected = (odDir: string, did: number, e: PendingPlayerEdit): boolean => {
  const push = loadPush(odDir, did, 'PLYZ');
  if (!push || push.updatedAt <= epochOf(e.updatedAt)) return false;
  let row: Record<string, number | string> | undefined;
  for (const r of push.rows) if (r.PGID === e.pgid) row = r; // last push wins
  if (!row) return false;
  return (e.jersey === null || row.PJEN === e.jersey) && (e.pos === null || row.PPOS === e.pos) && (e.redshirt === null || row.PRSD === e.redshirt)
    && (e.firstName === null || row.PFNA === e.firstName.slice(0, 11)) && (e.lastName === null || row.PLNA === e.lastName.slice(0, 13));
};
type PlyzRow = Record<string, number | string> & { PGID: number; TGID: number };

// Site -> console: writes private/web-edits/<did>/REBZ.json from the boards still pending on the site (all teams of the
// dynasty in one file; the stub filters by TGID) and PLYZ.json from pending player edits laid over the console's own
// last roster push; acks edits whose week the dynasty has already left.
export async function syncWebEdits(cfg: BridgeConfig, d: OdDynasty, api = new WorkerApi(cfg), opts: { quiet?: boolean } = {}): Promise<void> {
  const res = await api.json<{ dynastyWeek: number | null; boards: PendingBoard[]; players?: PendingPlayerEdit[] }>('GET', `/api/bridge/web-edits?od=${d.id}`);
  const dir = join(cfg.odDir, 'web-edits', String(d.id));
  const week = d.week ?? 0;
  await syncBoards(d, api, dir, week, res.boards ?? [], opts, cfg.odDir);
  await syncPlayerEdits(cfg, d, api, dir, week, res.players ?? [], opts);
}

async function syncBoards(d: OdDynasty, api: WorkerApi, dir: string, week: number, boards: PendingBoard[], opts: { quiet?: boolean }, odDir = join(dir, '..', '..')): Promise<void> {
  const file = join(dir, 'REBZ.json');
  const done = (b: PendingBoard) => b.week < week || boardReflected(odDir, d.id, b);
  const delivered = boards.filter(done);
  for (const b of delivered) { await api.json('POST', `/api/bridge/web-edits/${b.id}/delivered`); if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: board for team ${b.tgid} week ${b.week} delivered (${b.week < week ? `dynasty is at week ${week}` : 'the console pushed it back'})`); }
  const live = boards.filter((b) => !done(b));
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (!live.length) { if (prev !== null) { unlinkSync(file); if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: no pending boards, REBZ.json removed`); } return; }
  const rows = live.flatMap((b) => b.rows.map((r) => ({ ...r, TGID: b.tgid })));
  const out = JSON.stringify({ table: 'REBZ', columns: REBZ_COLUMNS, rows, meta: { type: 0, flty: 1, source: 'site', boards: live.map((b) => ({ id: b.id, tgid: b.tgid, week: b.week, note: b.note ?? null })), updatedAt: Math.floor(Date.now() / 1000) } });
  if (prev !== null && JSON.parse(prev).rows && JSON.stringify(JSON.parse(prev).rows) === JSON.stringify(rows)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, out);
  if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: REBZ.json <- ${live.length} board(s), ${rows.length} rows (${live.map((b) => `team ${b.tgid} wk ${b.week}`).join(', ')})`);
}

// Player edits: the console pulls its whole PLYZ table at the advance, so the file carries the FULL roster of every team
// with a pending edit, taken from the console's last push (dynasty-tables/<did>/PLYZ.json; a PGID may repeat there and
// the last row wins) with the edited columns swapped in. The site lacks PLFL/PTEN/PTYP/PLCR, hence the push as the base.
async function syncPlayerEdits(cfg: BridgeConfig, d: OdDynasty, api: WorkerApi, dir: string, week: number, edits: PendingPlayerEdit[], opts: { quiet?: boolean }): Promise<void> {
  const file = join(dir, 'PLYZ.json');
  const done = (e: PendingPlayerEdit) => e.week < week || playerReflected(cfg.odDir, d.id, e);
  const delivered = edits.filter(done);
  for (const e of delivered) { await api.json('POST', `/api/bridge/web-edits/${e.id}/delivered?kind=player`); if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: player edit PGID ${e.pgid} (team ${e.tgid}) week ${e.week} delivered (${e.week < week ? `dynasty is at week ${week}` : 'the console pushed it back'})`); }
  const live = edits.filter((e) => !done(e));
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (!live.length) { if (prev !== null) { unlinkSync(file); if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: no pending player edits, PLYZ.json removed`); } return; }
  const pushFile = join(cfg.odDir, 'dynasty-tables', String(d.id), 'PLYZ.json');
  if (!existsSync(pushFile)) { if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: ${live.length} player edit(s) pending but the console has not pushed PLYZ yet (${pushFile}); waiting`); return; }
  const push = JSON.parse(readFileSync(pushFile, 'utf8')) as { rows?: PlyzRow[] };
  const byPgid = new Map<number, PlyzRow>();
  for (const r of push.rows ?? []) byPgid.set(r.PGID, r);
  const teams = new Set(live.map((e) => e.tgid));
  const rows = [...byPgid.values()].filter((r) => teams.has(r.TGID)).map((r) => ({ ...r }));
  const changes: string[] = [];
  for (const e of live) {
    const row = rows.find((r) => r.PGID === e.pgid);
    if (!row) { if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: PGID ${e.pgid} (team ${e.tgid}) is not in the console's roster push, edit skipped`); continue; }
    const before = { ...row };
    if (e.jersey !== null) row.PJEN = e.jersey;
    if (e.pos !== null) row.PPOS = e.pos;
    if (e.redshirt !== null) row.PRSD = e.redshirt;
    if (e.firstName !== null) row.PFNA = e.firstName.slice(0, 11);
    if (e.lastName !== null) row.PLNA = e.lastName.slice(0, 13);
    const diff = PLYZ_EDITED.filter((k) => before[k] !== row[k]).map((k) => `${k} ${JSON.stringify(before[k])} -> ${JSON.stringify(row[k])}`);
    changes.push(`team ${e.tgid} PGID ${e.pgid} wk ${e.week}: ${diff.join(', ') || 'no change'}`);
  }
  const out = JSON.stringify({ table: 'PLYZ', columns: PLYZ_COLUMNS, rows, meta: { type: 1, flty: 1 } });
  if (prev !== null && JSON.stringify(JSON.parse(prev).rows ?? null) === JSON.stringify(rows)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, out);
  if (!opts.quiet) { console.log(`${stamp()} DID ${d.id}: PLYZ.json <- ${live.length} edit(s), ${rows.length} roster rows for team(s) ${[...teams].join(', ')}`); for (const c of changes) console.log(`${stamp()}   ${c}`); }
}

export interface OdImportOptions { did?: number; files?: boolean; note?: string; force?: boolean; quiet?: boolean }

// Results the console uploaded since the dynasty file was saved: the current week's finals, shown before the next
// advance writes them into the file. Team records and streaks are bumped to match.
export function overlayResults(ex: DynastyExport, games: Record<string, OdGameResult[]>): number {
  const teams = new Map(ex.teams.map((t) => [t.tgid, t]));
  let applied = 0;
  for (const list of Object.values(games)) {
    for (const g of list) {
      const row = ex.schedule.find((x) => x.week === g.GMWK && x.homeTgid === g.HTID && x.awayTgid === g.ATID);
      if (!row || isPlayed(row.status)) continue;
      row.status = g.HTSC >= g.ATSC ? 3 : 2; row.homeScore = g.HTSC; row.awayScore = g.ATSC; row.overtime = (g.OTFL ?? 0) > 0; row.userPlayed = true;
      (row as Game & { source?: string }).source = 'online';
      const h = teams.get(g.HTID), a = teams.get(g.ATID);
      const [w, l] = row.status === 3 ? [h, a] : [a, h];
      if (w) { w.wins++; w.streak = w.streak > 0 ? w.streak + 1 : 1; }
      if (l) { l.losses++; l.streak = l.streak < 0 ? l.streak - 1 : -1; }
      if (h && a && h.cgid === a.cgid) { if (w) w.confWins++; if (l) l.confLosses++; }
      applied++;
    }
  }
  return applied;
}

export async function odImportOne(cfg: BridgeConfig, d: OdDynasty, opts: OdImportOptions, state: OdState): Promise<boolean> {
  const dir = cfg.odDir;
  const fp = odFingerprint(d);
  const name = odName(d);
  if (!opts.force && state[sk(cfg, d)]?.fingerprint === fp) { if (!opts.quiet) console.log(`DID ${d.id} ${name}: unchanged since ${state[sk(cfg, d)]!.at}`); return false; }
  if (!d.fileId) { console.log(`DID ${d.id} ${name}: no dynasty file uploaded yet, skipped`); return false; }
  const blob = readLockerBlob(dir, d.fileId);
  if (!blob) { console.log(`DID ${d.id} ${name}: dynasty file CID ${d.fileId} is missing from the locker, skipped`); return false; }
  const t0 = Date.now();
  const opened = openDynastyFile(blob);
  const ex = exportDynasty(opened.file);
  const overlaid = overlayResults(ex, d.games ?? {});
  const photos = attachPhotoKeys(ex, loadPhotoIndex(cfg.photosDir));
  const logos = attachLogoKeys(ex);
  if (logos.missing.length) console.log(`  no logo for: ${logos.missing.join(', ')}`);
  const members = d.members.map((m) => ({
    blazeId: m.blazeId, persona: m.persona, ncId: m.ncId ?? 0, commissioner: !!m.commissioner, team: m.team ?? 0, teamFileId: m.teamFileId ?? 0,
    coach: ex.coaches.find((c) => c.tgid === m.team && c.userControlled)?.ccid ?? m.coach ?? 0,
  }));
  const api = new WorkerApi(cfg);
  const od = {
    id: d.id, name, abbr: String(d.request?.ABBR ?? ''), description: String(d.request?.DESC ?? ''), state: d.state ?? 0, week: d.week ?? 0, season: d.season ?? 1, year: d.year ?? 0,
    fileId: d.fileId, fileSavedAt: d.fileSavedAt ?? null, createdAt: d.createdAt, settings: d.request, members, games: d.games ?? {},
  };
  const { dynasty } = await api.json('POST', '/api/bridge/dynasties', { slug: state[sk(cfg, d)]?.slug ?? odSlug(d), name, od });
  const sha256 = createHash('sha256').update(opened.db).digest('hex');
  const { importId } = await api.json('POST', '/api/bridge/import', {
    slug: dynasty.slug, seasonYear: ex.season.year, week: ex.season.week, stage: ex.season.stage, weekType: ex.season.weekType, sha256, dbSize: opened.file.header.dbSize,
    tableCounts: Object.fromEntries(ex.tables.map((t) => [t.name, t.records])), note: opts.note ?? `online dynasty ${d.id}, file ${d.fileId}, ${overlaid} uploaded result(s)`,
  });
  const playedCount = ex.schedule.filter((g) => isPlayed(g.status)).length;
  console.log(`${stamp()} DID ${d.id} "${name}" -> /d/${dynasty.slug}: import #${importId}, ${ex.season.year} week ${ex.season.week}, ${playedCount} games played (${overlaid} from uploads), ${photos} player photos`);
  try {
    await pushExport(api, importId, ex, { quiet: opts.quiet });
    if (opts.files !== false) {
      await api.putFile(`/api/bridge/import/${importId}/file/DYNASTY.dynasty`, blob);
      const index = lockerIndex(dir);
      for (const m of d.members) {
        const c = m.teamFileId ? index[String(m.teamFileId)] : undefined;
        const b = m.teamFileId ? readLockerBlob(dir, m.teamFileId) : null;
        if (c && b) await api.putFile(`/api/bridge/import/${importId}/file/${c.name}`, b);
      }
    }
    await api.json('POST', `/api/bridge/import/${importId}/commit`, {});
  } catch (e) {
    await api.json('POST', `/api/bridge/import/${importId}/abort`, {}).catch(() => {});
    throw e;
  }
  state[sk(cfg, d)] = { fingerprint: fp, slug: dynasty.slug, importId, at: new Date().toISOString() };
  saveState(state);
  console.log(`${stamp()}   committed in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${cfg.workerUrl}/d/${dynasty.slug}`);
  return true;
}

export async function odImport(cfg: BridgeConfig, opts: OdImportOptions): Promise<number> {
  const store = loadOdStore(cfg.odDir);
  const state = loadState();
  const list = Object.values(store.dynasties).filter((d) => opts.did === undefined || d.id === opts.did);
  if (!list.length) { console.log(opts.did === undefined ? `no online dynasties in ${cfg.odDir}` : `no dynasty DID ${opts.did} in ${cfg.odDir}`); return 0; }
  let n = 0;
  for (const d of list) if (await odImportOne(cfg, d, opts, state)) n++;
  return n;
}

export function odList(cfg: BridgeConfig): void {
  const store = loadOdStore(cfg.odDir);
  const state = loadState();
  for (const d of Object.values(store.dynasties)) {
    const results = Object.values(d.games ?? {}).reduce((n, l) => n + l.length, 0);
    const site = state[sk(cfg, d)] ? `/d/${state[sk(cfg, d)]!.slug} (synced ${state[sk(cfg, d)]!.at})` : 'never synced';
    console.log(`DID ${d.id}  ${odName(d).padEnd(20)} week ${d.week ?? 0}  year ${d.year ?? 0}  state ${d.state ?? 0}  file ${d.fileId ?? 0}  results ${results}  members ${d.members.map((m) => `${m.persona}:${m.team ?? 0}`).join(', ')}  ${site}`);
  }
}

// Polls the stub's registry and re-imports a dynasty once its fingerprint has been stable for `settle` seconds (the
// console finishes an advance or a game upload with several calls spread over a few seconds).
export async function odWatch(cfg: BridgeConfig, opts: { did?: number; interval: number; settle: number; files?: boolean }): Promise<never> {
  console.log(`${stamp()} watching ${cfg.odDir} every ${opts.interval}s; imports to ${cfg.workerUrl} after ${opts.settle}s of quiet (Ctrl+C to stop)`);
  const pending = new Map<number, { fp: string; since: number }>();
  const api = new WorkerApi(cfg);
  let tick = 0;
  for (;;) {
    try {
      const store = loadOdStore(cfg.odDir);
      const state = loadState();
      tick++;
      for (const d of Object.values(store.dynasties)) {
        if (opts.did !== undefined && d.id !== opts.did) continue;
        if (!d.fileId) continue;
        if (tick % 3 === 1) await syncWebEdits(cfg, d, api).catch((e: Error) => console.error(`${stamp()} DID ${d.id} web edits: ${e.message}`));
        const fp = odFingerprint(d);
        if (state[sk(cfg, d)]?.fingerprint === fp) { pending.delete(d.id); continue; }
        const p = pending.get(d.id);
        if (!p || p.fp !== fp) { pending.set(d.id, { fp, since: Date.now() }); if (!p) console.log(`${stamp()} DID ${d.id} "${odName(d)}" changed, waiting for the console to finish`); continue; }
        if (Date.now() - p.since < opts.settle * 1000) continue;
        pending.delete(d.id);
        await odImportOne(cfg, d, { files: opts.files, quiet: true }, state).catch((e: Error) => console.error(`${stamp()} DID ${d.id} import failed: ${e.message}`));
      }
    } catch (e) {
      console.error(`${stamp()} ${(e as Error).message}`); // store mid-write or site unreachable: retried next tick
    }
    await new Promise((r) => setTimeout(r, opts.interval * 1000));
  }
}
