// Supersim adapter: runs inside the league server process (the only writer of private/dynasties.json) and moves official
// web-simulated results from the site's outbox into the dynasty store: the score for the hub (RetrieveGameResults -> TMWP)
// and the game's tables for the load/advance (DynastyStatus.GAME + GetTableUpdate, gamedata.mjs), which make the console
// apply the result instead of simulating the game. Receipts: accepted = registered in the store and persisted;
// synced = the console's own schedule push later shows the game final with the same score; conflict = the console
// uploaded its own result for that game after ours.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from './log.mjs';
import { fileURLToPath } from 'node:url';
import { buildGameTables, saveGameData } from './gamedata.mjs';
import { readDynastyFile } from './tdb-read.mjs';

const LOCKER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'private', 'locker');

const now = () => Math.floor(Date.now() / 1000);

// Site URL + bridge token from the bridge's own config (same machine); nothing from the browser is trusted here.
export function siteConfig() {
  try { const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ncaa-bridge', 'config.json'), 'utf8')); if (c.workerUrl && c.token) return { workerUrl: String(c.workerUrl).replace(/\/$/, ''), token: String(c.token) }; } catch { /* no config */ }
  return null;
}

// Validates and registers one official result. Throws on anything stale or ambiguous; never overwrites a console result.
export function acceptResult({ store, save, loadTable }, envelope) {
  const e = envelope, d = store.dynasties[e.odId];
  if (!d) throw new Error(`unknown dynasty ${e.odId}`);
  d.supersimLedger ??= {};
  if (d.supersimLedger[e.runId]) return d.supersimLedger[e.runId];
  if (d.advancing || d.update) throw new Error('dynasty busy (advance or update in progress)');
  if ((d.week ?? 0) !== e.week) throw new Error(`stale week: site ${e.week}, server ${d.week}`);
  if (!d.members.some((m) => m.blazeId === e.blazeId && m.team === e.ownedTeamId)) throw new Error('ownership changed');
  const g = e.gameResult;
  if (!g || ![g.ATID, g.HTID].includes(e.ownedTeamId) || g.GMWK !== e.week || ![g.ATSC, g.HTSC].every((x) => Number.isInteger(x) && x >= 0) || g.ATSC === g.HTSC) throw new Error('invalid game result');
  const row = (loadTable(d.id, 'SCHD')?.rows ?? []).find((x) => x.SEWN === e.week && x.GHTG === g.HTID && x.GATG === g.ATID);
  if (!row) throw new Error('game not on the pushed schedule');
  if (row.GSTA >= 2) throw new Error('the console already shows this game as final');
  const list = d.games?.[String(e.week)] ?? [];
  if (list.some((x) => x.HTID === g.HTID && x.ATID === g.ATID && !x.supersimRunId)) throw new Error('a console result already exists for this game');
  const entry = { ...g, by: e.blazeId, at: now(), supersimRunId: e.runId };
  (d.games ??= {})[String(e.week)] = [...list.filter((x) => !(x.HTID === g.HTID && x.ATID === g.ATID)), entry];
  // Without game data the advance simulates the game itself (2026-10-30: week 6 re-simmed 31-41 over a 24-21 Supersim win).
  let gameData = null;
  try {
    // the dynasty file the console will load holds the head coach skills and goal progress the coach tables start from
    let db = null; try { db = readDynastyFile(path.join(LOCKER_DIR, `${d.fileId}.bin`)); } catch (err) { log('supersim', `run ${e.runId}: dynasty file ${d.fileId} unreadable (${err.message}); no coach XP`); }
    const opts = { db }; const tables = buildGameTables(e, row, opts);
    const id = d.nextGameDataId ?? 900001; d.nextGameDataId = id + 1;
    saveGameData(d.id, id, { runId: e.runId, week: e.week, team: e.ownedTeamId, sgnm: row.SGNM, createdAt: now(), tables });
    const wk = String(e.week);
    (d.gameData ??= {})[wk] = [...(d.gameData[wk] ?? []).filter((x) => x.team !== e.ownedTeamId), { team: e.ownedTeamId, id, runId: e.runId }];
    gameData = { id, rows: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])), coachXp: opts.coachXp ?? null };
  } catch (err) { log('supersim', `run ${e.runId}: no game data (${err.message}); the console will show the score but simulate the game at the advance`); }
  const receipt = { runId: e.runId, durable: true, acceptedAt: new Date().toISOString(), week: e.week, home: g.HTID, away: g.ATID, score: [g.ATSC, g.HTSC], gameData };
  d.supersimLedger[e.runId] = receipt;
  save();
  return receipt;
}

// The console's later SCHD push proves the result landed.
export function syncedProof({ store, loadTable }, envelope) {
  const d = store.dynasties[envelope.odId]; const g = envelope.gameResult;
  if (!d) return null;
  const conflict = d.supersimConflicts?.[envelope.runId];
  if (conflict) return { status: 'conflict', proof: conflict };
  const row = (loadTable(d.id, 'SCHD')?.rows ?? []).find((x) => x.SEWN === envelope.week && x.GHTG === g.HTID && x.GATG === g.ATID);
  if (!row || row.GSTA < 2) return null;
  if (row.GHSC !== g.HTSC || row.GASC !== g.ATSC) return { status: 'conflict', proof: { reason: 'console final differs', console: [row.GASC, row.GHSC], ours: [g.ATSC, g.HTSC] } };
  return { status: 'synced', proof: { runId: envelope.runId, syncedAt: new Date().toISOString(), fileId: d.fileId ?? 0, console: [row.GASC, row.GHSC] } };
}

// Called by dod.mjs when the console uploads its own result for a game we had simulated: keep the console's, flag ours.
export function noteConsoleOverride(store, d, consoleResult, ours) {
  for (const wk of Object.keys(d.gameData ?? {})) d.gameData[wk] = d.gameData[wk].filter((x) => x.runId !== ours.supersimRunId); // the console played it: stop offering ours
  (d.supersimConflicts ??= {})[ours.supersimRunId] = { reason: 'console uploaded its own result', console: [consoleResult.ATSC, consoleResult.HTSC], ours: [ours.ATSC, ours.HTSC], at: now() };
  log('supersim', `conflict: console result for ${consoleResult.ATID}@${consoleResult.HTID} replaced Supersim run ${ours.supersimRunId}`);
}

export function startSupersimPoller(deps, { intervalMs = 5000 } = {}) {
  const site = siteConfig();
  if (!site) { log('supersim', 'no ~/.ncaa-bridge/config.json (workerUrl + token): web-simulated games are not polled'); return () => {}; }
  let busy = false;
  const call = async (p, method = 'GET', body) => {
    const res = await fetch(site.workerUrl + p, { method, headers: { authorization: `Bearer ${site.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}`);
    return res.json();
  };
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      for (const d of Object.values(deps.store.dynasties)) {
        if (!d.fileId) continue;
        const { runs } = await call(`/api/bridge/supersim?od=${d.id}`);
        for (const run of runs ?? []) {
          try {
            if (run.status === 'pending') {
              const proof = acceptResult(deps, run.envelope);
              await call(`/api/bridge/supersim/${run.id}/receipt`, 'POST', { status: 'accepted', proof });
              log('supersim', `accepted run ${run.id}: week ${run.envelope.week} ${run.envelope.gameResult.ATID}@${run.envelope.gameResult.HTID} ${run.envelope.gameResult.ATSC}-${run.envelope.gameResult.HTSC}`);
            } else if (run.status === 'accepted') {
              const r = syncedProof(deps, run.envelope);
              if (r) { await call(`/api/bridge/supersim/${run.id}/receipt`, 'POST', r); log('supersim', `run ${run.id} ${r.status}`); }
            }
          } catch (e) { log('supersim', `run ${run.id}: ${e.message}`); }
        }
      }
    } catch (e) { log('supersim', `poll failed: ${e.message}`); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  log('supersim', `polling ${site.workerUrl} every ${intervalMs / 1000}s for web-simulated games`);
  tick();
  return () => clearInterval(timer);
}
