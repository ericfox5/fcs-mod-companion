import type { TdbFile } from '@ncaa/tdb';

// GSTA encodes the result: 1 = not played yet, 2 = away team won, 3 = home team won (verified on real saves).
export const GAME_STATUS = { SCHEDULED: 1, AWAY_WIN: 2, HOME_WIN: 3 } as const;
export const isPlayed = (status: number): boolean => status >= 2;
export const winnerTgid = (g: { status: number; homeTgid: number; awayTgid: number }): number | null => (g.status === 3 ? g.homeTgid : g.status === 2 ? g.awayTgid : null);

export interface Game {
  week: number; // SEWN
  gameNo: number; // SGNM (within week)
  yearOffset: number; // SEYR
  status: number; // GSTA 1 scheduled, 2 away win, 3 home win
  homeTgid: number; // GHTG
  awayTgid: number; // GATG
  homeScore: number; // GHSC
  awayScore: number; // GASC
  stadiumId: number; // SGID
  kickoffMinutes: number; // GTOD
  dayOfWeek: number; // GDAT
  weekType: number; // SEWT
  overtime: boolean; // GFOT
  userPlayed: boolean; // GFHU
  userTeamGame: boolean; // GUTE
  cpuPick: number; // CPCK
  homePick: number; // HPCK
  raw: Record<string, number | string>;
}

export function decodeSchedule(file: TdbFile): Game[] {
  const t = file.table('SCHD');
  const n = (r: Record<string, number | string>, k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  return [...t.rows()].map((r) => ({
    week: n(r, 'SEWN'), gameNo: n(r, 'SGNM'), yearOffset: n(r, 'SEYR'), status: n(r, 'GSTA'),
    homeTgid: n(r, 'GHTG'), awayTgid: n(r, 'GATG'), homeScore: n(r, 'GHSC'), awayScore: n(r, 'GASC'),
    stadiumId: n(r, 'SGID'), kickoffMinutes: n(r, 'GTOD'), dayOfWeek: n(r, 'GDAT'), weekType: n(r, 'SEWT'),
    overtime: n(r, 'GFOT') === 1, userPlayed: n(r, 'GFHU') === 1, userTeamGame: n(r, 'GUTE') === 1,
    cpuPick: n(r, 'CPCK'), homePick: n(r, 'HPCK'), raw: r,
  }));
}
