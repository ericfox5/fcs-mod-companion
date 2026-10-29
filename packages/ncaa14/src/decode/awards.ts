import type { TdbFile } from '@ncaa/tdb';

export interface HeismanCandidate { rank: number; pgid: number; raw: Record<string, number | string> }
export interface AllAmerican { raw: Record<string, number | string> }

export function decodeHeisman(file: TdbFile): HeismanCandidate[] {
  if (!file.hasTable('HEIS')) return [];
  return [...file.table('HEIS').rows()].map((r) => ({ rank: r['HPRK'] as number, pgid: r['PGID'] as number, raw: r }));
}

export function decodeAllAmericans(file: TdbFile): AllAmerican[] {
  if (!file.hasTable('AAPL')) return [];
  return [...file.table('AAPL').rows()].map((r) => ({ raw: r }));
}
