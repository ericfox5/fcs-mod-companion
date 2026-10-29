// Player headshots. The league keeps real photos of its FCS players (one JPEG per player, named <Team>__<First>_<Last>.jpg,
// listed in player_photos_manifest.csv by the downloader that fetched them from the schools' roster pages) and the game's
// face art (face_<n>.png, one per in-game head id). At import every player whose team + name matches a photo gets its key.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DynastyExport } from '@ncaa/ncaa14';

export const normName = (s: string): string => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '').length);
}

export interface PhotoIndex { dir: string; byKey: Map<string, string>; files: string[] }

export function loadPhotoIndex(dir: string | undefined): PhotoIndex | null {
  if (!dir) return null;
  const manifest = join(dir, 'player_photos_manifest.csv');
  if (!existsSync(manifest)) return null;
  const rows = parseCsv(readFileSync(manifest, 'utf8').replace(/^﻿/, ''));
  const head = rows[0]!.map((h) => h.trim());
  const col = (name: string) => head.indexOf(name);
  const [iStatus, iFile, iName, iTeam] = [col('status'), col('filename'), col('full_name'), col('team_name')];
  const byKey = new Map<string, string>();
  const files: string[] = [];
  for (const r of rows.slice(1)) {
    if (r[iStatus] !== 'downloaded' || !r[iFile]) continue;
    if (!existsSync(join(dir, 'player_photos', r[iFile]!))) continue;
    const k = `${normName(r[iTeam]!)}|${normName(r[iName]!)}`;
    if (!byKey.has(k)) byKey.set(k, r[iFile]!);
    files.push(r[iFile]!);
  }
  return { dir, byKey, files };
}

export const photoKeyFor = (idx: PhotoIndex, teamName: string | undefined, first: string, last: string): string | null => {
  if (!teamName) return null;
  const f = idx.byKey.get(`${normName(teamName)}|${normName(first + last)}`);
  return f ? `players/${f}` : null;
};

// Marks every player of a decoded dynasty with its photo key; returns how many matched.
export function attachPhotoKeys(ex: DynastyExport, idx: PhotoIndex | null): number {
  if (!idx) return 0;
  const teamName = new Map(ex.teams.map((t) => [t.tgid, t.name]));
  let n = 0;
  for (const p of ex.players) {
    const key = photoKeyFor(idx, teamName.get(p.tgid), p.firstName, p.lastName);
    if (key) { (p as typeof p & { photoKey?: string }).photoKey = key; n++; }
  }
  return n;
}
