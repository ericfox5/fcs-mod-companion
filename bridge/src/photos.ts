// Player headshots. The league keeps real photos of its FCS players in photo sets: a folder with player_photos/ (one
// image per player) and player_photos_manifest.csv (status, filename, full_name, team_name, ... as the downloader that
// fetched them from the schools' roster pages writes it). A roster year's pack from tools/photo-pack.py also carries
// tgid + game_first/game_last (+ pgid), the game's team id and the name exactly as the roster wrote it, so a dynasty on
// that roster matches its players outright; the team_name + full_name columns are the fallback for every set. The
// game's face art (face_<n>.png, one per in-game head id) is uploaded beside them. At import every player whose
// team + name matches a photo gets its key (players/<file>).
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

export interface PhotoFile { dir: string; file: string; key: string }
// byTeam: "<team name>|<first+last>" -> key; byTgid: "<tgid>|<game first+last>" -> key (sets with a tgid column only).
export interface PhotoIndex { dirs: string[]; byTeam: Map<string, string>; byTgid: Map<string, string>; files: PhotoFile[] }

// The photo sets of a config: photosDir (the league's original set) plus photosDirs, in that order; a later set wins a
// key both hold (a returning player's newest photo).
export const photoDirsOf = (cfg: { photosDir?: string; photosDirs?: string[] }): string[] =>
  [...new Set([cfg.photosDir, ...(cfg.photosDirs ?? [])].filter((d): d is string => !!d))];

export function loadPhotoIndex(dirs: string | string[] | undefined): PhotoIndex | null {
  const list = (Array.isArray(dirs) ? dirs : dirs ? [dirs] : []).filter((d) => existsSync(join(d, 'player_photos_manifest.csv')));
  if (!list.length) return null;
  const idx: PhotoIndex = { dirs: list, byTeam: new Map(), byTgid: new Map(), files: [] };
  for (const dir of list) {
    const rows = parseCsv(readFileSync(join(dir, 'player_photos_manifest.csv'), 'utf8').replace(/^﻿/, ''));
    const head = rows[0]!.map((h) => h.trim());
    const col = (name: string) => head.indexOf(name);
    const [iStatus, iFile, iName, iTeam, iTgid, iFirst, iLast] = [col('status'), col('filename'), col('full_name'), col('team_name'), col('tgid'), col('game_first'), col('game_last')];
    const own = new Set<string>(); // within one set the first row of a key stands
    for (const r of rows.slice(1)) {
      if (r[iStatus] !== 'downloaded' || !r[iFile]) continue;
      if (!existsSync(join(dir, 'player_photos', r[iFile]!))) continue;
      const key = `players/${r[iFile]!}`;
      idx.files.push({ dir, file: r[iFile]!, key });
      const tk = `${normName(r[iTeam]!)}|${normName(r[iName]!)}`;
      if (!own.has(tk)) { own.add(tk); idx.byTeam.set(tk, key); }
      if (iTgid >= 0 && iFirst >= 0 && iLast >= 0 && r[iTgid] && (r[iFirst] || r[iLast])) {
        const gk = `${Number(r[iTgid])}|${normName(r[iFirst]! + r[iLast]!)}`;
        if (!own.has(gk)) { own.add(gk); idx.byTgid.set(gk, key); }
      }
    }
  }
  return idx;
}

export const photoKeyFor = (idx: PhotoIndex, tgid: number | undefined, teamName: string | undefined, first: string, last: string): string | null => {
  const n = normName(first + last);
  const exact = tgid !== undefined ? idx.byTgid.get(`${tgid}|${n}`) : undefined;
  if (exact) return exact;
  return (teamName && idx.byTeam.get(`${normName(teamName)}|${n}`)) || null;
};

// Marks every player of a decoded dynasty with its photo key; returns how many matched.
export function attachPhotoKeys(ex: DynastyExport, idx: PhotoIndex | null): number {
  if (!idx) return 0;
  const teamName = new Map(ex.teams.map((t) => [t.tgid, t.name]));
  let n = 0;
  for (const p of ex.players) {
    const key = photoKeyFor(idx, p.tgid, teamName.get(p.tgid), p.firstName, p.lastName);
    if (key) { (p as typeof p & { photoKey?: string }).photoKey = key; n++; }
  }
  return n;
}
