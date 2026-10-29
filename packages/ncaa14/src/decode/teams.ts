import type { TdbFile } from '@ncaa/tdb';

export interface Team {
  tgid: number;
  name: string; // TDNA display name
  longName: string; // TLNA
  mascot: string; // TMNA
  abbr: string; // TSNA
  conferenceLabel: string; // TMCC
  cgid: number;
  dgid: number;
  teamType: number; // TTYP (0 normal)
  assetSlot: string; // CSAT: FBS asset slot the FCS mod maps this team onto
  stadiumId: number; // SGID
  wins: number; // TSWI
  losses: number; // TSLO
  confWins: number; // computed from the schedule in exportDynasty (TCWI/TCLO are all-time records)
  confLosses: number;
  allTimeWins: number; // TCWI
  allTimeLosses: number; // TCLO
  streak: number; // TSCS (signed)
  rankBcs: number; // TBRK
  rankCoaches: number; // TCRK
  rankMedia: number; // TMRK
  prestige: number; // TPRS is labelled 'Team Pride Sticker' by the DB editor config; treat as unknown
  overall: number; // TOVR
  raw: Record<string, number | string>;
}

export function decodeTeams(file: TdbFile): Team[] {
  const t = file.table('TEAM');
  const n = (r: Record<string, number | string>, k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  const s = (r: Record<string, number | string>, k: string) => (typeof r[k] === 'string' ? (r[k] as string) : '');
  return [...t.rows()].map((r) => ({
    tgid: n(r, 'TGID'), name: s(r, 'TDNA'), longName: s(r, 'TLNA'), mascot: s(r, 'TMNA'), abbr: s(r, 'TSNA'), conferenceLabel: s(r, 'TMCC'),
    cgid: n(r, 'CGID'), dgid: n(r, 'DGID'), teamType: n(r, 'TTYP'), assetSlot: s(r, 'CSAT'), stadiumId: n(r, 'SGID'),
    wins: n(r, 'TSWI'), losses: n(r, 'TSLO'), confWins: 0, confLosses: 0, allTimeWins: n(r, 'TCWI'), allTimeLosses: n(r, 'TCLO'), streak: n(r, 'TSCS'),
    rankBcs: n(r, 'TBRK'), rankCoaches: n(r, 'TCRK'), rankMedia: n(r, 'TMRK'), prestige: n(r, 'TPRS'), overall: n(r, 'TOVR'), raw: r,
  }));
}
