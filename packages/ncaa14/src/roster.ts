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
// Re-key every PGID column of every table from one stride to another by arithmetic (team = id / from, slot = id % from),
// and grow PLAY to teams x to. PGID_NONE, 0 and ids that would not fit their field are left as they are.
export function rekeyStride(file: TdbFile, opts: { from: number; to: number }): RekeyResult {
  const { from, to } = opts;
  if (!(to > from)) throw new RangeError(`stride ${to} must be larger than ${from}`);
  const play = file.table('PLAY');
  const teams = Math.floor(play.header.maxRecords / from);
  let rekeyed = 0, kept = 0, overflow = 0; const perTable: string[] = [];
  for (const t of file.tables) {
    if (!t.fieldMap.has('PGID')) continue;
    const f = t.field('PGID'); const limit = 2 ** f.bits; let n = 0, k = 0, ov = 0;
    for (let i = 0; i < t.recordCount; i++) {
      const v = Number(t.get(i, 'PGID'));
      if (v === PGID_NONE || v === 0) { k++; continue; }
      const nv = pgidOf(teamOfPgid(v, from), slotOfPgid(v, from), to);
      if (nv >= limit) { ov++; continue; }
      t.set(i, 'PGID', nv); n++;
    }
    rekeyed += n; kept += k; overflow += ov;
    if (n || ov) perTable.push(`${t.name} ${n}${ov ? ` (${ov} left: would overflow ${f.bits} bits)` : ''}`);
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

// Remove PLAY rows by PGID (highest row index first, so the indices stay valid); returns the ids actually removed.
export function removePlayers(file: TdbFile, pgids: number[]): number[] {
  const play = file.table('PLAY'); const want = new Set(pgids); const hits: { i: number; pgid: number }[] = [];
  for (let i = 0; i < play.recordCount; i++) { const g = Number(play.get(i, 'PGID')); if (want.has(g)) hits.push({ i, pgid: g }); }
  hits.sort((a, b) => b.i - a.i);
  for (const h of hits) play.removeRecord(h.i);
  return hits.map((h) => h.pgid);
}
