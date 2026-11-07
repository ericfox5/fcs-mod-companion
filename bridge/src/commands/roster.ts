// Roster-file tooling for the 100-player roster project (docs/roster-stride-inventory.md):
//   roster grow <in> <out> [--stride 100] [--from 70] [--allow-oversize]   re-key every PGID to a new stride, grow PLAY
//   roster add  <in> <out> --tgid N --first F --last L [--pos P] [--jersey J] [--template PGID] [--stride S]
// Input is a plain EA DB (an offline USR-DATA) or a locker dynasty file (zlib, 4-byte prefix); the output keeps the form.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseTdb, serializeTdb, verifyTdb, type TdbFile, type TdbTable } from '@ncaa/tdb';
import { PGID_STRIDE, addPlayer, detectStride, rekeyStride } from '@ncaa/ncaa14';
import { openDynastyFile } from '../od.js';
import { buildDynastyFile } from '../dynasty-patch.js';

export const ROSTER_SAVE_BUFFER = 0x15e000; // the console's roster save buffer (EBOOT 0x3b46a0): 1,433,600 bytes
export const DYNASTY_DB_BUFFER = 0x7e5000; // the dynasty DB buffer (EBOOT 0x335828 ...): 8,278,016 bytes

interface Opened { file: TdbFile; dynasty: boolean; dbLength: number; fileLength: number }
function open(path: string): Opened {
  const bytes = new Uint8Array(readFileSync(path));
  if (bytes[0] === 0x44 && bytes[1] === 0x42) return { file: parseTdb(bytes), dynasty: false, dbLength: bytes.length, fileLength: bytes.length };
  const o = openDynastyFile(bytes);
  return { file: o.file, dynasty: true, dbLength: o.db.length, fileLength: o.inflatedLength };
}
// a dynasty DB (locker file or offline dynasty save, SEAI present) lives in the 0x7e5000 buffer; a roster save in 0x15e000
const bufferOf = (o: Opened) => (o.dynasty || o.file.hasTable('SEAI') ? DYNASTY_DB_BUFFER : ROSTER_SAVE_BUFFER);
function save(path: string, o: Opened, opts: { allowOversize: boolean }): { bytes: number; dbSize: number } {
  const buffer = bufferOf(o);
  const db = serializeTdb(o.file, { padTo: o.dbLength });
  const problems = verifyTdb(db, o.file);
  if (problems.length) throw new Error(`output does not verify: ${JSON.stringify(problems.slice(0, 3))}`);
  const dbSize = o.file.header.dbSize;
  if (dbSize > buffer && !opts.allowOversize) throw new Error(`the DB (${dbSize} bytes) exceeds the console's ${buffer === DYNASTY_DB_BUFFER ? 'dynasty' : 'roster save'} buffer of ${buffer} bytes; pass --allow-oversize once the game is patched for it`);
  const out = o.dynasty ? buildDynastyFile(db) : db;
  writeFileSync(path, out);
  return { bytes: out.length, dbSize };
}
const fmt = (n: number) => n.toLocaleString('en-US');

// Every table with a PGID column gets its ids re-keyed from the old stride to the new one by arithmetic (team =
// id / oldStride, slot = id % oldStride): the game itself keys departed players into unused team ranges, so the PLAY
// row's TGID is not the authority. PGID_NONE and ids whose new value would not fit the field are left as they are.
export function rosterGrow(inPath: string, outPath: string, opts: { stride?: number; from?: number; allowOversize?: boolean } = {}): void {
  const stride = opts.stride ?? 100, from = opts.from ?? PGID_STRIDE;
  if (!(stride > from)) throw new Error(`--stride ${stride} must be larger than --from ${from}`);
  const o = open(inPath);
  const play = o.file.table('PLAY');
  const detected = detectStride(play);
  if (detected !== null && detected !== from) throw new Error(`${inPath} is keyed with stride ${detected}, not ${from} (pass --from ${detected})`);
  const teams = Math.floor(play.header.maxRecords / from);
  if (teams * from !== play.header.maxRecords) console.log(`note: PLAY max ${play.header.maxRecords} is not a multiple of ${from}; growing to ${teams} teams x ${stride}`);
  console.log(`${inPath}: ${o.dynasty ? 'dynasty file' : 'EA DB'}, dbSize ${fmt(o.file.header.dbSize)}, PLAY ${play.recordCount}/${play.header.maxRecords} x ${play.header.lengthBytes} B, stride ${detected ?? '?'}`);
  const r = rekeyStride(o.file, { from, to: stride });
  for (const t of o.file.tables) if (t !== play && t.header.maxRecords % from === 0 && t.header.maxRecords >= from * 10) console.log(`note: ${t.name} max ${t.header.maxRecords} is a multiple of ${from} (not grown; check whether it is per-slot)`);
  const { bytes, dbSize } = save(outPath, o, { allowOversize: Boolean(opts.allowOversize) });
  const buffer = bufferOf(o);
  console.log(`re-keyed ${fmt(r.rekeyed)} PGID cells (${r.kept} sentinels kept${r.overflow ? `, ${r.overflow} left unchanged: overflow` : ''}) in: ${r.perTable.join(', ')}`);
  console.log(`PLAY max ${r.playMax[0]} -> ${r.playMax[1]}; dbSize ${fmt(dbSize)} vs console buffer ${fmt(buffer)} (${dbSize <= buffer ? `${fmt(buffer - dbSize)} spare` : `${fmt(dbSize - buffer)} OVER`})`);
  console.log(`wrote ${outPath} (${fmt(bytes)} bytes)`);
}

export function rosterAdd(inPath: string, outPath: string, opts: { tgid: number; first: string; last: string; pos?: number; jersey?: number; template?: number; stride?: number }): void {
  const o = open(inPath);
  const fields: Record<string, number | string> = { PFNA: opts.first.slice(0, 11), PLNA: opts.last.slice(0, 13) };
  if (opts.pos !== undefined) fields.PPOS = opts.pos;
  if (opts.jersey !== undefined) fields.PJEN = opts.jersey;
  const { pgid, row } = addPlayer(o.file, { tgid: opts.tgid, template: opts.template, fields, stride: opts.stride });
  const play: TdbTable = o.file.table('PLAY');
  console.log(`added ${play.get(row, 'PFNA')} ${play.get(row, 'PLNA')} as PGID ${pgid} (row ${row}) on team ${opts.tgid}, copied from ${opts.template !== undefined ? `PGID ${opts.template}` : "the team's first row"}`);
  const { bytes } = save(outPath, o, { allowOversize: false });
  console.log(`wrote ${outPath} (${fmt(bytes)} bytes)`);
}
