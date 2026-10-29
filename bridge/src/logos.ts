// Team and conference logos: bridge/data/logos.json maps normalized team display names (TEAM.TDNA) and conference names
// (CONF.CNAM) to object keys under R2 logos/. At import every matched team/conference gets its key.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DynastyExport } from '@ncaa/ncaa14';

export interface LogoMap { teams: Record<string, { key: string; espn?: string }>; conferences: Record<string, string> }
export const normLogoName = (s: string): string => (s ?? '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
export const logoDataPath = (): string => join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'logos.json');
export const loadLogoMap = (): LogoMap => JSON.parse(readFileSync(logoDataPath(), 'utf8'));

export function attachLogoKeys(ex: DynastyExport, map: LogoMap = loadLogoMap()): { teams: number; conferences: number; missing: string[] } {
  let teams = 0, conferences = 0;
  const missing: string[] = [];
  for (const t of ex.teams) {
    const hit = map.teams[normLogoName(t.name)] ?? map.teams[normLogoName(t.longName)] ?? map.teams[normLogoName(`${t.name} ${t.mascot}`)];
    if (hit) { (t as typeof t & { logoKey?: string }).logoKey = hit.key; teams++; } else if (t.tgid < 300) missing.push(t.name);
  }
  for (const c of ex.conferences) {
    const key = map.conferences[normLogoName(c.name)];
    if (key) { (c as typeof c & { logoKey?: string }).logoKey = key; conferences++; }
  }
  return { teams, conferences, missing };
}
