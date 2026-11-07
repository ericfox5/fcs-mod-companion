// ncaa-bridge od ...: mirrors the Blaze stub's online dynasties to the site. The dynasty file the console uploads at each
// advance is decoded like an offline save; results uploaded since (UploadGameResults) are laid over the schedule; the
// members and their teams come from the stub's registry.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exportDynasty, decodeSeason, isPlayed, detectStride, freePgids, rosterSlots, PGID_STRIDE, STRIDES, type DynastyExport, type Game } from '@ncaa/ncaa14';
import { WorkerApi } from '../api.js';
import type { BridgeConfig } from '../config.js';
import { loadOdStore, lockerIndex, lockerIndexAll, readLockerBlob, readLockerBlobAny, openDynastyFile, odFingerprint, odSlug, odName, consoleFileId, seasonGames, type OdDynasty, type OdGameResult, type OpenedDynastyFile } from '../od.js';
import { patchDynasty, PATCH_FORMAT, NEW_TRANSFER_WEIGHT, BASE_YEAR, RECRUIT_FIRST_MAX, RECRUIT_LAST_MAX, WEIGHT_BASE, patchSetEmpty, type TransferPatch, type DepthPatch, type DynastyPatchSet, type RecruitPatch, type RecruitEdit, type CreatePlayerPatch } from '../dynasty-patch.js';
import { pushExport, playerUids } from './import.js';
import { syncCaptures } from './captures.js';
import { loadPhotoIndex, attachPhotoKeys, photoDirsOf } from '../photos.js';
import { attachLogoKeys } from '../logos.js';
import { parseTdb } from '@ncaa/tdb';
import { runRecruitOverhaul, classTaken, installRcat, restoreRcat, installTool, OVERHAUL_DIR, RCAT_ARCHIVE, RCAT_ENTRY } from '../recruit-overhaul.js';
import { saveConfigKey, refreshConfig } from '../config.js';
import { postseasonRows, fieldFilled, weeksApplied, selectField, nextRoundGames, winnerOf, mergeSiteResults, consoleOutcome, playoffDiff, siteState, autoBids, overlayPlayoff, ROUND_WEEKS, PLAYOFF_ROWS, BOWL_SEASON_WEEK, SEASON_OVER_WEEK, type PlayoffMemo, type PlayoffPatch, type SiteGame } from '../playoff.js';
import { roundName } from '@ncaa/ncaa14';
import type { TdbFile } from '@ncaa/tdb';

const STATE_DIR = join(homedir(), '.ncaa-bridge');
const STATE_FILE = join(STATE_DIR, 'od-state.json');
// eligibility: the transfer-eligibility rule's memo for the season (syncEligibility): players whose redshirt it has asked
// the console to clear (pending) and those the console has cleared (done, never touched again that season)
// overhaul: the recruiting class Fang's Recruit Overhaul reshaped this season (maybeOverhaul): the tool's output on disk,
// the fields it changed, the console file it ran on (base), and whether the console has since taken it (taken = that
// file's id) or moved on without it (stale)
interface OverhaulMemo { year: number; storeYear: number; base: number; file: string; sha: string; fields: string[]; interestFields: string[]; renamed: number; at: string; taken?: number; stale?: boolean }
// startYear: the calendar year a new dynasty was asked to start in (maybeStartYear): published through the dynasty-file
// copy until a console file shows it (taken), or dropped once the dynasty moved on without it (stale)
interface StartYearMemo { year: number; base: number; at: string; taken?: number; stale?: boolean }
// a commissioner's recruit lock (`od lock`): the prospect's interest in tgid is kept above the commit threshold on every
// published copy until the console's file shows him committed there
interface LockMemo { prsi: number; tgid: number; at: string }
// the roster stride the dynasty's files are keyed with (`od stride`, docs/roster-stride-inventory.md): published through
// the dynasty-file copy until a console upload is keyed that way (taken); the console must run the matching game patch
interface StrideMemo { stride: number; base: number; at: string; taken?: number }
// players created from the bridge (`od players`): PLAY rows added through the dynasty-file copy until the console's
// upload carries them (matched by team + last name)
// batch: the `od players` run that queued the row; once the console's file carries any row of a batch, the rest of that
// batch is known to have been skipped at patch time (no free slot) and is dropped with it
type QueuedPlayer = CreatePlayerPatch & { batch?: string };
interface PlayersMemo { pending: QueuedPlayer[]; at: string; base: number }
// PLAY rows the bridge takes back out through the dynasty-file copy (`od repair`), until a console upload lacks them all
interface RepairMemo { remove: number[]; restores?: number[]; at: string; base: number; note: string }
interface OdState { [did: string]: { fingerprint: string; slug: string; importId: number; at: string; eligibility?: { year: number; pending: number[]; done: number[] }; overhaul?: OverhaulMemo; startYear?: StartYearMemo; locks?: LockMemo[]; playoff?: PlayoffMemo; firstYear?: number; stride?: StrideMemo; players?: PlayersMemo; repair?: RepairMemo } }
const loadState = (): OdState => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {});
const saveState = (s: OdState): void => { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); };
const stamp = () => new Date().toTimeString().slice(0, 8);
const sk = (cfg: BridgeConfig, d: OdDynasty) => `${cfg.workerUrl} #${d.id}`; // one sync state per site (local dev and production differ)

const REBZ_COLUMNS = { SINT: ['PSCP', 'PPSC', 'PPSL', 'TGID', 'PRSI'], TINT: ['USEL', 'PROR', 'PEPV'] };
// REVZ as the console pulls it: the RECV layout (VMVP/NFGZ/NFGM are outcomes the game fills after the visit).
const REVZ_COLUMNS = { SINT: ['VMVP', 'TGID', 'PRSI', 'OFGP'], TINT: ['RCWK', 'NFGZ', 'NFGM'] };
interface PendingVisits { id: number; tgid: number; week: number; rows: Record<string, number>[]; note?: string | null; updatedAt?: string }
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
// Transfer portal edits from the site (one per player and week); TRAN/PLSS layouts as the dynasty file stores them.
interface PendingTransferEdit { id: number; pgid: number; fromTgid: number; action: 'transfer' | 'stay'; toTgid: number | null; reason: number | null; seasonYear: number; week: number; updatedAt?: string }
const TRAN_COLUMNS = { SINT: ['PTID', 'PGID'], TINT: ['TRYR', 'TRAC'] };
const PLSS_COLUMNS = { SINT: ['WTLS', 'PGID'], INTC: ['CSPL', 'CTSP'] };
const TRANSFER_REASONS = new Set([9, 10, 11, 14, 15]); // PLFL: leaving, playing time (10, 11), coach leaving, home sick

// Depth chart + formation subs from the site's Depth Chart page (one per team and week); only the dynasty file can carry them.
interface PendingDepthEdit { id: number; tgid: number; seasonYear: number; week: number; chart: Record<string, number[]>; subs: DepthPatch['subs']; note?: string | null; updatedAt?: string }
// A prospect edited on the site (migration 0019) and a commissioner's "re-generate the class" request.
interface PendingRecruitEdit { id: number; prsi: number; seasonYear: number; week: number; firstName: string | null; lastName: string | null; pos: number | null; height: number | null; weight: number | null; stars: number | null; headId?: number | null; note?: string | null; updatedAt?: string }
interface PendingOverhaulRequest { id: number; seasonYear: number; requestedBy: number | null; createdAt?: string }

// Site -> console: writes private/web-edits/<did>/<TABLE>.json for the stub from the edits still pending on the site:
// REBZ (boards, all teams of the dynasty in one file; the stub filters by TGID), REVZ (visits), PLYZ (player edits,
// transfer flags and the transfer-eligibility rule), TRAZ and PLSZ (transfer portal), and DYNASTY.patch.bin (a copy
// of the console's dynasty file with the edits no change table can carry: new transfers, depth charts, formation
// subs, cleared redshirts); acks edits the console has taken in.
export async function syncWebEdits(cfg: BridgeConfig, d: OdDynasty, api = new WorkerApi(cfg), opts: { quiet?: boolean } = {}): Promise<void> {
  const res = await api.json<{ dynastyWeek: number | null; boards: PendingBoard[]; players?: PendingPlayerEdit[]; visits?: PendingVisits[]; transfers?: PendingTransferEdit[]; depth?: PendingDepthEdit[]; recruits?: PendingRecruitEdit[]; overhaul?: PendingOverhaulRequest[]; memberTeams?: number[] }>('GET', `/api/bridge/web-edits?od=${d.id}`);
  const dir = join(cfg.odDir, 'web-edits', String(d.id));
  const week = d.week ?? 0;
  await syncBoards(d, api, dir, week, res.boards ?? [], opts, cfg.odDir);
  await syncVisits(cfg, d, api, dir, week, res.visits ?? [], opts);
  // PLYZ carries player edits and transfer flags together (a player with both keeps his edit and takes the flags)
  // what each pending edit turns into is logged only when it changes a table, not on every pass while it waits for
  // the console (an edit stays pending until the console loads the dynasty and uploads a newer file)
  const notes: string[] = [];
  const players = await syncPlayerEdits(cfg, d, api, res.players ?? [], opts, notes);
  const transfers = await syncTransferEdits(cfg, d, api, res.transfers ?? [], opts, notes);
  const depth = await syncDepthEdits(d, api, res.depth ?? [], opts, notes);
  const eligible = syncEligibility(cfg, d, res.memberTeams ?? [], notes);
  await syncOverhaulRequests(cfg, d, api, res.overhaul ?? []);
  const recruitEdits = await syncRecruitEdits(cfg, d, api, res.recruits ?? [], opts, notes);
  mergeLocks(cfg, d, recruitEdits, notes, opts);
  const playoff = await pendingPlayoff(cfg, d, api, notes, opts);
  const plyz = new Map<number, PlyzRow>(players.map((r) => [r.PGID, r]));
  for (const r of transfers.plyz) plyz.set(r.PGID, { ...(plyz.get(r.PGID) ?? r), PLFL: r.PLFL as number, PTYP: r.PTYP as number });
  for (const r of eligible.plyz) plyz.set(r.PGID, { ...(plyz.get(r.PGID) ?? r), PRSD: 0 });
  const recruits = pendingOverhaul(cfg, d); const startYear = pendingStartYear(cfg, d); const stride = pendingStride(cfg, d); const createPlayers = pendingCreatePlayers(cfg, d); const removePlayers = pendingRemovePlayers(cfg, d);
  const patch: DynastyPatchSet = { transfers: transfers.newRows ? transfers.patches : [], depth, eligible: eligible.pgids, ...(recruits ? { recruits } : {}), ...(recruitEdits.length ? { recruitEdits } : {}), ...(startYear ? { startYear } : {}), ...(playoff ? { playoff } : {}), ...(stride ? { stride } : {}), ...(createPlayers.length ? { createPlayers } : {}), ...(removePlayers.length ? { removePlayers } : {}) };
  // while a stride change is on its way the change tables name players by ids the console is about to change: held back
  if (stride && (plyz.size || transfers.traz.length || transfers.plsz.length)) notes.push(` DID ${d.id}: player/transfer change tables held until the console takes stride ${stride}`);
  const changed = [
    writeEditTable(d, join(dir, 'PLYZ.json'), 'PLYZ', PLYZ_COLUMNS, stride ? [] : [...plyz.values()], { type: 1, flty: 1 }, opts),
    writeEditTable(d, join(dir, 'TRAZ.json'), 'TRAZ', TRAN_COLUMNS, stride ? [] : transfers.traz, { type: 0, flty: 1 }, opts),
    writeEditTable(d, join(dir, 'PLSZ.json'), 'PLSZ', PLSS_COLUMNS, stride ? [] : transfers.plsz, { type: 0, flty: 1 }, opts),
    syncDynastyPatch(cfg, d, dir, patch, opts),
  ].some(Boolean);
  if (changed && !opts.quiet) for (const n of notes) console.log(`${stamp()}${n}`);
}

// Depth charts: delivered once the console uploads a newer dynasty file (the load that took the patched copy is
// followed by an advance or a save); until then the whole chart goes into the dynasty-file copy.
async function syncDepthEdits(d: OdDynasty, api: WorkerApi, edits: PendingDepthEdit[], opts: { quiet?: boolean }, notes: string[]): Promise<DepthPatch[]> {
  const done = (e: PendingDepthEdit) => (d.fileSavedAt ?? 0) > epochOf(e.updatedAt);
  for (const e of edits.filter(done)) { await api.json('POST', `/api/bridge/web-edits/${e.id}/delivered?kind=depth`); if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: depth chart for team ${e.tgid} week ${e.week} delivered (a newer dynasty file came in)`); }
  const live = edits.filter((e) => !done(e));
  for (const e of live) notes.push(`   depth chart team ${e.tgid} wk ${e.week}: ${e.note ?? 'saved on the site'}`);
  return live.map((e) => ({ tgid: e.tgid, chart: e.chart ?? {}, subs: Array.isArray(e.subs) ? e.subs : [] }));
}

// Transfer eligibility (2026-11-02). At the season rollover the game redshirts every portal player who ends up on a
// member's team, the one who stayed home as much as the arrivals (CPU teams' transfers play at once), and its depth
// chart screen then refuses him as a transfer who must sit a year. The NCAA no longer makes transfers sit, so the
// league clears that redshirt: PLYZ PRSD 0 for the console's next load and PRSD 0 in the dynasty-file copy. Only in
// the first weeks of a season and once per player per season: a redshirt the coach puts back on afterwards stays.
function syncEligibility(cfg: BridgeConfig, d: OdDynasty, memberTeams: number[], notes: string[]): { plyz: PlyzRow[]; pgids: number[] } {
  const out = { plyz: [] as PlyzRow[], pgids: [] as number[] };
  const week = d.week ?? 0, year = d.year ?? 0;
  if (!memberTeams.length || week > 2) return out; // the store's week is 31 in the offseason
  const tran = new Set((loadPush(cfg.odDir, d.id, 'TRAN')?.rows ?? []).map((r) => Number(r.PGID)));
  if (!tran.size) return out;
  const state = loadState(); const key = sk(cfg, d); const entry = state[key]; if (!entry) return out;
  const memo = entry.eligibility?.year === year ? entry.eligibility : { year, pending: [], done: [] };
  const fresh = freshPlayers(cfg.odDir, d.id); let changed = false;
  for (const pgid of [...memo.pending]) { // the console took an earlier pass's row: his redshirt is the coach's from here
    const p = fresh.get(pgid); if (p && Number(p.PRSD) !== 1) { memo.pending = memo.pending.filter((x) => x !== pgid); memo.done.push(pgid); changed = true; }
  }
  for (const [pgid, p] of fresh) {
    if (Number(p.PRSD) !== 1 || !memberTeams.includes(Number(p.TGID)) || !tran.has(pgid) || memo.done.includes(pgid)) continue;
    out.plyz.push({ ...p, PRSD: 0 }); out.pgids.push(pgid);
    if (!memo.pending.includes(pgid)) { memo.pending.push(pgid); changed = true; }
    notes.push(`   eligibility: ${p.PFNA} ${p.PLNA} (PGID ${pgid}, team ${p.TGID}) was sat down as a transfer; redshirt cleared`);
  }
  if (changed || entry.eligibility !== memo) { entry.eligibility = memo; saveState(state); }
  return out;
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
// A visit set counts as delivered when the console's RECV push is newer than the save and lists the same prospects
// with the same visit weeks for that team.
const visitsReflected = (odDir: string, did: number, v: PendingVisits): boolean => {
  const push = loadPush(odDir, did, 'RECV');
  if (!push || push.updatedAt <= epochOf(v.updatedAt)) return false;
  const mine = push.rows.filter((r) => r.TGID === v.tgid);
  if (mine.length !== v.rows.length) return false;
  const want = new Map(v.rows.map((r) => [r.PRSI, r.RCWK]));
  return mine.every((r) => want.get(r.PRSI as number) === r.RCWK);
};
async function syncVisits(cfg: BridgeConfig, d: OdDynasty, api: WorkerApi, dir: string, week: number, sets: PendingVisits[], opts: { quiet?: boolean }): Promise<void> {
  const file = join(dir, 'REVZ.json');
  const done = (v: PendingVisits) => v.week < week || visitsReflected(cfg.odDir, d.id, v);
  for (const v of sets.filter(done)) { await api.json('POST', `/api/bridge/web-edits/${v.id}/delivered?kind=visit`); if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: visits for team ${v.tgid} week ${v.week} delivered`); }
  const live = sets.filter((v) => !done(v));
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (!live.length) { if (prev !== null) { unlinkSync(file); if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: no pending visits, REVZ.json removed`); } return; }
  const rows = live.flatMap((v) => v.rows.map((r) => ({ ...r, TGID: v.tgid })));
  if (prev !== null && JSON.stringify(JSON.parse(prev).rows ?? null) === JSON.stringify(rows)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ table: 'REVZ', columns: REVZ_COLUMNS, rows, meta: { type: 0, flty: 1, source: 'site', updatedAt: Math.floor(Date.now() / 1000) } }));
  if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: REVZ.json <- ${live.length} visit set(s), ${rows.length} rows (${live.map((v) => `team ${v.tgid} wk ${v.week}`).join(', ')})`);
}

// The freshest copy of every player's PLYZ columns: the dynasty file's PLAY table when it is newer than the console's
// last roster push (the offseason rewrites PLFL/PTYP between pushes), the push otherwise.
function freshPlayers(odDir: string, did: number): Map<number, PlyzRow> {
  const cols = [...PLYZ_COLUMNS.SINT, ...PLYZ_COLUMNS.TINT, ...PLYZ_COLUMNS.STRC];
  const out = new Map<number, PlyzRow>();
  const sources = [loadPush(odDir, did, 'PLYZ'), loadPush(odDir, did, 'PLAY')].filter((s) => !!s).sort((a, b) => a!.updatedAt - b!.updatedAt);
  for (const s of sources) for (const r of s!.rows) out.set(r.PGID as number, Object.fromEntries(cols.map((k) => [k, r[k] as number | string])) as PlyzRow);
  return out;
}

// Writes one table of private/web-edits/<did>/ for the stub, or removes it when nothing is pending; unchanged rows are
// left alone so the file only changes with the edits.
function writeEditTable(d: OdDynasty, file: string, table: string, columns: Record<string, string[]>, rows: Record<string, number | string>[], meta: Record<string, number>, opts: { quiet?: boolean }): boolean {
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (!rows.length) { if (prev !== null) { unlinkSync(file); if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: nothing pending for ${table}, ${table}.json removed`); } return prev !== null; }
  if (prev !== null && JSON.stringify(JSON.parse(prev).rows ?? null) === JSON.stringify(rows)) return false;
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ table, columns, rows, meta: { ...meta, source: 'site', updatedAt: Math.floor(Date.now() / 1000) } }));
  if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: ${table}.json <- ${rows.length} row(s)`);
  return true;
}

// Player edits (jersey, position, redshirt, names) -> PLYZ rows for the edited players only: the console merges PLYZ
// by PGID (descriptor mode 2, spike/blaze NOTES 2026-11-01), so the rest of a roster need not be resent (sending it
// from an older push would also roll back the offseason's PLFL/PTYP). An edit is done once the console pushes it
// back or uploads a newer dynasty file (the store's week is a placeholder 31 in the offseason).
async function syncPlayerEdits(cfg: BridgeConfig, d: OdDynasty, api: WorkerApi, edits: PendingPlayerEdit[], opts: { quiet?: boolean }, notes: string[]): Promise<PlyzRow[]> {
  const done = (e: PendingPlayerEdit) => (d.fileSavedAt ?? 0) > epochOf(e.updatedAt) || playerReflected(cfg.odDir, d.id, e);
  for (const e of edits.filter(done)) { await api.json('POST', `/api/bridge/web-edits/${e.id}/delivered?kind=player`); if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: player edit PGID ${e.pgid} (team ${e.tgid}) week ${e.week} delivered`); }
  const live = edits.filter((e) => !done(e));
  if (!live.length) return [];
  const fresh = freshPlayers(cfg.odDir, d.id);
  const rows: PlyzRow[] = [];
  for (const e of live) {
    const base = fresh.get(e.pgid);
    if (!base) { notes.push(` DID ${d.id}: PGID ${e.pgid} (team ${e.tgid}) is in neither the roster push nor the dynasty file, edit skipped`); continue; }
    const row = { ...base };
    if (e.jersey !== null) row.PJEN = e.jersey;
    if (e.pos !== null) row.PPOS = e.pos;
    if (e.redshirt !== null) row.PRSD = e.redshirt;
    if (e.firstName !== null) row.PFNA = e.firstName.slice(0, 11);
    if (e.lastName !== null) row.PLNA = e.lastName.slice(0, 13);
    const diff = PLYZ_EDITED.filter((k) => base[k] !== row[k]).map((k) => `${k} ${JSON.stringify(base[k])} -> ${JSON.stringify(row[k])}`);
    notes.push(`   player edit team ${e.tgid} PGID ${e.pgid} wk ${e.week}: ${diff.join(', ') || 'no change'}`);
    rows.push(row);
  }
  return rows;
}

// Transfer portal (offseason "Players Leaving" week): each edit becomes up to three rows the console pulls on load:
//  PLYZ (merged by PGID): the player's PTYP/PLFL, 1 + the reason to transfer, 0 + 28 ("stays in school") to stay;
//  TRAZ (merged by PGID): his TRAN row with the destination, TRAC 0 when he stays (a merge cannot delete the row);
//  PLSZ (replaces the PLSS rows of the pulling console's own team): that team's whole PLSS set with the change,
//  each row tagged with TGID so the stub hands a console only its team's rows (CPU teams never pull PLSZ).
// An edit is done once the console uploads a newer dynasty file: the advance that carries out the departures.
// patches: the same edits for the dynasty file (syncDynastyPatch), needed when newRows: TRAZ cannot add a TRAN row
interface TransferTables { plyz: PlyzRow[]; traz: Record<string, number>[]; plsz: Record<string, number>[]; patches: TransferPatch[]; newRows: boolean }
async function syncTransferEdits(cfg: BridgeConfig, d: OdDynasty, api: WorkerApi, edits: PendingTransferEdit[], opts: { quiet?: boolean }, notes: string[]): Promise<TransferTables> {
  const out: TransferTables = { plyz: [], traz: [], plsz: [], patches: [], newRows: false };
  const done = (e: PendingTransferEdit) => (d.fileSavedAt ?? 0) > epochOf(e.updatedAt);
  for (const e of edits.filter(done)) { await api.json('POST', `/api/bridge/web-edits/${e.id}/delivered?kind=transfer`); if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: transfer edit PGID ${e.pgid} (${e.action}) delivered (a newer dynasty file came in)`); }
  const live = edits.filter((e) => !done(e));
  if (!live.length) return out;
  const fresh = freshPlayers(cfg.odDir, d.id);
  const tran = new Map((loadPush(cfg.odDir, d.id, 'TRAN')?.rows ?? []).map((r) => [r.PGID as number, r]));
  const plss = loadPush(cfg.odDir, d.id, 'PLSS')?.rows ?? [];
  const inPlss = (pgid: number) => plss.some((r) => r.PGID === pgid);
  const plssChange = new Map<number, 'add' | 'remove'>();
  for (const e of live) {
    const p = fresh.get(e.pgid), cur = tran.get(e.pgid);
    if (!p) { notes.push(` DID ${d.id}: transfer edit PGID ${e.pgid}: player not in the dynasty file, skipped`); continue; }
    const who = `${p.PFNA} ${p.PLNA} (PGID ${e.pgid}, team ${p.TGID})`;
    if (e.action === 'transfer') {
      const to = e.toTgid ?? (cur ? Number(cur.PTID) : undefined);
      if (to === undefined || to === p.TGID) { notes.push(` DID ${d.id}: transfer edit for ${who} has no valid destination, skipped`); continue; }
      const reason = e.reason ?? (TRANSFER_REASONS.has(Number(p.PLFL)) ? Number(p.PLFL) : 9);
      out.plyz.push({ ...p, PTYP: 1, PLFL: reason });
      out.traz.push({ PTID: to, PGID: e.pgid, TRYR: Number(cur?.TRYR ?? 0), TRAC: 1 });
      out.patches.push({ pgid: e.pgid, action: 'transfer', to, reason });
      if (!cur) out.newRows = true;
      if (!inPlss(e.pgid)) plssChange.set(e.pgid, 'add');
      notes.push(`   transfer: ${who} -> team ${to}, reason ${reason}${cur ? ` (was team ${cur.PTID})` : ' (new)'}`);
    } else {
      out.plyz.push({ ...p, PTYP: 0, PLFL: 28 });
      if (cur) out.traz.push({ PTID: Number(cur.PTID), PGID: e.pgid, TRYR: Number(cur.TRYR ?? 0), TRAC: 0 });
      out.patches.push({ pgid: e.pgid, action: 'stay', to: null, reason: 28 });
      if (inPlss(e.pgid)) plssChange.set(e.pgid, 'remove');
      notes.push(`   stay: ${who}${cur ? ` (was going to team ${cur.PTID})` : ''}`);
    }
  }
  const teamOf = (pgid: number) => fresh.get(pgid)?.TGID;
  for (const t of new Set([...plssChange.keys()].map(teamOf).filter((x): x is number => x !== undefined))) {
    const rows: Record<string, number>[] = plss.filter((r) => teamOf(r.PGID as number) === t && plssChange.get(r.PGID as number) !== 'remove')
      .map((r) => ({ WTLS: Number(r.WTLS), PGID: Number(r.PGID), CSPL: Number(r.CSPL), CTSP: Number(r.CTSP), TGID: t }));
    for (const [pgid, ch] of plssChange) if (ch === 'add' && teamOf(pgid) === t) rows.push({ WTLS: NEW_TRANSFER_WEIGHT, PGID: pgid, CSPL: 0, CTSP: 0, TGID: t });
    // an empty reply is a no-op for the console, so a team's last PLSS row cannot be removed this way (PTYP/TRAC do it)
    if (rows.length) out.plsz.push(...rows); else notes.push(` DID ${d.id}: team ${t} would have no PLSS rows left; PLSZ not sent for it`);
  }
  return out;
}

// The reshaped class on the site right away: the site's recruits come from the console's uploads, which still carry the
// game's own class until a console has loaded the copy and uploaded again. Pushed after a run, and again after every
// import while the class is still pending (the import just put the vanilla names back).
async function previewRecruits(cfg: BridgeConfig, d: OdDynasty, api: WorkerApi, dbFile: string): Promise<void> {
  if (!existsSync(dbFile)) return;
  try {
    const ex = exportDynasty(parseTdb(new Uint8Array(readFileSync(dbFile))));
    for (const [table, rows] of [['recruits', ex.recruits], ['recruitInterest', ex.recruitInterest]] as const) {
      for (let i = 0; i < rows.length; i += 500) await api.json('PUT', `/api/bridge/recruits-preview?od=${d.id}`, { table, rows: rows.slice(i, i + 500) });
    }
    console.log(`${stamp()} DID ${d.id}: the reshaped class (${ex.recruits.length} prospects) is on the site; the console's own upload replaces it once it carries the class`);
  } catch (e) { console.error(`${stamp()} DID ${d.id}: recruits preview not sent: ${(e as Error).message.slice(0, 200)}`); }
}
// The reshaped recruiting class still to reach the console (its interest table only while the console's file is the
// one the tool ran on: later files carry the preseason's recruiting).
function pendingOverhaul(cfg: BridgeConfig, d: OdDynasty): RecruitPatch | undefined {
  const ov = loadState()[sk(cfg, d)]?.overhaul;
  if (!ov || ov.taken || ov.stale || ov.storeYear !== (d.year ?? 0) || !existsSync(ov.file)) return undefined;
  return { file: ov.file, sha: ov.sha, fields: ov.fields, interestFields: ov.base === consoleFileId(d) ? ov.interestFields : [] };
}

// The console's own recruits (RCPT of its current dynasty file), cached per file: tells whether a site edit landed.
const recruitCache = new Map<number, { fileId: number; rows: Map<number, Record<string, number | string>> }>();
function consoleRecruits(cfg: BridgeConfig, d: OdDynasty): Map<number, Record<string, number | string>> | null {
  const fileId = consoleFileId(d); if (!fileId) return null;
  const hit = recruitCache.get(d.id); if (hit && hit.fileId === fileId) return hit.rows;
  const blob = readLockerBlob(cfg.odDir, fileId); if (!blob) return null;
  const f = openDynastyFile(blob).file; const rows = new Map<number, Record<string, number | string>>();
  if (f.hasTable('RCPT')) for (const r of f.table('RCPT').rows()) rows.set(Number(r.PRSI), r);
  recruitCache.set(d.id, { fileId, rows });
  return rows;
}
// Recruit edits from the site: pending until a console file newer than the edit carries every edited value (a newer
// file that does not, from a console that never loaded the copy, keeps the edit pending and it is re-applied).
async function syncRecruitEdits(cfg: BridgeConfig, d: OdDynasty, api: WorkerApi, edits: PendingRecruitEdit[], opts: { quiet?: boolean }, notes: string[]): Promise<RecruitEdit[]> {
  if (!edits.length) return [];
  const rows = consoleRecruits(cfg, d);
  const reflected = (e: PendingRecruitEdit) => {
    const r = rows?.get(e.prsi); if (!r) return false;
    return (e.firstName === null || r.PFNA === e.firstName.slice(0, RECRUIT_FIRST_MAX)) && (e.lastName === null || r.PLNA === e.lastName.slice(0, RECRUIT_LAST_MAX)) && (e.pos === null || Number(r.PPOS) === e.pos)
      && (e.height === null || Number(r.PHGT) === e.height) && (e.weight === null || Number(r.PWGT) + WEIGHT_BASE === e.weight) && (e.stars === null || Number(r.RCCB) === e.stars)
      && (e.headId === null || e.headId === undefined || Number(r.PGHE) === e.headId);
  };
  const done = (e: PendingRecruitEdit) => (d.fileSavedAt ?? 0) > epochOf(e.updatedAt) && reflected(e);
  for (const e of edits.filter(done)) { await api.json('POST', `/api/bridge/web-edits/${e.id}/delivered?kind=recruit`); if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: recruit edit PRSI ${e.prsi} delivered (the console's file carries it)`); }
  const live = edits.filter((e) => !done(e));
  for (const e of live) notes.push(`   recruit edit PRSI ${e.prsi}: ${e.note ?? 'saved on the site'}`);
  return live.map((e) => ({ prsi: e.prsi, firstName: e.firstName, lastName: e.lastName, pos: e.pos, height: e.height, weight: e.weight, stars: e.stars, headId: e.headId ?? null }));
}
// RCPR by PRSI from the console's current file (committed team PTCM, points-to-commit CMTS, top slot), cached per file.
const interestCache = new Map<number, { fileId: number; rows: Map<number, { ptcm: number; cmts: number; lead: number; leadTeam: number; mine: (tgid: number) => number }> }>();
function consoleRecruitInterest(cfg: BridgeConfig, d: OdDynasty) {
  const fileId = consoleFileId(d); if (!fileId) return null;
  const hit = interestCache.get(d.id); if (hit && hit.fileId === fileId) return hit.rows;
  const blob = readLockerBlob(cfg.odDir, fileId); if (!blob) return null;
  const f = openDynastyFile(blob).file; const rows = new Map<number, { ptcm: number; cmts: number; lead: number; leadTeam: number; mine: (tgid: number) => number }>();
  if (f.hasTable('RCPR')) for (const r of f.table('RCPR').rows()) {
    const slots = Array.from({ length: 10 }, (_, k) => { const s = String(k + 1).padStart(2, '0'); return { team: Number(r[`PT${s}`]), pts: Number(r[`PS${s}`]) }; });
    const top = slots.reduce((a, b) => (b.pts > a.pts ? b : a));
    rows.set(Number(r.PRSI), { ptcm: Number(r.PTCM), cmts: Number(r.CMTS), lead: top.pts, leadTeam: top.team, mine: (tgid) => slots.find((s) => s.team === tgid)?.pts ?? 0 });
  }
  interestCache.set(d.id, { fileId, rows });
  return rows;
}
// Locks ride the patch set as recruit edits with lockTgid; a lock whose prospect the console shows committed to the team
// is done and dropped (committed elsewhere: dropped with a warning).
function mergeLocks(cfg: BridgeConfig, d: OdDynasty, edits: RecruitEdit[], notes: string[], opts: { quiet?: boolean }): void {
  const state = loadState(); const entry = state[sk(cfg, d)]; const locks = entry?.locks ?? [];
  if (!locks.length) return;
  const interest = consoleRecruitInterest(cfg, d); const keep: LockMemo[] = [];
  for (const l of locks) {
    const r = interest?.get(l.prsi);
    if (r && r.ptcm === l.tgid) { if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: lock done, PRSI ${l.prsi} committed to team ${l.tgid}`); continue; }
    if (r && r.ptcm !== 1023) { console.log(`${stamp()} DID ${d.id}: lock dropped, PRSI ${l.prsi} committed to team ${r.ptcm}, not ${l.tgid}`); continue; }
    keep.push(l);
    const e = edits.find((x) => x.prsi === l.prsi);
    if (e) e.lockTgid = l.tgid; else edits.push({ prsi: l.prsi, firstName: null, lastName: null, pos: null, height: null, weight: null, stars: null, headId: null, lockTgid: l.tgid });
    notes.push(`   recruit lock PRSI ${l.prsi} -> team ${l.tgid}${r ? ` (console: team has ${r.mine(l.tgid)}, commit at ${r.cmts}, leader ${r.leadTeam} with ${r.lead})` : ''}`);
  }
  if (keep.length !== locks.length) { entry!.locks = keep; saveState(state); }
}
// ---- the FCS playoff (bridge/src/playoff.ts) ----
// Runs on every pass against the console's current file. The bracket is played on the site: the field is selected once
// the console sits at Bowl Season (week 18, its own bowl selection final), the bracket goes to the site, the site's
// results come back round by round, and when the champion is known the whole bracket (teams, results, renamed and
// re-weeked bowl rows) goes into the dynasty-file copy the console must load before it advances. The row layout rides
// every copy from the start of the season. web-edits/<did>/ADVANCE.hold.json holds the console's advance (dod.mjs
// CheckAdvanceWeekStatus) while the bracket is being played.
const playoffCache = new Map<number, { fileId: number; file: TdbFile; ex: DynastyExport }>();
function consoleDynasty(cfg: BridgeConfig, d: OdDynasty): { fileId: number; file: TdbFile; ex: DynastyExport } | null {
  const fileId = consoleFileId(d); if (!fileId) return null;
  const hit = playoffCache.get(d.id); if (hit && hit.fileId === fileId) return hit;
  const blob = readLockerBlob(cfg.odDir, fileId); if (!blob) return null;
  const file = openDynastyFile(blob).file; const entry = { fileId, file, ex: exportDynasty(file) };
  playoffCache.set(d.id, entry); return entry;
}
function playoffMemo(cfg: BridgeConfig, d: OdDynasty, year: number): { state: OdState; memo: PlayoffMemo } {
  const state = loadState(); const key = sk(cfg, d); state[key] ??= { fingerprint: '', slug: '', importId: 0, at: '' } as OdState[string]; const entry = state[key]!;
  if (!entry.playoff || entry.playoff.year !== year) { entry.playoff = { year, enabled: entry.playoff?.enabled ?? true, autoBidConfs: entry.playoff?.autoBidConfs ?? null, phase: 'pending', games: [] }; saveState(state); }
  const memo = entry.playoff;
  if (!memo.phase) { memo.phase = memo.seeds ? 'live' : 'pending'; saveState(state); } // memos from before the phases
  return { state, memo };
}
const HOLD_FILE = 'ADVANCE.hold.json';
interface HoldFile { reason?: string; at?: number; manual?: boolean }
const readHoldFile = (dir: string): HoldFile | null => { try { return JSON.parse(readFileSync(join(dir, HOLD_FILE), 'utf8')) as HoldFile; } catch { return null; } };
// the league server answers CheckAdvanceWeekStatus with "not allowed" + this reason while the file exists. The watcher
// sets and clears its own hold (the playoff); a hold set by hand (od playoff --hold, manual) stays until --release.
function setHold(dir: string, reason: string | null, manual = false): void {
  const p = join(dir, HOLD_FILE); const cur = readHoldFile(dir);
  if (cur?.manual && !manual) return;
  if (!reason) { if (existsSync(p)) unlinkSync(p); return; }
  if (cur?.reason === reason && !!cur.manual === manual) return;
  mkdirSync(dir, { recursive: true }); writeFileSync(p, JSON.stringify({ reason, at: Math.floor(Date.now() / 1000), ...(manual ? { manual: true } : {}) }, null, 2));
}
export const readHold = (dir: string): string | null => String(readHoldFile(dir)?.reason ?? '') || null;
const HOLD_PLAYING = 'FCS playoff: finish the bracket on the site first';
async function pendingPlayoff(cfg: BridgeConfig, d: OdDynasty, api: WorkerApi, notes: string[], opts: { quiet?: boolean }): Promise<PlayoffPatch | undefined> {
  const c = consoleDynasty(cfg, d); if (!c) return undefined;
  const dir = join(cfg.odDir, 'web-edits', String(d.id));
  const { state, memo } = playoffMemo(cfg, d, c.ex.season.year);
  if (!memo.enabled) { setHold(dir, null); return undefined; }
  const rows = postseasonRows(c.file); if (!rows.length) { setHold(dir, null); return undefined; }
  const week = c.ex.season.week;
  const name = (tgid: number) => c.ex.teams.find((t) => t.tgid === tgid)?.name ?? `team ${tgid}`;
  let changed = false;
  if (memo.phase === 'pending') {
    if (week >= BOWL_SEASON_WEEK && week < SEASON_OVER_WEEK) {
      if (rows.some((r) => PLAYOFF_ROWS.has(r.sgnm) && r.week >= BOWL_SEASON_WEEK && r.status >= 2)) { memo.phase = 'skipped'; memo.note = `The console played its own bowl season before the playoff field could be set (file ${c.fileId}).`; changed = true; console.log(`${stamp()} DID ${d.id}: playoff skipped this season: ${memo.note}`); }
      else if (fieldFilled(rows)) {
        const sel = selectField(c.ex, memo.autoBidConfs); memo.seeds = sel.seeds; memo.selectedAt = c.fileId; memo.phase = 'live'; changed = true;
        console.log(`${stamp()} DID ${d.id}: playoff field set from file ${c.fileId} (week ${week}): ${sel.seeds.map((s) => `${s.seed}. ${name(s.tgid)}${s.autoBid !== null ? '*' : ''}`).join(', ')} (* conference champion); the bracket is played on the site`);
      }
    } else if (week >= SEASON_OVER_WEEK) { memo.phase = 'skipped'; memo.note = 'The season ended before the playoff field was set.'; changed = true; console.log(`${stamp()} DID ${d.id}: playoff skipped this season: ${memo.note}`); }
  }
  if (memo.phase === 'live' && week >= SEASON_OVER_WEEK) { // the console went through the bowl season without the bracket (an older server, or the hold was not in place)
    memo.phase = 'skipped'; memo.note = memo.games.some((g) => g.status >= 2) ? 'The season ended before the bracket was finished; the console played its own bowl season.' : 'The console played its own bowl season before the bracket was played (the playoff copies were never loaded).'; changed = true;
    console.log(`${stamp()} DID ${d.id}: playoff skipped this season: ${memo.note}`);
  }
  for (const g of memo.games) if (typeof g.status !== 'number') { g.status = 1; g.hs = 0; g.as = 0; changed = true; } // memos from before the site played the games
  if (memo.phase === 'live') {
    try { const site = await api.json<{ state?: { games?: SiteGame[] } | null }>('GET', `/api/bridge/playoff?od=${d.id}`); if (site?.state?.games && mergeSiteResults(memo, site.state.games)) changed = true; }
    catch (e) { if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: playoff results not read from the site: ${(e as Error).message}`); }
    for (;;) {
      const next = nextRoundGames(c.file, memo); if (!next.length) break;
      memo.games.push(...next); changed = true;
      console.log(`${stamp()} DID ${d.id}: playoff ${roundName(next[0]!.round)} set: ${next.map((g) => `${name(g.away)} at ${name(g.home)}`).join('; ')}`);
    }
    const champ = winnerOf(memo)(5, 0);
    if (champ !== null) { memo.champion = champ; memo.phase = 'final'; changed = true; console.log(`${stamp()} DID ${d.id}: FCS national champion ${name(champ)}; the finished bracket goes into the console's next copy`); }
  }
  if (memo.phase === 'final') {
    const o = consoleOutcome(rows, memo);
    if (o.total && o.played === o.total) {
      memo.phase = 'delivered'; memo.delivered = { file: c.fileId, matched: o.matched, total: o.total }; changed = true;
      console.log(`${stamp()} DID ${d.id}: the console played the bowl season from the bracket copy: ${o.matched}/${o.total} playoff results kept${o.matched < o.total ? ' (the console simulated the rest again; the site keeps its own results)' : ''}`);
    }
  }
  if (changed) saveState(state);
  const st = siteState(memo); const key = JSON.stringify(st);
  if ((memo.seeds || memo.phase === 'skipped') && memo.pushedKey !== key) {
    try { await api.json('PUT', `/api/bridge/playoff?od=${d.id}`, st); memo.pushedKey = key; saveState(state); }
    catch (e) { if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: playoff state not sent to the site: ${(e as Error).message}`); }
  }
  setHold(dir, memo.phase === 'live' && week >= BOWL_SEASON_WEEK && week < SEASON_OVER_WEEK ? HOLD_PLAYING : null);
  const diff = playoffDiff(c.file, c.ex, memo);
  if (diff) notes.push(`   playoff: ${diff.weeks ? 'bowl rows laid out for the bracket; ' : ''}${diff.games.length} bracket game(s) with results, ${diff.consolation.length} bowl row fix(es)${diff.requireLoad ? '; the console must load this copy before it advances' : ''}`);
  return diff ?? undefined;
}
// od playoff --did N [--on|--off] [--autobids "CAA,MVFC,..."|--autobids default] [--preview] [--reset] [--skip "note"] [--hold "reason"|--release]
export async function odPlayoff(cfg: BridgeConfig, opts: { did?: number; on: boolean; off: boolean; autobids?: string; preview: boolean; reset: boolean; skip?: string; hold?: string; release: boolean }): Promise<void> {
  const store = loadOdStore(cfg.odDir); const d = Object.values(store.dynasties).find((x) => x.id === opts.did);
  if (!d) { console.log('od playoff needs --did N (see od list)'); return; }
  const c = consoleDynasty(cfg, d); if (!c) { console.log(`DID ${d.id}: the console has not uploaded a dynasty file yet`); return; }
  const dir = join(cfg.odDir, 'web-edits', String(d.id));
  const { state, memo } = playoffMemo(cfg, d, c.ex.season.year);
  if (opts.on) memo.enabled = true; if (opts.off) memo.enabled = false;
  if (opts.autobids !== undefined) memo.autoBidConfs = opts.autobids.trim().toLowerCase() === 'default' ? null : opts.autobids.split(',').map((s) => s.trim()).filter(Boolean);
  if (opts.reset) { memo.seeds = undefined; memo.games = []; memo.champion = null; memo.pushedKey = undefined; memo.phase = 'pending'; memo.note = undefined; memo.delivered = undefined; console.log('playoff memo reset for this season (rows already written to the console stay as they are)'); }
  if (opts.skip !== undefined) { memo.phase = 'skipped'; memo.note = opts.skip || 'No playoff this season.'; memo.pushedKey = undefined; console.log(`playoff marked skipped for ${memo.year}: ${memo.note}`); }
  saveState(state);
  // a hold by hand (to see what the console shows when an advance is refused) and its release
  if (opts.hold !== undefined) { setHold(dir, opts.hold || 'Advance held by the league (test)', true); console.log(`advance hold set for DID ${d.id}: "${readHold(dir)}" (the console's next Advance Week is refused with this text; od playoff --did ${d.id} --release clears it)`); }
  if (opts.release) { setHold(dir, null, true); console.log(`advance hold cleared for DID ${d.id}`); }
  if (opts.skip !== undefined || opts.reset) { const api = new WorkerApi(cfg); const st = siteState(memo); try { await api.json('PUT', `/api/bridge/playoff?od=${d.id}`, st); memo.pushedKey = JSON.stringify(st); saveState(state); console.log('site updated'); } catch (e) { console.log(`site not updated: ${(e as Error).message}`); } }
  const name = (tgid: number) => c.ex.teams.find((t) => t.tgid === tgid)?.name ?? `team ${tgid}`;
  const rows = postseasonRows(c.file);
  console.log(`DID ${d.id} season ${memo.year}, week index ${c.ex.season.week}: playoff ${memo.enabled ? 'ON' : 'OFF'}, phase ${memo.phase}${memo.note ? ` (${memo.note})` : ''}; bracket rows ${weeksApplied(rows) ? 'laid out in the console file' : 'not yet laid out in the console file'}; bowls ${fieldFilled(rows) ? 'filled by the game' : 'not filled yet'}; advance hold: ${readHold(dir) ?? 'none'}`);
  const bids = autoBids(c.ex, memo.autoBidConfs); console.log(`automatic bids: ${bids.map((cg) => c.ex.conferences.find((x) => x.cgid === cg)?.name ?? cg).join(', ')}${memo.autoBidConfs ? ' (override)' : ' (default)'}`);
  if (memo.seeds) {
    console.log('field:'); for (const s of memo.seeds) console.log(`  ${String(s.seed).padStart(2)}. ${name(s.tgid)}${s.autoBid !== null ? ' *' : ''}`);
    for (const g of memo.games) console.log(`  ${roundName(g.round)} ${g.idx + 1}: ${name(g.away)} at ${name(g.home)} (row ${g.sgnm}, week ${ROUND_WEEKS[g.round]!.week})${g.status >= 2 ? ` FINAL ${g.as}-${g.hs}${g.ot ? ' OT' : ''}` : ''}`);
    if (memo.champion) console.log(`  champion: ${name(memo.champion)}`);
    if (memo.delivered) console.log(`  delivered to the console: ${memo.delivered.matched}/${memo.delivered.total} results kept (file ${memo.delivered.file})`);
  } else if (opts.preview) { const sel = selectField(c.ex, memo.autoBidConfs); console.log('projected field as of this file:'); for (const s of sel.seeds) console.log(`  ${String(s.seed).padStart(2)}. ${name(s.tgid)}${s.autoBid !== null ? ' *' : ''}`); }
}
// od lock --did N [--prsi P --tgid T | --prsi P --clear]: list, add or remove a recruit lock
export async function odLock(cfg: BridgeConfig, opts: { did?: number; prsi?: number; tgid?: number; clear: boolean }): Promise<void> {
  const store = loadOdStore(cfg.odDir); const d = Object.values(store.dynasties).find((x) => x.id === opts.did);
  if (!d) { console.log('od lock needs --did N (see od list)'); return; }
  const state = loadState(); const key = sk(cfg, d); state[key] ??= { fingerprint: '', slug: '', importId: 0, at: '' } as OdState[string]; const entry = state[key]!; entry.locks ??= [];
  const names = consoleRecruits(cfg, d); const interest = consoleRecruitInterest(cfg, d);
  const describe = (l: LockMemo) => { const n = names?.get(l.prsi); const r = interest?.get(l.prsi); return `PRSI ${l.prsi}${n ? ` ${n.PFNA} ${n.PLNA}` : ''} -> team ${l.tgid}${r ? ` (team has ${r.mine(l.tgid)}, commit at ${r.cmts}, leader ${r.leadTeam} with ${r.lead}${r.ptcm !== 1023 ? `, COMMITTED to ${r.ptcm}` : ''})` : ''}`; };
  if (opts.prsi !== undefined && opts.clear) { entry.locks = entry.locks.filter((l) => l.prsi !== opts.prsi); saveState(state); console.log(`lock for PRSI ${opts.prsi} removed`); }
  else if (opts.prsi !== undefined && opts.tgid !== undefined) {
    if (names && !names.has(opts.prsi)) { console.log(`PRSI ${opts.prsi} is not in the console's recruit class`); return; }
    entry.locks = [...entry.locks.filter((l) => l.prsi !== opts.prsi), { prsi: opts.prsi, tgid: opts.tgid, at: new Date().toISOString() }]; saveState(state);
    console.log(`lock added: ${describe(entry.locks[entry.locks.length - 1]!)}; the next published copy carries it and the console commits him at its next weekly update`);
  }
  if (!entry.locks.length) console.log(`DID ${d.id}: no recruit locks`); else for (const l of entry.locks) console.log(`  ${describe(l)}`);
}
// A commissioner's "re-generate the class" request from the site: Fang's Recruit Overhaul on the console's current
// file, preseason only; the result goes back to the site (status + message) and the new class rides the next patch.
async function syncOverhaulRequests(cfg: BridgeConfig, d: OdDynasty, api: WorkerApi, reqs: PendingOverhaulRequest[]): Promise<void> {
  for (const r of reqs) {
    const finish = (status: 'done' | 'failed', message: string) => api.json('POST', `/api/bridge/web-edits/${r.id}/overhaul`, { status, message });
    try {
      if (!cfg.overhaulExe) { await finish('failed', 'The recruit overhaul tool is not set up on the league server (ncaa-bridge od overhaul --set-exe).'); continue; }
      const fileId = consoleFileId(d); const blob = fileId ? readLockerBlob(cfg.odDir, fileId) : null;
      if (!blob) { await finish('failed', 'The console has not uploaded a dynasty file yet.'); continue; }
      const opened = openDynastyFile(blob); const ex = exportDynasty(opened.file);
      if (ex.season.week !== 0) { await finish('failed', `The dynasty is at week ${ex.season.week + 1}; the class can only be re-generated in the preseason.`); continue; }
      console.log(`${stamp()} DID ${d.id}: re-generate request #${r.id} from the site`);
      const state = loadState();
      const ok = await maybeOverhaul(cfg, d, opened, ex, fileId, state, api, true, false);
      const ov = state[sk(cfg, d)]?.overhaul;
      await finish(ok && ov ? 'done' : 'failed', ok && ov ? `${ov.renamed} of the class renamed and reshaped; every console takes the new class at its next dynasty load.` : 'The tool did not run.');
    } catch (e) { await finish('failed', (e as Error).message.slice(0, 300)).catch(() => {}); console.error(`${stamp()} DID ${d.id} re-generate request #${r.id}: ${(e as Error).message}`); }
  }
}
// The calendar year a dynasty began, for the site's "Nth season" (dynasties.start_year). The file's SEAI.SSYE moves
// with SEYR at every rollover, so it is no guide: the year is the one the bridge queued and a console took (od year;
// counted as taken as soon as the file being imported carries it), else the year of the dynasty's earliest file in
// the locker, decoded once and kept in od-state as firstYear.
function odStartYear(dir: string, d: OdDynasty, ex: DynastyExport, memo: OdState[string] | undefined): { startYear: number; firstYear: number } {
  let firstYear = memo?.firstYear;
  if (firstYear === undefined) {
    const cids = Object.values(lockerIndexAll(dir)).filter((c) => c.name === 'DYNASTY.dynasty' && c.group?.id === d.id).map((c) => c.cid).sort((a, b) => a - b);
    for (const cid of cids) {
      const blob = readLockerBlobAny(dir, cid); if (!blob) continue;
      try { firstYear = decodeSeason(openDynastyFile(blob).file).year; break; } catch { /* a damaged upload: try the next one */ }
    }
    firstYear ??= ex.season.year;
  }
  const m = memo?.startYear;
  const taken = !!m && !m.stale && (!!m.taken || ex.season.year === m.year);
  return { startYear: taken ? m!.year : firstYear, firstYear };
}
// The roster stride still to reach the console (od stride --did N --stride 100).
function pendingStride(cfg: BridgeConfig, d: OdDynasty): number | undefined {
  const m = loadState()[sk(cfg, d)]?.stride;
  return m && !m.taken ? m.stride : undefined;
}
// A console upload keyed at the queued stride: the switch is done, the copy is withdrawn by the next syncWebEdits.
function maybeStrideTaken(cfg: BridgeConfig, d: OdDynasty, opened: OpenedDynastyFile, fileId: number, state: OdState): void {
  const memo = state[sk(cfg, d)]?.stride; if (!memo || memo.taken) return;
  if (detectStride(opened.file.table('PLAY')) === memo.stride) { memo.taken = fileId; saveState(state); console.log(`${stamp()} DID ${d.id}: the console's file ${fileId} is keyed at stride ${memo.stride}; the switch is done`); }
}
// ncaa-bridge od stride [--did N --stride 100 | --did N --off]: queue a roster-stride change for one dynasty (status without flags).
export async function odStride(cfg: BridgeConfig, opts: { did?: number; stride?: number; off: boolean }): Promise<void> {
  const store = loadOdStore(cfg.odDir); const state = loadState();
  const list = Object.values(store.dynasties).filter((d) => opts.did === undefined || d.id === opts.did);
  if (opts.stride === undefined && !opts.off) {
    for (const d of list) { const m = state[sk(cfg, d)]?.stride; console.log(`DID ${d.id} ${odName(d)}: ${m ? `stride ${m.stride}, ${m.taken ? `taken (console file ${m.taken})` : `pending since ${m.at} (built from file ${m.base})`}` : 'stride 70 (the game default, nothing queued)'}`); }
    return;
  }
  if (opts.did === undefined) throw new Error('--did N is required with --stride / --off');
  const d = list[0]; if (!d) throw new Error(`no dynasty DID ${opts.did} in ${cfg.odDir}`);
  const memo = state[sk(cfg, d)] ?? (state[sk(cfg, d)] = { fingerprint: '', slug: '', importId: 0, at: '' });
  if (opts.off) { delete memo.stride; saveState(state); console.log(`DID ${d.id}: stride setting cleared (files already published are left as they are)`); }
  else {
    const want = opts.stride;
    if (want === undefined || !(STRIDES as readonly number[]).includes(want)) throw new Error(`--stride takes one of ${STRIDES.join(', ')}`);
    memo.stride = { stride: want, base: consoleFileId(d), at: new Date().toISOString() }; saveState(state);
    console.log(`DID ${d.id}: stride ${want} queued (from console file ${consoleFileId(d)}); the watcher publishes the re-keyed dynasty file and the console takes it at its next load from the hub. The console must run the "FCS mod: 100-player rosters" patch for stride 100, and must not load stride-70 dynasties while it does.`);
  }
  await syncWebEdits(cfg, d, new WorkerApi(cfg)).catch((e: Error) => console.error(`${stamp()} DID ${d.id} web edits: ${e.message}`));
}
// Players queued by `od players` / `od repair` that no console upload carries yet.
function pendingCreatePlayers(cfg: BridgeConfig, d: OdDynasty): CreatePlayerPatch[] {
  return loadState()[sk(cfg, d)]?.players?.pending ?? [];
}
function pendingRemovePlayers(cfg: BridgeConfig, d: OdDynasty): number[] {
  return loadState()[sk(cfg, d)]?.repair?.remove ?? [];
}
function maybeRemovalsTaken(cfg: BridgeConfig, d: OdDynasty, ex: DynastyExport, state: OdState): void {
  const memo = state[sk(cfg, d)]?.repair; if (!memo?.remove.length) return;
  const have = new Set(ex.players.map((p) => p.pgid)); const left = memo.remove.filter((g) => have.has(g));
  const restored = memo.restores?.length ? memo.restores.every((g) => have.has(g)) : false; // the same copy's restores arrived
  if (left.length === memo.remove.length && !restored) return;
  // one batch: once the console's file lacks any of them it took the copy, and an id still present is a row created
  // afterwards under a freed id (the fill reuses them), not a removal that failed
  console.log(`${stamp()} DID ${d.id}: the console's file lacks ${memo.remove.length - left.length} of the ${memo.remove.length} rows the repair removed${left.length ? ` (${left.length} ids reused since)` : ''}; repair done`);
  delete state[sk(cfg, d)]!.repair;
  saveState(state);
}
function maybePlayersTaken(cfg: BridgeConfig, d: OdDynasty, ex: DynastyExport, state: OdState): void {
  const memo = state[sk(cfg, d)]?.players; if (!memo?.pending.length) return;
  const have = new Set(ex.players.map((p) => `${p.tgid}:${p.lastName}`));
  const carried = (c: QueuedPlayer) => have.has(`${c.tgid}:${c.lastName.slice(0, RECRUIT_LAST_MAX)}`);
  const landed = new Set(memo.pending.filter(carried).map((c) => c.batch).filter((b): b is string => !!b));
  const left = memo.pending.filter((c) => !carried(c) && !(c.batch && landed.has(c.batch)));
  if (left.length === memo.pending.length) return;
  const n = memo.pending.filter(carried).length, dropped = memo.pending.length - left.length - n;
  console.log(`${stamp()} DID ${d.id}: the console's file carries ${n} of the ${memo.pending.length} queued players${dropped ? ` (${dropped} of the same batch skipped at patch time, dropped)` : ''}`);
  if (left.length) memo.pending = left; else delete state[sk(cfg, d)]!.players;
  saveState(state);
}
// rating codes set low on a generated reserve so the auto depth chart leaves him on the bench
const RESERVE_RATINGS = ['POVR', 'PSPD', 'PACC', 'PAGI', 'PSTR', 'PAWR', 'PCTH', 'PCAR', 'PBTK', 'PTRK', 'PJMP', 'PTHA', 'PTHP', 'PRBK', 'PPBK', 'PRBS', 'PPBS', 'PIBL', 'PPBF', 'PPMV', 'PFMV', 'PBSH', 'PPRS', 'PTAK', 'PHIT', 'PPRC', 'PZCV', 'PMCV', 'PBCV', 'PRTR', 'PESV', 'PJMV', 'PSMV', 'PKPR', 'PKAC', 'PSTA', 'PKRT', 'PBFW'];
export const RESERVE_RATING = 40;
// ncaa-bridge od players [--did N] [--tgid T | --team NAME] [--fill 100] [--prefix Reserve] [--clear]: fill a team up to
// N players with generated reserves (copies of the team's own players at the same position, low ratings, free jersey
// numbers) through the dynasty-file copy; status without --fill. The console must run the capacity patch first.
export async function odPlayers(cfg: BridgeConfig, opts: { did?: number; tgid?: number; team?: string; fill?: number; prefix?: string; clear: boolean }): Promise<void> {
  const store = loadOdStore(cfg.odDir); const state = loadState();
  const list = Object.values(store.dynasties).filter((d) => opts.did === undefined || d.id === opts.did);
  if (opts.fill === undefined && !opts.clear) {
    for (const d of list) { const m = state[sk(cfg, d)]?.players; console.log(`DID ${d.id} ${odName(d)}: ${m?.pending.length ? `${m.pending.length} generated player(s) pending since ${m.at} (built from file ${m.base}): ${m.pending.map((c) => `team ${c.tgid} ${c.firstName} ${c.lastName}`).slice(0, 5).join(', ')}${m.pending.length > 5 ? ' ...' : ''}` : 'nothing queued'}`); }
    return;
  }
  if (opts.did === undefined) throw new Error('--did N is required with --fill / --clear');
  const d = list[0]; if (!d) throw new Error(`no dynasty DID ${opts.did} in ${cfg.odDir}`);
  const memo = state[sk(cfg, d)] ?? (state[sk(cfg, d)] = { fingerprint: '', slug: '', importId: 0, at: '' });
  if (opts.clear) { delete memo.players; saveState(state); console.log(`DID ${d.id}: queued players cleared (rows already published stay in the copy until the console's next upload replaces it)`); }
  else {
    const cd = consoleDynasty(cfg, d); if (!cd) throw new Error(`DID ${d.id}: no console dynasty file yet`);
    const teams = cd.ex.teams; const want = String(opts.team ?? '').toLowerCase();
    const team = opts.tgid !== undefined ? teams.find((t) => t.tgid === opts.tgid) : teams.find((t) => [t.name, t.longName, t.abbr].some((n) => String(n ?? '').toLowerCase() === want)) ?? teams.find((t) => [t.name, t.longName].some((n) => String(n ?? '').toLowerCase().includes(want)));
    if (!team) throw new Error(`team ${opts.tgid ?? opts.team} not found in the dynasty (use --tgid or the display name)`);
    const fill = opts.fill!; if (!(fill > 0 && fill <= 100)) throw new Error('--fill takes 1..100');
    const play = cd.file.table('PLAY'); const stride = detectStride(play) ?? PGID_STRIDE; const slots = rosterSlots(stride);
    // the roster as the next copy will carry it: the console's rows minus a pending repair's removals, plus its restores
    const removeSet = new Set(memo.repair?.remove ?? []);
    const mine = cd.ex.players.filter((p) => p.tgid === team.tgid && !removeSet.has(p.pgid));
    const pendingAll = (memo.players?.pending ?? []).filter((c) => c.tgid === team.tgid);
    const restores = pendingAll.filter((c) => c.pgid); const pending = pendingAll.filter((c) => !c.pgid);
    const usedIds = new Set<number>(restores.map((c) => c.pgid!)); for (let i = 0; i < play.recordCount; i++) { const g = Number(play.get(i, 'PGID')); if (!removeSet.has(g)) usedIds.add(g); }
    let free = -pending.length; for (let s = 0; s < slots; s++) if (!usedIds.has(team.tgid * stride + s)) free++;
    const need = Math.min(Math.min(fill, slots) - mine.length - restores.length - pending.length, free);
    if (need <= 0) { console.log(`DID ${d.id}: ${team.name} already has ${mine.length + restores.length} players${pending.length ? ` + ${pending.length} queued` : ''} and ${Math.max(free, 0)} free slot(s) of the ${slots} a stride-${stride} team can fill; nothing to add for --fill ${fill}`); return; }
    const playFields = play.fieldMap;
    const ratings = RESERVE_RATINGS.filter((k) => playFields.has(k));
    const byPos = new Map<number, typeof mine>(); for (const p of mine) byPos.set(p.pos, [...(byPos.get(p.pos) ?? []), p]);
    const order = [...byPos.entries()].sort((a, b) => b[1].length - a[1].length).map(([pos]) => pos);
    const used = new Set<number>([...mine.map((p) => p.jersey), ...pendingAll.map((c) => c.jersey ?? -1)]);
    const taken = new Set<string>([...mine.map((p) => p.lastName), ...(memo.players?.pending ?? []).map((c) => c.lastName)]);
    const prefix = (opts.prefix ?? 'Reserve').slice(0, RECRUIT_FIRST_MAX);
    const made: QueuedPlayer[] = []; const batch = new Date().toISOString();
    let seq = 1;
    for (let i = 0; i < need; i++) {
      const pos = order[i % order.length] ?? 0; const cands = byPos.get(pos) ?? mine;
      const tpl = cands[(i * 7) % cands.length]!;
      let jersey = 0; while (used.has(jersey) && jersey < 100) jersey++; if (jersey >= 100) jersey = 99; used.add(jersey);
      let last = ''; do { last = `Res${String(seq++).padStart(2, '0')}`; } while (taken.has(last)); taken.add(last);
      const fields: Record<string, number> = { PYEA: i % 4, PRSD: 0 }; for (const k of ratings) fields[k] = RESERVE_RATING;
      made.push({ tgid: team.tgid, firstName: prefix, lastName: last, pos, jersey, template: tpl.pgid, fields, batch });
    }
    memo.players = { pending: [...(memo.players?.pending ?? []), ...made], at: batch, base: cd.fileId }; saveState(state);
    const to = mine.length + restores.length + pending.length + made.length;
    console.log(`DID ${d.id}: ${made.length} reserve(s) queued for ${team.name} (TGID ${team.tgid}, ${mine.length + restores.length} players now -> ${to}${to < fill ? `; a stride-${stride} team fills ${slots} slots and ${free} were free` : ''}); positions ${[...new Set(made.map((c) => c.pos))].join('/')}, jerseys ${made.map((c) => c.jersey).join(' ')}. The watcher publishes them in the dynasty-file copy; the console must run both roster patches (stride + capacity) before loading it, and games dress only slots 0..69.`);
  }
  await syncWebEdits(cfg, d, new WorkerApi(cfg)).catch((e: Error) => console.error(`${stamp()} DID ${d.id} web edits: ${e.message}`));
}
// ncaa-bridge od repair --did N --tgid T --from CID [--keep-reserves]: put a team's roster back after the console mangled
// it (2026-11-06: a user team above 70 lost 20 original rows and gained 20 duplicate reserves at ids in other teams'
// ranges during a game). Rows of the team in locker file CID that no longer exist anywhere in the console's newest
// file are restored under their original ids with every field; the team's rows named "Reserve" (unless --keep-reserves)
// and any row outside the team's id range that duplicates an in-range row by name are removed. Delivered like
// `od players`: through the dynasty-file copy at the console's next hub load.
export async function odRepair(cfg: BridgeConfig, opts: { did?: number; tgid?: number; from?: number; keepReserves: boolean }): Promise<void> {
  if (opts.did === undefined || opts.tgid === undefined || !opts.from) throw new Error('--did N, --tgid T and --from CID are required');
  const store = loadOdStore(cfg.odDir); const state = loadState();
  const d = Object.values(store.dynasties).find((x) => x.id === opts.did); if (!d) throw new Error(`no dynasty DID ${opts.did} in ${cfg.odDir}`);
  const cd = consoleDynasty(cfg, d); if (!cd) throw new Error(`DID ${d.id}: no console dynasty file yet`);
  const refBlob = readLockerBlob(cfg.odDir, opts.from); if (!refBlob) throw new Error(`locker file ${opts.from} not found`);
  const ref = openDynastyFile(refBlob).file; const tgid = opts.tgid; const stride = detectStride(cd.file.table('PLAY')) ?? PGID_STRIDE;
  const play = cd.file.table('PLAY'); const present = new Set<number>(); const mine: { pgid: number; first: string; last: string }[] = [];
  for (let i = 0; i < play.recordCount; i++) { const g = Number(play.get(i, 'PGID')); present.add(g); if (Number(play.get(i, 'TGID')) === tgid) mine.push({ pgid: g, first: String(play.get(i, 'PFNA')), last: String(play.get(i, 'PLNA')) }); }
  const rp = ref.table('PLAY'); const restore: QueuedPlayer[] = []; const batch = new Date().toISOString();
  for (let i = 0; i < rp.recordCount; i++) {
    if (Number(rp.get(i, 'TGID')) !== tgid) continue; const g = Number(rp.get(i, 'PGID')); if (present.has(g)) continue;
    const row = rp.row(i); const fields: Record<string, number | string> = {};
    for (const [k, v] of Object.entries(row)) if (k !== 'PGID' && k !== 'TGID' && k !== 'POID' && (typeof v === 'number' || typeof v === 'string')) fields[k] = v;
    restore.push({ tgid, firstName: String(row.PFNA), lastName: String(row.PLNA), pos: Number(row.PPOS), jersey: Number(row.PJEN), template: null, fields, pgid: g, batch });
  }
  const inRange = (g: number) => Math.floor(g / stride) === tgid;
  const inRangeNames = new Set(mine.filter((m) => inRange(m.pgid)).map((m) => `${m.first} ${m.last}`));
  const remove = mine.filter((m) => (!opts.keepReserves && m.first === 'Reserve') || (!inRange(m.pgid) && inRangeNames.has(`${m.first} ${m.last}`))).map((m) => m.pgid);
  if (!restore.length && !remove.length) { console.log(`DID ${d.id}: team ${tgid} needs no repair against file ${opts.from} (${mine.length} rows now)`); return; }
  const memo = state[sk(cfg, d)] ?? (state[sk(cfg, d)] = { fingerprint: '', slug: '', importId: 0, at: '' });
  memo.players = { pending: [...(memo.players?.pending ?? []).filter((c) => !(c.tgid === tgid && c.firstName === 'Reserve' && !opts.keepReserves)), ...restore], at: batch, base: cd.fileId };
  memo.repair = { remove: [...new Set([...(memo.repair?.remove ?? []), ...remove])], restores: [...new Set([...(memo.repair?.restores ?? []), ...restore.map((r) => r.pgid!)])], at: batch, base: cd.fileId, note: `team ${tgid} from file ${opts.from}` };
  saveState(state);
  console.log(`DID ${d.id}: team ${tgid} repair queued from file ${opts.from}: restore ${restore.length} row(s) [${restore.map((r) => `${r.pgid}:${r.lastName}`).join(' ')}], remove ${remove.length} row(s) [${remove.join(' ')}]; ${mine.length} rows now -> ${mine.length - remove.length + restore.length}. Published in the dynasty-file copy; the console takes it at its next hub load.`);
  await syncWebEdits(cfg, d, new WorkerApi(cfg)).catch((e: Error) => console.error(`${stamp()} DID ${d.id} web edits: ${e.message}`));
}
// The start year still to reach the console.
function pendingStartYear(cfg: BridgeConfig, d: OdDynasty): number | undefined {
  const m = loadState()[sk(cfg, d)]?.startYear;
  return m && !m.taken && !m.stale ? m.year : undefined;
}
// A brand-new dynasty's start year (the Dynasty Tool's Year Changer, done through the dynasty-file copy): queued on the
// first file of a new dynasty at its preseason when the config has a default (od year --default) or by hand (od year
// --did N --year Y), published until a console file carries it, dropped if the dynasty moved on without it.
export async function maybeStartYear(cfg: BridgeConfig, d: OdDynasty, ex: DynastyExport, fileId: number, state: OdState, api: WorkerApi, want?: number): Promise<boolean> {
  const memo = state[sk(cfg, d)]; if (!memo) return false;
  const m = memo.startYear; const off = ex.season.yearOffset, week = ex.season.week;
  if (m && !m.taken && !m.stale && !want) {
    if (off === m.year - BASE_YEAR) {
      m.taken = fileId;
      // the class reshaped on the game's own calendar is the same class: it moves to the new year with the dynasty
      const ov = memo.overhaul; if (ov && !ov.taken && !ov.stale && ov.year === BASE_YEAR && m.year !== BASE_YEAR) { ov.year = m.year; ov.storeYear = d.year ?? 0; }
      saveState(state); console.log(`${stamp()} DID ${d.id}: the console has the ${m.year} start year (file ${fileId})`); return true;
    }
    if (week > 0 || off !== 0) { m.stale = true; saveState(state); console.log(`${stamp()} DID ${d.id}: the ${m.year} start year was never loaded by a console; the dynasty went on in ${BASE_YEAR + off}`); return true; }
    return false; // still pending: syncDynastyPatch keeps publishing it
  }
  const year = want ?? cfg.startYear;
  if (!year || (m && !want)) return false;
  if (year < BASE_YEAR || year > 2050) throw new Error(`start year ${year}: the game takes ${BASE_YEAR}..2050`);
  if (off === year - BASE_YEAR) { if (want) console.log(`DID ${d.id}: already in ${year}`); return false; }
  if (week !== 0 || off !== 0) { if (want) throw new Error(`DID ${d.id} is at ${BASE_YEAR + off} week ${week}: a start year can only be set on a brand-new dynasty at its first preseason (the Dynasty Tool's rule)`); return false; }
  memo.startYear = { year, base: fileId, at: new Date().toISOString() }; saveState(state);
  console.log(`${stamp()} DID ${d.id}: start year ${year} queued for the console (file ${fileId}); it takes it at its next dynasty load`);
  await syncWebEdits(cfg, d, api).catch((e: Error) => console.error(`${stamp()} DID ${d.id} web edits: ${e.message}`));
  return true;
}
// ncaa-bridge od year [--default Y | --default off] [--did N --year Y]: the start year of new dynasties.
export async function odYear(cfg: BridgeConfig, opts: { did?: number; year?: number; dflt?: string }): Promise<void> {
  if (opts.dflt !== undefined) {
    if (opts.dflt === 'off') { saveConfigKey('startYear', undefined); cfg.startYear = undefined; console.log(`new dynasties keep the game's own start year (${BASE_YEAR})`); }
    else { const y = Number(opts.dflt); if (!Number.isInteger(y) || y < BASE_YEAR || y > 2050) throw new Error(`--default takes a year ${BASE_YEAR}..2050 or off`); saveConfigKey('startYear', y); cfg.startYear = y; console.log(`new dynasties will start in ${y} (set on their first preseason file by od watch)`); }
  }
  const store = loadOdStore(cfg.odDir); const state = loadState(); const api = new WorkerApi(cfg);
  for (const d of Object.values(store.dynasties).filter((x) => opts.did === undefined || x.id === opts.did)) {
    const fileId = consoleFileId(d); if (!fileId) continue;
    const memo = state[sk(cfg, d)];
    if (opts.year !== undefined && opts.did !== undefined) {
      if (!memo) { console.log(`DID ${d.id}: not imported yet (od import first)`); continue; }
      const blob = readLockerBlob(cfg.odDir, fileId); if (!blob) { console.log(`DID ${d.id}: dynasty file CID ${fileId} is missing from the locker`); continue; }
      await maybeStartYear(cfg, d, exportDynasty(openDynastyFile(blob).file), fileId, state, api, opts.year);
    }
    const m = memo?.startYear;
    console.log(`DID ${d.id} ${odName(d)}: ${m ? `start year ${m.year} (queued ${m.at} on file ${m.base}): ${m.taken ? `taken by the console (file ${m.taken})` : m.stale ? 'never taken, left alone' : 'waiting for a console to load the dynasty'}` : `the game's own calendar (${BASE_YEAR} + ${d.year ?? 0})`}`);
  }
  console.log(`default for new dynasties: ${cfg.startYear ?? `none (${BASE_YEAR})`}`);
}

// Fang's Recruit Overhaul on a new recruiting class (recruit-overhaul.ts). The class is generated when the season
// opens (week 0), so the tool runs on the first file of a season year and its output is published as the dynasty's
// file until a console file carries the reshaped names (taken); a season that moves past week 1 on the vanilla class
// is left alone (stale). force: run on this file whatever the week (od overhaul --run).
export async function maybeOverhaul(cfg: BridgeConfig, d: OdDynasty, opened: OpenedDynastyFile, ex: DynastyExport, fileId: number, state: OdState, api: WorkerApi, force = false, publish = true): Promise<boolean> {
  if (!cfg.overhaulExe) return false;
  const memo = state[sk(cfg, d)]; if (!memo) return false;
  const year = ex.season.year, week = ex.season.week; const ov = memo.overhaul;
  // a start year the console just took moves the calendar under the same class (the first preseason, week 0)
  if (ov && ov.year !== year && !ov.taken && !ov.stale && week === 0 && memo.startYear?.year === year && ov.year === BASE_YEAR) { ov.year = year; ov.storeYear = d.year ?? 0; saveState(state); }
  if (ov && ov.year !== year && !ov.taken && !ov.stale) { ov.stale = true; saveState(state); console.log(`${stamp()} DID ${d.id}: the reshaped ${ov.year} class never reached the console; the dynasty is in ${year} now`); }
  if (ov && ov.year === year && !force) {
    if (ov.taken || ov.stale) return false;
    const stored = existsSync(ov.file) ? parseTdb(new Uint8Array(readFileSync(ov.file))) : null;
    if (stored && classTaken(opened.file, stored)) { ov.taken = fileId; saveState(state); console.log(`${stamp()} DID ${d.id}: the console has the reshaped ${year} class (file ${fileId})`); return true; }
    if (week > 1) { ov.stale = true; saveState(state); console.log(`${stamp()} DID ${d.id}: the reshaped ${year} class was never loaded by a console (the dynasty is at week ${week}); the class stays as the game made it`); return true; }
    await previewRecruits(cfg, d, api, ov.file); // the import just showed the console's vanilla class again
    return false; // still pending: syncDynastyPatch keeps publishing it on the current console file
  }
  if (!force && week !== 0) return false;
  if (!opened.file.hasTable('RCPT') || !opened.file.table('RCPT').recordCount) return false;
  console.log(`${stamp()} DID ${d.id}: running Fang's Recruit Overhaul on the ${year} recruiting class (file ${fileId}, ${opened.file.table('RCPT').recordCount} recruits)…`);
  const run = runRecruitOverhaul(cfg.overhaulExe, opened.db, (l) => console.log(`${stamp()}${l}`));
  mkdirSync(OVERHAUL_DIR, { recursive: true });
  const host = cfg.workerUrl.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-');
  const file = join(OVERHAUL_DIR, `${host}-did${d.id}-${year}.db`);
  writeFileSync(file, run.db);
  memo.overhaul = { year, storeYear: d.year ?? 0, base: fileId, file, sha: run.sha, fields: run.fields, interestFields: run.interestFields, renamed: run.renamed, at: new Date().toISOString() };
  saveState(state);
  console.log(`${stamp()} DID ${d.id}: ${run.renamed} recruits renamed, ${run.fields.length} RCPT and ${run.interestFields.length} RCPR fields reshaped in ${run.seconds}s -> ${file}`);
  if (publish) await syncWebEdits(cfg, d, api).catch((e: Error) => console.error(`${stamp()} DID ${d.id} web edits: ${e.message}`)); // a request from inside syncWebEdits is published by its caller
  await previewRecruits(cfg, d, api, file);
  return true;
}

export interface OdOverhaulOptions { did?: number; setExe?: string; clearExe?: boolean; run?: boolean; force?: boolean; installRcat?: string; restoreRcat?: boolean; archive?: string; preview?: boolean }
// ncaa-bridge od overhaul: set up the tool, install its RCAT file into the game archive, run it by hand, show the memo.
export async function odOverhaul(cfg: BridgeConfig, opts: OdOverhaulOptions): Promise<void> {
  if (opts.setExe) { const dest = installTool(opts.setExe); saveConfigKey('overhaulExe', dest); cfg.overhaulExe = dest; console.log(`recruit overhaul tool installed: ${dest}\n(od watch runs it on every new recruiting class from here on)`); }
  if (opts.clearExe) { saveConfigKey('overhaulExe', undefined); cfg.overhaulExe = undefined; console.log('recruit overhaul switched off'); }
  if (opts.installRcat || opts.restoreRcat) {
    const archive = opts.archive ?? (cfg.rpcs3Root ? join(cfg.rpcs3Root, RCAT_ARCHIVE) : undefined);
    if (!archive) throw new Error('no --archive given and no rpcs3Root in the config');
    if (rpcs3Running()) throw new Error('RPCS3 is running: close the game before touching its archives');
    const backups = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ncaa-bridge', 'backups');
    if (opts.restoreRcat) { restoreRcat(archive, backups); console.log(`entry ${RCAT_ENTRY} of ${archive} restored from the backup`); }
    else { const r = installRcat(archive, new Uint8Array(readFileSync(opts.installRcat!)), backups); console.log(r.changed ? `entry ${RCAT_ENTRY} of ${archive} replaced at offset ${r.offset} (backup in ${backups})` : `entry ${RCAT_ENTRY} of ${archive} already holds this file`); }
  }
  const store = loadOdStore(cfg.odDir); const state = loadState(); const api = new WorkerApi(cfg);
  for (const d of Object.values(store.dynasties).filter((x) => opts.did === undefined || x.id === opts.did)) {
    const fileId = consoleFileId(d); if (!fileId) continue;
    const memo = state[sk(cfg, d)]; const ov = memo?.overhaul;
    if (opts.run) {
      if (!cfg.overhaulExe) throw new Error('no recruit overhaul tool configured (od overhaul --set-exe <RecruitOverhaul.exe>)');
      if (!memo) { console.log(`DID ${d.id}: not imported yet (od import first)`); continue; }
      const blob = readLockerBlob(cfg.odDir, fileId); if (!blob) { console.log(`DID ${d.id}: dynasty file CID ${fileId} is missing from the locker`); continue; }
      const opened = openDynastyFile(blob); const ex = exportDynasty(opened.file);
      if (ex.season.week !== 0 && !opts.force) { console.log(`DID ${d.id}: the dynasty is at ${ex.season.year} week ${ex.season.week}, not the preseason; --force runs the tool anyway (recruits already being recruited get new names and ratings)`); continue; }
      await maybeOverhaul(cfg, d, opened, ex, fileId, state, api, true);
    }
    if (opts.preview && ov && !ov.taken && !ov.stale) await previewRecruits(cfg, d, api, ov.file); // show the pending class on the site again
    console.log(`DID ${d.id} ${odName(d)}: ${!cfg.overhaulExe ? 'tool not configured' : !ov ? 'no class reshaped yet' : `${ov.year} class reshaped ${ov.at} from file ${ov.base} (${ov.renamed} renamed): ${ov.taken ? `taken by the console (file ${ov.taken})` : ov.stale ? 'never taken, left alone' : 'waiting for a console to load the dynasty'}`}`);
  }
}
function rpcs3Running(): boolean {
  if (process.platform !== 'win32') return false;
  try { return /rpcs3\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq rpcs3.exe', '/NH'], { encoding: 'utf8', windowsHide: true })); } catch { return false; }
}

// Edits no change table can carry (a transfer for a player without a TRAN row, depth charts and formation subs, cleared
// redshirts) are written into a copy of the console's dynasty file, web-edits/<did>/DYNASTY.patch.bin with
// DYNASTY.patch.json {base, key, size, changes}; the league server publishes it as the dynasty's file until the
// console uploads its own again (dod.mjs refreshPatch). Rebuilt only when the edits or the console's file change.
function syncDynastyPatch(cfg: BridgeConfig, d: OdDynasty, dir: string, set: DynastyPatchSet, opts: { quiet?: boolean }): boolean {
  const bin = join(dir, 'DYNASTY.patch.bin'), manifest = join(dir, 'DYNASTY.patch.json');
  const base = consoleFileId(d);
  if (patchSetEmpty(set) || !base) {
    if (!existsSync(manifest)) return false;
    unlinkSync(manifest); if (existsSync(bin)) unlinkSync(bin);
    if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: no edit needs the dynasty file any more, DYNASTY.patch removed`);
    return true;
  }
  const key = JSON.stringify([PATCH_FORMAT, base, set]);
  const prev = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) as { key?: string } : null;
  if (prev?.key === key && existsSync(bin)) return false;
  const blob = readLockerBlob(cfg.odDir, base);
  if (!blob) throw new Error(`dynasty file CID ${base} is missing from the locker`);
  const out = patchDynasty(blob, set);
  mkdirSync(dir, { recursive: true });
  // the file first and the manifest last: the server goes by the manifest
  writeFileSync(`${bin}.tmp`, out.blob); renameSync(`${bin}.tmp`, bin);
  writeFileSync(manifest, JSON.stringify({ base, key, size: out.blob.length, changes: out.changes, updatedAt: Math.floor(Date.now() / 1000), requireLoad: !!set.playoff?.requireLoad, holdReason: set.playoff?.requireLoad ? 'Load the dynasty from the hub: the playoff bracket is waiting' : undefined }, null, 2));
  if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: DYNASTY.patch.bin <- file ${base} + ${out.changes.join('; ')} (${out.blob.length} bytes)`);
  return true;
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
  const fileId = consoleFileId(d); // the console's own upload, not a copy carrying site edits (syncDynastyPatch)
  if (!fileId) { console.log(`DID ${d.id} ${name}: no dynasty file uploaded yet, skipped`); return false; }
  const blob = readLockerBlob(dir, fileId);
  if (!blob) { console.log(`DID ${d.id} ${name}: dynasty file CID ${fileId} is missing from the locker, skipped`); return false; }
  const t0 = Date.now();
  const opened = openDynastyFile(blob);
  const ex = exportDynasty(opened.file);
  const overlaid = overlayResults(ex, seasonGames(d));
  const playoffLaid = overlayPlayoff(ex, state[sk(cfg, d)]?.playoff); // the bracket as the site plays it (bridge/src/playoff.ts)
  const photos = attachPhotoKeys(ex, loadPhotoIndex(photoDirsOf(cfg)));
  const logos = attachLogoKeys(ex);
  if (logos.missing.length) console.log(`  no logo for: ${logos.missing.join(', ')}`);
  const members = d.members.map((m) => ({
    blazeId: m.blazeId, persona: m.persona, ncId: m.ncId ?? 0, commissioner: !!m.commissioner, team: m.team ?? 0, teamFileId: m.teamFileId ?? 0,
    coach: ex.coaches.find((c) => c.tgid === m.team && c.userControlled)?.ccid ?? m.coach ?? 0,
  }));
  const api = new WorkerApi(cfg);
  const od = {
    id: d.id, name, abbr: String(d.request?.ABBR ?? ''), description: String(d.request?.DESC ?? ''), state: d.state ?? 0, week: d.week ?? 0, season: d.season ?? 1, year: d.year ?? 0,
    fileId, fileSavedAt: d.fileSavedAt ?? null, createdAt: d.createdAt, settings: d.request, members, games: seasonGames(d),
  };
  // `||`, not `??`: the playoff and lock passes create a state entry with slug '' before the first import, and the
  // Worker refuses an empty slug (DID 10 "efoxOD4" sat invisible for this on 2026-11-05).
  const { dynasty } = await api.json('POST', '/api/bridge/dynasties', { slug: state[sk(cfg, d)]?.slug || odSlug(d), name, od });
  const { startYear, firstYear } = odStartYear(dir, d, ex, state[sk(cfg, d)]);
  const sha256 = createHash('sha256').update(opened.db).digest('hex');
  const { importId } = await api.json('POST', '/api/bridge/import', {
    slug: dynasty.slug, seasonYear: ex.season.year, startYear, week: ex.season.week, stage: ex.season.stage, weekType: ex.season.weekType, sha256, dbSize: opened.file.header.dbSize,
    tableCounts: Object.fromEntries(ex.tables.map((t) => [t.name, t.records])), note: opts.note ?? `online dynasty ${d.id}, file ${fileId}, ${overlaid} uploaded result(s)${playoffLaid ? `, ${playoffLaid} playoff game(s)` : ''}`,
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
  state[sk(cfg, d)] = { ...state[sk(cfg, d)], fingerprint: fp, slug: dynasty.slug, importId, at: new Date().toISOString(), firstYear };
  saveState(state);
  console.log(`${stamp()}   committed in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${cfg.workerUrl}/d/${dynasty.slug}`);
  maybeStrideTaken(cfg, d, opened, fileId, state);
  maybePlayersTaken(cfg, d, ex, state);
  maybeRemovalsTaken(cfg, d, ex, state);
  // the start year first: a console file that took it moves the reshaped class to the new year before the overhaul looks
  await maybeStartYear(cfg, d, ex, fileId, state, api).catch((e: Error) => console.error(`${stamp()} DID ${d.id} start year: ${e.message}`));
  await maybeOverhaul(cfg, d, opened, ex, fileId, state, api).catch((e: Error) => console.error(`${stamp()} DID ${d.id} recruit overhaul: ${e.message}`));
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

// Game lines the site lost: a dynasty file's B* tables hold the season's box-score lines so far, and the console empties
// them in the offseason; until 2026-11-02 every import replaced the season's lines with the file's, so the first
// offseason import wiped the season. Each import stored its dynasty file in R2; walking those snapshots oldest first
// refills every week from the newest file that has it. Only the site's game_logs change.
export async function odBackfillLogs(cfg: BridgeConfig, opts: { did?: number }): Promise<void> {
  const store = loadOdStore(cfg.odDir);
  const api = new WorkerApi(cfg);
  for (const d of Object.values(store.dynasties).filter((x) => opts.did === undefined || x.id === opts.did)) {
    const { snapshots } = await api.json<{ snapshots: { id: number }[] }>('GET', `/api/bridge/snapshots?od=${d.id}`);
    console.log(`DID ${d.id} ${odName(d)}: ${snapshots.length} stored imports`);
    const weeks = new Map<string, { season: number; week: number; snap: number; rows: Record<string, unknown>[] }>();
    for (const s of snapshots) {
      const blob = await api.getBytes(`/api/bridge/snapshots/${s.id}/file/DYNASTY.dynasty`);
      if (!blob) { console.log(`  import #${s.id}: no stored dynasty file`); continue; }
      const ex = exportDynasty(openDynastyFile(blob).file);
      const uids = playerUids(ex); // identities from the same file as the lines
      const byWeek = new Map<number, Record<string, unknown>[]>();
      for (const [kind, list] of Object.entries(ex.gameLogs)) for (const r of list) { const w = Number(r.SEWN); if (Number.isInteger(w)) byWeek.set(w, [...(byWeek.get(w) ?? []), { ...r, kind, uid: uids.get(Number(r.PGID)) ?? null }]); }
      for (const [w, list] of byWeek) weeks.set(`${ex.season.year}:${w}`, { season: ex.season.year, week: w, snap: s.id, rows: list });
      console.log(`  import #${s.id} (${ex.season.year} week ${ex.season.week}): ${[...byWeek.values()].reduce((n, l) => n + l.length, 0)} game lines${byWeek.size ? ` for week ${[...byWeek.keys()].join(', ')}` : ''}`);
    }
    for (const w of [...weeks.values()].sort((a, b) => a.season - b.season || a.week - b.week)) {
      const res = await api.json<{ rows: number }>('POST', '/api/bridge/game-logs', { od: d.id, snapshotId: w.snap, seasonYear: w.season, rows: w.rows });
      console.log(`  ${w.season} week ${w.week}: ${res.rows} lines restored (from import #${w.snap})`);
    }
  }
}

export function odList(cfg: BridgeConfig): void {
  const store = loadOdStore(cfg.odDir);
  const state = loadState();
  for (const d of Object.values(store.dynasties)) {
    const results = Object.values(seasonGames(d)).reduce((n, l) => n + l.length, 0);
    const site = state[sk(cfg, d)] ? `/d/${state[sk(cfg, d)]!.slug} (synced ${state[sk(cfg, d)]!.at})` : 'never synced';
    console.log(`DID ${d.id}  ${odName(d).padEnd(20)} week ${d.week ?? 0}  year ${d.year ?? 0}  state ${d.state ?? 0}  file ${consoleFileId(d)}${d.patch ? ` (consoles get ${d.fileId}: site edits)` : ''}  results ${results}  members ${d.members.map((m) => `${m.persona}:${m.team ?? 0}`).join(', ')}  ${site}`);
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
      refreshConfig(cfg); // od overhaul --set-exe / od year --default while the watcher runs
      const store = loadOdStore(cfg.odDir);
      const state = loadState();
      tick++;
      for (const d of Object.values(store.dynasties)) {
        if (opts.did !== undefined && d.id !== opts.did) continue;
        if (!d.fileId) continue;
        if (tick % 3 === 1) await syncWebEdits(cfg, d, api).catch((e: Error) => console.error(`${stamp()} DID ${d.id} web edits: ${e.message}`));
        if (tick % 6 === 2) await syncCaptures(cfg, d, api).catch((e: Error) => console.error(`${stamp()} DID ${d.id} captures: ${e.message}`));
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
