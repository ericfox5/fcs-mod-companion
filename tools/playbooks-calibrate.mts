// Calibration of the play creator against the stock playbook database: harvests, per assignment kind, the step
// shapes EA's plays use (code sequences and their modal parameters), the PLRR roles per position, the play types
// (PLYT) and PBPL fields per concept, the cut-code conventions, and the art field widths, and writes them to
// packages/ncaa14/src/playbook/conventions.json, which the compiler (playbook/compile.ts) reads. The compiler never
// invents grammar: it fills numbers into the shapes recorded here, so what we do not understand (head codes, cut
// animations, the handoff hand/turn codes) is inherited from EA's own plays.
//
// Usage: npx tsx tools/playbooks-calibrate.mts [misc-7.db] [boot-360.db]   (defaults: fixtures/real/playbook/*.db,
// the game's qkl_misc.ast entry #7 and qkl_boot.ast entry #360 as the extractor dumps them; both are gitignored)
// Units, from EA's own play designer parameter table (PATY.PDOV = store scale) and confirmed on the stock data:
// distance = yards * 8, direction = turns * 128 (0 = the offense's right, counter-clockwise: 32 downfield, 64 left,
// 96 back), speed = percent * 2.54 (254 = full), time = seconds * 32, option offsets = yards * 16.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseTdb } from '../packages/tdb/src/index.ts';
import { PlaybookDb, type PlaybookRow } from '../packages/ncaa14/src/playbook/db.ts';
import { offenseKind, artPath } from '../packages/ncaa14/src/playbook/extract.ts';

const [miscPath = 'fixtures/real/playbook/misc-7.db', bootPath = 'fixtures/real/playbook/boot-360.db'] = process.argv.slice(2);
const miscBytes = new Uint8Array(readFileSync(miscPath));
const misc = parseTdb(miscBytes), boot = parseTdb(new Uint8Array(readFileSync(bootPath)));
const db = new PlaybookDb(misc, boot);
const f32 = (u: number) => new DataView(new Uint32Array([u >>> 0]).buffer).getFloat32(0, true);

type Counter<K> = Map<K, number>;
const inc = <K>(m: Counter<K>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);
const modal = <K>(m: Counter<K>): K | undefined => [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
const topList = <K>(m: Counter<K>, n = 8) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${String(k)}:${v}`).join('  ');
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
const nested = <K>(m: Map<string, Counter<K>>, k: string) => m.get(k) ?? m.set(k, new Map()).get(k)!;

// offensive plays = the plays listed in some book (PGPL); their set slots with coordinates
const offPlays = new Set<number>(); for (const rows of db.PGPL.values()) for (const r of rows) offPlays.add(r.PLYL as number);
function slotsOf(setl: number) {
  const subs = db.SGFF.get(setl) ?? []; const dflt = (subs.find((x) => x.dflt) ?? subs[0])?.SGF_;
  return (db.SETP.get(setl) ?? []).slice().sort((a, b) => (a.poso as number) - (b.poso as number)).map((sp) => { const gs = db.SETG.get(sp.SETP as number) ?? []; const g = gs.find((x) => x.SGF_ === dflt) ?? gs[0]; return { i: sp.poso as number, pos: sp.EPos as number, x: g ? f32(g.x___ as number) : 0, y: g ? f32(g.y___ as number) : 0 }; });
}
const trip = (s: PlaybookRow) => [s.code, s.val1, s.val2, s.val3].map(Number);
const key = (xs: number[]) => xs.join(',');
const unkey = (k: string | undefined, dflt: number[]) => (k ? k.split(',').map(Number) : dflt);

// ---- harvest ---------------------------------------------------------------------------------------------------------
const shapes = new Map<string, Counter<string>>(); // kind -> code sequence
const roles = new Map<string, Counter<number>>(); // "kind|pos" -> PLRR
const roleAll = new Map<string, Counter<number>>(); // kind -> PLRR
const routeRole = new Map<number, { n: number; depth: number[]; turn: number[]; legs: number[]; sit: number; pos: Counter<number> }>();
const plytField = new Map<number, { n: number; PLF_: Counter<number>; vpos: Counter<number>; SRMM: Counter<number>; SITT: Counter<number> }>();
const plytByConcept = new Map<string, Counter<number>>();
const qbDrop = new Map<string, Counter<string>>(); // "gun|uc|<PLYT>" -> "3 triple / 7 triple"
const rollouts = new Map<string, Counter<string>>(); // "L|R" -> program
const handTurn = new Map<string, Counter<string>>(); // "gun|uc" + "L|R|C" -> 38 triple
const handGive = new Map<string, Counter<string>>(); // "gun|uc" -> [run, exit]
const handFace: Counter<number> = new Map();
const paTurn: Counter<string> = new Map(), paFake: Counter<string> = new Map(), paThrow: Counter<string> = new Map(), paBack: Counter<string> = new Map();
const carryAnim = new Map<string, Counter<string>>(); // side -> 26 (val1,val2)
const carryDelay = new Map<string, Counter<number>>(); // gun|uc -> delay val (-1 none)
const carrySpeed: Counter<number> = new Map();
const cutLR: Counter<string> = new Map(); const cutType = new Map<number, Counter<number>>(); // |turn| (1/128) -> type
const stalk: Counter<string> = new Map(), release: Counter<string> = new Map(), readOpt: Counter<string> = new Map(), gunHandoff: Counter<string> = new Map();
const artSp: Counter<number> = new Map(); const artCap = new Map<string, Counter<number>>(); const artLegs = new Map<string, Counter<number>>();
const runPlyt = new Map<string, Counter<number>>(); // gun|uc -> PLYT of handoff runs
const holeX = new Map<number, number[]>(); // hole -> carrier x at the LOS
const progPct = new Map<number, Counter<string>>(); // receivers -> list
const leadAnim = new Map<string, Counter<string>>(); // pos -> 26 triple for lead blocks (block kind with 18)
const plfByPlyt = plytField;
let nPlays = 0, nAsg = 0;

for (const [plyl, info] of db.PBPL) {
  if (!offPlays.has(plyl)) continue; nPlays++;
  const slots = slotsOf(info.SETL as number);
  const asg = (db.PLYS.get(plyl) ?? []).slice().sort((a, b) => (a.poso as number) - (b.poso as number));
  const progs = asg.map((a) => { const st = db.steps(a.PSAL as number); return { a, st, slot: slots[a.poso as number], k: offenseKind(st, a.PLRR as number, a.poso as number), art: artPath(db.ARTO.get(a.ARTL as number)) }; });
  const qb = progs.find((p) => p.slot?.pos === 0); const gun = !!qb && qb.slot!.y < -3.5; const gk = gun ? 'gun' : 'uc';
  const kinds = new Set(progs.map((p) => p.k)); const plyt = info.PLYT as number;
  const concept = kinds.has('qbpa') ? 'pa' : kinds.has('screen') ? 'optroute' : kinds.has('qb') ? 'pass' : kinds.has('qbopt') ? 'option' : kinds.has('handoff') ? 'run' : kinds.has('kick') ? 'kick' : kinds.has('punt') ? 'punt' : 'other';
  inc(nested(plytByConcept, concept), plyt);
  const pf = plytField.get(plyt) ?? plytField.set(plyt, { n: 0, PLF_: new Map(), vpos: new Map(), SRMM: new Map(), SITT: new Map() }).get(plyt)!;
  pf.n++; inc(pf.PLF_, info.PLF_ as number); inc(pf.vpos, info.vpos as number); inc(pf.SRMM, info.SRMM as number); inc(pf.SITT, info.SITT as number);
  const prog = db.PLPD.get(plyl); if (prog) { const ps: number[] = []; for (let i = 1; i <= 5; i++) if ((prog['per' + i] as number) > 0) ps.push(prog['per' + i] as number); inc(nested(progPct, ps.length), ps.join('/')); }
  const carrier = progs.find((p) => p.k === 'carry');
  const hole = db.PLRD.get(plyl);
  if (hole && carrier?.slot && carrier.art.p.length > 1) { // where the run track crosses the line of scrimmage
    const P = carrier.art.p; for (let i = 1; i < P.length; i++) { const y0 = carrier.slot.y + P[i - 1]![1]!, y1 = carrier.slot.y + P[i]![1]!; if (y0 < 0 && y1 >= 0) { const x = carrier.slot.x + P[i - 1]![0]! + (P[i]![0]! - P[i - 1]![0]!) * ((0 - y0) / (y1 - y0)); (holeX.get(hole.hole as number) ?? holeX.set(hole.hole as number, []).get(hole.hole as number)!).push(x); break; } }
  }
  if (concept === 'run' && carrier) inc(nested(runPlyt, gk), plyt);
  for (const p of progs) {
    nAsg++; const codes = p.st.map((s) => s.code as number); const seq = codes.join(' '); const pos = p.slot?.pos ?? -1;
    inc(nested(shapes, p.k), seq); inc(nested(roles, `${p.k}|${pos}`), p.a.PLRR as number); inc(nested(roleAll, p.k), p.a.PLRR as number);
    inc(nested(artCap, p.k), p.art.cap); inc(nested(artLegs, p.k), p.art.p.length ? p.art.p.length - 1 : 0);
    const artRow = db.ARTO.get(p.a.ARTL as number); if (artRow) for (let i = 1; i <= 12; i++) { const k = String(i).padStart(2, '0'); if (artRow['ax' + k] || artRow['ay' + k]) inc(artSp, artRow['sp' + k] as number); }
    const legs = p.st.filter((s) => s.code === 8);
    if (p.k === 'route' && codes.includes(10) && !codes.includes(33) && legs.length) { // real routes: role signature
      const r = p.a.PLRR as number; const e = routeRole.get(r) ?? routeRole.set(r, { n: 0, depth: [], turn: [], legs: [], sit: 0, pos: new Map() }).get(r)!;
      e.n++; e.depth.push((legs[0]!.val1 as number) / 8); e.legs.push(legs.length); if (codes.includes(25)) e.sit++; inc(e.pos, pos);
      if (legs[1]) e.turn.push(((((legs[1].val2 as number) - (legs[0]!.val2 as number)) % 128) + 192) % 128 - 64); else e.turn.push(0);
      // cut conventions: val1 left/right against the turn sense, val2 type against the turn size
      for (let i = 0; i < p.st.length; i++) if (p.st[i]!.code === 9) { const before = p.st.slice(0, i).filter((s) => s.code === 8).length; const l0 = legs[before - 1], l1 = legs[before]; if (!l0 || !l1) continue; const turn = ((((l1.val2 as number) - (l0.val2 as number)) % 128) + 192) % 128 - 64; if (!turn) continue; inc(cutLR, `${turn > 0 ? 'ccw' : 'cw'}:${p.st[i]!.val1}`); inc(nested(cutType, Math.abs(turn)), p.st[i]!.val2 as number); }
    }
    if (p.k === 'route' && codes.includes(33) && codes.includes(18)) inc(stalk, p.st.map((s) => key(trip(s))).join(' '));
    if (p.k === 'block' && seq === '14 3 18 14 255') inc(release, p.st.map((s) => key(trip(s))).join(' '));
    if (p.k === 'block' && codes.includes(18) && (pos === 1 || pos === 2 || pos === 4)) { const s26 = p.st.find((s) => s.code === 26); inc(nested(leadAnim, String(pos)), s26 ? key(trip(s26).slice(1)) : 'none'); }
    if (p.k === 'qb') { const s3 = p.st.find((s) => s.code === 3), s7 = p.st.find((s) => s.code === 7); if (s3 && s7 && codes[0] === 3) { if (s3.val2 === 96) inc(nested(qbDrop, `${gk}|${plyt}`), `${key(trip(s3))} / ${key(trip(s7))}`); else inc(nested(rollouts, (s3.val2 as number) > 96 ? 'R' : 'L'), p.st.map((s) => key(trip(s))).join(' ') + ` PLYT${plyt}`); } }
    if (p.k === 'qbopt' && codes[0] === 12 && seq === '12 1 255') inc(readOpt, p.st.map((s) => key(trip(s))).join(' ') + ` PLYT${plyt}`);
    if (p.k === 'handoff' && qb) {
      const side = carrier?.slot ? (carrier.slot.x < qb.slot!.x - 0.5 ? 'L' : carrier.slot.x > qb.slot!.x + 0.5 ? 'R' : 'C') : 'C';
      const s38 = p.st.find((s) => s.code === 38), s39 = p.st.find((s) => s.code === 39), s5 = p.st.find((s) => s.code === 5);
      if (s38) inc(nested(handTurn, gk + side), key(trip(s38).slice(1))); if (s39) inc(nested(handGive, gk), key([s39.val2 as number, s39.val3 as number])); if (s5) inc(handFace, s5.val1 as number);
      if (codes[0] === 12) inc(gunHandoff, p.st.map((s) => key(trip(s))).join(' ') + ` PLYT${plyt}`);
    }
    if (p.k === 'qbpa') { const s38 = p.st.find((s) => s.code === 38), s40 = p.st.find((s) => s.code === 40), s7 = p.st.find((s) => s.code === 7); if (s38) inc(paTurn, key(trip(s38).slice(1))); if (s40) inc(paFake, key([s40.val2 as number, s40.val3 as number])); if (s7) inc(paThrow, key(trip(s7).slice(1)));
      const back = progs.find((q) => q.slot && (q.slot.pos === 1 || q.slot.pos === 2) && q.st.some((s) => s.code === 13)); if (back) inc(paBack, back.st.map((s) => key(trip(s))).join(' ')); }
    if (p.k === 'carry') { const s26 = p.st.find((s) => s.code === 26), s25 = p.st.find((s) => s.code === 25), s13 = p.st.find((s) => s.code === 13); const dir = s13 ? (s13.val2 as number) : 32; const side = dir < 32 || dir > 96 ? 'R' : dir > 32 && dir < 96 ? 'L' : 'C'; if (s26) inc(nested(carryAnim, side), key(trip(s26).slice(1, 3))); inc(nested(carryDelay, gk), s25 ? (s25.val1 as number) : -1); if (s13) inc(carrySpeed, s13.val3 as number); }
  }
}

// ---- derive the conventions ---------------------------------------------------------------------------------------------
const widths: Record<string, Record<string, number>> = {}; // art segment index -> field -> bits (signed): the room a drawn path has
const arto = misc.table('ARTO'); for (let i = 1; i <= 12; i++) { const k = String(i).padStart(2, '0'); widths[k] = { ax: arto.field('ax' + k).bits, ay: arto.field('ay' + k).bits, au: arto.field('au' + k).bits, av: arto.field('av' + k).bits }; }
const pslo = misc.table('PSLO'); const stepBits = { val1: pslo.field('val1').bits, val2: pslo.field('val2').bits, val3: pslo.field('val3').bits, step: pslo.field('step').bits, code: pslo.field('code').bits };
const pbpl = misc.table('PBPL'); const nameBits = pbpl.field('name').bits;
const rolesOut: Record<string, Record<string, number>> = {};
for (const [kp, m] of roles) { const [k, pos] = kp.split('|'); (rolesOut[k!] ??= {})[pos!] = modal(m)!; }
for (const [k, m] of roleAll) (rolesOut[k] ??= {})['*'] = modal(m)!;
const routeRoles = [...routeRole].filter(([, e]) => e.n >= 20).map(([r, e]) => ({ r, n: e.n, depth: Math.round(median(e.depth) * 2) / 2, turn: Math.round(median(e.turn) * 360 / 128), legs: median(e.legs), sit: Math.round((e.sit / e.n) * 100) / 100, pos: modal(e.pos)! })).sort((a, b) => b.n - a.n);
const cutTypes: [number, number][] = [...cutType].map(([t, m]) => [Math.round(t * 360 / 128), modal(m)!] as [number, number]).sort((a, b) => a[0] - b[0]);
const plytOut: Record<string, { n: number; PLF_: number; vpos: number; SRMM: number; SITT: number }> = {};
for (const [t, f] of [...plytField].sort((a, b) => a[0] - b[0])) plytOut[String(t)] = { n: f.n, PLF_: modal(f.PLF_)!, vpos: modal(f.vpos)!, SRMM: modal(f.SRMM)!, SITT: modal(f.SITT)! };
const drop = (k: string) => { const m = qbDrop.get(k); if (!m) return null; const [a, b] = modal(m)!.split(' / '); return { move: unkey(a, [3, 8, 96, 254]), pass: unkey(b, [7, 35, 0, 0]) }; };
const pick = <K>(m: Counter<K> | undefined, dflt: K): K => (m ? modal(m) ?? dflt : dflt);
const holeOut: Record<string, number> = {}; for (const [h, xs] of holeX) if (xs.length >= 10) holeOut[String(h)] = Math.round(median(xs) * 10) / 10;
const shapesOut: Record<string, [string, number][]> = {}; for (const [k, m] of shapes) shapesOut[k] = [...m].sort((a, b) => b[1] - a[1]).slice(0, 6);
const conventions = {
  generated: new Date().toISOString(), source: { misc: `qkl_misc.ast entry #7, sha256 ${createHash('sha256').update(miscBytes).digest('hex')}`, plays: nPlays, assignments: nAsg },
  // store scales (EA's PATY.PDOV) and the direction frame fitted on the stock data
  scale: { dist: 8, dir: 128, speed: 2.54, time: 32, offset: 16 }, dir: { origin: 'right', ccw: true, downfield: 32, left: 64, back: 96 }, speedFull: 254,
  limits: { stepBits, stepsPerProgram: 1 << stepBits.step, artSegments: 12, artWidths: widths, nameChars: 24 /* PBPL.name is 24 chars in the per-book DBs the game plays; the master allows nameBits/8 */, progReceiverBits: 3 },
  cut: { lr: { cw: Number(modal(new Map([...cutLR].filter(([k]) => k.startsWith('cw')).map(([k, v]) => [k.split(':')[1], v])))), ccw: Number(modal(new Map([...cutLR].filter(([k]) => k.startsWith('ccw')).map(([k, v]) => [k.split(':')[1], v])))) }, types: cutTypes },
  qb: {
    gun: drop('gun|103') ?? { move: [3, 8, 96, 254], pass: [7, 35, 0, 0] }, uc: drop('uc|102') ?? { move: [3, 30, 96, 254], pass: [7, 3, 0, 0] }, quick: drop('uc|101') ?? { move: [3, 8, 96, 254], pass: [7, 16, 0, 0] },
    screenGun: drop('gun|5') ?? { move: [3, 8, 96, 254], pass: [7, 36, 0, 0] }, screenUc: drop('uc|5') ?? { move: [3, 30, 96, 254], pass: [7, 28, 0, 0] }, rpo: drop('gun|6') ?? { move: [3, 8, 96, 254], pass: [7, 31, 0, 0] },
    rollR: (modal(rollouts.get('R') ?? new Map()) ?? '3,33,113,254 7,26,0,0 255,0,0,0 PLYT7').split(' PLYT')[0]!.split(' ').map((s) => s.split(',').map(Number)).filter((t) => t[0] !== 255),
    rollL: (modal(rollouts.get('L') ?? new Map()) ?? '3,33,85,254 7,27,80,64 255,0,0,0 PLYT7').split(' PLYT')[0]!.split(' ').map((s) => s.split(',').map(Number)).filter((t) => t[0] !== 255),
  },
  handoff: { turn: Object.fromEntries(['gunL', 'gunR', 'gunC', 'ucL', 'ucR', 'ucC'].map((k) => [k, unkey(pick(handTurn.get(k), undefined as unknown as string), [1, 32, 64])])), give: unkey(pick(handGive.get('uc'), '1,2'), [1, 2]), giveGun: unkey(pick(handGive.get('gun'), '1,2'), [1, 2]), face: pick(handFace, 32), gunShape: topList(gunHandoff, 3) },
  pa: { turn: unkey(pick(paTurn, '2,32,0'), [2, 32, 0]), fake: unkey(pick(paFake, '1,2'), [1, 2]), pass: unkey(pick(paThrow, '0,0,0'), [0, 0, 0]), back: pick(paBack, '26,1,14,0 13,48,18,191 14,0,0,0 255,0,0,0') },
  carry: { anim: Object.fromEntries([...carryAnim].map(([side, m]) => [side, unkey(modal(m), [22, side === 'L' ? 64 : 0])])), delayGun: pick(carryDelay.get('gun'), -1), delayUc: pick(carryDelay.get('uc'), -1), speed: pick(carrySpeed, 191) },
  lead: Object.fromEntries([...leadAnim].map(([pos, m]) => [pos, modal(m)])),
  stalk: (modal(stalk) ?? '8,80,32,254 33,12,0,0 18,2,32,254 15,0,0,0 255,0,0,0').split(' ').map((s) => s.split(',').map(Number)).filter((t) => t[0] !== 255),
  release: (modal(release) ?? '14,8,0,0 3,12,8,254 18,80,1,254 14,0,2,0 255,0,0,0').split(' ').map((s) => s.split(',').map(Number)).filter((t) => t[0] !== 255),
  readOption: (modal(readOpt) ?? '12,1,12,1 1,0,0,0 255,0,0,0 PLYT169'),
  plyt: { gunPass: 103, ucPass: 102, quick: 101, screen: 5, rpo: 6, rollout: 7, pa: 4, runGun: pick(runPlyt.get('gun'), 151), runUc: pick(runPlyt.get('uc'), 13), readOption: 169, byConcept: Object.fromEntries([...plytByConcept].map(([c, m]) => [c, topList(m, 8)])) },
  pbpl: plytOut,
  prog: Object.fromEntries([...progPct].map(([n, m]) => [n, topList(m, 4)])),
  roles: rolesOut, routeRoles,
  hole: holeOut,
  art: { sp: pick(artSp, 15), caps: Object.fromEntries([...artCap].map(([k, m]) => [k, modal(m)])), legs: Object.fromEntries([...artLegs].map(([k, m]) => [k, topList(m, 5)])) },
  shapes: shapesOut,
};
const out = new URL('../packages/ncaa14/src/playbook/conventions.json', import.meta.url);
writeFileSync(out, JSON.stringify(conventions, null, 1) + '\n');
console.log(`plays ${nPlays}, assignments ${nAsg}; wrote ${out.pathname}`);
console.log('cut left/right:', topList(cutLR), '\ncut types (deg -> type):', JSON.stringify(cutTypes));
console.log('qb gun:', JSON.stringify(conventions.qb.gun), 'uc:', JSON.stringify(conventions.qb.uc), 'quick:', JSON.stringify(conventions.qb.quick));
console.log('rollouts:', JSON.stringify(conventions.qb.rollR), JSON.stringify(conventions.qb.rollL));
console.log('handoff:', JSON.stringify(conventions.handoff));
console.log('pa:', JSON.stringify(conventions.pa));
console.log('carry:', JSON.stringify(conventions.carry), 'lead:', JSON.stringify(conventions.lead));
console.log('read option:', conventions.readOption, '\nrun PLYT gun/uc:', topList(runPlyt.get('gun') ?? new Map()), '|', topList(runPlyt.get('uc') ?? new Map()));
console.log('holes (median x at LOS):', JSON.stringify(holeOut));
console.log('route roles:', routeRoles.slice(0, 24).map((r) => `${r.r}(n${r.n} d${r.depth} t${r.turn} l${r.legs} s${r.sit} p${r.pos})`).join(' '));
console.log('roles:', JSON.stringify(rolesOut));
console.log('prog:', JSON.stringify(conventions.prog));
