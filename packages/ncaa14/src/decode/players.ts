import type { TdbFile } from '@ncaa/tdb';
import { positionName, classYear } from '../positions.js';

export interface Player {
  pgid: number;
  tgid: number;
  firstName: string;
  lastName: string;
  pos: number;
  position: string;
  year: number; // PYEA 0..3
  redshirt: number; // PRSD
  classLabel: string;
  jersey: number; // PJEN
  overall: number; // POVR
  heightInches: number; // PHGT
  weight: number; // PWGT (+160 lb offset in EA games)
  gamesPlayed: number; // sgmp
  headId: number; // PGHE: in-game head/face art id (1..246)
  ratings: Record<string, number>; // every other numeric field by code
  raw: Record<string, number | string>;
}

const CORE = new Set(['PGID', 'TGID', 'PFNA', 'PLNA', 'PPOS', 'PYEA', 'PRSD', 'PJEN', 'POVR', 'PHGT', 'PWGT', 'sgmp', 'PGHE']);

export function decodePlayers(file: TdbFile): Player[] {
  const t = file.table('PLAY');
  const out: Player[] = [];
  for (const r of t.rows()) {
    const ratings: Record<string, number> = {};
    for (const [k, v] of Object.entries(r)) if (!CORE.has(k) && typeof v === 'number') ratings[k] = v;
    const pos = r['PPOS'] as number;
    const year = r['PYEA'] as number;
    const rs = r['PRSD'] as number;
    out.push({
      pgid: r['PGID'] as number, tgid: r['TGID'] as number, firstName: r['PFNA'] as string, lastName: r['PLNA'] as string,
      pos, position: positionName(pos), year, redshirt: rs, classLabel: classYear(year, rs), jersey: r['PJEN'] as number,
      overall: r['POVR'] as number, heightInches: r['PHGT'] as number, weight: (r['PWGT'] as number) + 160, gamesPlayed: (r['sgmp'] as number) ?? 0, headId: (r['PGHE'] as number) ?? 0,
      ratings, raw: r,
    });
  }
  return out;
}
