// Playbook database -> Book JSON (worker/public/data/playbooks/<bookId>.json), the data Supersim's coaching mode, the
// Depth Chart page and the Playbook page run on. Pure functions over a PlaybookDb: tools/playbooks-extract.mts reads the
// game archives and writes the files, the bridge proves a book it wrote re-extracts to the same JSON, and the tests
// check both against the stock output. Every object here is built with its keys in the order the JSON files have them,
// because the files are compared byte for byte: JSON.stringify of the Book must not change.
//
// Coordinates: set positions (SETG x___/y___) are yards, x to the offense's right, y toward the defense (offense slots
// are negative, defensive slots positive). Art is in feet with screen-down positive, so field = (x/3, -y/3).
import type { PlaybookDb, PlaybookRow } from './db.js';
import type { Assign, Book, BookIndex, Formation, Play, SetDef, Slot } from './types.js';

type Row = PlaybookRow;

const f32 = (u: number) => new DataView(new Uint32Array([u >>> 0]).buffer).getFloat32(0, true);
const codesOf = (st: Row[]) => st.map((s) => s.code as number);

// ---- step programs -> assignment kind --------------------------------------------------------------------------
// Offense step codes (PSLO/PSAL): 1 carry ball, 3 move, 5 fake carry-out, 7 throw, 8 route segment, 9 cut, 10 route end,
// 11/12 read-option mesh, 13 run to hole, 14 pass block, 15 run block, 18 stalk block, 26 pre-snap path, 27 kick,
// 28 hold, 29 punt, 31 kneel, 32 toss catch, 36/37 screen catch, 38/39 handoff, 48 align.
// Defense step codes (PSLD): 19 rush (val1 gap), 41 man coverage (val3 = offensive slot), 23 deep zone, 21/20 under zone,
// 24 delay, 47/48 align.
// Special-teams roles: 26/27 kickoff kicker, 24 FG kicker (the K slot), 37 holder (QB2/P slot), 29 punter, 38 kneel QB, 45 spike QB, 106/138 kickoff
// coverage, 127 punt coverage, 105 kick-return unit (the KR slot returns), 107 punt returner, 139 onside recovery.
export const ROLE_KIND: Record<number, string> = { 26: 'kick', 27: 'kick', 24: 'kick', 37: 'hold', 29: 'punt', 38: 'kneel', 45: 'spike', 106: 'cover', 138: 'cover', 127: 'cover', 107: 'ret', 139: 'recover' };
export function offenseKind(st: Row[], role: number, slotPos: number): string {
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
export function defenseKind(st: Row[], cap: number, pos: number, role: number): { k: string; t?: number; z?: number } {
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
export function artPath(art: Row | undefined): { p: number[][]; cap: number } {
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
  for (const [x, y] of pts) { const q = [yd(x!), -yd(y!) || 0]; const last = out[out.length - 1]; if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q); }
  return { p: out.length > 1 ? out : [], cap };
}

export interface BookMeta { bgid: number; side: 'off' | 'def'; name: string } // from the PLAB list: BGID, BOFF, BNAM

// ---- one book --------------------------------------------------------------------------------------------------
// null when PGPL lists no plays for the book. Formations come in PGFM order; each one's sets (STID) hold the book's PGPL
// plays for that set in ord_ order; sets STID links under a formation PGFM does not list, then the special sets every
// book shares (BSMO, plays from DPSF: field goal / kneel / spike for the offense, FG block / punt return / kick return
// for the defense) go into a "Special Teams" formation. Assignments are shared through a dictionary: identical (role,
// kind, path) entries repeat across plays (every pass play's five pass-blockers, every run play's stalk-blocking
// receivers), which halves the file.
export function extractBook(db: PlaybookDb, bokl: number, meta: BookMeta): Book | null {
  const id = bokl, { bgid, side, name } = meta;
  const forms = db.PGFM.get(id) ?? [], sets = db.STID.get(id) ?? [], plays = db.PGPL.get(id) ?? [];
  if (!plays.length) return null;
  const playsOut: Record<string, Play> = {};
  const formationsOut: Formation[] = [];
  const dict: Assign[] = []; const dictIndex = new Map<string, number>();
  const intern = (o: Assign) => { const k = JSON.stringify(o); let i = dictIndex.get(k); if (i === undefined) { i = dict.length; dict.push(o); dictIndex.set(k, i); } return i; };
  const seenSet = new Set<number>();
  const ordered = (list: Row[]) => list.slice().sort((a, b) => (a.ord_ as number) - (b.ord_ as number));
  function buildSet(setId: number, setPlays: Row[]): SetDef | null {
    const setl = db.SETL.get(setId); if (!setl || seenSet.has(setId)) return null; seenSet.add(setId);
    const subs = db.SGFF.get(setId) ?? []; const dflt = (subs.find((x) => x.dflt) ?? subs[0])?.SGF_;
    const slots: Slot[] = (db.SETP.get(setId) ?? []).slice().sort((a, b) => (a.poso as number) - (b.poso as number)).map((sp) => {
      const gs = db.SETG.get(sp.SETP as number) ?? []; const g = gs.find((x) => x.SGF_ === dflt) ?? gs[0];
      return { i: sp.poso as number, pos: sp.EPos as number, depth: Math.max(0, (sp.DPos as number) - 1), x: g ? Math.round(f32(g.x___ as number) * 10) / 10 : 0, y: g ? Math.round(f32(g.y___ as number) * 10) / 10 : 0 };
    });
    const list: number[] = [];
    for (const p of ordered(setPlays)) {
      const plyl = p.PLYL as number; if (list.includes(plyl)) continue;
      const info = db.PBPL.get(plyl); if (!info) continue;
      list.push(plyl);
      if (playsOut[plyl]) continue;
      const assigns = (db.PLYS.get(plyl) ?? []).slice().sort((a, b) => (a.poso as number) - (b.poso as number));
      const a: number[] = new Array(11).fill(-1);
      for (const as of assigns) {
        const slot = slots[as.poso as number]; const st = db.steps(as.PSAL as number); const i = as.poso as number; if (i < 0 || i > 10) continue;
        if (side === 'off') { const art = artPath(db.ARTO.get(as.ARTL as number)); const k = offenseKind(st, as.PLRR as number, i); a[i] = intern({ r: as.PLRR as number, k, ...(art.p.length ? { p: art.p, c: art.cap } : {}) }); continue; }
        const art = artPath(db.ARTD.get(as.ARTL as number) ?? db.ARTO.get(as.ARTL as number)); const dk = defenseKind(st, art.cap, slot?.pos ?? 16, as.PLRR as number);
        a[i] = intern({ r: as.PLRR as number, k: dk.k, ...(dk.t !== undefined ? { t: dk.t } : {}), ...(dk.z !== undefined ? { z: dk.z } : {}), ...(art.p.length ? { p: art.p, c: art.cap } : {}) });
      }
      const prog = db.PLPD.get(plyl); const progOut: number[][] = [];
      if (prog) for (let i = 1; i <= 5; i++) { const pct = prog['per' + i] as number, rcv = prog['rcv' + i] as number; if (pct > 0) progOut.push([rcv, pct]); }
      const hole = db.PLRD.get(plyl)?.hole as number | undefined;
      playsOut[plyl] = { id: plyl, n: info.name as string, t: info.PLYT as number, sit: info.SITT as number, f: info.PLF_ as number, v: info.vpos as number, ...(hole !== undefined ? { h: hole } : {}), ...(progOut.length ? { prog: progOut } : {}), a };
    }
    return list.length ? { id: setId, n: setl.name as string, slots, plays: list } : null;
  }
  for (const f of ordered(forms)) {
    const fm = db.PBFM.get(f.PBFM as number);
    const fsets = sets.filter((s) => s.PBFM === f.PBFM);
    const setsOut: SetDef[] = [];
    for (const s of fsets) { const built = buildSet(s.SETL as number, plays.filter((p) => p.SETL === s.SETL)); if (built) setsOut.push(built); }
    if (setsOut.length) formationsOut.push({ id: f.PBFM as number, n: (fm?.name as string | undefined) ?? `Formation ${f.PBFM}`, t: (fm?.FTYP as number | undefined) ?? (side === 'off' ? 1 : 11), sets: setsOut });
  }
  const extra: { setl: number; plays: Row[] }[] = [];
  for (const s of sets) if (!seenSet.has(s.SETL as number)) extra.push({ setl: s.SETL as number, plays: plays.filter((p) => p.SETL === s.SETL) });
  for (const b of db.BSMO) { if (seenSet.has(b.SETL as number)) continue; const list: Row[] = (db.DPSF.get(b.SETL as number) ?? []).map((r) => ({ PLYL: r.PLYL as number, SETL: b.SETL as number, ord_: 0 })); if (list.length) extra.push({ setl: b.SETL as number, plays: list }); }
  const special: SetDef[] = [];
  for (const e of extra) {
    const sp = db.SETP.get(e.setl) ?? []; if (!sp.length) continue;
    // offense sets carry a QB/K/P/KO/LS or a line; defense sets a returner or a front seven
    const has = (...ps: number[]) => sp.some((x) => ps.includes(x.EPos as number));
    const defensiveSet = has(21, 22) || (!has(0, 19, 20, 23, 24) && sp.filter((x) => (x.EPos as number) >= 10 && (x.EPos as number) <= 18).length >= 6);
    if ((side === 'def') !== defensiveSet) continue;
    const built = buildSet(e.setl, e.plays); if (built) special.push(built);
  }
  if (special.length) { const st = formationsOut.find((f) => f.n === 'Special Teams'); if (st) st.sets.push(...special); else formationsOut.push({ id: 0, n: 'Special Teams', t: side === 'off' ? 1 : 11, sets: special }); }
  // AI weights: AIGR situation group -> [play, weight]; only plays present in this book
  const ai: Record<string, number[][]> = {};
  for (const r of db.PBA.get(id) ?? []) { if (!playsOut[r.PLYL as number]) continue; (ai[r.AIGR as number] ??= []).push([r.PLYL as number, r.prct as number]); }
  return { id, bgid, side, name, formations: formationsOut, plays: playsOut, asg: dict, ai };
}

// ---- index.json ------------------------------------------------------------------------------------------------
// one entry per book, offense first, then by name; `generated` is the only field that changes between identical runs
export function extractIndex(books: Book[], generated = new Date().toISOString()): BookIndex {
  const index: BookIndex['books'] = books.map((b) => ({ id: b.id, bgid: b.bgid, side: b.side, name: b.name, plays: Object.keys(b.plays).length, formations: b.formations.map((f) => f.n) }));
  index.sort((a, b) => (a.side === b.side ? a.name.localeCompare(b.name) : a.side < b.side ? 1 : -1));
  return { generated, books: index };
}
