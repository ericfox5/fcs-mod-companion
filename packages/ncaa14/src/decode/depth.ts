import type { TdbFile } from '@ncaa/tdb';

export interface DepthChartEntry { tgid: number; pos: number; depth: number; pgid: number }

export function decodeDepthChart(file: TdbFile): DepthChartEntry[] {
  if (!file.hasTable('DCHT')) return [];
  return [...file.table('DCHT').rows()].map((r) => ({ tgid: r['TGID'] as number, pos: r['PPOS'] as number, depth: r['ddep'] as number, pgid: r['PGID'] as number }));
}
