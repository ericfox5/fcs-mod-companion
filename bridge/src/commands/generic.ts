// Generic opponents -> real teams (packages/ncaa14 generic-swap.ts). The generic teams' players live in PLST/DCST of
// the standard-data DB, archive entry b57b5e0ae8e74714 in qkl_boot.ast and qkl_fe2ig.ast (stored uncompressed); their
// TEAM rows live in roster and dynasty files. Only `install` writes an archive (in place, through bridge/src/stda.ts:
// re-key to stride 100 first, backup, read back; `ncaa-bridge stda restore` undoes it); the others write only --out.
//   ncaa-bridge generic extract --archive <qkl_*.ast> --out <file> [--hash b57b5e0ae8e74714]
//   ncaa-bridge generic swap --stda <entry> --donor <USR-DATA> --donor-tgid N --tgid 160..164 --out <file> [--stride 70|100] [--force]
//   ncaa-bridge generic team --file <USR-DATA> --donor <USR-DATA> --donor-tgid N --tgid 160..164 --out <file> [--force]
//   ncaa-bridge generic install --donor <USR-DATA> --donor-tgid N --tgid 160..164 [--rpcs3 DIR | --archive FILE]
//   ncaa-bridge generic fill --plan <plan.json> [--rpcs3 DIR | --archive FILE]   (real rosters from the roster tooling: FCS/Rosters/tools/src/generics.ts)
// (or `npx tsx bridge/src/commands/generic.ts <same>`). --donor / --file take a plain EA DB (an offline roster or
// dynasty USR-DATA) or a locker dynasty file (zlib).
import { readFileSync, writeFileSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseTdb, serializeTdb, verifyTdb, FILE_HEADER_SIZE, DIR_ENTRY_SIZE, TABLE_HEADER_SIZE, EOF_CRC_SIZE, type TdbFile, type FieldValue } from '@ncaa/tdb';
import { swapGenericTeam, copyTeamIdentity, fillGenericRows, staleGenericRows, type GenericPlanRow } from '@ncaa/ncaa14';
import { openDynastyFile } from '../od.js';
import { buildDynastyFile } from '../dynasty-patch.js';
import { findStdaCopies, gameArchives, newStdaBackupDir, rekeyStdaArchive, rpcs3RootFromConfig, rpcs3RunningOver } from '../stda.js';

export const STDA_HASH = 0xb57b5e0ae8e74714n; // FNV-1a 64 of the standard-data DB's (unknown) name
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const GENERIC = new Set([160, 161, 162, 163, 164]);

// An entry of a BGFA 1.05 archive by hash (TOC layout as in spike/blaze/tools/uniforms/src/codec.cjs); read-only.
export function readArchiveEntry(path: string, hash: bigint): { off: number; csize: number; usize: number; bytes: Uint8Array } {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(64); readSync(fd, head, 0, 64, 0);
    if (head.toString('latin1', 0, 8) !== 'BGFA1.05') throw new Error(`${path}: not a BGFA 1.05 archive`);
    const tocOff = head.readUInt32LE(16), tocSize = head.readUInt32LE(24), w8 = head.readUInt32LE(32), w9 = head.readUInt32LE(36);
    const prefixWords = head.readUInt32LE(40), nameWidth = head.readUInt32LE(44);
    const offW = (w8 >>> 24) & 255, hashW = (w8 >>> 16) & 255, csW = (w9 >>> 8) & 255, usW = w9 & 255, rec = 2 + hashW + offW + csW + usW + nameWidth;
    const toc = Buffer.alloc(tocSize); readSync(fd, toc, 0, tocSize, tocOff);
    const num = (p: number, n: number) => { let v = 0n; for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(toc[p + i]!); return v; };
    for (let p = prefixWords * 4; p + rec <= tocSize; p += rec) {
      if (num(p + 2, hashW) !== hash) continue;
      let q = p + 2 + hashW; const off = Number(num(q, offW)); q += offW; const csize = Number(num(q, csW)); q += csW; const usize = csize + Number(num(q, usW));
      const raw = Buffer.alloc(csize); readSync(fd, raw, 0, csize, off);
      const bytes = raw[0] === 0x78 && usize !== csize ? new Uint8Array(inflateSync(raw)) : new Uint8Array(raw);
      return { off, csize, usize, bytes };
    }
    throw new Error(`${path}: no entry with hash ${hash.toString(16)}`);
  } finally { closeSync(fd); }
}

interface Opened { file: TdbFile; dynasty: boolean; dbLength: number }
function open(path: string): Opened {
  const bytes = new Uint8Array(readFileSync(path));
  if (bytes[0] === 0x44 && bytes[1] === 0x42) return { file: parseTdb(bytes), dynasty: false, dbLength: bytes.length };
  const o = openDynastyFile(bytes); return { file: o.file, dynasty: true, dbLength: o.db.length };
}
function rowsOf(file: TdbFile, table: string, tgid: number): Record<string, FieldValue>[] {
  const t = file.table(table); const out: Record<string, FieldValue>[] = [];
  for (let i = 0; i < t.recordCount; i++) if (Number(t.get(i, 'TGID')) === tgid) out.push(t.row(i));
  return out;
}
function outPath(out: string | undefined, inputs: string[], force: boolean): string {
  if (!out) throw new Error('--out is required');
  const o = resolve(out);
  if (inputs.some((i) => resolve(i) === o)) throw new Error('--out must be a new file, not one of the inputs');
  if (existsSync(o) && !force) throw new Error(`${o} exists (pass --force to replace it)`);
  return o;
}

// Every byte a swap may change: the record bytes of the named tables, each table's prior-CRC word and the EOF CRC
// (tables are contiguous in file order, as serializeTdb writes them).
function allowedRanges(file: TdbFile, tables: string[]): [number, number][] {
  const ranges: [number, number][] = []; let pos = FILE_HEADER_SIZE + file.directory.length * DIR_ENTRY_SIZE;
  for (const t of file.tables) {
    ranges.push([pos, pos + 4]);
    const data = pos + TABLE_HEADER_SIZE + t.fieldDefsRaw.length;
    if (tables.includes(t.name)) ranges.push([data, data + t.data.length]);
    pos = data + t.data.length + t.index.length;
  }
  ranges.push([file.header.dbSize - EOF_CRC_SIZE, file.header.dbSize]);
  return ranges;
}

export function genericSwap(opts: { stda: string; donor: string; donorTgid: number; tgid: number; out?: string; stride?: number; force?: boolean }): void {
  if (!GENERIC.has(opts.tgid)) throw new Error(`--tgid ${opts.tgid}: only the generic teams 160-164 have PLST rows`);
  const out = outPath(opts.out, [opts.stda, opts.donor], Boolean(opts.force));
  const input = new Uint8Array(readFileSync(opts.stda));
  const stda = parseTdb(input);
  if (!stda.hasTable('PLST') || !stda.hasTable('DCST')) throw new Error(`${opts.stda}: no PLST/DCST (not the standard-data DB)`);
  const d = open(opts.donor);
  const players = rowsOf(d.file, 'PLAY', opts.donorTgid), depth = rowsOf(d.file, 'DCHT', opts.donorTgid);
  if (!players.length) throw new Error(`${opts.donor}: no PLAY rows for TGID ${opts.donorTgid}`);
  const r = swapGenericTeam(stda, { players, depth }, { tgid: opts.tgid, stride: opts.stride });

  const bytes = serializeTdb(stda, { padTo: input.length });
  if (bytes.length !== input.length) throw new Error(`output is ${bytes.length} bytes, input ${input.length}: refusing`);
  const problems = verifyTdb(bytes, parseTdb(bytes));
  if (problems.length) throw new Error(`output does not verify: ${JSON.stringify(problems.slice(0, 3))}`);
  const ranges = allowedRanges(parseTdb(input), ['PLST', 'DCST']); let changed = 0;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === bytes[i]) continue; changed++;
    if (!ranges.some(([a, b]) => i >= a && i < b)) throw new Error(`byte ${i} changed outside PLST/DCST records and CRC words: refusing`);
  }
  writeFileSync(out, bytes);
  console.log(`TGID ${r.tgid} <- donor TGID ${opts.donorTgid}: ${r.count} PLST rows (stride ${r.stride}), ${r.depthRows} DCST rows; OVR top/mean ${r.ovr.before.top}/${r.ovr.before.mean} -> ${r.ovr.after.top}/${r.ovr.after.mean}`);
  for (const p of r.players) console.log(`  ${String(p.pgid).padStart(5)} ${p.pos.padEnd(4)} ${String(p.ovr).padStart(2)} ${p.name}${p.asPos ? `  (as ${p.asPos})` : ''}`);
  for (const s of r.improvised) console.log(`  improvised: ${s}`);
  console.log(`wrote ${out} (${bytes.length} bytes, ${changed} bytes changed, all inside PLST/DCST and CRC words; sha256 ${sha(bytes)})`);
}

export function genericTeam(opts: { file: string; donor: string; donorTgid: number; tgid: number; out?: string; force?: boolean }): void {
  if (!GENERIC.has(opts.tgid)) throw new Error(`--tgid ${opts.tgid}: not a generic team (160-164)`);
  const out = outPath(opts.out, [opts.file, opts.donor], Boolean(opts.force));
  const o = open(opts.file), d = open(opts.donor);
  const donorTeam = rowsOf(d.file, 'TEAM', opts.donorTgid)[0];
  if (!donorTeam) throw new Error(`${opts.donor}: no TEAM row for TGID ${opts.donorTgid}`);
  const changed = copyTeamIdentity(o.file, opts.tgid, donorTeam);
  const db = serializeTdb(o.file, { padTo: o.dbLength });
  const problems = verifyTdb(db, parseTdb(db));
  if (problems.length) throw new Error(`output does not verify: ${JSON.stringify(problems.slice(0, 3))}`);
  const bytes = o.dynasty ? buildDynastyFile(db) : db;
  writeFileSync(out, bytes);
  console.log(`TEAM ${opts.tgid} <- TEAM ${opts.donorTgid}: ${changed.length ? changed.join('; ') : 'nothing to change'}\nwrote ${out} (${bytes.length} bytes)`);
}

export function genericExtract(opts: { archive: string; out?: string; hash?: string; force?: boolean }): void {
  const out = outPath(opts.out, [opts.archive], Boolean(opts.force));
  const e = readArchiveEntry(opts.archive, opts.hash ? BigInt(`0x${opts.hash.replace(/^0x/, '')}`) : STDA_HASH);
  writeFileSync(out, e.bytes);
  console.log(`entry at ${e.off}: ${e.csize} bytes stored, ${e.bytes.length} bytes written to ${out} (sha256 ${sha(e.bytes)})`);
}

// The swap written into every copy of the standard-data entry of an RPCS3 install (or one --archive), in place: each
// copy is re-keyed to stride 100 if it is not yet and the swap runs on it under rewriteStandardData's checks; one backup
// folder (<backups>/<stamp>-stda) holds every original entry for `ncaa-bridge stda restore`.
export function genericInstall(opts: { donor: string; donorTgid: number; tgid: number; rpcs3?: string; archive?: string }): void {
  if (!GENERIC.has(opts.tgid)) throw new Error(`--tgid ${opts.tgid}: only the generic teams 160-164 have PLST rows`);
  const root = opts.rpcs3 ?? process.env.NCAA_RPCS3 ?? rpcs3RootFromConfig();
  const archives = opts.archive ? [opts.archive] : root ? gameArchives(root) : [];
  if (rpcs3RunningOver(archives)) throw new Error('RPCS3 is running from this install: close it before touching the game archives');
  const copies = findStdaCopies(archives); if (!copies.length) throw new Error(`no standard-data entry in ${archives.length} archive(s) (pass --rpcs3 DIR or --archive FILE)`);
  const d = open(opts.donor); const players = rowsOf(d.file, 'PLAY', opts.donorTgid), depth = rowsOf(d.file, 'DCHT', opts.donorTgid);
  if (!players.length) throw new Error(`${opts.donor}: no PLAY rows for TGID ${opts.donorTgid}`);
  const dir = newStdaBackupDir(); let shown = false;
  for (const c of copies) {
    let r: ReturnType<typeof swapGenericTeam> | undefined;
    const out = rekeyStdaArchive(c.archive, dir, { to: 100, tool: 'ncaa-bridge generic install', edit: (f) => { r = swapGenericTeam(f, { players, depth }, { tgid: opts.tgid }); } });
    console.log(`${c.archive}: ${out.status}: ${out.note}`);
    if (r && !shown) {
      shown = true;
      console.log(`TGID ${r.tgid} <- donor TGID ${opts.donorTgid}: ${r.count} PLST rows (stride ${r.stride}), ${r.depthRows} DCST rows; OVR top/mean ${r.ovr.before.top}/${r.ovr.before.mean} -> ${r.ovr.after.top}/${r.ovr.after.mean}`);
      for (const s of r.improvised) console.log(`  improvised: ${s}`);
    }
  }
  if (existsSync(resolve(dir, 'manifest.json'))) console.log(`backup: ${dir} (ncaa-bridge stda restore --backup "${dir}")`);
}

// Real rosters on the generic teams (a plan from the roster tooling's generics.ts: per row PGID, team, the position and
// rating it was built against, and the identity fields): every copy re-keyed if needed and filled in place. A plan row
// whose PLST row no longer has that position and rating (a swap since) is refused rather than half-applied.
export function genericFill(opts: { plan: string; rpcs3?: string; archive?: string }): void {
  const plan = JSON.parse(readFileSync(opts.plan, 'utf8')) as { teams: Record<string, { team: string; rows: GenericPlanRow[] }> };
  const rows = Object.values(plan.teams).flatMap((t) => t.rows);
  if (!rows.length) throw new Error(`${opts.plan}: no rows`);
  const root = opts.rpcs3 ?? process.env.NCAA_RPCS3 ?? rpcs3RootFromConfig();
  const archives = opts.archive ? [opts.archive] : root ? gameArchives(root) : [];
  if (rpcs3RunningOver(archives)) throw new Error('RPCS3 is running from this install: close it before touching the game archives');
  const copies = findStdaCopies(archives); if (!copies.length) throw new Error(`no standard-data entry in ${archives.length} archive(s) (pass --rpcs3 DIR or --archive FILE)`);
  const dir = newStdaBackupDir();
  for (const c of copies) {
    let r: ReturnType<typeof fillGenericRows> | undefined;
    const out = rekeyStdaArchive(c.archive, dir, { to: 100, tool: 'ncaa-bridge generic fill', edit: (f) => {
      const off = staleGenericRows(f, rows);
      if (off.length) throw new Error(`${off.length} plan row(s) do not match PLST (first: PGID ${off[0]!.pgid}); the generic rows changed since the plan was built (restore a swap first, or rebuild the plan)`);
      r = fillGenericRows(f, rows);
    } });
    console.log(`${c.archive}: ${out.status}: ${out.note}${r ? `; ${r.rows} rows, ${r.cells} cells, teams ${r.teams.join(',')}` : ''}`);
  }
  for (const [tgid, t] of Object.entries(plan.teams)) console.log(`  ${tgid} ${t.team}: ${t.rows.length} rows`);
  if (existsSync(resolve(dir, 'manifest.json'))) console.log(`backup: ${dir} (ncaa-bridge stda restore --backup "${dir}")`);
}

export function genericCli(cmd: string | undefined, flags: Map<string, string>): void {
  const num = (k: string) => (flags.has(k) ? Number(flags.get(k)) : undefined);
  const force = flags.get('force') === 'true';
  if (cmd === 'extract' && flags.has('archive')) genericExtract({ archive: flags.get('archive')!, out: flags.get('out'), hash: flags.get('hash'), force });
  else if (cmd === 'swap' && flags.has('stda') && flags.has('donor')) genericSwap({ stda: flags.get('stda')!, donor: flags.get('donor')!, donorTgid: num('donor-tgid')!, tgid: num('tgid')!, out: flags.get('out'), stride: num('stride'), force });
  else if (cmd === 'team' && flags.has('file') && flags.has('donor')) genericTeam({ file: flags.get('file')!, donor: flags.get('donor')!, donorTgid: num('donor-tgid')!, tgid: num('tgid')!, out: flags.get('out'), force });
  else if (cmd === 'fill' && flags.has('plan')) genericFill({ plan: flags.get('plan')!, rpcs3: flags.get('rpcs3'), archive: flags.get('archive') });
  else if (cmd === 'install' && flags.has('donor')) genericInstall({ donor: flags.get('donor')!, donorTgid: num('donor-tgid')!, tgid: num('tgid')!, rpcs3: flags.get('rpcs3'), archive: flags.get('archive') });
  else console.log('usage: generic extract --archive <qkl_*.ast> --out <file> [--hash H] | swap --stda <entry> --donor <USR-DATA> --donor-tgid N --tgid 160..164 --out <file> [--stride 70|100] | team --file <USR-DATA> --donor <USR-DATA> --donor-tgid N --tgid 160..164 --out <file> | install --donor <USR-DATA> --donor-tgid N --tgid 160..164 [--rpcs3 DIR | --archive FILE] | fill --plan <generics plan.json> [--rpcs3 DIR | --archive FILE]   (add --force to replace an existing --out)');
}

function main(argv: string[]): void {
  const [cmd, ...rest] = argv; const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!, next = rest[i + 1]; if (!a.startsWith('--')) continue;
    if (next !== undefined && !next.startsWith('--')) { flags.set(a.slice(2), next); i++; } else flags.set(a.slice(2), 'true');
  }
  genericCli(cmd, flags);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`error: ${(e as Error).message}`); process.exitCode = 1; }
}
