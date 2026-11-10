// Extract NCAA 14 playbooks (formations, sets, plays, per-player assignments, play art, AI weights) from the game's
// archives into compact JSON for the Supersim coaching mode and the Playbook page.
//
//   npx tsx tools/playbooks-extract.mts [--usrdir <PS3_GAME/USRDIR>] [--out worker/public/data/playbooks] [--master]
//
// This file is the archive reader and the CLI; the DB -> Book JSON logic lives in @ncaa/ncaa14 (packages/ncaa14/src/
// playbook/db.ts and extract.ts) so the Worker, the bridge and the tests build the same JSON from the same tables.
// Archive format: BGFA 1.05 ("qkl" .ast). Header 'BGFA1.05', u32 count @0x08, u32 tocOffset @0x10, u32 tocSize @0x18,
// u32 prefixWords @0x28, u32 nameWidth @0x2C. TOC = prefixWords*4 bytes, then records {u16 flags, u64 hash (FNV-1a 64
// of the upper-cased entry name), u32 offset, u32 csize, u32 usize - csize, char name[nameWidth]}; entries are stored or
// zlib streams. The playbook databases are EA DB files (same format as the saves, parsed by @ncaa/tdb):
//   boot: PLAB (playbook list: BGID index used by TEAM.TOPB/TDPB -> PBGI book id, BNAM name, PBAN asset name), found
//         by its table set; PSAL + base formations/sets/plays (entry #360) for the --master path.
//   fe2ig (default source): one compiled DB per book, entry PLAYBOOK_<PBAN> — what the game plays from (found
//         2026-11-10: the master DB below only feeds the in-game custom-playbook feature, and on the FCS mod it is
//         CFBR's edited copy, so the master's books do not match what the console runs).
//   misc (--master): the master playbook DB: PGFM/STID/PGPL (book -> formations -> sets -> plays), PBFM, SETL, SETP,
//         SETG, SGFF, PBPL (play names/types), PLYS (per-slot assignment + art ids), PSLO/PSLD (offense/defense step
//         programs), ARTO/ARTD (play art), PLPD (progressions), PLRD (run hole), PBA1 (AI situation weights).
// Output: index.json + <bookId>.json { id, bgid, side, name, formations[{id,n,t,sets[{id,n,slots[{i,pos,depth,x,y}],plays[]}]}],
//   plays{ id:{id,n,t,sit,f,v,h?,prog?,a[11 -> asg index]} }, asg[{r,k,p?,c?,t?,z?}], ai{ AIGR: [[play, weight]] } }.
// Coordinates: set positions (SETG x___/y___) are yards, x to the offense's right, y toward the defense (offense
// slots are negative, defensive slots positive). Art is in feet with screen-down positive, so field = (x/3, -y/3).
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { parseTdb } from '@ncaa/tdb';
import { PlaybookDb, extractBook, extractIndex, playbookEntryHash, playbookEntryName, type Book } from '@ncaa/ncaa14';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1]! : d; };
const fromMaster = args.includes('--master');
const defaultUsrdir = () => {
  try { const c = JSON.parse(readFileSync(path.join(os.homedir(), '.ncaa-bridge', 'config.json'), 'utf8')); if (c.rpcs3Root) return path.join(c.rpcs3Root, 'dev_hdd0', 'disc', 'BLUS31159-[NCAA Football 14]', 'PS3_GAME', 'USRDIR'); } catch { /* no config */ }
  return '';
};
const usrdir = opt('--usrdir', defaultUsrdir());
const outDir = opt('--out', 'worker/public/data/playbooks');
if (!usrdir || !existsSync(path.join(usrdir, 'qkl_misc.ast'))) { console.error('qkl_misc.ast not found; pass --usrdir <PS3_GAME/USRDIR>'); process.exit(1); }

// ---- BGFA archive -------------------------------------------------------------------------------------------------
interface Entry { i: number; off: number; csize: number; usize: number }
function readToc(buf: Buffer): Entry[] {
  if (buf.toString('latin1', 0, 8) !== 'BGFA1.05') throw new Error('not a BGFA 1.05 archive');
  const tocOff = buf.readUInt32LE(0x10), tocSize = buf.readUInt32LE(0x18), prefixWords = buf.readUInt32LE(0x28), nameW = buf.readUInt32LE(0x2c);
  const rec = 22 + nameW, out: Entry[] = [];
  for (let p = tocOff + prefixWords * 4; p + rec <= tocOff + tocSize; p += rec) out.push({ i: out.length, off: buf.readUInt32LE(p + 10), csize: buf.readUInt32LE(p + 14), usize: buf.readUInt32LE(p + 18) });
  return out;
}
function entryData(buf: Buffer, e: Entry): Buffer {
  const raw = buf.subarray(e.off, e.off + e.csize);
  if (raw[0] === 0x78) { try { return inflateSync(raw); } catch { return raw; } }
  return raw;
}
// EA DB header: 'DB' u16 version(8) u8 endian; numTables @0x10; directory {name[4] (byte-reversed when big-endian), u32 off}
function dbTables(b: Buffer): string[] | null {
  if (b.length < 0x18 || b[0] !== 0x44 || b[1] !== 0x42) return null;
  const big = b[4] === 1, n = big ? b.readUInt32BE(0x10) : b.readUInt32LE(0x10);
  if (n === 0 || n > 2000 || 0x18 + n * 8 > b.length) return null;
  const names: string[] = [];
  for (let i = 0; i < n; i++) { const raw = b.subarray(0x18 + i * 8, 0x18 + i * 8 + 4); names.push((big ? Buffer.from([...raw].reverse()) : raw).toString('latin1')); }
  return names;
}
function findDb(archive: string, must: string[]): ReturnType<typeof parseTdb> {
  const buf = readFileSync(archive);
  for (const e of readToc(buf)) {
    if (e.usize > 60_000_000) continue;
    let b = entryData(buf, e);
    let k = b[0] === 0x44 && b[1] === 0x42 ? 0 : b.indexOf(Buffer.from([0x44, 0x42, 0x00, 0x08]));
    if (k < 0 || k > 4096) continue;
    b = b.subarray(k);
    const names = dbTables(b);
    if (names && must.every((m) => names.includes(m))) { console.log(`${path.basename(archive)} entry #${e.i}: ${names.length} tables (${must.join(', ')})`); return parseTdb(new Uint8Array(b)); }
  }
  throw new Error(`${archive}: no DB entry with tables ${must.join(', ')}`);
}

// the per-book entries of a big archive, read by hash through a file descriptor (qkl_fe2ig.ast is 3.5 GB)
interface HashedEntry { off: number; csize: number; usize: number }
function openArchive(archive: string): { byHash: Map<bigint, HashedEntry>; read(e: HashedEntry): Buffer; close(): void } {
  const fd = openSync(archive, 'r');
  const at = (off: number, len: number) => { const b = Buffer.alloc(len); let n = 0; while (n < len) { const r = readSync(fd, b, n, len - n, off + n); if (!r) break; n += r; } return b; };
  const h = at(0, 64); if (h.toString('latin1', 0, 8) !== 'BGFA1.05') throw new Error(`${archive}: not a BGFA 1.05 archive`);
  const tocOff = h.readUInt32LE(0x10), tocSize = h.readUInt32LE(0x18), prefixWords = h.readUInt32LE(0x28), nameW = h.readUInt32LE(0x2c), rec = 22 + nameW;
  const toc = at(tocOff, tocSize), byHash = new Map<bigint, HashedEntry>();
  for (let p = prefixWords * 4; p + rec <= tocSize; p += rec) byHash.set(toc.readBigUInt64LE(p + 2), { off: toc.readUInt32LE(p + 10), csize: toc.readUInt32LE(p + 14), usize: toc.readUInt32LE(p + 14) + toc.readUInt32LE(p + 18) });
  return { byHash, read: (e) => { const raw = at(e.off, e.csize); return raw[0] === 0x78 && e.usize !== e.csize ? inflateSync(raw) : raw; }, close: () => closeSync(fd) };
}

const books = findDb(path.join(usrdir, 'qkl_boot.ast'), ['PLAB']);
const PLAB = [...books.table('PLAB').rows()];
// the boot base DB (shared special-teams sets, plays, programs, art) and the master DB (the list of special sets every
// book offers: BSMO/DPSF) are needed on both paths
const boot = findDb(path.join(usrdir, 'qkl_boot.ast'), ['PSAL', 'SETL', 'PLYS']);
const misc = findDb(path.join(usrdir, 'qkl_misc.ast'), ['PGPL', 'PBPL', 'PLYS']);
let master: PlaybookDb | null = null;
if (fromMaster) {
  master = new PlaybookDb(misc, boot);
  console.log(`master: formations ${master.PBFM.size}, sets ${master.SETL.size}, plays ${master.PBPL.size}, assignments ${master.PLYS.size} plays, art ${master.ARTO.size}/${master.ARTD.size}, books ${PLAB.length}`);
}
const fe2ig = fromMaster ? null : openArchive(path.join(usrdir, 'qkl_fe2ig.ast'));
if (fe2ig) console.log(`qkl_fe2ig.ast: ${fe2ig.byHash.size} entries; ${PLAB.length} books in PLAB`);

// ---- build each book ---------------------------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const written: Book[] = [];
for (const pb of PLAB) {
  const id = pb.PBGI as number, side = pb.BOFF ? 'off' : 'def', bgid = pb.BGID as number, name = String(pb.BNAM), pban = String(pb.PBAN);
  let db = master;
  if (fe2ig) {
    const e = fe2ig.byHash.get(playbookEntryHash(pban));
    if (!e) { console.warn(`book ${id} ${name}: no entry ${playbookEntryName(pban)} in qkl_fe2ig.ast`); continue; }
    db = new PlaybookDb(parseTdb(new Uint8Array(fe2ig.read(e))), id, { boot, master: misc });
  }
  const book = extractBook(db!, id, { bgid, side, name });
  if (!book) { console.warn(`book ${id} ${name}: no plays`); continue; }
  const json = JSON.stringify(book);
  writeFileSync(path.join(outDir, `${id}.json`), json);
  written.push(book);
  console.log(`book ${id} ${side} ${name}: ${book.formations.length} formations, ${Object.keys(book.plays).length} plays, ${book.asg.length} assignments, ${(json.length / 1024).toFixed(0)} KB`);
}
writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(extractIndex(written)));
fe2ig?.close();
console.log(`wrote ${written.length} books to ${outDir}${fromMaster ? ' (from the master DB)' : ' (from the per-book entries of qkl_fe2ig.ast)'}`);
