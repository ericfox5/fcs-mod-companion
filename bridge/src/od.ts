// Reader for the Blaze stub's stores (spike/blaze/private): the online dynasty registry (dynasties.json), the locker
// blobs (locker/<cid>.bin) and the dynasty file the console uploads at every advance: one zlib stream whose payload is
// 4 unknown bytes followed by a complete EA DB (the same table set as an offline save), so the regular decoders apply.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { parseTdb, type TdbFile } from '@ncaa/tdb';

export interface OdMember { blazeId: number; persona: string; ncId?: number; commissioner?: boolean; coach?: number; team?: number; teamFileId?: number }
export interface OdGameResult {
  ATID: number; ATSC: number; HTID: number; HTSC: number; GMWK: number; OTFL?: number; TMID?: number; CRCT?: number; STCT?: number; FLID?: number;
  AQ1S?: number; AQ2S?: number; AQ3S?: number; AQ4S?: number; AOTS?: number; HQ1S?: number; HQ2S?: number; HQ3S?: number; HQ4S?: number; HOTS?: number;
  by?: number; at?: number;
}
export interface OdDynasty {
  id: number; request: Record<string, unknown>; createdAt: number; members: OdMember[];
  season?: number; week?: number; year?: number; state?: number; status?: number; fileId?: number; fileSavedAt?: number; advancing?: boolean;
  games?: Record<string, OdGameResult[]>; tables?: Record<string, { rows: number; updatedAt: number }>;
}
export interface OdStore { nextId: number; dynasties: Record<string, OdDynasty>; users?: Record<string, { ncId: number }> }
export interface LockerContent { cid: number; name: string; size: number; owner: number; confirmed?: boolean; group?: { component: number; type: number; id: number } }

export const defaultOdDir = (): string => join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'spike', 'blaze', 'private');
export const loadOdStore = (dir: string): OdStore => JSON.parse(readFileSync(join(dir, 'dynasties.json'), 'utf8'));
export function lockerIndex(dir: string): Record<string, LockerContent> {
  const p = join(dir, 'locker', 'index.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')).contents ?? {}) : {};
}
export const lockerBlobPath = (dir: string, cid: number): string => join(dir, 'locker', `${cid}.bin`);
export const readLockerBlob = (dir: string, cid: number): Uint8Array | null => { const p = lockerBlobPath(dir, cid); return existsSync(p) ? new Uint8Array(readFileSync(p)) : null; };

export interface OpenedDynastyFile { file: TdbFile; db: Uint8Array; prefix: Uint8Array; inflatedLength: number }
export function openDynastyFile(blob: Uint8Array): OpenedDynastyFile {
  const inflated = inflateSync(blob);
  let off = -1;
  for (let i = 0; i < Math.min(inflated.length - 4, 256); i++) if (inflated[i] === 0x44 && inflated[i + 1] === 0x42 && inflated[i + 2] === 0 && inflated[i + 3] === 8) { off = i; break; }
  if (off < 0) throw new Error('no EA DB header inside the dynasty file');
  const db = new Uint8Array(inflated.buffer, inflated.byteOffset + off, inflated.length - off);
  return { file: parseTdb(db), db, prefix: new Uint8Array(inflated.subarray(0, off)), inflatedLength: inflated.length };
}

export const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
export const odName = (d: OdDynasty): string => String(d.request?.NAME ?? '').trim() || `Online Dynasty ${d.id}`;
export const odSlug = (d: OdDynasty): string => slugify(String(d.request?.NAME ?? '')) || `od-${d.id}`;

// Everything the site mirrors, in one string: the watcher re-imports a dynasty when it changes.
export function odFingerprint(d: OdDynasty): string {
  const games = Object.entries(d.games ?? {}).map(([w, list]) => [w, list.map((g) => [g.HTID, g.ATID, g.HTSC, g.ATSC, g.at ?? 0])]);
  const members = d.members.map((m) => [m.blazeId, m.persona, m.team ?? 0, m.teamFileId ?? 0, m.commissioner ? 1 : 0]);
  return JSON.stringify([d.fileId ?? 0, d.fileSavedAt ?? 0, d.week ?? 0, d.year ?? 0, d.season ?? 0, d.state ?? 0, members, games]);
}
