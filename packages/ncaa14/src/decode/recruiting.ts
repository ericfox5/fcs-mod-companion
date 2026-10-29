import type { TdbFile } from '@ncaa/tdb';
import { positionName } from '../positions.js';

export interface Recruit {
  prsi: number;
  firstName: string;
  lastName: string;
  pos: number;
  position: string;
  stars: number; // RCCB
  rank: number; // RCRK (national)
  committed: boolean; // RCCM
  preScoutOverall: number; // RCOV
  overall: number; // POVR (true)
  stateCode: number; // PSTA
  hometownId: number; // RCHD
  importances: [number, number, number]; // IMP1..3 pitch ids
  heightInches: number;
  weight: number;
  raw: Record<string, number | string>;
}

export interface RecruitInterest { prsi: number; committedTgid: number; pointsToCommit: number; teams: { rank: number; tgid: number; points: number; prevPoints: number }[]; raw: Record<string, number | string> }
export interface BoardEntry { tgid: number; prsi: number; pointsThisWeek: number; pointsLastWeek: number; scoutPoints: number; order: number; playingTime: number; userSelected: boolean; raw: Record<string, number | string> }

export const NO_TEAM = 1023;

export function decodeRecruits(file: TdbFile): Recruit[] {
  if (!file.hasTable('RCPT')) return [];
  const n = (r: Record<string, number | string>, k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  return [...file.table('RCPT').rows()].map((r) => ({
    prsi: n(r, 'PRSI'), firstName: r['PFNA'] as string, lastName: r['PLNA'] as string, pos: n(r, 'PPOS'), position: positionName(n(r, 'PPOS')),
    stars: n(r, 'RCCB'), rank: n(r, 'RCRK'), committed: n(r, 'RCCM') === 1, preScoutOverall: n(r, 'RCOV'), overall: n(r, 'POVR'),
    stateCode: n(r, 'PSTA'), hometownId: n(r, 'RCHD'), importances: [n(r, 'IMP1'), n(r, 'IMP2'), n(r, 'IMP3')],
    heightInches: n(r, 'PHGT'), weight: n(r, 'PWGT') + 160, raw: r,
  }));
}

export function decodeRecruitInterest(file: TdbFile): RecruitInterest[] {
  if (!file.hasTable('RCPR')) return [];
  const n = (r: Record<string, number | string>, k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  return [...file.table('RCPR').rows()].map((r) => {
    const teams = [];
    for (let i = 1; i <= 10; i++) {
      const k = String(i).padStart(2, '0');
      const tgid = n(r, `PT${k}`);
      if (tgid !== NO_TEAM) teams.push({ rank: i, tgid, points: n(r, `PS${k}`), prevPoints: n(r, `PR${k}`) });
    }
    return { prsi: n(r, 'PRSI'), committedTgid: n(r, 'PTCM'), pointsToCommit: n(r, 'CMTS'), teams, raw: r };
  });
}

export function decodeRecruitingBoard(file: TdbFile): BoardEntry[] {
  if (!file.hasTable('RECB')) return [];
  const n = (r: Record<string, number | string>, k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  return [...file.table('RECB').rows()].map((r) => ({
    tgid: n(r, 'TGID'), prsi: n(r, 'PRSI'), pointsThisWeek: n(r, 'PPSC'), pointsLastWeek: n(r, 'PPSL'), scoutPoints: n(r, 'PSCP'),
    order: n(r, 'PROR'), playingTime: n(r, 'PEPV'), userSelected: n(r, 'USEL') === 1, raw: r,
  }));
}
