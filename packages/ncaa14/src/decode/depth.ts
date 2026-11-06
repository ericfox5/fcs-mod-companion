import type { TdbFile } from '@ncaa/tdb';

// DCHT: 88 rows per team, a fixed number of slots per position (DEPTH_SLOTS); ddep is the 0-based depth.
export interface DepthChartEntry { tgid: number; pos: number; depth: number; pgid: number }
export const DEPTH_SLOTS: Record<number, number> = { 0: 3, 1: 4, 2: 3, 3: 6, 4: 3, 5: 3, 6: 3, 7: 3, 8: 3, 9: 3, 10: 3, 11: 3, 12: 5, 13: 3, 14: 4, 15: 3, 16: 5, 17: 3, 18: 3, 19: 3, 20: 3, 21: 5, 22: 5, 23: 3, 24: 3 };

export function decodeDepthChart(file: TdbFile): DepthChartEntry[] {
  if (!file.hasTable('DCHT')) return [];
  return [...file.table('DCHT').rows()].map((r) => ({ tgid: r['TGID'] as number, pos: r['PPOS'] as number, depth: r['ddep'] as number, pgid: r['PGID'] as number }));
}

// PLSU ("Formation Subs"): one row per overridden slot. The columns are PGID, TGID, PFPI (4 bits), PLFO (10 bits) and
// PFIO (1 bit); the game's own files seen so far hold no rows, so the reading below (slot index, playbook set id,
// offense flag) is the site's and is unverified against the console.
export interface FormationSubEntry { tgid: number; side: number; setId: number; slot: number; pgid: number }
export function decodeFormationSubs(file: TdbFile): FormationSubEntry[] {
  if (!file.hasTable('PLSU')) return [];
  return [...file.table('PLSU').rows()].map((r) => ({ tgid: r['TGID'] as number, side: r['PFIO'] as number, setId: r['PLFO'] as number, slot: r['PFPI'] as number, pgid: r['PGID'] as number }));
}
