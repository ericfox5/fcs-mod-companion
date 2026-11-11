// Depth charts in a save: Road to Glory, dynasty, season or roster (DCHT, 88 rows per team, DEPTH_SLOTS per position).
//   ncaa-bridge depth show <save> --team T [--pos QB,K]
//   ncaa-bridge depth set <save> --team T --player "First Last" --pos K,P,TE [--depth 1] [--out FILE] [--dry-run]
//   ncaa-bridge depth auto <save> [--team T] [--out FILE] [--dry-run] [--allow-oversize]   every chart ordered by overall
// <save> is a USR-DATA file, a save folder, or a save name in RPCS3's savedata (RTGTEST1, BLUS31159-RTG-RTGTEST1);
// --team is a TGID, a school ("Holy Cross") or an abbreviation (HC); --player is a PGID or a name on that team.
// `set` puts the player at that depth (1 = starter) and moves the others down one; the last one drops off. Without
// --out it writes the save in place, after a backup to %LOCALAPPDATA%\ncaa-bridge\backups, and refuses while RPCS3
// runs from the same folder. The game reorders CPU-run depth charts as the season goes (a Road to Glory team is CPU
// run), so an edit may need doing again after a week is played.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { TdbFile } from '@ncaa/tdb';
import { DEPTH_SLOTS, PGID_NONE, POSITIONS, positionName } from '@ncaa/ncaa14';
import { openSaveDb, writeSaveDb } from './roster.js';
import { STDA_BACKUP_ROOT, rpcs3RootFromConfig, rpcs3RunningOver } from '../stda.js';

const savedataDir = (rpcs3: string) => join(rpcs3, 'dev_hdd0', 'home', '00000001', 'savedata');

// A USR-DATA path from a file, a save folder or a save name (matched against BLUS31159-<KIND>-<NAME> folders).
export function resolveSave(save: string, rpcs3?: string): string {
  if (existsSync(save)) return statSync(save).isDirectory() ? join(save, 'USR-DATA') : save;
  const root = rpcs3 ?? process.env.NCAA_RPCS3 ?? rpcs3RootFromConfig();
  if (!root) throw new Error(`${save}: not a file or folder, and no RPCS3 folder to look in (pass --rpcs3)`);
  const dir = savedataDir(root), want = save.toUpperCase();
  const hits = existsSync(dir) ? readdirSync(dir).filter((d) => d.toUpperCase() === want || (/^BLUS31159-[A-Z]+-/.test(d.toUpperCase()) && d.toUpperCase().replace(/^BLUS31159-[A-Z]+-/, '') === want)) : [];
  if (!hits.length) throw new Error(`no save named ${save} in ${dir}`);
  if (hits.length > 1) throw new Error(`${save} matches ${hits.join(', ')}: give the full folder name`);
  return join(dir, hits[0]!, 'USR-DATA');
}

export function findTeam(file: TdbFile, team: string): { tgid: number; name: string } {
  const t = file.table('TEAM'), q = team.trim().toLowerCase(), all: { tgid: number; name: string; keys: string[] }[] = [];
  for (let i = 0; i < t.recordCount; i++) {
    const school = String(t.get(i, 'TDNA')), nick = String(t.get(i, 'TMNA'));
    all.push({ tgid: Number(t.get(i, 'TGID')), name: `${school} ${nick}`, keys: [school, `${school} ${nick}`, String(t.get(i, 'TSNA'))].map((s) => s.toLowerCase()) });
  }
  const hits = /^\d+$/.test(q) ? all.filter((x) => x.tgid === Number(q)) : all.filter((x) => x.keys.includes(q));
  if (hits.length !== 1) throw new Error(hits.length ? `--team ${team} matches ${hits.map((h) => `${h.name} (${h.tgid})`).join(', ')}: pass the TGID` : `no team ${team} in this save`);
  return hits[0]!;
}

interface Player { pgid: number; name: string; pos: number; jersey: number; ovr: number }
function teamPlayers(file: TdbFile, tgid: number): Map<number, Player> {
  const p = file.table('PLAY'), out = new Map<number, Player>();
  for (let i = 0; i < p.recordCount; i++) if (Number(p.get(i, 'TGID')) === tgid) {
    const pgid = Number(p.get(i, 'PGID'));
    out.set(pgid, { pgid, name: `${p.get(i, 'PFNA')} ${p.get(i, 'PLNA')}`, pos: Number(p.get(i, 'PPOS')), jersey: Number(p.get(i, 'PJEN')), ovr: Number(p.get(i, 'POVR')) });
  }
  return out;
}

export function findPlayer(players: Map<number, Player>, player: string): Player {
  const q = player.trim().toLowerCase();
  const hits = /^\d+$/.test(q) ? [...players.values()].filter((p) => p.pgid === Number(q)) : [...players.values()].filter((p) => p.name.toLowerCase() === q);
  if (hits.length !== 1) throw new Error(hits.length ? `--player ${player} matches PGIDs ${hits.map((h) => h.pgid).join(', ')}: pass the PGID` : `no player ${player} on this team`);
  return hits[0]!;
}

export function parsePositions(list: string): number[] {
  return list.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).map((s) => {
    const i = (POSITIONS as readonly string[]).indexOf(s);
    if (i < 0) throw new Error(`unknown position ${s} (one of ${POSITIONS.join(' ')})`);
    return i;
  });
}

// One position's chart with `pgid` at `depth` (0-based): the others keep their order and move down past it; the chart
// keeps its length, so the last one drops off. Empty slots stay at the end.
export function placeInDepth(chart: number[], pgid: number, depth: number): number[] {
  const rest = chart.filter((id) => id !== pgid && id !== PGID_NONE);
  rest.splice(Math.min(depth, rest.length), 0, pgid);
  return [...rest, ...Array<number>(chart.length).fill(PGID_NONE)].slice(0, chart.length);
}

// The DCHT rows of one team, by position, in depth order.
function chartRows(file: TdbFile, tgid: number): Map<number, number[]> {
  const d = file.table('DCHT'), byPos = new Map<number, { depth: number; row: number }[]>();
  for (let i = 0; i < d.recordCount; i++) if (Number(d.get(i, 'TGID')) === tgid) {
    const pos = Number(d.get(i, 'PPOS'));
    (byPos.get(pos) ?? byPos.set(pos, []).get(pos)!).push({ depth: Number(d.get(i, 'ddep')), row: i });
  }
  return new Map([...byPos].map(([pos, rows]) => [pos, rows.sort((a, b) => a.depth - b.depth).map((r) => r.row)]));
}

function describe(players: Map<number, Player>, pgid: number): string {
  if (pgid === PGID_NONE) return '(empty)';
  const p = players.get(pgid);
  return p ? `${p.name} (${positionName(p.pos)} #${p.jersey}, ${p.ovr})` : `PGID ${pgid} (not on this team)`;
}
const line = (pos: number, ids: number[], players: Map<number, Player>) => `${positionName(pos).padEnd(3)} ${ids.map((id, d) => `${d + 1}. ${describe(players, id)}`).join('  ')}`;

export function depthShow(save: string, opts: { team: string; pos?: string; rpcs3?: string }): void {
  const path = resolveSave(save, opts.rpcs3), o = openSaveDb(path);
  const team = findTeam(o.file, opts.team), players = teamPlayers(o.file, team.tgid), rows = chartRows(o.file, team.tgid), d = o.file.table('DCHT');
  console.log(`${path}\n${team.name} (TGID ${team.tgid}) depth chart:`);
  for (const pos of opts.pos ? parsePositions(opts.pos) : [...rows.keys()].sort((a, b) => a - b)) console.log(line(pos, (rows.get(pos) ?? []).map((r) => Number(d.get(r, 'PGID'))), players));
}

export function depthSet(save: string, opts: { team: string; player: string; pos: string; depth?: number; out?: string; dryRun?: boolean; rpcs3?: string }): void {
  const path = resolveSave(save, opts.rpcs3), o = openSaveDb(path);
  const team = findTeam(o.file, opts.team), players = teamPlayers(o.file, team.tgid), who = findPlayer(players, opts.player);
  const depth = (opts.depth ?? 1) - 1, rows = chartRows(o.file, team.tgid), d = o.file.table('DCHT');
  let changed = 0;
  console.log(`${path}\n${team.name}: ${who.name} (PGID ${who.pgid}) at depth ${depth + 1}`);
  for (const pos of parsePositions(opts.pos)) {
    const r = rows.get(pos) ?? [];
    if (r.length !== (DEPTH_SLOTS[pos] ?? r.length) || !r.length) throw new Error(`${positionName(pos)}: the save has ${r.length} DCHT rows for this team, expected ${DEPTH_SLOTS[pos]}; nothing changed`);
    if (depth < 0 || depth >= r.length) throw new Error(`--depth ${depth + 1}: ${positionName(pos)} has ${r.length} slots`);
    const before = r.map((row) => Number(d.get(row, 'PGID'))), after = placeInDepth(before, who.pgid, depth);
    after.forEach((id, i) => { if (before[i] !== id) { d.set(r[i]!, 'PGID', id); changed++; } });
    console.log(`  before ${line(pos, before, players)}\n  after  ${line(pos, after, players)}`);
  }
  if (!changed) { console.log('already set: nothing to write'); return; }
  if (opts.dryRun) { console.log(`dry run: ${changed} slot(s) would change; nothing written`); return; }
  const target = opts.out ?? path;
  if (rpcs3RunningOver([target])) throw new Error('RPCS3 is running from this folder: close it first; nothing written');
  if (target === path) {
    const backup = join(STDA_BACKUP_ROOT, `${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}-depth`, basename(dirname(path)));
    mkdirSync(backup, { recursive: true }); copyFileSync(path, join(backup, 'USR-DATA'));
    console.log(`backup: ${join(backup, 'USR-DATA')}`);
  }
  writeSaveDb(target, o, { allowOversize: false });
  // read it back: every slot of the team must hold what was written
  const back = openSaveDb(target), bd = back.file.table('DCHT');
  for (const [, r] of rows) for (const row of r) if (Number(bd.get(row, 'PGID')) !== Number(d.get(row, 'PGID'))) throw new Error(`${target}: DCHT row ${row} reads back ${bd.get(row, 'PGID')}, wrote ${d.get(row, 'PGID')}`);
  console.log(`wrote ${target}: ${changed} slot(s) changed, read back OK`);
}

// Positions a depth-chart slot may borrow from when the team is short at it, nearest first (line with line, edge with
// edge, linebackers together, secondary together, kickers together).
const DEPTH_FALLBACK: Record<number, number[]> = {
  0: [], 1: [2], 2: [1, 4], 3: [4], 4: [2, 3], 5: [9, 6, 8, 7], 6: [8, 7, 5, 9], 7: [6, 8], 8: [6, 7, 9, 5], 9: [5, 8, 6, 7],
  10: [11, 12], 11: [10, 12], 12: [10, 11], 13: [15, 14], 14: [13, 15], 15: [13, 14], 16: [17, 18], 17: [18, 16], 18: [17, 16],
  19: [20], 20: [19], 24: [7, 4],
};
const RETURN_SLOTS = new Set([21, 22, 23]); // KR, PR, KOS keep whoever holds them

// One team's chart ordered by overall: each position's slots take the team's players of that position, best first;
// when there are fewer than the slots, the players already in the chart keep the rest, then the nearest positions fill
// in. The return and kickoff slots are left as they are. Nobody's PPOS changes and every slot keeps a player.
export function autoDepth(players: Map<number, Player>, chart: Map<number, number[]>): Map<number, number[]> {
  const byOvr = (a: Player, b: Player) => b.ovr - a.ovr || a.pgid - b.pgid;
  const at = (pos: number) => [...players.values()].filter((p) => p.pos === pos).sort(byOvr).map((p) => p.pgid);
  const out = new Map<number, number[]>();
  for (const [pos, before] of chart) {
    if (RETURN_SLOTS.has(pos)) { out.set(pos, before.slice()); continue; }
    const order: number[] = [];
    const add = (ids: number[]) => { for (const id of ids) if (id !== PGID_NONE && players.has(id) && !order.includes(id)) order.push(id); };
    add(at(pos)); add(before);
    for (const other of DEPTH_FALLBACK[pos] ?? []) { if (order.length >= before.length) break; add(at(other)); }
    out.set(pos, [...order, ...Array<number>(before.length).fill(PGID_NONE)].slice(0, before.length));
  }
  return out;
}

// `depth auto`: every team's chart (or one team's) reordered by overall. Roster builds use it after new ratings are
// written, so the starter slot holds the best-rated player and not last year's starter row.
export function depthAuto(save: string, opts: { team?: string; out?: string; dryRun?: boolean; allowOversize?: boolean; rpcs3?: string }): { teams: number; changed: number } {
  const path = resolveSave(save, opts.rpcs3), o = openSaveDb(path), d = o.file.table('DCHT');
  const tgids = new Set<number>();
  if (opts.team) tgids.add(findTeam(o.file, opts.team).tgid);
  else for (let i = 0; i < d.recordCount; i++) tgids.add(Number(d.get(i, 'TGID')));
  let changed = 0, starters = 0, teams = 0;
  for (const tgid of [...tgids].sort((a, b) => a - b)) {
    const players = teamPlayers(o.file, tgid), rows = chartRows(o.file, tgid);
    if (!players.size) continue;
    const before = new Map([...rows].map(([pos, r]) => [pos, r.map((row) => Number(d.get(row, 'PGID')))]));
    const after = autoDepth(players, before);
    teams++;
    for (const [pos, r] of rows) {
      const b = before.get(pos)!, a = after.get(pos)!;
      if (b[0] !== a[0]) starters++;
      a.forEach((id, i) => { if (b[i] !== id) { d.set(r[i]!, 'PGID', id); changed++; } });
    }
  }
  console.log(`${path}\n${teams} team(s): ${changed} depth slot(s) change, ${starters} new first-string player(s)`);
  if (!changed || opts.dryRun) { console.log(changed ? 'dry run: nothing written' : 'already in order: nothing to write'); return { teams, changed }; }
  const target = opts.out ?? path;
  if (rpcs3RunningOver([target])) throw new Error('RPCS3 is running from this folder: close it first; nothing written');
  writeSaveDb(target, o, { allowOversize: Boolean(opts.allowOversize) });
  const back = openSaveDb(target), bd = back.file.table('DCHT');
  for (let i = 0; i < d.recordCount; i++) if (Number(bd.get(i, 'PGID')) !== Number(d.get(i, 'PGID'))) throw new Error(`${target}: DCHT row ${i} reads back ${bd.get(i, 'PGID')}, wrote ${d.get(i, 'PGID')}`);
  console.log(`wrote ${target}, read back OK`);
  return { teams, changed };
}

export function depthCli(cmd: string | undefined, args: string[], flags: Map<string, string>): void {
  const team = flags.get('team'), rpcs3 = flags.get('rpcs3');
  if (cmd === 'auto' && args[0]) { depthAuto(args[0], { team, out: flags.get('out'), dryRun: flags.has('dry-run'), allowOversize: flags.has('allow-oversize'), rpcs3 }); return; }
  if (cmd === 'show' && args[0] && team) depthShow(args[0], { team, pos: flags.get('pos'), rpcs3 });
  else if (cmd === 'set' && args[0] && team && flags.has('player') && flags.has('pos')) depthSet(args[0], { team, player: flags.get('player')!, pos: flags.get('pos')!, depth: flags.has('depth') ? Number(flags.get('depth')) : undefined, out: flags.get('out'), dryRun: flags.has('dry-run'), rpcs3 });
  else console.log('usage: ncaa-bridge depth show <save> --team T [--pos QB,K] | depth auto <save> [--team T] [--out FILE] [--dry-run] [--allow-oversize] | depth set <save> --team T --player "First Last" --pos K,P,TE [--depth 1] [--out FILE] [--dry-run]   (<save>: USR-DATA, a save folder or a save name such as RTGTEST1; [--rpcs3 DIR])');
}
