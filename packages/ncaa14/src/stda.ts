// The game's standard-data DB (archive entry hash b57b5e0ae8e74714: in qkl_boot.ast and as file 4664 of qkl_fe2ig.ast,
// stored uncompressed) keeps the rosters of the teams that have no PLAY rows of their own: PLST holds their players and
// DCST their depth charts. Teams 160-164 are the generic opponents (TEAM.TTYP 1; the game reads their players from PLST
// instead of PLAY, 0x232cd8), 610-619 a second set of stored teams. Their ids are keyed TGID * stride + slot like every
// PGID, and the 100-player roster patch turns a PGID into its team by / 100 (0x44098c) where the stock game used / 70:
// stored rosters left at 70 resolve to the wrong team (a generic player read from another team's PLAY row). These
// functions re-key them; in that DB only PLST.PGID, PLST.POID and DCST.PGID hold these ids.
import { parseTdb, serializeTdb, verifyTdb, FILE_HEADER_SIZE, DIR_ENTRY_SIZE, TABLE_HEADER_SIZE, EOF_CRC_SIZE, type TdbFile, type TdbTable } from '@ncaa/tdb';
import { STRIDES, pgidOf, slotOfPgid, teamOfPgid } from './roster.js';

export const STDA_ENTRY_HASH = 0xb57b5e0ae8e74714n;
export const GENERIC_ROSTER_COLUMNS: readonly (readonly [table: string, column: string])[] = [['PLST', 'PGID'], ['PLST', 'POID'], ['DCST', 'PGID']];

export const isStandardDataDb = (file: TdbFile): boolean => file.hasTable('PLST') && file.hasTable('DCST');

// The stride PLST is keyed with: the candidate under which most rows satisfy PGID / stride == TGID (null below half).
export function genericRosterStride(file: TdbFile, candidates: readonly number[] = STRIDES): number | null {
  const t = file.table('PLST'); const n = t.recordCount; if (!n) return null;
  let best: number | null = null, bestShare = 0;
  for (const s of candidates) {
    let hit = 0;
    for (let i = 0; i < n; i++) if (teamOfPgid(Number(t.get(i, 'PGID')), s) === Number(t.get(i, 'TGID'))) hit++;
    if (hit / n > bestShare) { best = s; bestShare = hit / n; }
  }
  return bestShare >= 0.5 ? best : null;
}

export interface GenericRekeyResult { from: number; to: number; cells: number; perColumn: Record<string, number>; skipped: number; teams: number[] }
// Re-key PLST.PGID / PLST.POID / DCST.PGID from the stride PLST is keyed with to `to` (team = TGID of the row, slot =
// id % from), keeping row order. A cell whose id does not belong to its row's team at the old stride is left alone
// (counted in skipped). Already at `to`: nothing changes (cells 0).
export function rekeyGenericRosters(file: TdbFile, opts: { to?: number } = {}): GenericRekeyResult {
  const to = opts.to ?? 100;
  const from = genericRosterStride(file);
  if (from === null) throw new Error('PLST: no stride fits its ids (not a standard-data DB, or keyed some other way)');
  const perColumn: Record<string, number> = {}; const teams = new Set<number>(); let cells = 0, skipped = 0;
  if (from === to) return { from, to, cells, perColumn, skipped, teams: [] };
  for (const [name, col] of GENERIC_ROSTER_COLUMNS) {
    const t = file.table(name); const limit = 2 ** t.field(col).bits; let n = 0;
    for (let i = 0; i < t.recordCount; i++) {
      const v = Number(t.get(i, col)), tgid = Number(t.get(i, 'TGID'));
      if (teamOfPgid(v, from) !== tgid) { skipped++; continue; }
      const nv = pgidOf(tgid, slotOfPgid(v, from), to);
      if (nv >= limit) throw new RangeError(`${name}.${col} row ${i}: ${nv} does not fit ${t.field(col).bits} bits`);
      t.set(i, col, nv); n++; teams.add(tgid);
    }
    perColumn[`${name}.${col}`] = n; cells += n;
  }
  return { from, to, cells, perColumn, skipped, teams: [...teams].sort((a, b) => a - b) };
}

// Where each table sits in the image: the directory gives the offset (tables matched to entries by raw name, in order).
function tablePositions(file: TdbFile): Map<TdbTable, number> {
  const dataStart = FILE_HEADER_SIZE + file.directory.length * DIR_ENTRY_SIZE; const used = new Set<number>(); const out = new Map<TdbTable, number>();
  for (const t of file.tables) {
    const di = file.directory.findIndex((d, i) => !used.has(i) && d.nameRaw.length === t.nameRaw.length && d.nameRaw.every((b, j) => b === t.nameRaw[j]));
    if (di < 0) throw new Error(`table ${t.name}: no directory entry`);
    used.add(di); out.set(t, dataStart + file.directory[di]!.offset);
  }
  return out;
}

export interface StdaRewrite { bytes: Uint8Array; result: GenericRekeyResult; changed: [start: number, end: number][] }
// Re-key a standard-data DB image (the archive entry's bytes). The input must verify; the output has the same length,
// verifies, and differs from the input only inside PLST / DCST record data and the checksum that covers each of them
// (the next table's priorCrc word, or the EOF CRC for the last table). Anything else throws, so a caller can write the
// changed ranges into the archive in place. Already re-keyed: the input comes back with no changed ranges. `edit` runs
// on the re-keyed DB before it is written (a generic team swap, generic-swap.ts) under the same checks.
export function rewriteStandardData(bytes: Uint8Array, opts: { to?: number; edit?: (file: TdbFile) => void } = {}): StdaRewrite {
  const file = parseTdb(bytes);
  if (!isStandardDataDb(file)) throw new Error('not the standard-data DB (no PLST / DCST table)');
  const bad = verifyTdb(bytes, file); if (bad.length) throw new Error(`the DB does not verify before the change: ${JSON.stringify(bad.slice(0, 3))}`);
  const pos = tablePositions(file);
  const result = rekeyGenericRosters(file, opts);
  opts.edit?.(file);
  if (!result.cells && !opts.edit) return { bytes, result, changed: [] };
  const out = serializeTdb(file, { padTo: bytes.length });
  if (out.length !== bytes.length) throw new Error(`the rewritten DB is ${out.length} bytes, the original ${bytes.length}`);
  const back = parseTdb(out); const bad2 = verifyTdb(out, back); if (bad2.length) throw new Error(`the rewritten DB does not verify: ${JSON.stringify(bad2.slice(0, 3))}`);
  const allowed: [number, number][] = [];
  for (const name of ['PLST', 'DCST']) {
    const t = file.table(name), p = pos.get(t)!, k = file.tables.indexOf(t), next = file.tables[k + 1];
    const start = p + TABLE_HEADER_SIZE + t.fieldDefsRaw.length;
    allowed.push([start, start + t.data.length]);
    if (next) allowed.push([pos.get(next)!, pos.get(next)! + 4]); else allowed.push([file.header.dbSize - EOF_CRC_SIZE, file.header.dbSize]);
  }
  const changed: [number, number][] = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === bytes[i]) continue;
    if (!allowed.some(([a, b]) => i >= a && i < b)) throw new Error(`byte ${i} changed outside PLST / DCST and their checksums; refusing`);
    const last = changed[changed.length - 1];
    if (last && last[1] === i) last[1] = i + 1; else changed.push([i, i + 1]);
  }
  return { bytes: out, result, changed };
}
