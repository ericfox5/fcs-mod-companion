import type { TdbFile } from '@ncaa/tdb';

export interface Coach {
  ccid: number;
  tgid: number;
  firstName: string;
  lastName: string;
  positionCode: number; // COPS
  userControlled: boolean; // CFUC
  age: number; // CAGE
  prestige: number; // CPRE
  offPlaybook: number; // COPK
  simRunPassOff: number; // COTR
  simRunPassDef: number; // CDTR
  careerWins: number; // CCWI
  careerLosses: number; // CCLO
  seasonWins: number; // CSWI
  seasonLosses: number; // CSLO
  raw: Record<string, number | string>;
}

export function decodeCoaches(file: TdbFile): Coach[] {
  const t = file.table('COCH');
  const n = (r: Record<string, number | string>, k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  return [...t.rows()].map((r) => ({
    ccid: n(r, 'CCID'), tgid: n(r, 'TGID'), firstName: r['CFNM'] as string, lastName: r['CLNM'] as string, positionCode: n(r, 'COPS'),
    userControlled: n(r, 'CFUC') === 1, age: n(r, 'CAGE'), prestige: n(r, 'CPRE'), offPlaybook: n(r, 'COPK'),
    simRunPassOff: n(r, 'COTR'), simRunPassDef: n(r, 'CDTR'), careerWins: n(r, 'CCWI'), careerLosses: n(r, 'CCLO'),
    seasonWins: n(r, 'CSWI'), seasonLosses: n(r, 'CSLO'), raw: r,
  }));
}
