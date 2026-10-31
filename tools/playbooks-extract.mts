// Extract NCAA 14 playbooks (formations, sets, plays, per-player assignments, play art, AI weights) from the game's
// qkl_boot.ast / qkl_misc.ast archives into compact JSON for the Supersim coaching mode.
//
//   npx tsx tools/playbooks-extract.mts [--usrdir <PS3_GAME/USRDIR>] [--out worker/public/data/playbooks]
//
// Archive format: BGFA 1.05 ("qkl" .ast). Header 'BGFA1.05', u32 count @0x08, u32 tocOffset @0x10, u32 tocSize @0x18,
// u32 prefixWords @0x28, u32 nameWidth @0x2C. TOC = prefixWords*4 bytes, then records {u16 flags, u64 hash, u32 offset,
// u32 csize, u32 usize, char name[nameWidth]}; entries are zlib streams. The playbook databases are EA DB files (same
// format as the saves, parsed by @ncaa/tdb) found by their table sets:
//   boot: PLAB (playbook list: BGID index used by TEAM.TOPB/TDPB -> PBGI book id + name), PSAL (assignment steps), base
//         formations/sets/plays shared by every book (SETL/SETP/SETG/PLYL/PLYS/PLPD/PLRD/ARTL).
//   misc: the master playbook DB: PGFM/STID/PGPL (book -> formations -> sets -> plays), PBFM, SETL, SETP, SETG, SGFF,
//         PBPL (play names/types), PLYS (per-slot assignment + art ids), PSLO/PSLD (offense/defense step programs),
//         ARTO/ARTD (play art), PLPD (progressions), PLRD (run hole), PBA1 (AI situation weights).
// Output: index.json + <bookId>.json { id, bgid, side, name, formations[{id,n,t,sets[{id,n,slots[{i,pos,depth,x,y}],plays[]}]}],
//   plays{ id:{id,n,t,sit,f,v,h?,prog?,a[11 -> asg index]} }, asg[{r,k,p?,c?,t?,z?}], ai{ AIGR: [[play, weight]] } }.
// Coordinates: set positions (SETG x___/y___) are yards, x to the offense's right, y toward the defense (offense
// slots are negative, defensive slots positive). Art is in feet with screen-down positive, so field = (x/3, -y/3).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { parseTdb } from '@ncaa/tdb';

type Row = Record<string, number | string>;
const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1]! : d; };
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

const boot = findDb(path.join(usrdir, 'qkl_boot.ast'), ['PSAL', 'SETL', 'PLYS']);
const books = findDb(path.join(usrdir, 'qkl_boot.ast'), ['PLAB']);
const misc = findDb(path.join(usrdir, 'qkl_misc.ast'), ['PGPL', 'PBPL', 'PLYS']);
const rows = (db: ReturnType<typeof parseTdb>, n: string): Row[] => { try { return [...db.table(n).rows()] as Row[]; } catch { return []; } };
const f32 = (u: number) => new DataView(new Uint32Array([u >>> 0]).buffer).getFloat32(0, true);
const byKey = <T extends Row>(rs: T[], k: string) => { const m = new Map<number, T>(); for (const r of rs) if (!m.has(r[k] as number)) m.set(r[k] as number, r); return m; };
// group by k; when a second key is given, rows duplicated across the two databases (same k + k2) keep the first seen
const group = <T extends Row>(rs: T[], k: string, k2?: string) => { const m = new Map<number, T[]>(); const seen = new Set<string>(); for (const r of rs) { if (k2) { const id = `${r[k]}/${r[k2]}`; if (seen.has(id)) continue; seen.add(id); } const l = m.get(r[k] as number); if (l) l.push(r); else m.set(r[k] as number, [r]); } return m; };

// ---- merged tables (misc first, boot as the shared base) ---------------------------------------------------------
const PBFM = byKey([...rows(misc, 'PBFM'), ...rows(boot, 'PBFM')], 'PBFM');
const SETL = byKey([...rows(misc, 'SETL'), ...rows(boot, 'SETL')], 'SETL');
const SETP = group([...rows(misc, 'SETP'), ...rows(boot, 'SETP')], 'SETL', 'poso');
const SETG = group([...rows(misc, 'SETG'), ...rows(boot, 'SETG')], 'SETP', 'SGF_');
const SGFF = group([...rows(misc, 'SGFF'), ...rows(boot, 'SGF ')], 'SETL');
const PBPL = byKey([...rows(misc, 'PBPL'), ...rows(boot, 'PLYL')], 'PLYL'); // boot keeps play info in PLYL
const PLYS = group([...rows(misc, 'PLYS'), ...rows(boot, 'PLYS')], 'PLYL', 'poso');
const PSLO = group(rows(misc, 'PSLO'), 'PSAL'), PSLD = group(rows(misc, 'PSLD'), 'PSAL'), PSAL = group(rows(boot, 'PSAL'), 'PSAL');
const ARTO = byKey([...rows(misc, 'ARTO'), ...rows(boot, 'ARTL')], 'ARTL'), ARTD = byKey(rows(misc, 'ARTD'), 'ARTL');
const PLPD = byKey([...rows(misc, 'PLPD'), ...rows(boot, 'PLPD')], 'PLYL'), PLRD = byKey([...rows(misc, 'PLRD'), ...rows(boot, 'PLRD')], 'PLYL');
const PGFM = group(rows(misc, 'PGFM'), 'BOKL'), STID = group(rows(misc, 'STID'), 'BOKL'), PGPL = group(rows(misc, 'PGPL'), 'BOKL');
const PBA = group([...rows(misc, 'PBA1'), ...rows(misc, 'PBA2'), ...rows(misc, 'PBA3'), ...rows(misc, 'PBA4')], 'BOKL'); // AI tables are split by book ranges
const BSMO = rows(misc, 'BSMO'), DPSF = group(rows(misc, 'DPSF'), 'SETL'); // special sets shared by every book (field goal, kneel, spike, returns)
const PLAB = rows(books, 'PLAB');
console.log(`formations ${PBFM.size}, sets ${SETL.size}, plays ${PBPL.size}, assignments ${PLYS.size} plays, art ${ARTO.size}/${ARTD.size}, books ${PLAB.length}`);

// ---- step programs -> assignment kind --------------------------------------------------------------------------
// Offense step codes (PSLO/PSAL): 1 carry ball, 3 move, 5 fake carry-out, 7 throw, 8 route segment, 9 cut, 10 route end,
// 11/12 read-option mesh, 13 run to hole, 14 pass block, 15 run block, 18 stalk block, 26 pre-snap path, 27 kick,
// 28 hold, 29 punt, 31 kneel, 32 toss catch, 36/37 screen catch, 38/39 handoff, 48 align.
// Defense step codes (PSLD): 19 rush (val1 gap), 41 man coverage (val3 = offensive slot), 23 deep zone, 21/20 under zone,
// 24 delay, 47/48 align.
const steps = (psal: number) => (PSLO.get(psal) ?? PSLD.get(psal) ?? PSAL.get(psal) ?? []).slice().sort((a, b) => (a.step as number) - (b.step as number));
const codesOf = (st: Row[]) => st.map((s) => s.code as number);
// Special-teams roles: 26/27 kickoff kicker, 24 FG kicker (the K slot), 37 holder (QB2/P slot), 29 punter, 38 kneel QB, 45 spike QB, 106/138 kickoff
// coverage, 127 punt coverage, 105 kick-return unit (the KR slot returns), 107 punt returner, 139 onside recovery.
const ROLE_KIND: Record<number, string> = { 26: 'kick', 27: 'kick', 24: 'kick', 37: 'hold', 29: 'punt', 38: 'kneel', 45: 'spike', 106: 'cover', 138: 'cover', 127: 'cover', 107: 'ret', 139: 'recover' };
function offenseKind(st: Row[], role: number, slotPos: number): string {
  const c = codesOf(st);
  if (ROLE_KIND[role]) return ROLE_KIND[role]!;
  if (c.includes(27)) return 'kick';
  if (c.includes(29)) return 'punt';
  if (c.includes(28)) return 'hold';
  if (c.includes(31)) return 'kneel';
  if (slotPos === 0 || role === 40 || role === 41 || role === 43 || role === 111 || role === 113) { // quarterback programs
    if (c.includes(7)) return c.includes(38) || c.includes(39) || c.includes(5) ? 'qbpa' : 'qb';
    if (c.includes(1)) return 'qbopt';
    if (c.includes(38) || c.includes(39) || c.includes(11) || c.includes(12)) return 'handoff';
    if (c.includes(3) && !c.includes(8)) return 'qb';
  }
  if (c.includes(1)) return 'carry';
  if (c.includes(36) || c.includes(37)) return 'screen';
  if (c.includes(8) || c.includes(32)) return 'route';
  if (c.includes(14)) return c.includes(15) || c.includes(18) ? 'block' : 'pblock';
  if (c.includes(15) || c.includes(18)) return 'block';
  if (c.includes(3)) return 'move';
  return 'move';
}
function defenseKind(st: Row[], cap: number, pos: number, role: number): { k: string; t?: number; z?: number } {
  const c = codesOf(st);
  if (ROLE_KIND[role]) return { k: ROLE_KIND[role]! };
  if (role === 105) return { k: pos === 21 ? 'ret' : 'block' };
  if (c.includes(41)) return { k: 'rush' };
  const man = st.find((s) => s.code === 19); if (man) return { k: 'man', t: man.val1 as number };
  const deep = st.find((s) => s.code === 23); if (deep) return { k: 'deep', z: deep.val1 as number };
  if (c.includes(21) || c.includes(20)) return { k: 'under' };
  if (role === 5) return { k: 'rush' };
  if (cap === 4 || cap === 5) return { k: 'deep' };
  if (cap === 3) return { k: 'under' };
  if (cap === 2) return { k: pos >= 16 ? 'man' : 'rush' };
  if (pos >= 10 && pos <= 12) return { k: 'rush' };
  if (pos >= 13 && pos <= 15) return { k: 'under' };
  if (pos === 16) return { k: 'man' };
  return { k: 'deep' };
}
// Play art -> polyline in yards relative to the player's alignment. Segments with at=0 run from the previous end to
// (ax,ay) in absolute art coordinates; at=1 segments are detached pieces drawn from (ax,ay) to (au,av) (arrow at au,av).
function artPath(art: Row | undefined): { p: number[][]; cap: number } {
  if (!art) return { p: [], cap: 0 };
  const pts: number[][] = [[0, 0]]; let cap = 0;
  const n = Math.min(12, (art.acnt as number) || 12);
  for (let i = 1; i <= n; i++) {
    const k = String(i).padStart(2, '0');
    const au = art['au' + k] as number, av = art['av' + k] as number, ax = art['ax' + k] as number, ay = art['ay' + k] as number, at = art['at' + k] as number, ct = art['ct' + k] as number;
    if (!au && !av && !ax && !ay) continue;
    if (at === 1) { pts.push([ax, ay]); pts.push([au, av]); } else pts.push([ax, ay]);
    if (ct) cap = ct;
  }
  const yd = (v: number) => Math.round((v / 3) * 10) / 10;
  const out: number[][] = [];
  for (const [x, y] of pts) { const q = [yd(x), -yd(y)]; const last = out[out.length - 1]; if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q); }
  return { p: out.length > 1 ? out : [], cap };
}

// ---- build each book ---------------------------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const index: { id: number; bgid: number; side: 'off' | 'def'; name: string; plays: number; formations: string[] }[] = [];
for (const pb of PLAB) {
  const id = pb.PBGI as number, side = pb.BOFF ? 'off' : 'def', bgid = pb.BGID as number, name = String(pb.BNAM);
  const forms = PGFM.get(id) ?? [], sets = STID.get(id) ?? [], plays = PGPL.get(id) ?? [];
  if (!plays.length) { console.warn(`book ${id} ${name}: no plays`); continue; }
  const playsOut: Record<string, unknown> = {};
  const formationsOut: unknown[] = [];
  // Assignments are shared through a dictionary: identical (role, kind, path) entries repeat across plays (every pass
  // play's five pass-blockers, every run play's stalk-blocking receivers), which halves the file.
  const dict: unknown[] = []; const dictIndex = new Map<string, number>();
  const intern = (o: unknown) => { const k = JSON.stringify(o); let i = dictIndex.get(k); if (i === undefined) { i = dict.length; dict.push(o); dictIndex.set(k, i); } return i; };
  const seenSet = new Set<number>();
  const ordered = (list: Row[]) => list.slice().sort((a, b) => (a.ord_ as number) - (b.ord_ as number));
  for (const f of ordered(forms)) {
    const fm = PBFM.get(f.PBFM as number);
    const fsets = sets.filter((s) => s.PBFM === f.PBFM);
    const setsOut: unknown[] = [];
    for (const s of fsets) { const built = buildSet(s.SETL as number, plays.filter((p) => p.SETL === s.SETL)); if (built) setsOut.push(built); }
    if (setsOut.length) formationsOut.push({ id: f.PBFM, n: fm?.name ?? `Formation ${f.PBFM}`, t: fm?.FTYP ?? (side === 'off' ? 1 : 11), sets: setsOut });
  }
  function buildSet(setId: number, setPlays: Row[]) {
      const setl = SETL.get(setId); if (!setl || seenSet.has(setId)) return null; seenSet.add(setId);
      const subs = SGFF.get(setId) ?? []; const dflt = (subs.find((x) => x.dflt) ?? subs[0])?.SGF_;
      const slots = (SETP.get(setId) ?? []).slice().sort((a, b) => (a.poso as number) - (b.poso as number)).map((sp) => {
        const gs = SETG.get(sp.SETP as number) ?? []; const g = gs.find((x) => x.SGF_ === dflt) ?? gs[0];
        return { i: sp.poso as number, pos: sp.EPos as number, depth: Math.max(0, (sp.DPos as number) - 1), x: g ? Math.round(f32(g.x___ as number) * 10) / 10 : 0, y: g ? Math.round(f32(g.y___ as number) * 10) / 10 : 0 };
      });
      const list: number[] = [];
      for (const p of ordered(setPlays)) {
        const plyl = p.PLYL as number; if (list.includes(plyl)) continue;
        const info = PBPL.get(plyl); if (!info) continue;
        list.push(plyl);
        if (playsOut[plyl]) continue;
        const assigns = (PLYS.get(plyl) ?? []).slice().sort((a, b) => (a.poso as number) - (b.poso as number));
        const a: number[] = new Array(11).fill(-1);
        for (const as of assigns) {
          const slot = slots[as.poso as number]; const st = steps(as.PSAL as number); const i = as.poso as number; if (i < 0 || i > 10) continue;
          if (side === 'off') { const art = artPath(ARTO.get(as.ARTL as number)); const k = offenseKind(st, as.PLRR as number, i); a[i] = intern({ r: as.PLRR, k, ...(art.p.length ? { p: art.p, c: art.cap } : {}) }); continue; }
          const art = artPath(ARTD.get(as.ARTL as number) ?? ARTO.get(as.ARTL as number)); const dk = defenseKind(st, art.cap, slot?.pos ?? 16, as.PLRR as number);
          a[i] = intern({ r: as.PLRR, k: dk.k, ...(dk.t !== undefined ? { t: dk.t } : {}), ...(dk.z !== undefined ? { z: dk.z } : {}), ...(art.p.length ? { p: art.p, c: art.cap } : {}) });
        }
        const prog = PLPD.get(plyl); const progOut: number[][] = [];
        if (prog) for (let i = 1; i <= 5; i++) { const pct = prog['per' + i] as number, rcv = prog['rcv' + i] as number; if (pct > 0) progOut.push([rcv, pct]); }
        const hole = PLRD.get(plyl)?.hole;
        playsOut[plyl] = { id: plyl, n: info.name, t: info.PLYT as number, sit: info.SITT as number, f: info.PLF_ as number, v: info.vpos as number, ...(hole !== undefined ? { h: hole } : {}), ...(progOut.length ? { prog: progOut } : {}), a };
      }
      return list.length ? { id: setId, n: setl.name, slots, plays: list } : null;
  }
  // Sets the book links (STID) under a formation PGFM does not list, then the special sets every book shares (BSMO,
  // plays from DPSF): field goal / kneel / spike for the offense, FG block / punt return / kick return for the defense.
  const extra: { setl: number; plays: Row[] }[] = [];
  for (const s of sets) if (!seenSet.has(s.SETL as number)) extra.push({ setl: s.SETL as number, plays: plays.filter((p) => p.SETL === s.SETL) });
  for (const b of BSMO) { if (seenSet.has(b.SETL as number)) continue; const list = (DPSF.get(b.SETL as number) ?? []).map((r) => ({ PLYL: r.PLYL, SETL: b.SETL, ord_: 0 })); if (list.length) extra.push({ setl: b.SETL as number, plays: list }); }
  const special: unknown[] = [];
  for (const e of extra) {
    const sp = SETP.get(e.setl) ?? []; if (!sp.length) continue;
    // offense sets carry a QB/K/P/KO/LS or a line; defense sets a returner or a front seven
    const has = (...ps: number[]) => sp.some((x) => ps.includes(x.EPos as number));
    const defensiveSet = has(21, 22) || (!has(0, 19, 20, 23, 24) && sp.filter((x) => (x.EPos as number) >= 10 && (x.EPos as number) <= 18).length >= 6);
    if ((side === 'def') !== defensiveSet) continue;
    const built = buildSet(e.setl, e.plays); if (built) special.push(built);
  }
  if (special.length) { const st = formationsOut.find((f: any) => f.n === 'Special Teams') as any; if (st) st.sets.push(...special); else formationsOut.push({ id: 0, n: 'Special Teams', t: side === 'off' ? 1 : 11, sets: special }); }
  // AI weights: AIGR situation group -> [play, weight]; only plays present in this book
  const ai: Record<string, number[][]> = {};
  for (const r of PBA.get(id) ?? []) { if (!playsOut[r.PLYL as number]) continue; (ai[r.AIGR as number] ??= []).push([r.PLYL as number, r.prct as number]); }
  const book = { id, bgid, side, name, formations: formationsOut, plays: playsOut, asg: dict, ai };
  const json = JSON.stringify(book);
  writeFileSync(path.join(outDir, `${id}.json`), json);
  index.push({ id, bgid, side, name, plays: Object.keys(playsOut).length, formations: formationsOut.map((f: any) => f.n) });
  console.log(`book ${id} ${side} ${name}: ${formationsOut.length} formations, ${Object.keys(playsOut).length} plays, ${dict.length} assignments, ${(json.length / 1024).toFixed(0)} KB`);
}
index.sort((a, b) => (a.side === b.side ? a.name.localeCompare(b.name) : a.side < b.side ? 1 : -1));
writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ generated: new Date().toISOString(), books: index }));
console.log(`wrote ${index.length} books to ${outDir}`);
