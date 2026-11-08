// Generic opponent -> real team. The five generic opponents (TGID 160-164, TEAM.TTYP 1) have no PLAY rows: the game
// reads their players from PLST and their depth chart from DCST in the standard-data DB (archive entry
// b57b5e0ae8e74714 in qkl_boot.ast / qkl_fe2ig.ast; 0x232cd8 picks PLST over PLAY when the team's TTYP is 1). Turning a
// generic team into another team is therefore a data edit: its existing PLST rows are overwritten with the donor's
// best players (no rows added, so the entry keeps its size) and its DCST rows re-pointed at them. Players never enter a
// dynasty's PLAY, so the weekly dynasty passes never see them. The TEAM row (names, colours) lives in roster and dynasty
// files instead: copyTeamIdentity.
import type { TdbFile, TdbTable, FieldValue } from '@ncaa/tdb';
import { positionName } from './positions.js';

type Row = Record<string, FieldValue>;
export interface GenericDonor { players: Row[]; depth: Row[] }
export interface SwappedPlayer { pgid: number; name: string; pos: string; ovr: number; asPos?: string }
export interface GenericSwapResult {
  tgid: number; stride: number; count: number;
  players: SwappedPlayer[];
  ovr: { before: { top: number; mean: number }; after: { top: number; mean: number } };
  improvised: string[]; // roster slots or depth spots not filled from the donor's own position / depth chart
  depthRows: number;
}

// Positions that can stand in for one another (PPOS codes), nearest first. KR 21 / PR 22 / KO 23 are depth-chart-only
// spots; LS 24 is a real position in the FCS mod's rosters.
const FALLBACK: Record<number, number[]> = {
  0: [], 1: [2, 3], 2: [1, 4], 3: [4, 1], 4: [3, 2],
  5: [9, 6, 8, 7], 6: [8, 7, 5, 9], 7: [6, 8, 5, 9], 8: [6, 7, 9, 5], 9: [5, 8, 6, 7],
  10: [11, 12], 11: [10, 12], 12: [10, 11], 13: [15, 14], 14: [13, 15], 15: [13, 14],
  16: [18, 17], 17: [18, 16], 18: [17, 16], 19: [20], 20: [19],
  21: [3, 1, 16], 22: [3, 16, 1], 23: [19, 20], 24: [7, 4, 6, 8],
};
const n = (r: Row, k: string) => Number(r[k] ?? 0);
const nameOf = (r: Row) => `${String(r.PFNA ?? '').trim()} ${String(r.PLNA ?? '').trim()}`.trim();

function rowsOf(t: TdbTable, tgid: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < t.recordCount; i++) if (Number(t.get(i, 'TGID')) === tgid) out.push(i);
  return out;
}
// The stride a team's PGIDs follow (PGID / stride == TGID for every row), 70 before the stride-100 re-key, 100 after.
function strideOf(t: TdbTable, rows: number[], tgid: number): number | null {
  for (const s of [70, 100]) if (rows.every((i) => Math.floor(Number(t.get(i, 'PGID')) / s) === tgid)) return s;
  return null;
}
// Write a donor value into a field, clamped to what the field holds (strings cut to the field's bytes).
function put(t: TdbTable, i: number, name: string, v: FieldValue): void {
  const f = t.field(name);
  if (f.type === 0) { t.set(i, name, String(v).slice(0, f.bits / 8)); return; }
  if (f.type === 1 || typeof v !== 'number') { if (typeof v === typeof t.get(i, name)) t.set(i, name, v); return; }
  const max = f.type === 2 ? 2 ** (f.bits - 1) - 1 : 2 ** f.bits - 1, min = f.type === 2 ? -(2 ** (f.bits - 1)) : 0;
  t.set(i, name, Math.max(min, Math.min(max, Math.round(v))));
}

// Overwrite generic team `tgid` (its PLST rows, count unchanged) with the donor's best players and re-point its DCST
// rows. Selection: the generic team's own position counts are the quota; each position takes the donor's best at that
// position by POVR; a shortfall goes first to a specialist the depth chart needs but the quota lacks (LS), then to the
// nearest stand-in positions, then to the best players left. PLST fields are copied from the donor's PLAY row by name
// (names, ratings, body, jersey, year); fields the donor lacks keep the generic row's value. PGID/POID = TGID x stride +
// slot, slots in position order, with the stride the team already uses unless given.
export function swapGenericTeam(stda: TdbFile, donor: GenericDonor, opts: { tgid: number; stride?: number }): GenericSwapResult {
  const { tgid } = opts;
  const plst = stda.table('PLST'), dcst = stda.table('DCST');
  const target = rowsOf(plst, tgid);
  if (!target.length) throw new Error(`PLST has no rows for TGID ${tgid} (only the generic teams' players live there)`);
  const stride = opts.stride ?? strideOf(plst, target, tgid);
  if (stride === null) throw new Error(`TGID ${tgid}: PLST PGIDs follow neither stride 70 nor 100; pass a stride`);
  const N = target.length;
  if (donor.players.length < N) throw new Error(`donor has ${donor.players.length} players; the generic team needs ${N}`);

  const before = target.map((i) => Number(plst.get(i, 'POVR')));
  const quota = new Map<number, number>();
  for (const i of target) { const p = Number(plst.get(i, 'PPOS')); quota.set(p, (quota.get(p) ?? 0) + 1); }
  const depthRows = rowsOf(dcst, tgid);
  const depthPos = new Set(depthRows.map((i) => Number(dcst.get(i, 'PPOS'))));

  const byOvr = (a: Row, b: Row) => n(b, 'POVR') - n(a, 'POVR') || n(a, 'PGID') - n(b, 'PGID');
  const pool = [...donor.players].sort(byOvr);
  const taken = new Set<Row>();
  const chosen: { r: Row; as: number; improvised: boolean }[] = [];
  const take = (r: Row, as: number, improvised: boolean) => { taken.add(r); chosen.push({ r, as, improvised }); };
  const improvised: string[] = [];
  let short = 0; const shortPos: number[] = [];
  for (const [p, q] of [...quota].sort((a, b) => a[0] - b[0])) {
    const same = pool.filter((r) => !taken.has(r) && n(r, 'PPOS') === p).slice(0, q);
    for (const r of same) take(r, p, false);
    for (let k = same.length; k < q; k++) shortPos.push(p);
    short += q - same.length;
  }
  // specialists the depth chart uses but the quota has none of (the FCS mod's long snapper)
  for (const p of [...depthPos].filter((p) => p <= 24 && !quota.has(p)).sort((a, b) => a - b)) {
    if (!short) break;
    const r = pool.find((x) => !taken.has(x) && n(x, 'PPOS') === p);
    if (!r) continue;
    // the slot comes from the position the donor is shortest at (one it does not play at all, e.g. FB)
    const miss = (s: number) => shortPos.filter((x) => x === s).length;
    const give = shortPos.reduce((best, s, k) => (miss(s) > miss(shortPos[best]!) ? k : best), 0);
    take(r, p, false); short--; improvised.push(`${positionName(shortPos[give]!)} slot given to the donor's ${positionName(p)} ${nameOf(r)} (${n(r, 'POVR')})`); shortPos.splice(give, 1);
  }
  for (const p of shortPos) {
    let r: Row | undefined;
    for (const f of FALLBACK[p] ?? []) { r = pool.find((x) => !taken.has(x) && n(x, 'PPOS') === f); if (r) break; }
    r ??= pool.find((x) => !taken.has(x));
    if (!r) throw new Error('donor ran out of players');
    take(r, p, true); improvised.push(`${positionName(p)} filled by ${positionName(n(r, 'PPOS'))} ${nameOf(r)} (${n(r, 'POVR')})`);
  }

  // PLST rows in PGID order receive the chosen players in position order, best first; slot = rank
  const rows = [...target].sort((a, b) => Number(plst.get(a, 'PGID')) - Number(plst.get(b, 'PGID')));
  const order = [...chosen].sort((a, b) => n(a.r, 'PPOS') - n(b.r, 'PPOS') || byOvr(a.r, b.r));
  const others = new Set<number>(); for (let i = 0; i < plst.recordCount; i++) if (Number(plst.get(i, 'TGID')) !== tgid) others.add(Number(plst.get(i, 'PGID')));
  const newPgid = new Map<Row, number>(); const players: SwappedPlayer[] = [];
  order.forEach((c, slot) => {
    const i = rows[slot]!, pgid = tgid * stride + slot;
    if (others.has(pgid)) throw new Error(`PGID ${pgid} is already used by another PLST team`);
    for (const f of plst.fields) {
      if (f.name === 'PGID' || f.name === 'POID' || f.name === 'TGID' || !(f.name in c.r)) continue;
      if (f.type === 13 || f.type === 14) continue; // varchar (extra-data) fields: not in PLST, never copied
      put(plst, i, f.name, c.r[f.name]!);
    }
    plst.set(i, 'PGID', pgid); if (plst.fieldMap.has('POID')) plst.set(i, 'POID', pgid);
    newPgid.set(c.r, pgid);
    players.push({ pgid, name: nameOf(c.r), pos: positionName(n(c.r, 'PPOS')), ovr: n(c.r, 'POVR'), ...(c.improvised ? { asPos: positionName(c.as) } : {}) });
  });

  // DCST: same rows and spots (PPOS, ddep); each spot takes the donor's depth order among players of that position, then
  // its other players at that position, then the rest of its depth order (a stored chart can predate the roster: a guard
  // listed at LS while a real long snapper exists), then stand-ins (return men by speed, long snapper from C/TE), then
  // anyone by overall
  const donorDepth = new Map<number, Row[]>();
  for (const d of [...donor.depth].sort((a, b) => n(a, 'ddep') - n(b, 'ddep'))) { const p = n(d, 'PPOS'); if (!donorDepth.has(p)) donorDepth.set(p, []); donorDepth.get(p)!.push(d); }
  const byPgid = new Map(donor.players.map((r) => [n(r, 'PGID'), r]));
  const spots = new Map<number, number[]>();
  for (const i of depthRows) { const p = Number(dcst.get(i, 'PPOS')); if (!spots.has(p)) spots.set(p, []); spots.get(p)!.push(i); }
  const picks = [...chosen.map((c) => c.r)];
  for (const [p, idx] of spots) {
    idx.sort((a, b) => Number(dcst.get(a, 'ddep')) - Number(dcst.get(b, 'ddep')));
    const cands: { r: Row; own: boolean }[] = [];
    const add = (r: Row | undefined, own: boolean) => { if (r && newPgid.has(r) && !cands.some((c) => c.r === r)) cands.push({ r, own }); };
    const listed = (donorDepth.get(p) ?? []).map((d) => byPgid.get(n(d, 'PGID')));
    for (const r of listed) if (r && n(r, 'PPOS') === p) add(r, true);
    for (const r of picks.filter((r) => n(r, 'PPOS') === p).sort(byOvr)) add(r, true);
    for (const r of listed) add(r, true);
    const speed = (a: Row, b: Row) => n(b, 'PSPD') - n(a, 'PSPD') || byOvr(a, b);
    for (const f of FALLBACK[p] ?? []) for (const r of picks.filter((r) => n(r, 'PPOS') === f).sort(p === 21 || p === 22 ? speed : byOvr)) add(r, false);
    for (const r of [...picks].sort(byOvr)) add(r, false);
    idx.forEach((i, k) => {
      const c = cands[k]!;
      dcst.set(i, 'PGID', newPgid.get(c.r)!);
      if (!c.own) improvised.push(`depth ${positionName(p)} #${k + 1}: ${positionName(n(c.r, 'PPOS'))} ${nameOf(c.r)}`);
    });
  }

  const stat = (v: number[]) => ({ top: Math.max(...v), mean: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 });
  return { tgid, stride, count: N, players, ovr: { before: stat(before), after: stat(players.map((p) => p.ovr)) }, improvised, depthRows: depthRows.length };
}

// The TEAM row fields that make a generic slot look like the donor: school, nickname, abbreviations and colours.
export const TEAM_IDENTITY_FIELDS = ['TDNA', 'TMNA', 'TSNA', 'TLNA', 'TMNC', 'TBCR', 'TBCG', 'TBCB', 'TB2R', 'TB2G', 'TB2B'] as const;
// Copy the donor's identity fields into the TEAM row of `tgid` (a roster or dynasty file); returns the fields changed.
export function copyTeamIdentity(file: TdbFile, tgid: number, donorTeam: Row): string[] {
  const team = file.table('TEAM'); let ti = -1;
  for (let i = 0; i < team.recordCount; i++) if (Number(team.get(i, 'TGID')) === tgid) ti = i;
  if (ti < 0) throw new Error(`TEAM has no row for TGID ${tgid}`);
  const changed: string[] = [];
  for (const f of TEAM_IDENTITY_FIELDS) {
    if (!team.fieldMap.has(f) || !(f in donorTeam)) continue;
    const old = team.get(ti, f); put(team, ti, f, donorTeam[f]!);
    if (team.get(ti, f) !== old) changed.push(`${f} ${JSON.stringify(old)} -> ${JSON.stringify(team.get(ti, f))}`);
  }
  return changed;
}

// Real rosters on the generic teams by default (the roster tooling's generics.ts plan): identity fields set on existing
// PLST rows by PGID, nothing else (each row keeps its position, ratings, face and body; no row added or removed).
export const GENERIC_FILL_FIELDS = ['PFNA', 'PLNA', 'PJEN', 'PYEA', 'PRSD', 'PHGT', 'PWGT'] as const;
export interface GenericFillRow { pgid: number; tgid: number; fields: Record<string, FieldValue> }
export function fillGenericRows(stda: TdbFile, rows: readonly GenericFillRow[]): { rows: number; cells: number; teams: number[] } {
  const t = stda.table('PLST'); const at = new Map<number, number>();
  for (let i = 0; i < t.recordCount; i++) at.set(Number(t.get(i, 'PGID')), i);
  let cells = 0; const teams = new Set<number>();
  for (const r of rows) {
    if (r.tgid < 160 || r.tgid > 164) throw new RangeError(`PGID ${r.pgid}: team ${r.tgid} is not a generic team (160-164)`);
    const i = at.get(r.pgid); if (i === undefined) throw new Error(`PLST has no row PGID ${r.pgid}`);
    if (Number(t.get(i, 'TGID')) !== r.tgid) throw new Error(`PLST PGID ${r.pgid} belongs to team ${t.get(i, 'TGID')}, not ${r.tgid}`);
    for (const [k, v] of Object.entries(r.fields)) {
      if (!(GENERIC_FILL_FIELDS as readonly string[]).includes(k)) throw new Error(`PGID ${r.pgid}: field ${k} is not an identity field (${GENERIC_FILL_FIELDS.join(' ')})`);
      if (typeof v === 'number' && (v < 0 || v >= 2 ** t.field(k).bits)) throw new RangeError(`PGID ${r.pgid}: ${k} ${v} does not fit ${t.field(k).bits} bits`);
      if (t.get(i, k) !== v) { t.set(i, k, v); cells++; }
    }
    teams.add(r.tgid);
  }
  return { rows: rows.length, cells, teams: [...teams].sort((a, b) => a - b) };
}
// A plan row (the roster tools' generics.ts) also carries the position and rating of the stock row it was matched to.
// A row whose PLST row is gone or now has another team, position or rating (a swap put other players there) is stale:
// it must not take the plan's identity.
export interface GenericPlanRow extends GenericFillRow { ppos: number; povr: number }
function plstIndex(stda: TdbFile): { t: TdbTable; at: Map<number, number> } {
  const t = stda.table('PLST'); const at = new Map<number, number>();
  for (let i = 0; i < t.recordCount; i++) at.set(Number(t.get(i, 'PGID')), i);
  return { t, at };
}
export function staleGenericRows<R extends GenericPlanRow>(stda: TdbFile, rows: readonly R[]): R[] {
  const { t, at } = plstIndex(stda);
  return rows.filter((r) => { const i = at.get(r.pgid); return i === undefined || Number(t.get(i, 'TGID')) !== r.tgid || Number(t.get(i, 'PPOS')) !== r.ppos || Number(t.get(i, 'POVR')) !== r.povr; });
}
// How many rows already carry every identity value the plan gives them.
export function filledGenericRows(stda: TdbFile, rows: readonly GenericFillRow[]): number {
  const { t, at } = plstIndex(stda);
  return rows.filter((r) => { const i = at.get(r.pgid); return i !== undefined && Object.entries(r.fields).every(([k, v]) => t.get(i, k) === v); }).length;
}
