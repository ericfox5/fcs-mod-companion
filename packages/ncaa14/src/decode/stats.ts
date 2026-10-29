import type { TdbFile } from '@ncaa/tdb';

export type Row = Record<string, number | string>;

export const PLAYER_SEASON_TABLES = ['PSOF', 'PSDE', 'PSKI', 'PSKP', 'PSOL'] as const;
export const GAME_LOG_TABLES = ['BTES', 'BOFF', 'BDEF', 'BKIC', 'BKPR', 'BOLN'] as const;

export function decodeTeamSeasonStats(file: TdbFile): Row[] {
  return file.hasTable('TSSE') ? [...file.table('TSSE').rows()] : [];
}

export function decodeTeamHistory(file: TdbFile): Row[] {
  return file.hasTable('TSHS') ? [...file.table('TSHS').rows()] : [];
}

// Generic dump of a stats table: all populated rows with every field by code.
export function decodeRows(file: TdbFile, table: string): Row[] {
  return file.hasTable(table) ? [...file.table(table).rows()] : [];
}

export function decodePlayerSeasonStats(file: TdbFile): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const t of PLAYER_SEASON_TABLES) out[t] = decodeRows(file, t);
  return out;
}

export function decodeGameLogs(file: TdbFile): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const t of GAME_LOG_TABLES) out[t] = decodeRows(file, t);
  return out;
}
