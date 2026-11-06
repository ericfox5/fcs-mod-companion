import type { TdbFile } from '@ncaa/tdb';

// Offseason transfers ("Players Leaving" week). TRAN holds one row per player leaving by transfer: PGID, PTID (the
// destination team), TRYR and TRAC (0 and 1 on every row seen); PLSS adds WTLS per transferring player (70..245 seen).
// The player's own PLAY row carries PTYP 1 and the reason in PLFL (9 leaving, 10/11 playing time, 14 coach leaving,
// 15 home sick). The console merges web edits to TRAN by PGID (TRAZ, spike/blaze NOTES 2026-11-01).
export interface Transfer {
  pgid: number;
  toTgid: number; // PTID
  year: number; // TRYR
  active: number; // TRAC
  weight: number | null; // PLSS.WTLS
}

export function decodeTransfers(file: TdbFile): Transfer[] {
  if (!file.hasTable('TRAN')) return [];
  const weight = new Map<number, number>();
  if (file.hasTable('PLSS')) for (const r of file.table('PLSS').rows()) weight.set(r['PGID'] as number, r['WTLS'] as number);
  const out: Transfer[] = [];
  for (const r of file.table('TRAN').rows()) {
    const pgid = r['PGID'] as number;
    out.push({ pgid, toTgid: r['PTID'] as number, year: r['TRYR'] as number, active: r['TRAC'] as number, weight: weight.get(pgid) ?? null });
  }
  return out;
}
