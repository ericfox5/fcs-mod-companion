// Roster slots and player ids. The game keys a player by PGID = TGID * PGID_STRIDE + slot and fills ROSTER_SLOTS of
// the PGID_STRIDE slots per team (slot 69 stays free; the online team copies once keyed a 70th player to PGID_NONE).
// Every PGID arithmetic in this repo goes through these helpers so a stride change (the 100-player roster project,
// docs/roster-stride-inventory.md) is one constant here plus the game patch.
import type { TdbFile, TdbTable, FieldValue } from '@ncaa/tdb';

export const PGID_STRIDE = 70;
export const ROSTER_SLOTS = 69;
export const PGID_NONE = 65535;
export const STRIDES = [70, 100] as const;

export const teamOfPgid = (pgid: number, stride = PGID_STRIDE): number => Math.floor(pgid / stride);
export const slotOfPgid = (pgid: number, stride = PGID_STRIDE): number => pgid % stride;
export const pgidOf = (tgid: number, slot: number, stride = PGID_STRIDE): number => tgid * stride + slot;

// The stride a PLAY table is keyed with: the candidate under which most rows satisfy PGID / stride == TGID (the game
// re-keys departed players into unused team ranges, so a few rows never match). null when no candidate reaches half.
export function detectStride(play: TdbTable, candidates: readonly number[] = STRIDES): number | null {
  const n = play.recordCount; if (!n) return null;
  let best: number | null = null, bestShare = 0;
  for (const s of candidates) {
    let hit = 0;
    for (let i = 0; i < n; i++) { const pgid = Number(play.get(i, 'PGID')); if (pgid !== PGID_NONE && Math.floor(pgid / s) === Number(play.get(i, 'TGID'))) hit++; }
    const share = hit / n;
    if (share > bestShare) { best = s; bestShare = share; }
  }
  return bestShare >= 0.5 ? best : null;
}

export interface RekeyResult { from: number; to: number; rekeyed: number; kept: number; overflow: number; perTable: string[]; playMax: [number, number]; teams: number }
// Columns that hold a PGID under another name, re-keyed with every PGID column. Found by matching value / stride to the
// row's TGID in real saves: PLAY.POID (the id a player was created with; the roster tooling and offline roster saves
// keep POID == PGID), TEAM's captains and featured players (OCAP/DCAP; TPIO best and TSI1 second-best offensive player,
// TMPI best and TSI2 second-best defensive player) and SSUM's season-summary player ids.
export const PGID_ALIASES: Readonly<Record<string, readonly string[]>> = {
  PLAY: ['POID'],
  TEAM: ['OCAP', 'DCAP', 'TPIO', 'TMPI', 'TSI1', 'TSI2'],
  SSUM: ['SSFI', 'SSPI', 'SSTI'],
};
// Re-key every PGID column of every table from one stride to another by arithmetic (team = id / from, slot = id % from),
// and grow PLAY to teams x to. PGID_NONE, 0 and ids that would not fit their field are left as they are.
export function rekeyStride(file: TdbFile, opts: { from: number; to: number }): RekeyResult {
  const { from, to } = opts;
  if (!(to > from)) throw new RangeError(`stride ${to} must be larger than ${from}`);
  const play = file.table('PLAY');
  const teams = Math.floor(play.header.maxRecords / from);
  let rekeyed = 0, kept = 0, overflow = 0; const perTable: string[] = [];
  for (const t of file.tables) {
    for (const col of ['PGID', ...(PGID_ALIASES[t.name] ?? [])]) {
      if (!t.fieldMap.has(col)) continue;
      const f = t.field(col); const limit = 2 ** f.bits; let n = 0, k = 0, ov = 0;
      for (let i = 0; i < t.recordCount; i++) {
        const v = Number(t.get(i, col));
        if (v === PGID_NONE || v === 0) { k++; continue; }
        const nv = pgidOf(teamOfPgid(v, from), slotOfPgid(v, from), to);
        if (nv >= limit) { ov++; continue; }
        t.set(i, col, nv); n++;
      }
      rekeyed += n; kept += k; overflow += ov;
      if (n || ov) perTable.push(`${t.name}${col === 'PGID' ? '' : `.${col}`} ${n}${ov ? ` (${ov} left: would overflow ${f.bits} bits)` : ''}`);
    }
  }
  const oldMax = play.header.maxRecords;
  if (teams * to > oldMax) play.growTable(teams * to);
  return { from, to, rekeyed, kept, overflow, perTable, playMax: [oldMax, play.header.maxRecords], teams };
}

// How many of a stride's slots a team may fill: the game's own one-slot margin (69 of 70) carried over (99 of 100).
export const rosterSlots = (stride = PGID_STRIDE): number => Math.min(ROSTER_SLOTS + (stride - PGID_STRIDE), stride);

// The unused PGIDs of a team's slot range, lowest first (slots = how many of the stride the game is allowed to fill;
// the default keeps the game's own one-slot margin). A transfer keeps the PGID of his old team, so a team's free slots
// and its player count by TGID are different things.
export function freePgids(play: TdbTable, tgid: number, opts: { stride?: number; slots?: number } = {}): number[] {
  const stride = opts.stride ?? PGID_STRIDE, slots = opts.slots ?? rosterSlots(stride);
  const used = new Set<number>();
  for (let i = 0; i < play.recordCount; i++) used.add(Number(play.get(i, 'PGID')));
  const free: number[] = [];
  for (let s = 0; s < slots; s++) { const pgid = pgidOf(tgid, s, stride); if (!used.has(pgid)) free.push(pgid); }
  return free;
}
// The first unused PGID of a team's slot range, or null when the team is full.
export function allocatePgid(play: TdbTable, tgid: number, opts: { stride?: number; slots?: number } = {}): number | null {
  return freePgids(play, tgid, opts)[0] ?? null;
}

// A new PLAY row: a copy of a template row (by default the team's first player) with PGID/TGID/POID assigned and the
// given fields written over it. Throws when the team has no free slot or PLAY has no capacity; the caller re-serializes.
// The stride defaults to the one the file is keyed with.
// pgid: use this id instead of allocating one (restoring a row the console dropped); it must be unused.
export interface NewPlayer { tgid: number; template?: number; fields?: Record<string, FieldValue>; stride?: number; slots?: number; pgid?: number }
export function addPlayer(file: TdbFile, p: NewPlayer): { pgid: number; row: number } {
  const play = file.table('PLAY');
  const stride = p.stride ?? detectStride(play) ?? PGID_STRIDE;
  let pgid: number | null;
  if (p.pgid !== undefined) { pgid = p.pgid; for (let i = 0; i < play.recordCount; i++) if (Number(play.get(i, 'PGID')) === pgid) throw new RangeError(`PGID ${pgid} is already in PLAY`); }
  else pgid = allocatePgid(play, p.tgid, { stride, slots: p.slots });
  if (pgid === null) throw new RangeError(`team ${p.tgid}: no free roster slot`);
  if (play.recordCount >= play.header.maxRecords) throw new RangeError(`PLAY is full (${play.header.maxRecords} rows); grow it first`);
  let tpl = -1;
  for (let i = 0; i < play.recordCount; i++) {
    const g = Number(play.get(i, p.template !== undefined ? 'PGID' : 'TGID'));
    if (g === (p.template ?? p.tgid)) { tpl = i; break; }
  }
  if (tpl < 0) throw new Error(p.template !== undefined ? `template PGID ${p.template} not in PLAY` : `team ${p.tgid} has no PLAY row to copy from`);
  const values: Record<string, FieldValue> = { ...play.row(tpl), ...(p.fields ?? {}), PGID: pgid, TGID: p.tgid };
  if (play.fieldMap.has('POID')) values.POID = pgid;
  const row = play.appendRecord(values);
  return { pgid, row };
}

// TEAM's player references from the team's own players, for a roster whose slots were refilled (the 90-man build puts
// different people in the slots a stride re-key keeps): TPIO / TSI1 the best and second-best offensive player (PPOS
// 0..9) by POVR, TMPI / TSI2 the same on defense (10..18), as in stock saves; OCAP / DCAP the best-rated senior on each
// side (stock captains follow no stored field, so any sensible pick is as good). A team without players gets the slot
// its stale value names in its own range, as the stock generic teams have (an id nobody holds). Returns cells changed.
export function setTeamPlayerRefs(file: TdbFile, opts: { stride?: number } = {}): { teams: number; changed: number } {
  const play = file.table('PLAY'), team = file.table('TEAM');
  const stride = opts.stride ?? detectStride(play) ?? PGID_STRIDE;
  interface P { pgid: number; pos: number; ovr: number; yr: number }
  const byTeam = new Map<number, P[]>();
  for (let i = 0; i < play.recordCount; i++) {
    const t = Number(play.get(i, 'TGID')); if (!byTeam.has(t)) byTeam.set(t, []);
    byTeam.get(t)!.push({ pgid: Number(play.get(i, 'PGID')), pos: Number(play.get(i, 'PPOS')), ovr: Number(play.get(i, 'POVR')), yr: Number(play.get(i, 'PYEA')) });
  }
  const byOvr = (a: P, b: P) => b.ovr - a.ovr || a.pgid - b.pgid, bySenior = (a: P, b: P) => b.yr - a.yr || byOvr(a, b);
  let teams = 0, changed = 0;
  const put = (i: number, col: string, v: number | undefined) => { if (v === undefined || !team.fieldMap.has(col)) return; if (Number(team.get(i, col)) !== v) { team.set(i, col, v); changed++; } };
  for (let i = 0; i < team.recordCount; i++) {
    const tgid = Number(team.get(i, 'TGID')), ps = byTeam.get(tgid) ?? [];
    if (!ps.length) {
      for (const col of PGID_ALIASES.TEAM!) {
        if (!team.fieldMap.has(col)) continue; const v = Number(team.get(i, col)); if (v === PGID_NONE || v === 0) continue;
        for (const from of STRIDES) if (from !== stride && teamOfPgid(v, from) === tgid) { put(i, col, pgidOf(tgid, slotOfPgid(v, from), stride)); break; }
      }
      continue;
    }
    const off = ps.filter((p) => p.pos <= 9), def = ps.filter((p) => p.pos >= 10 && p.pos <= 18);
    const o = [...off].sort(byOvr), d = [...def].sort(byOvr);
    put(i, 'TPIO', o[0]?.pgid); put(i, 'TSI1', o[1]?.pgid); put(i, 'TMPI', d[0]?.pgid); put(i, 'TSI2', d[1]?.pgid);
    put(i, 'OCAP', [...off].sort(bySenior)[0]?.pgid); put(i, 'DCAP', [...def].sort(bySenior)[0]?.pgid);
    teams++;
  }
  return { teams, changed };
}

// Remove PLAY rows by PGID (highest row index first, so the indices stay valid); returns the ids actually removed.
export function removePlayers(file: TdbFile, pgids: number[]): number[] {
  const play = file.table('PLAY'); const want = new Set(pgids); const hits: { i: number; pgid: number }[] = [];
  for (let i = 0; i < play.recordCount; i++) { const g = Number(play.get(i, 'PGID')); if (want.has(g)) hits.push({ i, pgid: g }); }
  hits.sort((a, b) => b.i - a.i);
  for (const h of hits) play.removeRecord(h.i);
  return hits.map((h) => h.pgid);
}
