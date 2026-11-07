// DynastyOnDemand (component 2148) stub for the NCAA 14 spike.
// Shapes come from the TDF member tables recovered from the game binary (spike/blaze/private/tdf-dod.txt):
// every response below is written with its members in tag order, as the client's decoder expects.
// Command ids come from the client's getCommandName switch; request/response pairing from the client API functions.
//
// What the console does (runs 11-12): createDynasty -> (team pick) -> GetDynastyStatus -> Locker upload of the .team file
// (EndDynastyUpdate UPDT 1 with FID = that file's locker id) -> StartDynastyUpdate UPDT 1 + sendTableUpdate for the user's
// team rows -> EndDynastyUpdate -> ReportConsoleRecruitingState. "Save online dynasty" uploads DYNASTY.dynasty (the whole
// EA DB, zlib) then StartDynastyUpdate UPDT 0 + sendTableUpdate for ~70 tables (PACK = chunk index) -> EndDynastyUpdate
// {FID = dynasty file id} -> optimizeProspectInfo. The client then compares DynastyStatus.DFID with the file id it just
// reported; a mismatch shows "The commissioner has made changes to the Dynasty that require you to restart."
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { T } from './tdf.mjs';
import { log } from './log.mjs';
import { noteConsoleOverride } from './supersim.mjs';
import { GAME_FILTER, LAYOUTS as GAME_LAYOUTS, loadGameData, saveGameData, gameTableRows } from './gamedata.mjs';
import { latestContent, publishContent, setDownloadHook, readContentBlob, replaceContentBlob } from './locker.mjs';
import { completeTeamPackage } from './team-package.mjs';
import { isPublicDynasty, canSeeInSearch, matchesDynastyQuery, mayJoinDynasty } from './league-auth.mjs';

export const DOD = 2148;
export const DOD_COMMANDS = {
  1: 'poke', 2: 'createDynasty', 3: 'deleteDynasty', 4: 'getMemberByBlazeId', 5: 'getDynasty', 6: 'joinDynasty', 8: 'sendInvitation',
  9: 'getInvitations', 10: 'processInvitation', 11: 'getMembers', 12: 'sendTableUpdate', 13: 'getContinueDynastyInfoForUser', 14: 'removeMember',
  16: 'addProspectToBoard', 17: 'removeProspectFromBoard', 18: 'moveProspectToRank', 19: 'getAllProspects', 20: 'SetActiveDynasty',
  21: 'GetActiveDynastyInfo', 22: 'FindDynasties', 23: 'GetTableUpdate', 24: 'UploadGameResults', 25: 'RetrieveGameResults', 26: 'GetDynastyUserInfo',
  27: 'SetOfflinePassword', 28: 'SetReadyToAdvance', 29: 'SetAutopilot', 32: 'BreakLock', 39: 'ScheduleRecruitVisitConsole', 40: 'ScheduleRecruitVisit',
  41: 'OfferScholarship', 42: 'HangUp', 43: 'IncrementGamesStarted', 44: 'DeleteGameResult', 45: 'changeUserTeam', 46: 'UploadTransientSettings',
  47: 'DownloadTransientSettings', 48: 'GetTeamStandings', 49: 'GetTeamRoster', 50: 'GetTeamInjuries', 51: 'GetAllTeams', 52: 'GetSchedule',
  53: 'GetCategoryStats', 54: 'GetPlayerStats', 55: 'GetPollRankings', 56: 'StartDynastyUpdate', 57: 'EndDynastyUpdate', 58: 'GetDynastyStatus',
  59: 'GetProspectTopSchools', 61: 'GetProspectRatings', 62: 'GetTeamNeeds', 63: 'GetTeamStatLeaders', 64: 'DownloadViewDetailsData',
  67: 'SetMaxOwnedDynasties', 68: 'TransferCommishStatus', 69: 'GetDynastyNotifications', 70: 'GetDynastyHubNotifications',
  71: 'GetExtraDynastySettings', 72: 'SetExtraDynastySettings', 73: 'SetAlertSmsNumber', 74: 'SetAlertEmailAddress', 75: 'SetAlertSettings',
  76: 'GetAlertSettings', 77: 'GetAlertContactInfo', 78: 'SendPeerMessage', 79: 'SendDynastyMessage', 80: 'optimizeProspectInfo',
  81: 'SetDynastyVisibility', 83: 'CheckAdvanceWeekStatus', 84: 'ReportConsoleRecruitingState', 85: 'UnsubscribeEmailAddress',
  86: 'SetDynastyHideStatus', 87: 'SetDynastyCensorStatus', 88: 'RequestAdvanceWeek', 89: 'CancelAdvanceWeek', 90: 'SetReadyToUploadAdvanceWeekData',
  91: 'MakeContractPick', 92: 'GetProspectCsvReport', 93: 'GetSyncTables', 100: 'CheckDynastyPassword', 103: 'SetAdvanceWeekQueueClientStatus',
  107: 'GetDynastyLockerFileMetaData', 108: 'GetHeismanWatchList', 109: 'GetAwardData', 111: 'GetHeismanWinners', 112: 'TogglePlayerRedshirt',
  113: 'GetPlayersOfWeek', 115: 'getPotentialTransfers', 116: 'setTransferAdmittance', 117: 'getValidPromisesForPlayer', 118: 'getRecruitingClass',
  119: 'getPlayerPositionOveralls', 120: 'getCoachChanges', 121: 'getTopClasses', 122: 'getAllAmericans', 123: 'getOffseasonRoster',
  124: 'changePlayerPosition', 125: 'getPipelineStates', 126: 'getPlayerRatingDiff', 127: 'checkCutPlayer', 128: 'cutPlayer', 129: 'getPlayersLeaving',
  130: 'MakePlayerPromise', 131: 'GetCoachCarousel', 132: 'MakeContractDecision', 134: 'VerifyProspectScout',
};

// ---- persistent dynasty store (private/dynasties.json, gitignored) ----
const PRIVATE = process.env.NCAA_PRIVATE
  ? path.resolve(process.env.NCAA_PRIVATE)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'private');
const STORE_FILE = path.join(PRIVATE, 'dynasties.json');
const load = () => { try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch { return { nextId: 1, dynasties: {} }; } };
const store = load();
const save = () => { try { fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2)); } catch { /* best effort */ } };
log('dod', `dynasty store ${STORE_FILE} (${Object.keys(store.dynasties).length} dynasties)`);

// Uploaded results (d.games) and game data (d.gameData) are keyed by week, so they hold one season: d.gamesYear. When
// the dynasty's year moves on they go to d.seasons[<year>]. Before this (2026-11-02), last season's week-1 final
// (Brown at Furman 49-14) came back through RetrieveGameResults as this season's week-1 result, the same matchup, and
// last season's game data would have been offered for this season's weeks 7, 9, 10, 11 and 17.
function rollSeason(d) {
  const year = d.year ?? 0, held = d.gamesYear ?? 0;
  if (year === held) return false;
  if (Object.keys(d.games ?? {}).length || Object.keys(d.gameData ?? {}).length) (d.seasons ??= {})[held] = { games: d.games ?? {}, gameData: d.gameData ?? {} };
  d.games = {}; d.gameData = {}; d.gamesYear = year;
  log('dod', `DID ${d.id}: year ${held} results and game data archived; the dynasty is in year ${year}`);
  return true;
}
if (Object.values(store.dynasties).map(rollSeason).some(Boolean)) save();

const now = () => Math.floor(Date.now() / 1000);
// NCID = the small online user id the real service assigns per user (DynastyUser.NCID, GetContinueDynastyInfoResponse.NCID,
// DynastyStatus.B2N values); the console writes it into its team row (TEAM.NCID) and the resume check maps it back to the
// user. Issued from 1 on first contact and kept in the store; 0 proved to be rejected (run 20).
const ncidOf = (blazeId) => { if (!blazeId) return 0; store.users ??= {}; store.nextNcid ??= 1; if (!store.users[blazeId]) { store.users[blazeId] = { ncId: store.nextNcid++ }; save(); } return store.users[blazeId].ncId; };
const str = (v, dflt = '') => (v === undefined || v === null ? dflt : String(v));
const num = (v, dflt = 0) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : dflt);
const items = (v) => (v && Array.isArray(v.items) ? v.items : []);

// ---- table store: private/dynasty-tables/<did>/<TABLE>.json ----
// sendTableUpdate carries EA DB rows: TABL and the column lists (SINT, TINT, INTC, STRC, BINC) hold 4-char names packed
// byte-reversed into an int32 ("TGID" -> 0x44494754); each DodRowUpdate has the values in the same order
// (SINT/TINT ints, INTV for INTC, STRV for STRC, BINY hex blobs for BINC). PACK numbers the chunks of one table.
export const name4 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE((Number(n) >>> 0)); return b.toString('latin1').split('').reverse().join('').replace(/[^\x20-\x7e]/g, '?'); };
const TABLE_DIR = path.join(PRIVATE, 'dynasty-tables');
const tableFile = (did, name) => path.join(TABLE_DIR, String(did), `${name}.json`);
const loadTable = (did, name) => { try { return JSON.parse(fs.readFileSync(tableFile(did, name), 'utf8')); } catch { return null; } };
const saveTable = (did, t) => { fs.mkdirSync(path.dirname(tableFile(did, t.table)), { recursive: true }); fs.writeFileSync(tableFile(did, t.table), JSON.stringify(t)); };
const COLUMN_LISTS = [['SINT', 'SINT'], ['TINT', 'TINT'], ['INTC', 'INTV'], ['STRC', 'STRV'], ['BINC', 'BINY']];
// ---- web edits: private/web-edits/<did>/<TABLE>.json ({table, columns{SINT,TINT,INTC,STRC,BINC}, rows, meta}) written by
// the site/bridge; served back to the console through GetTableUpdate (the advance pulls the per-user Z tables filtered by
// its TGID/CCID). Column names are packed like the console packs them (pack4 is the inverse of name4).
const WEB_DIR = path.join(PRIVATE, 'web-edits');
// The console's advance is refused (CheckAdvanceWeekStatus ALLW 0 with the reason as THTM/UTM) while the bridge holds
// it: web-edits/<did>/ADVANCE.hold.json {reason} (the FCS playoff being played on the site), or a published dynasty-file
// copy flagged requireLoad in DYNASTY.patch.json that the console has not downloaded yet (the finished bracket).
// consoleLoadedCid = the dynasty file the console last downloaded (locker download hook).
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
export function advanceHold(d) {
  const dir = path.join(WEB_DIR, String(d.id));
  const hold = readJson(path.join(dir, 'ADVANCE.hold.json'));
  if (hold?.reason) return String(hold.reason);
  const m = readJson(path.join(dir, 'DYNASTY.patch.json'));
  const base = d.consoleFileId ?? d.fileId ?? 0;
  if (m?.requireLoad && m.base === base && (!d.patch || d.consoleLoadedCid !== d.patch.cid)) return String(m.holdReason || 'Load the dynasty from the hub first: a league update is waiting');
  return null;
}
setDownloadHook((c) => {
  if (c.name !== 'DYNASTY.dynasty' || !c.group?.id) return;
  const d = store.dynasties[String(c.group.id)]; if (!d || d.consoleLoadedCid === c.cid) return;
  d.consoleLoadedCid = c.cid; save();
  log('dod', `DID ${d.id}: a console downloaded dynasty file ${c.cid}${d.patch?.cid === c.cid ? ' (the copy with site edits)' : ''}`);
});
const loadWebEdits = (did, table) => { try { return JSON.parse(fs.readFileSync(path.join(WEB_DIR, String(did), `${table}.json`), 'utf8')); } catch { return null; } };
// Site edits the change tables cannot carry (a transfer for a player with no TRAN row: TRAZ only merges into existing
// rows) come as a copy of the console's dynasty file with them written in: DYNASTY.patch.bin + DYNASTY.patch.json
// {base, key, size, changes}, built by the bridge (bridge/src/dynasty-patch.ts). When it was built from the console's
// current upload it is published as a new locker file and DFID names it; the console finds a file id it does not have
// and downloads it at its next load, as it would a commissioner's change. The console's next upload (EndDynastyUpdate
// UPDT 0) supersedes it, and with the patch gone DFID goes back to the console's own file. Decided only when a console
// loads (getDynasty, GetDynastyStatus for its team) and never during an advance, so DFID holds still within a session.
function refreshPatch(d) {
  if (d.advancing) return;
  const base = d.consoleFileId ?? d.fileId ?? 0;
  const dir = path.join(WEB_DIR, String(d.id));
  let m = null; try { m = JSON.parse(fs.readFileSync(path.join(dir, 'DYNASTY.patch.json'), 'utf8')); } catch { /* none */ }
  const bin = path.join(dir, 'DYNASTY.patch.bin');
  // A console inside the dynasty restarts it from the server's file whenever DFID changes (the restart check), and
  // everything it did since its last upload (recruiting points, depth charts) is gone with it. So a copy already
  // published for this base is replaced only when the console comes back in through the hub (getContinueDynastyInfo
  // after its last load); a copy nothing needs any more is kept until the console uploads a new base, since it holds
  // what the console already has. A new base (the console's own upload) publishes at once: the console just sent it.
  const fresh = (d.hubAt ?? 0) >= (d.loadedAt ?? 0);
  if (!m || !base || m.base !== base || !fs.existsSync(bin)) {
    if (d.patch && d.patch.base === base && !m) return; // nothing pending, but the console may be on this copy
    if (d.patch) {
      log('dod', `DID ${d.id}: dynasty file ${d.patch.cid} (site edits) withdrawn${m ? ` (built from file ${m.base}, the console's is ${base})` : ''}; DFID back to ${base}`);
      d.fileId = base; d.patch = null; save();
    }
    return;
  }
  if (d.patch?.key === m.key && d.fileId === d.patch.cid) return;
  if (d.patch && d.patch.base === base && !fresh) { if (!d.patchHeld) { d.patchHeld = true; log('dod', `DID ${d.id}: newer site edits for file ${base} wait for the console's next load (it is inside the dynasty on file ${d.patch.cid})`); } return; }
  d.patchHeld = false;
  const c = publishContent(base, fs.readFileSync(bin));
  if (!c) { log('dod', `DID ${d.id}: dynasty file ${base} is not in the locker; site edits not published`); return; }
  d.consoleFileId = base; d.fileId = c.cid; d.patch = { cid: c.cid, base, key: m.key, at: now() }; save();
  log('dod', `DID ${d.id}: dynasty file ${c.cid} published = file ${base} + site edits: ${(m.changes ?? []).join('; ')}`);
}
export const pack4 = (name) => Buffer.from(String(name).padEnd(4).slice(0, 4).split('').reverse().join(''), 'latin1').readUInt32BE(0);
// DodTableUpdate with rows (tags in order): BINC DYID FILT FLTY GHID INTC PACK ROWS RTID SINT STRC TABL TINT TYPE; each row
// struct carries only its non-empty lists (BINY, INTV, SINT, STRV, TINT), as the console itself sends them.
function tableUpdate(w, did, body, edits, rows, { ghid = 0, rtid = 0 } = {}) {
  const cols = edits?.columns ?? {};
  const L = { SINT: cols.SINT ?? [], TINT: cols.TINT ?? [], INTC: cols.INTC ?? [], STRC: cols.STRC ?? [], BINC: cols.BINC ?? [] };
  w.intList('BINC', L.BINC.map(pack4)); w.int('DYID', did);
  w.struct('FILT', (x) => { x.int('COLM', num(body.FILT?.COLM)); x.int('VALU', num(body.FILT?.VALU)); });
  w.int('FLTY', num(edits?.meta?.flty)); w.int('GHID', ghid); w.intList('INTC', L.INTC.map(pack4)); w.int('PACK', 0);
  w.list('ROWS', T.STRUCT, rows, (x, r) => {
    if (L.BINC.length) x.list('BINY', T.BLOB, L.BINC.map((c) => Buffer.from(str(r[c]), 'hex')), (y, b) => { y.varint(b.length); y.raw(b); });
    if (L.INTC.length) x.intList('INTV', L.INTC.map((c) => num(r[c])));
    if (L.SINT.length) x.intList('SINT', L.SINT.map((c) => num(r[c])));
    if (L.STRC.length) x.list('STRV', T.STRING, L.STRC.map((c) => str(r[c])), (y, v) => y.string(v));
    if (L.TINT.length) x.intList('TINT', L.TINT.map((c) => num(r[c])));
    x.push(0);
  });
  w.int('RTID', rtid); w.intList('SINT', L.SINT.map(pack4)); w.intList('STRC', L.STRC.map(pack4)); w.int('TABL', num(body.TABL)); w.intList('TINT', L.TINT.map(pack4)); w.int('TYPE', num(edits?.meta?.type));
}
const teamCache = new Map(); // did -> TEAM rows (refreshed when the console pushes TEAM again)
const teamRow = (did, tgid) => { if (!teamCache.has(did)) teamCache.set(did, loadTable(did, 'TEAM')?.rows ?? []); return teamCache.get(did).find((r) => r.TGID === tgid) ?? null; };
// user-controlled head coach of a team: COCH row with CFUC 1 (the console filters its own push on CCID = that coach)
const coachCache = new Map();
const coachId = (did, tgid, dflt = 0) => { if (!coachCache.has(did)) coachCache.set(did, loadTable(did, 'COCH')?.rows ?? []); const r = coachCache.get(did).find((x) => x.TGID === tgid && x.CFUC === 1) ?? coachCache.get(did).find((x) => x.TGID === tgid); return r ? num(r.CCID, dflt) : dflt; };
// SCHD row of a team in a week (opponent lookup for the hub card)
const scheduleCache = new Map();
const scheduleRow = (did, week, tgid) => { if (!scheduleCache.has(did)) scheduleCache.set(did, loadTable(did, 'SCHD')?.rows ?? []); return scheduleCache.get(did).find((r) => r.SEWN === week && (r.GHTG === tgid || r.GATG === tgid)) ?? null; };
const memberCoach = (d, m) => (m.coach ? m.coach : (m.team && m.team !== 1023 ? coachId(d.id, m.team, 0) : 0));
// Game data of console-played games. After a game the console uploads its 14 game tables (StartDynastyUpdate UPDT 2 ->
// sendTableUpdate x14 -> UploadGameResults -> EndDynastyUpdate UPDT 2). They are kept per game like a Supersim final
// (gamedata.mjs) and listed in DynastyStatus.GAME for the member's team. A console that reloads the dynasty before the
// advance (game or server restart) rebuilds it from the last dynasty file + the team file, so without them the game was
// unplayed again and the advance simulated it (2026-10-31: weeks 1, 4, 12 and 14 re-simmed; weeks 2 and 5, advanced
// without a reload, kept). The load only fetches game data for a game that is still unplayed, so nothing is applied twice.
const pendingGames = new Map(); // did -> { tables, columns, ghid, rtid, result } while an UPDT-2 upload is in progress
function registerConsoleGame(d, body, user) {
  const pg = pendingGames.get(d.id); pendingGames.delete(d.id);
  const ginf = pg?.tables.GINF?.[0];
  if (!ginf) return log('dod', `DID ${d.id}: game upload without GINF, no game data kept`);
  const team = num(body.TMID) || pg.rtid || num(pg.result?.TMID);
  const member = d.members.find(m => m.blazeId === user.blazeId);
  if (d.update?.byUser && (!member || member.team !== team || ![num(ginf.GATG),num(ginf.GHTG)].includes(team)))
    return log('dod', `DID ${d.id}: rejected game data with mismatched member/team`);
  const week = pg.result ? num(pg.result.GMWK) : num(body.NWWK, d.week ?? 0);
  const id = d.nextGameDataId ?? 900001; d.nextGameDataId = id + 1;
  saveGameData(d.id, id, { source: 'console', by: user.blazeId, ghid: pg.ghid, week, team, sgnm: num(ginf.SGNM), createdAt: now(), columns: pg.columns, tables: pg.tables });
  const wk = String(week);
  (d.gameData ??= {})[wk] = [...(d.gameData[wk] ?? []).filter((x) => x.team !== team), { team, id, source: 'console' }];
  log('dod', `DID ${d.id}: console game week ${week} ${ginf.GATG}@${ginf.GHTG} ${ginf.GASC}-${ginf.GHSC} (GQTR ${ginf.GQTR}) kept as game data ${id} for team ${team}`);
}
// A member's uploaded .team package rebuilt with every row of its roster (team-package.mjs): the console's PLAY table
// in it holds 70 rows and wraps when the team is larger, and the advance reconciles the dynasty to what it downloads
// back. The roster push that preceded EndDynastyUpdate names the rows to keep (fallback: the team's rows in the dynasty
// file the console is on, which can only be wrong after an offseason cut).
function fixTeamPackage(d, team, cid) {
  try {
    const pkg = readContentBlob(cid); if (!pkg) return;
    const onCid = d.patch && d.consoleLoadedCid === d.patch.cid ? d.patch.cid : (d.consoleFileId ?? d.fileId ?? 0);
    const dyn = onCid ? readContentBlob(onCid) : null; if (!dyn) { log('dod', `DID ${d.id}: team package ${cid} not checked (no dynasty file ${onCid})`); return; }
    const push = d.rosterPush?.[team]; const ids = push?.pgids ?? null;
    const r = completeTeamPackage(pkg, dyn, team, ids);
    if (!r) return;
    replaceContentBlob(cid, r.blob);
    log('dod', `DID ${d.id}: team package ${cid} (team ${team}) completed from dynasty file ${onCid}${ids ? ` and the ${ids.length}-row roster push` : ' (no roster push: every row of the team)'}: PLAY ${r.before} -> ${r.after} of ${r.max}${r.missing.length ? `, ${r.missing.length} did not fit: ${r.missing.join(' ')}` : ''}`);
  } catch (e) { log('dod', `DID ${d.id}: team package ${cid} fix failed: ${e.stack ?? e.message}`); }
}
function applyTableUpdate(d, body, memberScope = null) {
  const table = name4(body.TABL);
  const upd = d.update ?? { updt: 0, touched: [] };
  // Authenticated non-commissioner uploads must never replace shared league tables.
  // Their canonical .team file is still published normally; retain their table snapshot separately.
  const scopedFile = memberScope ? path.join(PRIVATE,'dynasty-member-tables',String(d.id),String(memberScope),`${table}.json`) : null;
  let previous = null;
  if (scopedFile) { try { previous = JSON.parse(fs.readFileSync(scopedFile,'utf8')); } catch { /* first snapshot */ } }
  const t = (scopedFile ? previous : loadTable(d.id, table)) ?? { table, columns: {}, rows: [], meta: {} };
  const filtCol = body.FILT && body.FILT.COLM ? name4(body.FILT.COLM) : null;
  if (!upd.touched.includes(table)) { // first chunk of this table in this update session: replace (full) or drop the filtered rows (partial)
    if (upd.updt === 2) { const ghid = num(body.GHID); t.rows = t.rows.filter((r) => !(ghid && r.GHID === ghid) && !(filtCol && r[filtCol] === num(body.FILT.VALU) && r.GHID === ghid)); } // game stats: one game's rows (GHID) replace the same game's earlier rows
    else if (upd.updt === 0 || !filtCol) t.rows = [];
    else t.rows = t.rows.filter((r) => r[filtCol] !== num(body.FILT.VALU));
    upd.touched.push(table);
  }
  for (const [listTag] of COLUMN_LISTS) if (body[listTag]) t.columns[listTag] = items(body[listTag]).map(name4);
  t.meta = { type: num(body.TYPE), flty: num(body.FLTY), rtid: num(body.RTID), ghid: num(body.GHID), filter: filtCol ? { column: filtCol, value: num(body.FILT.VALU) } : null, updatedAt: now() };
  const game = upd.updt === 2 ? pendingGames.get(d.id) : null; // console game upload: keep this game's rows as sent
  if (game) {
    game.ghid ||= num(body.GHID); game.rtid ||= num(body.RTID); game.tables[table] ??= [];
    game.columns[table] ??= Object.fromEntries(COLUMN_LISTS.filter(([tag]) => body[tag]).map(([tag]) => [tag, items(body[tag]).map(name4)]));
  }
  let added = 0;
  const pushed = [];
  for (const r of items(body.ROWS)) {
    const row = {};
    for (const [listTag, valueTag] of COLUMN_LISTS) {
      const cols = t.columns[listTag] ?? [], vals = items(r[valueTag]);
      vals.forEach((v, i) => { row[cols[i] ?? `${listTag}${i}`] = typeof v === 'bigint' ? Number(v) : v; });
    }
    t.rows.push(row); if (game) game.tables[table].push({ ...row }); added++; pushed.push(row);
  }
  // the user's team rows (UPDT 1) name every PLAY row the console still has: kept in memory for the team package fix
  if (table === 'PLYZ' && upd.updt === 1) {
    const byTeam = d.rosterPush ?? (d.rosterPush = {});
    const at = upd.startedAt ?? now();
    for (const row of pushed) { const tg = num(row.TGID); if (!tg) continue; const e = byTeam[tg] && byTeam[tg].at === at ? byTeam[tg] : (byTeam[tg] = { at, pgids: [] }); e.pgids.push(num(row.PGID)); }
  }
  if (scopedFile) { fs.mkdirSync(path.dirname(scopedFile),{recursive:true}); fs.writeFileSync(scopedFile,JSON.stringify(t)); }
  else saveTable(d.id, t);
  if (table === 'TEAM') teamCache.delete(d.id);
  if (table === 'COCH' || table === 'COCZ') coachCache.delete(d.id);
  if (table === 'SCHD') scheduleCache.delete(d.id);
  if (!scopedFile) (d.tables ??= {})[table] = { rows: t.rows.length, updatedAt: t.meta.updatedAt };
  d.update = upd;
  return { table, added, total: t.rows.length, pack: num(body.PACK), filter: t.meta.filter };
}

// Blaze::DynastyOnDemand::DynastyUser {BZID, NCID, NUCL, PERS, PRID, TMOT map}
function dynastyUser(w, u) {
  w.int('BZID', u.blazeId); w.int('NCID', u.ncId ?? 0); w.int('NUCL', u.nucleusId ?? u.blazeId); w.str('PERS', u.persona);
  w.int('PRID', u.personaId ?? u.blazeId); w.intMap('TMOT', []);
}
// Blaze::DynastyOnDemand::MemberStats (31 small ints)
function memberStats(w) {
  for (const tag of ['CLOS', 'CPA', 'CPF', 'CRNK', 'CTIE', 'CWIN', 'DLOS', 'DPA', 'DPF', 'DRNK', 'DTIE', 'DWIN', 'HLOS', 'HTIE', 'HWIN', 'LOSS', 'NLOS', 'NTIE', 'NWIN', 'PA', 'PF', 'PNTS', 'POST', 'RANK', 'RLOS', 'RTIE', 'RWIN', 'STK', 'STKT', 'TIES', 'WINS']) w.int(tag, 0);
}
// Blaze::DynastyOnDemand::MemberInfo
function memberInfo(w, d, m) {
  const tr = m.team && m.team !== 1023 ? teamRow(d.id, m.team) : null;
  w.int('BZID', m.blazeId); w.int('COCH', memberCoach(d, m)); w.int('CONF', num(tr?.CGID, m.conf ?? 0)); w.int('DID', d.id); w.int('DIV', m.div ?? 0); w.int('ICPU', 0);
  w.int('ISCM', m.commissioner ? 1 : 0); w.int('ISON', 1); w.str('PERS', m.persona); w.struct('STAT', memberStats); w.int('STUS', 0); w.int('TEAM', m.team ?? 0); w.str('TMNM', m.teamName ?? str(tr?.TDNA));
}
// Blaze::DynastyOnDemand::Dynasty (39 members, tag order). C2B = map<coach id, persona> and T2B = map<team id, persona>
// (string values): the client's converter at 0x2f4278 walks C2B, finds the T2B entry whose persona string matches, and
// inserts one DYUS row {persona, coach, team} per member; its member check then compares DYUS with the status pairs.
const personaMap = (tag, w, entries) => w.map(tag, T.INT, T.STRING, entries, (x, k) => x.varint(k), (x, v) => x.string(v));
// The shared dynasty file names the commissioner's coach and team (DEID). A joiner fails the restart check
// against that file, so their copy lives on member.dynastyFileId and is the only FID/DFID they are shown.
const memberFileId = (d, viewerId) => {
  const own = viewerId == null ? 0 : d?.members.find((m) => m.blazeId === viewerId)?.dynastyFileId;
  return own || d?.fileId || 0;
};
// Check 3 (0x33d084) counts DYUS rows built from the persona maps and compares that count, then each row's team,
// with the status T2B pairs (count at versionMgr+0x198). Those maps have to list every placed member or the
// member list drops anyone left out. The team-file list is separate: a joiner is only handed their own file.
const placedMembers = (d) => (d?.members ?? []).filter((m) => m.team && m.team !== 1023);
const shownMembers = (d, viewer) => {
  const placed = placedMembers(d);
  if (viewer && !viewer.commissioner) return placed.filter((m) => m.blazeId === viewer.blazeId);
  return placed;
};
function dynasty(w, d, viewerId) {
  const r = d.request;
  // The load's first getDynasty is what the restart check counts. A joiner's open team file is the current
  // database then, and that file only has their team, so the check can resolve only that one row. Later
  // replies list every placed member, which is what the in-game member list shows.
  const roster = placedMembers(d);
  const placed = d.limitRoster ? roster.filter((m) => m.blazeId === viewerId) : roster;
  const pub = isPublicDynasty(d);
  const storedPass = str(r.PASS);
  const showPass = viewerId === undefined || d.members.some((m) => m.blazeId === viewerId);
  const viewer = viewerId == null ? null : d.members.find((m) => m.blazeId === viewerId) ?? null;
  w.str('ABBR', str(r.ABBR)); w.int('ACTV', 1); personaMap('C2B', w, placed.map((m) => [memberCoach(d, m), m.persona])); w.int('CENS', 0); w.int('CHMP', 0); w.int('CHUM', 0);
  w.struct('CMSH', (x) => dynastyUser(x, d.members[0])); w.int('CRTM', d.createdAt); w.str('DESC', str(r.DESC)); w.int('DID', d.id); w.int('DNF', num(r.DNF)); w.int('DSKL', num(r.DSKL));
  w.int('FATG', num(r.FATG)); w.int('FID', memberFileId(d, viewerId)); w.int('HFAE', num(r.HFAE)); w.int('HIDN', pub ? 0 : 1); w.int('ICTK', num(r.ICTK)); w.int('INJU', num(r.INJU)); w.int('JOIN', pub ? 1 : 0);
  w.int('MEM', viewer && !viewer.commissioner ? placed.length : d.members.length); w.int('MHUM', num(r.MHUM, 12)); w.str('NAME', str(r.NAME)); w.int('ONLN', 1); w.int('OSKL', num(r.OSKL)); w.str('PASS', showPass ? storedPass : ''); w.int('PDLC', num(r.PDLC));
  w.int('PLCL', num(r.PLCL)); w.int('QTQB', num(r.QTQB)); w.int('QTR', num(r.QTR, 5)); w.int('RSTR', 0); w.int('SEAS', d.season ?? 1); w.str('SINF', ''); w.int('STTE', d.state ?? 0); // server-side state = what the last completed update reported (NWST); echoing the console's own mid-advance STAT back (run 31) loops the restart check
  personaMap('T2B', w, placed.map((m) => [m.team, m.persona])); w.int('USKL', num(r.USKL)); w.int('VERS', 0); w.int('VIS', pub ? 1 : 0); w.int('WEEK', d.week ?? 0); w.int('WTHR', num(r.WTHR));
}
const teamRecord = (tr) => (w) => { w.int('LOSS', num(tr?.TSLO)); w.int('WINS', num(tr?.TSWI)); }; // TEAM.TSWI/TSLO as of the last push
// Blaze::DynastyOnDemand::ContinueDynastyInfo: one hub card per dynasty the user belongs to
function continueDynastyInfo(w, d, m) {
  const tr = m.team && m.team !== 1023 ? teamRow(d.id, m.team) : null; // TEAM row: TDNA name, TLGL logo, CGID conference
  // GAMR = the member's result for the current week (UploadGameResults), user score vs opponent score. All zeros left the
  // hub's "Play Game" checklist item unchecked after a played game (run 38).
  const g = tr ? (d.games?.[String(d.week ?? 0)] ?? []).find((x) => x.HTID === m.team || x.ATID === m.team) : null;
  const home = g ? g.HTID === m.team : false;
  const sr = tr ? scheduleRow(d.id, d.week ?? 0, m.team) : null; // this week's opponent from the pushed schedule
  const or = sr ? teamRow(d.id, sr.GHTG === m.team ? sr.GATG : sr.GHTG) : null;
  w.int('AWST', 0); w.int('CDIF', 0); w.int('COLR', 0); w.int('CONF', num(tr?.CGID, m.conf ?? 0));
  w.struct('DYNA', (x) => dynasty(x, d, m.blazeId));
  w.struct('GAMR', (x) => { x.int('GPLD', g ? 1 : 0); x.int('OSCR', g ? num(home ? g.ATSC : g.HTSC) : 0); x.int('OVTF', g ? num(g.OTFL) : 0); x.int('USCR', g ? num(home ? g.HTSC : g.ATSC) : 0); });
  w.int('HMST', 0); w.int('LOGO', num(tr?.TLGL, 0));
  w.struct('MUSR', (x) => memberInfo(x, d, m));
  w.int('NMSG', 0); w.int('NRDY', 0); w.str('ONME', str(or?.TDNA)); w.int('OPON', 0);
  w.struct('OPPO', (x) => dynastyUser(x, { blazeId: 0, persona: '' }));
  // SEAS counts the dynasty's seasons from the year it started in (startYear: the year offset of its first advance; a
  // dynasty the bridge started in 2025 reports NWYR 12 from the beginning)
  w.struct('OREC', teamRecord(or)); w.int('OTRK', 0); w.int('RSTA', 0); w.str('SEAS', `Year ${(d.year ?? 0) - (d.startYear ?? 0) + 1}`); w.int('TCAV', 0); w.int('UIHT', 0);
  w.struct('UREC', teamRecord(tr)); w.int('UTRK', 0);
}
// Blaze::DynastyOnDemand::DynastyStatus {B2N map, CFID, DFID, GAME list<DynastyFileInfo{DFID, TMID}>, T2B map, TEAM list<DynastyFileInfo{DFID, TMID}>}
// The response handler at 0x2f6bc8 copies DFID then CFID into the version manager, the TEAM and GAME lists, and the T2B
// map as {team u16, blazeId u64} pairs read from pairs of {u64 key, u16 value}: T2B is keyed by BLAZE ID with the team as
// value (C2B/T2B in Dynasty likewise). The restart check (event 0x19 at 0x33d1c4) compares DFID with the dynasty file the
// client loaded or uploaded, then looks the caller's blaze id up in those pairs and compares the team with DEID.TGID in
// the loaded file (run 15 still looped because the pairs were sent team-first). B2N is iterated as {u64, u32} pairs
// (blaze id -> NCID, presumably); left empty for now.
// The coaching carousel's shared state: the newest .contract package a console uploaded since the dynasty's last advance
// (an older one belongs to a finished carousel). See the CFID note in dynastyStatus and case 91.
const contractFile = (d) => latestContent({ group: d.id, suffix: '.contract', since: d.fileSavedAt ?? 0, owners: d.members.map((m) => m.blazeId) });

function dynastyStatus(w, d, me, allTeams, cfid) {
  // TEAM = DynastyFileInfo per team. The load (request TMID = the caller's team) needs the team file id there: with 0 the
  // client skips the team-data download and the table sync and then fails its restart check (runs 26-27). The advance
  // step asks with TMID 1023 and treats every listed file as a server-built change package (DB with an ODCN table,
  // 0x43fe68), so a team file there crashes it (runs 24-25). Hence: specific team -> team files, 1023 -> no packages.
  // At load the client opens the TEAM[].DFID file as database ODTM (team file: fine). During an advance ('Checking for
  // team data' in step 1) it opens the same slot as database ODCN, a server-built package we do not have, and a team file
  // there crashes it (0x43fe68). The requests are identical, so the stub answers with an empty TEAM while an advance is in
  // progress (RequestAdvanceWeek seen, cleared by the next getDynasty/EndDynastyUpdate) and with the team files otherwise.
  // Run 35: with TEAM empty during the advance the console uploaded no refreshed team file, and the next resume merged
  // the stale preseason team file into the week-1 dynasty (loop). TEAM therefore stays listed during the advance; only
  // CFID (the own change package) is withheld, which is what the step-1 crash was actually reading (run 32).
  const shown = shownMembers(d, me);
  // A joiner must not be handed the other member's team file. The commissioner still sees every file, as before.
  const withFiles = (me && !me.commissioner ? shown : d.members).filter((m) => m.teamFileId);
  // Check 2 looks the signed-in blaze id up in T2B and compares it with select TGID from DEID, which
  // returns 1023 here. The real id must stay out of the map. Check 3 resolves each DYUS row through
  // B2N; with no registration that blaze id is 0, so one pair of 0 -> the joiner's team matches the
  // row and posts RtGm.TmChg, which copies that DYUS team onto the controlled coach.
  const withTeams = me && !me.commissioner
    ? (me.team && me.team !== 1023 ? [{ blazeId: 0, team: me.team }] : [])
    : placedMembers(d);
  // B2N = map<blazeId, NCID>: the client registers each pair with its user service; on resume 0x447f2c reads TEAM.NCID of a
  // member's team and maps it back to the blaze id through those registrations before comparing teams (0x33d084).
  // Every NCID the stub ever issued was 0 (DynastyUser.NCID, GetContinueDynastyInfoResponse.NCID), so the uploaded file's
  // TEAM.NCID is 0 as well; ncId stays 0 for existing members to match it.
  // Run 32: with TEAM empty the advance step still fetched the own team file, taken from CFID, and crashed opening it as
  // the ODCN package. So CFID is the own change package during an advance (none -> 0) and the own team file otherwise.
  // 2026-11-01: the coaching carousel ('Checking for contract data') asks with TMID 1023, STAT 12 and opens CFID the same
  // way, as the carousel's contract package: the newest .contract a console uploaded (case 91), or 0 before the first one
  // (a team file there crashes it at 0xa6a8fc reading 0x11). The caller picks CFID (case 58).
  w.intMap('B2N', (me && !me.commissioner ? [] : withTeams).map((m) => [m.blazeId, m.ncId ?? 0])); w.int('CFID', cfid); w.int('DFID', memberFileId(d, me?.blazeId));
  // GAME is list<DynastyFileInfo {DFID, TMID}> (0x2f6b18 copies it like TEAM): a member team whose game this week has game
  // data (a Supersim final, or a game a console played and uploaded), DFID = the game-data id the console then fetches
  // table by table (gamedata.mjs) when that game is still unplayed in the dynasty it loaded.
  const games = d.gameData?.[String(d.week ?? 0)] ?? [];
  const gameList = me && !me.commissioner ? games.filter((g) => shown.some((m) => m.team === g.team)) : games;
  w.list('GAME', T.STRUCT, gameList, (x, g) => { x.int('DFID', g.id); x.int('TMID', g.team); x.push(0); });
  w.intMap('T2B', withTeams.map((m) => [m.blazeId, m.team]));
  w.list('TEAM', T.STRUCT, withFiles, (x, m) => { x.int('DFID', m.teamFileId); x.int('TMID', m.team); x.push(0); });
}
// Blaze::DynastyOnDemand::GameResultsData {ATID, ATSC, CRCT, GMWK, HTID, HTSC, OTFL, STCT}
function gameResultsData(w, g) { w.int('ATID', g.ATID ?? 0); w.int('ATSC', g.ATSC ?? 0); w.int('CRCT', g.CRCT ?? 0); w.int('GMWK', g.GMWK ?? 0); w.int('HTID', g.HTID ?? 0); w.int('HTSC', g.HTSC ?? 0); w.int('OTFL', g.OTFL ?? 0); w.int('STCT', g.STCT ?? 0); }
const ok = (w) => w.int('ENUM', 0); // DynastyOnDemandResponse

export function handleDod({ p, body, session, reply }) {
  const name = DOD_COMMANDS[p.command] ?? `cmd${p.command}`;
  const user = { blazeId: session?.userId ?? 0, persona: session?.onlineId ?? 'Player', ncId: ncidOf(session?.userId ?? 0) };
  const did = num(body.DID ?? body.DYID ?? body.DYNI, 0);
  const d = store.dynasties[did];
  const me = d?.members.find((x) => x.blazeId === user.blazeId);
  const note = (extra = '') => `(DynastyOnDemand ${name}${extra})`;
  switch (p.command) {
    case 2: { // createDynasty -> CreateDynastyResponse {DID}
      const id = store.nextId++;
      store.dynasties[id] = { id, request: body, createdAt: now(), members: [{ ...user, commissioner: true, coach: 0, team: 0 }], season: 1, week: 0, year: 0, state: 0, fileId: 0, tables: {} };
      save();
      return reply(undefined, (w) => w.int('DID', id), note(`: "${body.NAME}" -> DID ${id}`));
    }
    case 5: // getDynasty {DID} -> Dynasty (a load: any advance flag from an aborted advance is cleared)
      if (!d) return reply(undefined, ok, note(`: unknown DID ${did}, generic response`));
      if (me && (!session?.leagueAuthenticated || me.commissioner)) {
        if (d.advancing) { d.advancing = false; save(); }
        refreshPatch(d);
        d.loadedAt = now(); save();
      }
      d.limitRoster = !!(me && !me.commissioner && !d.rosterExpanded);
      if (d.limitRoster) d.rosterExpanded = true;
      return reply(undefined, (w) => dynasty(w, d, user.blazeId), note(`: DID ${did}${d.limitRoster ? ' (load roster)' : ''}${d.patch ? ` (FID ${d.fileId}: file ${d.patch.base} + site edits)` : ''}`));
    case 9: // getInvitations -> GetInvitationsResponse {DYNS list<Dynasty>, INVS list<Invitation>}
      return reply(undefined, (w) => { w.list('DYNS', T.STRUCT, [], () => {}); w.list('INVS', T.STRUCT, [], () => {}); }, note(': none'));
    case 13: { // getContinueDynastyInfoForUser -> GetContinueDynastyInfoResponse {DNFO list<ContinueDynastyInfo>, NCID}
      const mine = Object.values(store.dynasties).filter((x) => x.members.some((m) => m.blazeId === user.blazeId));
      for (const x of mine) { x.hubAt = now(); x.rosterExpanded = false; x.limitRoster = false; } if (mine.length) save(); // the console is at the hub: its next getDynasty is a fresh load (refreshPatch)
      const myNcid = user.ncId;
      return reply(undefined, (w) => { w.list('DNFO', T.STRUCT, mine, (x, dd) => { continueDynastyInfo(x, dd, dd.members.find((m) => m.blazeId === user.blazeId)); x.push(0); }); w.int('NCID', myNcid); }, note(`: ${mine.length} dynasties for ${user.persona}, NCID ${myNcid}`));
    }
    case 22: {
      // DLST element ctor 0x14ef5d8 calls Dynasty ctor 0x775b74 (size 0x128).
      // Search lists public dynasties (the default) plus the caller's own. PRIV 0x7fffffff means no privacy filter.
      const list = Object.values(store.dynasties).filter((x) =>
        canSeeInSearch(x, session, user.blazeId) && matchesDynastyQuery(x, body))
        .slice(0, Math.min(50, Math.max(1, num(body.MAXR, 50))));
      return reply(undefined, (w) => w.list('DLST', T.STRUCT, list, (x,dd) => { dynasty(x, dd, user.blazeId); x.push(0); }), note(`: ${list.length} results [${list.map((x) => str(x.request?.NAME)).join(', ')}]`));
    }
    case 26: { // GetDynastyUserInfo {BZID, DYID} -> DynastyUserInfoResponse {DUIF list<DynastyUserInfo{AUTO, BZID, LDCL, LLOG, NCID, OFFP, PERS}>}
      // BZID 0 asks for the whole dynasty. A specific id asks for that member; answering with someone else first
      // makes the caller treat the commissioner's identity as its own and leave.
      const want = num(body.BZID);
      const list = (d?.members ?? []).filter((m) => !want || m.blazeId === want);
      return reply(undefined, (w) => w.list('DUIF', T.STRUCT, list, (x, m) => { x.int('AUTO', 0); x.int('BZID', m.blazeId); x.int('LDCL', 0); x.int('LLOG', now()); x.int('NCID', m.ncId ?? 0); x.str('OFFP', ''); x.str('PERS', m.persona); x.push(0); }), note(`: ${list.length} member(s) for BZID ${want || 'all'}`));
    }
    case 69: case 70: return reply(undefined, (w) => w.list('NLST', T.STRUCT, [], () => {}), note(': none')); // DynastyNotificationResponse
    case 93: return reply(undefined, (w) => w.list('TLST', T.STRUCT, [], () => {}), note(': no sync tables')); // GetSyncTablesResponse
    case 56: // StartDynastyUpdate {DYID, UPDT} -> begins a table push (UPDT 1 = user's team rows, 0 = whole dynasty)
      if (d) {
        d.update = { updt: num(body.UPDT), byUser: user.blazeId, startedAt: now(), touched: [] }; save();
        if (num(body.UPDT) === 2) pendingGames.set(d.id, { tables: {}, columns: {}, ghid: 0, rtid: 0, result: null }); else pendingGames.delete(d.id);
      }
      return reply(undefined, ok, note(`: DID ${did} UPDT ${body.UPDT}`));
    case 12: { // sendTableUpdate (DodTableUpdate) -> DodTableUpdateResponse {MSG}
      if (!d) return reply(undefined, (w) => w.str('MSG', ''), note(`: unknown DID ${did}`));
      let r;
      try { r = applyTableUpdate(d, body, session?.leagueAuthenticated && !me?.commissioner ? user.blazeId : null); } catch (e) { log('dod', `table update failed: ${e.stack ?? e.message}`); return reply(undefined, (w) => w.str('MSG', ''), note(': store error')); }
      save();
      return reply(undefined, (w) => w.str('MSG', ''), note(`: ${r.table} pack ${r.pack} +${r.added} rows (${r.total} total${r.filter ? `, ${r.filter.column}=${r.filter.value}` : ''})`));
    }
    case 57: { // EndDynastyUpdate {DYID, FID, NWST, NWWK, NWYR, TMID, UPDT}
      if (d) {
        if (num(body.UPDT) === 1) {
          const team = num(body.TMID);
          const m = team > 0 && team < 1023 ? (me ?? d.members.find((x) => x.team === team)) : null;
          if (m) { m.team = team; m.teamFileId = num(body.FID, m.teamFileId ?? 0); if (num(body.FID)) fixTeamPackage(d, team, num(body.FID)); }
        }
        else if (num(body.UPDT) === 0 && num(body.FID)) { d.fileId = d.consoleFileId = num(body.FID); d.patch = null; d.fileSavedAt = now(); }
        // UPDT 2 = a played game's stat tables + UploadGameResults; FID is 0 there and the dynasty file is unchanged (run 38 took it as file 0)
        else if (num(body.UPDT) === 2) registerConsoleGame(d, body, user);
        const prevYear = d.year ?? 0;
        if (!session?.leagueAuthenticated || me?.commissioner) {
          d.state = num(body.NWST, d.state); d.status = d.state; d.week = num(body.NWWK, d.week); d.year = num(body.NWYR, d.year ?? 0); d.advancing = false;
        }
        d.update = null;
        // the year offset the dynasty's first season ran in (hub card "Year N"): taken from the first advance into the
        // regular season, when a start year the bridge set (2025 -> NWYR 12) is already in the file
        if (d.startYear === undefined && num(body.NWST) === 7 && prevYear === 0) d.startYear = d.year;
        rollSeason(d); save();
      }
      return reply(undefined, ok, note(`: DID ${did} FID ${body.FID} UPDT ${body.UPDT} (tables: ${Object.keys(d?.tables ?? {}).length})`));
    }
    case 23: // GetTableUpdate {DYNI, FILT, TABL, UPDA} -> DodTableUpdate with no rows. An empty payload (run 17-24) is tolerated at
      // load time but crashed the advance step (run 24, table merge at 0xa6a874 reading a null table), so the reply names the
      // table and echoes the filter again, as in runs 13-16.
      {
        // Web edits (site -> console): rows of private/web-edits/<did>/<TABLE>.json that pass the request's filter.
        const table = name4(num(body.TABL));
        if (num(body.FILT?.COLM) === GAME_FILTER) { // game data of a web-played game (DynastyStatus.GAME id in FILT.VALU)
          const id = num(body.FILT.VALU);
          const entry = Object.values(d?.gameData ?? {}).flat().find((g) => g.id === id);
          const data = entry ? loadGameData(did, id) : null;
          const rows = data ? gameTableRows(data, table) : [];
          const layout = data?.columns?.[table === 'WQSC' ? 'UWQS' : table] ?? GAME_LAYOUTS[table]; // a console game goes back with the columns it was sent with
          return reply(undefined, (w) => tableUpdate(w, did, body, { columns: layout ?? {}, meta: { type: 0, flty: 2 } }, rows, { ghid: id, rtid: entry?.team ?? 0 }), note(`: ${table} game data ${id}${data?.source === 'console' ? ' (console game)' : ''}: ${rows.length} rows${data ? '' : ' (unknown game id)'}${layout ? '' : ' (unknown table)'}`));
        }
        const edits = loadWebEdits(did, table);
        const filtCol = body.FILT && num(body.FILT.COLM) ? name4(num(body.FILT.COLM)) : null;
        // PLYZ and TRAZ merge by PGID on the console (their descriptors use mode 2, NOTES 2026-11-01), so every row goes
        // to every console whatever the filter (a transfer's PTID or a player's TGID need not be the console's team). The
        // other tables replace the filtered subset (mode 0): a console gets only the rows of its own filter value.
        const keyed = table === 'PLYZ' || table === 'TRAZ';
        // Those two tables ignore the team filter, so the other team's rows arrive on every joiner load.
        // The joiner's published dynasty file already contains them. Sending the rows again marks the loaded
        // file changed, and the restart check loops (run 16). The commissioner still receives them.
        const baked = keyed && !!(me && !me.commissioner && me.dynastyFileId);
        const rows = edits && !baked ? edits.rows.filter((r) => keyed || !filtCol || r[filtCol] === undefined || r[filtCol] === num(body.FILT.VALU)) : [];
        return reply(undefined, (w) => tableUpdate(w, did, body, edits, rows), note(`: ${table} UPDA ${body.UPDA}: ${rows.length} web rows${baked ? ' (already in the joiner file)' : edits ? '' : ' (no web edits)'}`));
      }
    case 6: {
      let joined = false;
      let member = me;
      if (d && mayJoinDynasty(d, session, body)) {
        const picked = num(body.COCH);
        const coach = picked && picked !== 65535 ? picked : 0;
        const row = coach ? loadTable(d.id, 'COCH')?.rows?.find((r) => r.CCID === coach) : null;
        const team = num(row?.TGID);
        const open = team > 0 && team < 1023 && !d.members.some((m) => m.blazeId !== user.blazeId && m.team === team);
        if (!member) {
          member = { ...user, commissioner: false, coach, team: open ? team : 0 };
          d.members.push(member);
          joined = true;
        } else if (!member.team && coach) {
          member.coach = coach;
          if (open) member.team = team;
        }
        save();
      }
      return reply(undefined, (w) => w.int('COCH', member?.coach ?? 0), note(joined ? `: joined DID ${did} coach ${member?.coach ?? 0} team ${member?.team ?? 0}` : '')); // JoinDynastyResponse
    }
    case 14: { // RemoveMember {BZID, DID}. BZID 0 is the caller leaving.
      const target = num(body.BZID) || user.blazeId;
      const before = d?.members.length ?? 0;
      if (d && (target === user.blazeId || me?.commissioner)) {
        d.members = d.members.filter((m) => m.blazeId !== target);
        save();
      }
      return reply(undefined, (w) => w.int('DEST', 0), note(`: removed ${target}, ${before} -> ${d?.members.length ?? 0}`));
    }
    case 24: { // UploadGameResults {AOTS, AQ1S..AQ4S, ATID, ATSC, CRCT, DYID, FLID, GMWK, HOTS, HQ1S..HQ4S, HTID, HTSC, OTFL, STCT, TMID} -> {DYID, SFFG}
      if (d) { const g = Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'DYID').map(([k, v]) => [k, num(v)])); g.by = user.blazeId; g.at = now();
        const wk = String(num(body.GMWK)); (d.games ??= {})[wk] ??= []; const ours = d.games[wk].find((x) => x.HTID === g.HTID && x.ATID === g.ATID && x.supersimRunId); if (ours) noteConsoleOverride(store, d, g, ours); const pg = pendingGames.get(d.id); if (pg) pg.result = g; const list = d.games[wk].filter((x) => !(x.HTID === g.HTID && x.ATID === g.ATID)); list.push(g); d.games[wk] = list; save(); }
      return reply(undefined, (w) => { w.int('DYID', did); w.int('SFFG', 0); }, note(`: week ${body.GMWK} ${body.ATID}@${body.HTID} ${body.ATSC}-${body.HTSC}`));
    }
    case 25: { // RetrieveGameResults {DYID, WKID} -> {DYID, GRLI list<GameResultsData>, TIDL list<team id per result>}
      // GRLI and TIDL are parallel lists: the response handler (0x2fa48c) walks both and, for GRLI[i], runs
      // "update 'PWMT' ... where TGID = TIDL[i]" (0x3301c8, query @0x173c5b4), i.e. TIDL[i] names the member team whose
      // per-week row (TMWP: opponent, scores, status, CRCC = CRCT, ODSC = STCT) takes the result. Sending the game's two
      // team ids instead credited a Brown away game to the home team's row, which does not exist (Supersim run 1, week 6).
      // One entry per member team in the game, so both sides of a head-to-head game get their row.
      const list = d?.games?.[String(num(body.WKID))] ?? [];
      const humans = new Set((d?.members ?? []).map((m) => m.team).filter((t) => t && t !== 1023));
      const rows = list.flatMap((g) => { const own = [g.HTID, g.ATID].filter((t) => humans.has(t)); return (own.length ? own : [g.TMID ?? g.HTID]).map((t) => [g, t]); });
      return reply(undefined, (w) => { w.int('DYID', did); w.list('GRLI', T.STRUCT, rows, (x, [g]) => { gameResultsData(x, g); x.push(0); }); w.intList('TIDL', rows.map(([, t]) => t)); }, note(`: week ${body.WKID}: ${list.length} result(s) for team(s) ${rows.map(([, t]) => t).join(',') || '-'}`));
    }
    case 46: return reply(undefined, (w) => { w.int('DYID', did); w.int('SUCC', 1); }, note()); // UploadTransientSettingsResponse
    case 47: return reply(undefined, (w) => { w.int('DYID', did); w.intMap('TBID', []); w.map('TSID', T.INT, T.STRING, [], () => {}, () => {}); w.intMap('TTID', []); }, note()); // DownloadTransientSettingsResponse (TSID assumed id -> string)
    case 58: { // GetDynastyStatus {DFON, DYID, STAT, TMID, WEEK, YEAR} -> DynastyStatus
      // WEEK/YEAR here are the console's placeholders (31/0 before it has loaded); the authoritative week comes from
      // EndDynastyUpdate (NWWK/NWYR). Copying 31 over the advanced week looped the restart check after run 34.
      if (d && me && (!session?.leagueAuthenticated || me.commissioner)) {
        if (body.TMID !== undefined && num(body.TMID) !== 1023 && !me.team) me.team = num(body.TMID);
        d.status = num(body.STAT, d.status ?? 0);
        save();
        if (num(body.TMID) !== 1023) refreshPatch(d);
      }
      if (!d) return reply(undefined, (w) => { w.intMap('B2N', []); w.int('CFID', 0); w.int('DFID', 0); w.list('GAME', T.STRUCT, [], () => {}); w.intMap('T2B', []); w.list('TEAM', T.STRUCT, [], () => {}); }, note(`: unknown DID ${did}`));
      const contract = num(body.TMID) === 1023 && num(body.STAT) === 12; // the carousel's contract check (see dynastyStatus)
      const cf = contract && !d.advancing ? contractFile(d) : null;
      const cfid = d.advancing ? 0 : contract ? (cf?.cid ?? 0) : (me?.teamFileId ?? 0);
      const why = contract ? (cf ? ` (contract check: ${cf.name} from ${cf.persona})` : ' (contract check: no package yet)') : '';
      const dfid = memberFileId(d, me?.blazeId);
      const pairs = me && !me.commissioner ? (me.team && me.team !== 1023 ? [{ blazeId: 0, team: me.team }] : []) : placedMembers(d);
      const b2n = me && !me.commissioner ? [] : pairs;
      return reply(undefined, (w) => dynastyStatus(w, d, me, num(body.TMID) === 1023, cfid), note(`: TMID ${body.TMID} STAT ${body.STAT} DFID ${dfid} CFID ${cfid}${why}, T2B ${JSON.stringify(pairs.map((m) => [m.blazeId, m.team]))}, B2N ${JSON.stringify(b2n.map((m) => [m.blazeId, m.ncId ?? 0]))}`));
    }
    case 64: return reply(undefined, (w) => { w.intMap('TBID', []); w.intMap('TDMP', []); w.intMap('TSID', []); w.intMap('TTID', []); }, note()); // DownloadViewDetailsDataResponse
    case 71: { const r = d?.request ?? {}; return reply(undefined, (w) => { w.str('DESC', str(r.DESC)); w.int('MHUM', num(r.MHUM, 12)); w.str('PASS', me ? str(r.PASS) : ''); w.int('SSOW', num(r.SSOW)); }, note()); } // GetExtraDynastySettingsResponse
    case 83: { // CheckAdvanceWeekStatusResponse {ALLW, THTM, UTM}: ALLW 0 refuses the advance; the strings are shown to the commissioner
      const hold = d ? advanceHold(d) : null;
      if (hold) log('dod', `DID ${did}: advance refused: ${hold}`);
      return reply(undefined, (w) => { w.int('ALLW', hold ? 0 : 1); w.str('THTM', hold ? hold.slice(0, 64) : ''); w.str('UTM', hold ? hold.slice(0, 64) : ''); }, note(hold ? `: HELD "${hold}"` : ''));
    }
    case 84: if (d) { if (session?.leagueAuthenticated && !me?.commissioner) { (d.memberRecruitingState ??= {})[user.blazeId] = num(body.STAT); } else d.consoleRecruitingState = num(body.STAT); save(); } return reply(undefined, ok, note(`: STAT ${body.STAT}`)); // ReportConsoleRecruitingState
    case 88: if (d) { d.advancing = true; save(); } return reply(undefined, (w) => { w.int('QUPS', 0); w.int('TRAF', 0); }, note(': advance in progress')); // RequestAdvanceWeekRequestResponse
    case 90: // SetReadyToUploadAdvanceWeekData -> {AQST AdvanceWeekQueueStatus {BGUP, QUPS}}: the console has advanced the week locally and
      // asks for its upload slot; BGUP 0 shows the "heavy traffic, you are next in line" wait forever (run 33). There is no queue here.
      return reply(undefined, (w) => w.struct('AQST', (x) => { x.int('BGUP', 1); x.int('QUPS', 0); }), note(': begin upload now'));
    case 103: return reply(undefined, (w) => { w.int('BGUP', 0); w.int('QUPS', 0); }, note()); // AdvanceWeekQueueStatus
    case 68: return reply(undefined, (w) => w.int('SUCS', 1), note()); // TransferCommishStatusResponse
    case 41: return reply(undefined, (w) => { w.int('CTSC', 0); w.int('ICMT', 0); }, note()); // OfferScholarshipResponse
    case 91: { // MakeContractPick {CHID coach, CTID contract, DID} -> {RSIM, SYTY, TLID}
      // The coaching carousel. Accept and decline send the same request (the choice stays on the console). RSIM = 1 tells
      // the picking console to simulate: it fetches the newest .contract (contract check, case 58), applies its own
      // decision, lets the CPU coaches decide up to the next human on the clock and uploads the result as a new
      // .contract, which every other console then merges from its own contract check. With RSIM 0 the console finished
      // the pick with nothing changed and showed the same offer again (NOTES 2026-11-01).
      if (d) { (d.contractPicks ??= []).push({ by: user.blazeId, coach: num(body.CHID), contract: num(body.CTID), at: now() }); if (d.contractPicks.length > 200) d.contractPicks.shift(); save(); }
      return reply(undefined, (w) => { w.int('RSIM', 1); w.int('SYTY', 0); w.int('TLID', 0); }, note(`: coach ${body.CHID} contract ${body.CTID} -> RSIM 1 (the console simulates)`));
    }
    case 4: return reply(undefined, (w) => memberInfo(w, d ?? { id: did, request: {}, members: [] }, me ?? { ...user, commissioner: false, coach: 0, team: 0 }), note(me ? '' : ': not a member')); // getMemberByBlazeId -> MemberInfo
    case 3: if (d) { delete store.dynasties[did]; save(); } return reply(undefined, ok, note(`: DID ${did}`));
    case 45: // changeUserTeam {DYID, NWTM, OLTM}
      if (me) { me.team = num(body.NWTM); save(); }
      return reply(undefined, ok, note(`: team ${body.OLTM} -> ${body.NWTM}`));
    case 67: if (d) { d.maxOwned = num(body.MAXD); save(); } return reply(undefined, ok, note(`: MAXD ${body.MAXD}`)); // SetMaxOwnedDynasties
    case 80: { // optimizeProspectInfo {DYID, PRED list<ProspectExtraBlazeData{PRID, SQUT}>, TMED list<TeamExtraBlazeData{BCSP, TMID}>}
      if (d) { d.prospectExtra = items(body.PRED).map((x) => [num(x.PRID), num(x.SQUT)]); d.teamExtra = items(body.TMED).map((x) => [num(x.TMID), num(x.BCSP)]); save(); }
      return reply(undefined, ok, note(`: ${items(body.PRED).length} prospects, ${items(body.TMED).length} teams`));
    }
    default: // DynastyOnDemandResponse {ENUM 0} for everything else (poke, SetActiveDynasty, ...)
      return reply(undefined, ok, note(': generic ENUM 0'));
  }
}

// The Supersim adapter (supersim.mjs) runs inside this process and needs the store, the saver and the pushed tables.
export { store, save, loadTable };
