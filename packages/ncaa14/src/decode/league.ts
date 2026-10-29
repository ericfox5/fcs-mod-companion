import type { TdbFile } from '@ncaa/tdb';

export interface SeasonInfo { week: number; year: number; yearOffset: number; stage: number; weekType: number; raw: Record<string, number | string> }
export interface CalendarWeek { week: number; stage: number; period: number; raw: Record<string, number | string> }
export interface Conference { cgid: number; name: string; leagueId: number; raw: Record<string, number | string> }
export interface Division { cgid: number; dgid: number; name: string; shortName: string }

export const BASE_YEAR = 2013;

export function decodeSeason(file: TdbFile): SeasonInfo {
  const t = file.table('SEAI');
  const r = t.row(0);
  const off = r['SEYR'] as number;
  return { week: r['SEWN'] as number, year: BASE_YEAR + off, yearOffset: off, stage: r['SEST'] as number, weekType: r['SEWT'] as number, raw: r };
}

export function decodeCalendar(file: TdbFile): CalendarWeek[] {
  const t = file.table('SCWE');
  return [...t.rows()].map((r) => ({ week: r['SEWN'] as number, stage: r['SEST'] as number, period: r['PPRD'] as number, raw: r }));
}

export function decodeConferences(file: TdbFile): Conference[] {
  const t = file.table('CONF');
  return [...t.rows()].map((r) => ({ cgid: r['CGID'] as number, name: r['CNAM'] as string, leagueId: r['LGID'] as number, raw: r }));
}

export function decodeDivisions(file: TdbFile): Division[] {
  if (!file.hasTable('DIVI')) return [];
  const t = file.table('DIVI');
  return [...t.rows()].map((r) => ({ cgid: r['CGID'] as number, dgid: r['DGID'] as number, name: r['DNAM'] as string, shortName: r['SDNM'] as string }));
}
