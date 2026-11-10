// The play creator's compiler: a play drawn on the site (DrawnPlay: one SlotDraw per slot of a set, kinds and paths in
// yards) becomes the game's own representation, one PSLO step program and one ARTO art row per slot plus the PBPL /
// PLPD / PLRD fields, and from those rows the site's Book assignments through the same classifier the extractor uses
// (offenseKind + artPath), so the book Supersim runs is by construction what the console will show once the bridge
// writes the rows (Part 4). Template-and-parameter compilation: every step shape here is one EA's own plays use
// (tools/playbooks-calibrate.mts harvests them into conventions.json); the compiler only fills distances, directions,
// speeds, player numbers and cut codes. Units (conventions.scale): distance = yards * 8, direction = turns * 128 with
// 0 = the offense's right, counter-clockwise (32 downfield, 64 left, 96 back), speed = percent * 2.54, time = s * 32.
// Offense only; defensive play creation is a later phase.
import conventions from './conventions.json' with { type: 'json' };
import type { Assign, Play, SetDef, Slot } from './types.js';
import { LIMITS, type DrawnPlay, type SlotDraw } from './model.js';
import { offenseKind, artPath } from './extract.js';
import type { PlaybookRow } from './db.js';

export type Step = [number, number, number, number]; // code, val1, val2, val3 (PSLO row)
export interface ArtSeg { at: number; ct: number; ax: number; ay: number; au: number; av: number; sp: number } // one ARTO segment, feet, screen-down positive
export interface CompiledSlot { poso: number; role: number; steps: Step[]; art: ArtSeg[] } // steps end with the 255 terminator
export interface CompiledPlay { name: string; plyt: number; sitt: number; plf: number; vpos: number; srmm: number; slots: CompiledSlot[]; prog?: number[][]; hole?: number }
export class CompileError extends Error { constructor(public problems: string[]) { super(problems.join('; ')); this.name = 'CompileError'; } }

// The creator's vocabulary (SlotDraw.k) and the options each kind reads from SlotDraw.o:
//   route   p: waypoints        o.speed %, o.sit seconds (hitch / curl: settle before getting open), o.fake 1 (fake handoff on the first leg)
//   stalk   p: one point (depth) a receiver's run block: run the stem, then stalk-block the defender over him
//   block   p: optional path    run block; with a path a lead block along it (backs, tight ends)
//   pblock  -                   pass block
//   release p: path             screen blocker: pass block briefly, then release along the path and block for the receiver
//   carry   p: run track        the ball carrier (first leg receives the handoff); o.speed %, o.delay seconds
//   fake    p: short path       a back's fake handoff (play action), then pass block
//   move    p: path             just move (decoys)
//   qb      o.drop: 0 drop-back, 1 quick game, 2 deep drop, 3 roll right, 4 roll left, 5 screen, 6 RPO
//   qbpa    o.fake: the faking back's slot (play action pass)
//   handoff o.to: the carrier's slot
//   qbopt   o.to: the carrier's slot; p: the keep track (read option)
export const DRAW_KINDS = ['route', 'stalk', 'block', 'pblock', 'release', 'carry', 'fake', 'move', 'qb', 'qbpa', 'handoff', 'qbopt'] as const;
export type DrawKind = (typeof DRAW_KINDS)[number];
export const QB_KINDS: readonly string[] = ['qb', 'qbpa', 'handoff', 'qbopt'];
export const DROPS = ['Drop back', 'Quick game', 'Deep drop', 'Roll right', 'Roll left', 'Screen', 'RPO'] as const;
const C = conventions;
const CODE = { carry: 1, move: 3, face: 4, route: 8, cut: 9, open: 10, optHandoff: 12, receive: 13, pblock: 14, rblock: 15, lead: 18, delay: 25, anim: 26, pull: 33, turn: 38, give: 39, fakeGive: 40, end: 255 } as const;
const SPEED = { full: C.speedFull, carry: C.carry.speed }; // 254 = 100 %, 191 = 75 % (the stock carrier speed)
const OL = (pos: number) => pos >= 5 && pos <= 9;
const posName = ['QB', 'HB', 'FB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT', 'LE', 'RE', 'DT', 'LLB', 'MLB', 'RLB', 'CB', 'FS', 'SS', 'K', 'P', 'KR', 'PR', 'KO', 'LS'];
const label = (s: Slot) => `${posName[s.pos] ?? s.pos}${s.depth ? s.depth + 1 : ''} (slot ${s.i + 1})`;

// ---- geometry -----------------------------------------------------------------------------------------------------------
type Pt = [number, number]; // yards from the slot's alignment: x right, y downfield
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
const r1 = (n: number) => Math.round(n * 10) / 10;
export const dirUnits = (dx: number, dy: number) => ((Math.round((Math.atan2(dy, dx) * C.scale.dir) / (2 * Math.PI)) % C.scale.dir) + C.scale.dir) % C.scale.dir;
const dirDeg = (u: number) => (u * 360) / C.scale.dir;
const turnOf = (from: number, to: number) => ((((to - from) % C.scale.dir) + C.scale.dir * 1.5) % C.scale.dir) - C.scale.dir / 2; // (-64, 64]: + = counter-clockwise = to the left
const dist8 = (yd: number) => clamp(Math.round(yd * C.scale.dist), 1, 255);
const time32 = (s: number) => clamp(Math.round(s * C.scale.time), 0, 224);
const speedOf = (pct: number | undefined, dflt: number) => (pct === undefined ? dflt : clamp(Math.round(pct * C.scale.speed), 25, 254));
// a drawn path as legs (dx, dy, length); points closer than 0.3 yd to the previous one are dropped
function legsOf(p: number[][] | undefined): { pts: Pt[]; legs: { dx: number; dy: number; len: number; dir: number }[] } {
  const pts: Pt[] = [[0, 0]];
  for (const q of p ?? []) { const x = r1(Number(q[0]) || 0), y = r1(Number(q[1]) || 0); const l = pts[pts.length - 1]!; if (Math.hypot(x - l[0], y - l[1]) >= 0.3) pts.push([x, y]); }
  const legs = []; for (let i = 1; i < pts.length; i++) { const dx = pts[i]![0] - pts[i - 1]![0], dy = pts[i]![1] - pts[i - 1]![1]; legs.push({ dx, dy, len: Math.hypot(dx, dy), dir: dirUnits(dx, dy) }); }
  return { pts, legs };
}
// Douglas-Peucker down to at most `max` points after the origin (the art has 12 segments, the later ones narrow)
export function simplifyPath(p: number[][], max = 8, tol = 0.4): number[][] {
  const pts = legsOf(p).pts; if (pts.length - 1 <= max) return pts.slice(1);
  const keep = new Set<number>([0, pts.length - 1]);
  const dp = (a: number, b: number) => { let worst = -1, at = -1; const [ax, ay] = pts[a]!, [bx, by] = pts[b]!; const L = Math.hypot(bx - ax, by - ay) || 1; for (let i = a + 1; i < b; i++) { const [x, y] = pts[i]!; const d = Math.abs((bx - ax) * (ay - y) - (ax - x) * (by - ay)) / L; if (d > worst) { worst = d; at = i; } } if (at >= 0 && worst > tol) { keep.add(at); dp(a, at); dp(at, b); } };
  dp(0, pts.length - 1);
  let out = [...keep].sort((a, b) => a - b).map((i) => pts[i]!);
  while (out.length - 1 > max) { // still too many: drop the point whose removal bends the line least
    let best = 1, bestD = Infinity; for (let i = 1; i < out.length - 1; i++) { const [ax, ay] = out[i - 1]!, [bx, by] = out[i + 1]!, [x, y] = out[i]!; const d = Math.abs((bx - ax) * (ay - y) - (ax - x) * (by - ay)) / (Math.hypot(bx - ax, by - ay) || 1); if (d < bestD) { bestD = d; best = i; } } out.splice(best, 1);
  }
  return out.slice(1);
}

// ---- art ----------------------------------------------------------------------------------------------------------------
// one segment per path point, absolute from the alignment in feet (ax right, ay screen-down = -downfield), cap on the last
const WIDTHS = C.limits.artWidths as Record<string, { ax: number; ay: number }>;
function artOf(pts: Pt[], cap: number, who: string, problems: string[]): ArtSeg[] {
  const segs: ArtSeg[] = [];
  for (let i = 1; i < pts.length; i++) {
    const k = String(i).padStart(2, '0'); const w = WIDTHS[k]; if (!w) { problems.push(`${who}: the play art holds ${C.limits.artSegments} points at most`); break; }
    const ax = Math.round(pts[i]![0] * 3), ay = Math.round(-pts[i]![1] * 3); const mx = 2 ** (w.ax - 1) - 1, my = 2 ** (w.ay - 1) - 1;
    if (Math.abs(ax) > mx || Math.abs(ay) > my) problems.push(`${who}: point ${i} (${pts[i]![0]}, ${pts[i]![1]} yd) is too far for the play art (point ${i} may reach ${Math.floor(mx / 3)} yd across and ${Math.floor(my / 3)} yd deep)`);
    segs.push({ at: 0, ct: i === pts.length - 1 ? cap : 0, ax: clamp(ax, -mx, mx), ay: clamp(ay, -my, my), au: 0, av: 0, sp: C.art.sp });
  }
  return segs;
}
const CAP = { arrow: 2, block: 1 };

// ---- step shapes ----------------------------------------------------------------------------------------------------------
const step = (code: number, v1 = 0, v2 = 0, v3 = 0): Step => [code, v1, v2, v3];
const END = step(CODE.end);
const asSteps = (t: number[][]): Step[] => t.map((x) => step(x[0]!, x[1], x[2], x[3]));
// a cut between two legs: val1 1 = turning right (clockwise), 2 = left; val2 the cut animation by the size of the turn
export function cutStep(turn: number): Step | null {
  const deg = Math.abs(dirDeg(turn)); if (deg < 8) return null;
  const type = deg <= 30 ? 3 : deg <= 56 ? 1 : deg <= 82 ? 4 : deg <= 125 ? 2 : 7; // 22°, 45°, 67°, 90°, comeback
  return step(CODE.cut, turn < 0 ? C.cut.lr.cw : C.cut.lr.ccw, type);
}
// route legs: one `8` per leg (long legs split at 31 yards), a cut where the direction changes
function routeLegs(legs: { len: number; dir: number }[], speed: number, code: number = CODE.route): Step[] {
  const out: Step[] = [];
  legs.forEach((l, i) => {
    if (i > 0) { const cut = cutStep(turnOf(legs[i - 1]!.dir, l.dir)); if (cut) out.push(cut); }
    let rem = l.len; while (rem > 0) { const part = Math.min(rem, 255 / C.scale.dist); out.push(step(code, dist8(part), l.dir, speed)); rem -= part; }
  });
  return out;
}
const routeRoleOf = (depth: number, turn: number, legs: number, sit: boolean, pos: number): number => {
  let best = C.roles.route['*'], bestD = Infinity;
  for (const r of C.routeRoles) { const d = Math.abs(r.depth - depth) / 3 + Math.abs(r.turn - turn) / 30 + Math.abs(r.legs - legs) + 2 * Math.abs(r.sit - (sit ? 1 : 0)) + (r.pos === pos ? 0 : 1); if (d < bestD) { bestD = d; best = r.r; } }
  return best;
};
const roleOf = (kind: string, pos: number): number => { const r = (C.roles as Record<string, Record<string, number>>)[kind]; return r?.[String(pos)] ?? r?.['*'] ?? 2; };
const needPath = (who: string, legs: unknown[], what: string, problems: string[]) => { if (!legs.length) problems.push(`${who}: draw ${what}`); return legs.length > 0; };

interface Ctx { set: SetDef; draw: DrawnPlay; slots: Slot[]; qb: Slot | null; gun: boolean; carrier: number | null; problems: string[] }

function compileSlot(d: SlotDraw, slot: Slot, ctx: Ctx): CompiledSlot {
  const who = label(slot), P = ctx.problems, o = d.o ?? {};
  const { pts, legs } = legsOf(d.p ? simplifyPath(d.p) : undefined);
  const kind = d.k as DrawKind;
  const out = (steps: Step[], art: ArtSeg[], role: number): CompiledSlot => {
    if (steps.length > C.limits.stepsPerProgram) P.push(`${who}: ${steps.length} steps; a program holds ${C.limits.stepsPerProgram} (fewer legs)`);
    return { poso: slot.i, role, steps, art };
  };
  switch (kind) {
    case 'route': {
      if (!needPath(who, legs, 'the route', P)) return out([step(CODE.route, 8, 32, SPEED.full), step(CODE.open), END], [], roleOf('route', slot.pos));
      const speed = speedOf(o['speed'], SPEED.full); const steps = routeLegs(legs, speed);
      if (o['fake']) steps[0] = step(CODE.receive, steps[0]![1], steps[0]![2], SPEED.carry); // fake handoff on the stem
      if (o['sit']) steps.push(step(CODE.delay, time32(o['sit'])));
      steps.push(step(CODE.open), END);
      const depth = legs[0]!.len, turn = legs[1] ? dirDeg(turnOf(legs[0]!.dir, legs[1].dir)) : 0;
      return out(steps, artOf(pts, CAP.arrow, who, P), routeRoleOf(depth, turn, legs.length, !!o['sit'], slot.pos));
    }
    case 'stalk': {
      const depth = legs[0]?.len ?? 10, dir = legs[0]?.dir ?? C.dir.downfield; const t = C.stalk;
      const steps = [step(CODE.route, dist8(depth), dir, SPEED.full), step(t[1]![0]!, t[1]![1], t[1]![2], t[1]![3]), step(t[2]![0]!, t[2]![1], t[2]![2], t[2]![3]), step(CODE.rblock), END];
      const end: Pt = legs[0] ? pts[1]! : [0, depth];
      return out(steps, artOf([[0, 0], end], CAP.block, who, P), roleOf('route', slot.pos));
    }
    case 'block': {
      if (legs.length && !OL(slot.pos)) return out([...routeLegs(legs, SPEED.full, CODE.lead), END], artOf(pts, CAP.block, who, P), roleOf('block', slot.pos)); // lead block along the path
      if (legs.length) P.push(`${who}: linemen block where they stand (pulls come later); the path was dropped`);
      return out([step(CODE.rblock), END], artOf([[0, 0], [0, 1]], CAP.block, who, P), roleOf('block', slot.pos));
    }
    case 'pblock': return out([step(CODE.pblock), END], artOf([[0, 0], [0, 1]], CAP.block, who, P), roleOf('pblock', slot.pos));
    case 'release': {
      if (!needPath(who, legs, 'where he releases to', P)) return out([step(CODE.pblock), END], [], roleOf('pblock', slot.pos));
      const t = C.release; const first = legs[0]!, rest = legs.slice(1);
      const steps: Step[] = [step(t[0]![0]!, t[0]![1], t[0]![2], t[0]![3])];
      if (rest.length) { steps.push(step(CODE.move, dist8(first.len), first.dir, SPEED.full)); steps.push(...routeLegs(rest, SPEED.full, CODE.lead)); } else steps.push(step(CODE.lead, dist8(first.len), first.dir, SPEED.full));
      steps.push(step(t[3]![0]!, t[3]![1], t[3]![2], t[3]![3]), END);
      return out(steps, artOf(pts, CAP.block, who, P), roleOf('pblock', slot.pos));
    }
    case 'carry': {
      if (!needPath(who, legs, 'the run track', P)) return out([step(CODE.receive, 24, 32, SPEED.carry), step(CODE.carry), END], [], roleOf('carry', slot.pos));
      const speed = speedOf(o['speed'], SPEED.carry); const steps: Step[] = [];
      if (o['delay']) steps.push(step(CODE.delay, time32(o['delay'])));
      const d0 = legs[0]!.dir; const side = d0 < C.dir.downfield || d0 > C.dir.back ? 'R' : d0 > C.dir.downfield && d0 < C.dir.back ? 'L' : 'C';
      if ((slot.pos === 1 || slot.pos === 2) && side !== 'C') { const a = (C.carry.anim as Record<string, number[]>)[side]!; steps.push(step(CODE.anim, a[0], a[1])); }
      legs.forEach((l, i) => { let rem = l.len; let first = i === 0; while (rem > 0) { const part = Math.min(rem, 255 / C.scale.dist); steps.push(step(first ? CODE.receive : CODE.move, dist8(part), l.dir, first ? speed : SPEED.full)); rem -= part; first = false; } });
      steps.push(step(CODE.carry), END);
      return out(steps, artOf(pts, CAP.arrow, who, P), roleOf('carry', slot.pos));
    }
    case 'fake': {
      const l = legs[0] ?? { len: 2, dir: ctx.qb && slot.x < ctx.qb.x ? 8 : 56 }; // toward the quarterback's side when nothing is drawn
      const b = C.pa.back.split(' ').map((s) => s.split(',').map(Number)); const anim = b.find((t) => t[0] === CODE.anim);
      const steps: Step[] = []; if (anim) steps.push(step(CODE.anim, anim[1], l.dir));
      steps.push(step(CODE.receive, dist8(l.len), l.dir, SPEED.carry)); for (const x of legs.slice(1)) steps.push(step(CODE.move, dist8(x.len), x.dir, SPEED.full));
      steps.push(step(CODE.pblock), END);
      return out(steps, artOf(legs.length ? pts : [[0, 0], [Math.cos((l.dir / 128) * 2 * Math.PI) * 2, Math.sin((l.dir / 128) * 2 * Math.PI) * 2]], CAP.block, who, P), roleOf('pblock', slot.pos));
    }
    case 'move': {
      if (!needPath(who, legs, 'where he goes', P)) return out([step(CODE.rblock), END], [], roleOf('move', slot.pos));
      return out([...routeLegs(legs, SPEED.full, CODE.move), END], artOf(pts, CAP.arrow, who, P), roleOf('move', slot.pos));
    }
    case 'qb': {
      const drop = Number(o['drop'] ?? 0); const q = C.qb;
      const pick = (g: { move: number[]; pass: number[] }) => out([...asSteps([g.move, g.pass]), END], [], roleOf('qb', slot.pos));
      if (drop === 1) return pick(ctx.gun ? { move: q.gun.move, pass: q.quick.pass } : q.quick);
      if (drop === 2) return pick(ctx.gun ? { move: [3, 16, C.dir.back, SPEED.full], pass: q.gun.pass } : { move: [3, 34, C.dir.back, SPEED.full], pass: [7, 4, 0, 0] });
      if (drop === 3 || drop === 4) { const t = drop === 3 ? q.rollR : q.rollL, sx = drop === 3 ? 1 : -1; return out([...asSteps(t), END], artOf([[0, 0], [sx * 4, -3], [sx * 7, -2]], CAP.arrow, who, P), roleOf('qb', slot.pos)); }
      if (drop === 5) return pick(ctx.gun ? q.screenGun : q.screenUc);
      if (drop === 6) { if (ctx.carrier === null) P.push(`${who}: an RPO needs a ball carrier (give one back the Carry assignment)`); return pick(ctx.gun ? q.rpo : { move: q.uc.move, pass: q.rpo.pass }); }
      return pick(ctx.gun ? q.gun : q.uc);
    }
    case 'qbpa': {
      const fake = Number(o['fake'] ?? -1); const f = ctx.slots[fake];
      if (!f || f.i === slot.i) P.push(`${who}: pick the back who fakes the handoff`);
      const [g0, g1] = C.pa.fake; return out([step(CODE.turn, C.pa.turn[0], C.pa.turn[1], C.pa.turn[2]), step(CODE.fakeGive, f ? f.i : 1, g0, g1), step(7, C.pa.pass[0], C.pa.pass[1], C.pa.pass[2]), END], [], roleOf('qbpa', slot.pos));
    }
    case 'handoff': {
      const to = ctx.carrier; if (to === null) P.push(`${who}: a handoff needs a ball carrier (give one back the Carry assignment)`);
      const c = to === null ? null : ctx.slots[to]!; const cd = to === null ? null : ctx.draw.slots[to];
      const mesh = c ? c.x + (cd?.p?.[0]?.[0] ?? 0) - slot.x : 0; const side = mesh < -0.5 ? 'L' : mesh > 0.5 ? 'R' : 'C';
      const turn = (C.handoff.turn as Record<string, number[]>)[(ctx.gun ? 'gun' : 'uc') + side]!; const [run, exit] = ctx.gun ? C.handoff.giveGun : C.handoff.give;
      return out([step(CODE.turn, turn[0], turn[1], turn[2]), step(CODE.give, to ?? 1, run, exit), step(5, C.handoff.face), END], [], roleOf('handoff', slot.pos));
    }
    case 'qbopt': {
      const to = ctx.carrier; if (to === null) P.push(`${who}: a read option needs a ball carrier (give one back the Carry assignment)`);
      const t = C.readOption.split(' PLYT')[0]!.split(' ').map((s) => s.split(',').map(Number)); const h = t[0]!;
      return out([step(CODE.optHandoff, to ?? 1, h[2], h[3]), step(CODE.carry), END], legs.length ? artOf(pts, CAP.arrow, who, P) : [], roleOf('qbopt', slot.pos));
    }
    default: P.push(`${who}: unknown assignment "${String(d.k)}"`); return out([step(CODE.rblock), END], [], 2);
  }
}

// the play type (PBPL.PLYT) from the quarterback's assignment: it decides the family Supersim and the game see
export function playType(draw: DrawnPlay): number {
  const qb = draw.slots.find((s) => QB_KINDS.includes(s?.k)); const t = C.plyt;
  if (!qb) return draw.slots.some((s) => s?.k === 'carry') ? t.runGun : t.gunPass;
  if (qb.k === 'qbpa') return t.pa; if (qb.k === 'handoff') return t.runGun; if (qb.k === 'qbopt') return t.readOption;
  const drop = Number(qb.o?.['drop'] ?? 0); return drop === 1 ? t.quick : drop === 3 || drop === 4 ? t.rollout : drop === 5 ? t.screen : drop === 6 ? t.rpo : t.gunPass;
}
// run hole (PLRD.hole) from where the carrier's track crosses the line of scrimmage: even right, odd left, 0 over the centre
export function holeOf(x: number): number { const a = Math.abs(x); const n = a < 1.5 ? 0 : a < 3.5 ? 1 : a < 6 ? 2 : a < 9 ? 3 : 4; return n === 0 ? 0 : x > 0 ? n * 2 : n * 2 - 1; }
const PROG_PCT = [75, 55, 45, 30, 5];

export function compileDrawn(draw: DrawnPlay, set: SetDef): CompiledPlay {
  const problems: string[] = [];
  const slots = set.slots.slice().sort((a, b) => a.i - b.i);
  if (draw.set !== set.id) problems.push(`the play was drawn for set ${draw.set}, not ${set.id}`);
  if (!draw.n.trim()) problems.push('the play needs a name'); if (draw.n.length > LIMITS.nameChars) problems.push(`the name is longer than ${LIMITS.nameChars} characters`);
  const draws = slots.map((s) => draw.slots[s.i] ?? { k: OL(s.pos) ? 'block' : 'route' });
  const qbSlot = slots.find((s) => QB_KINDS.includes(draws[s.i]!.k)) ?? slots.find((s) => s.pos === 0) ?? null;
  const gun = !!qbSlot && qbSlot.y < -3.5;
  const carriers = slots.filter((s) => draws[s.i]!.k === 'carry'); if (carriers.length > 1) problems.push('one ball carrier per play');
  const qbs = slots.filter((s) => QB_KINDS.includes(draws[s.i]!.k)); if (qbs.length > 1) problems.push('one quarterback assignment per play');
  const ctx: Ctx = { set, draw, slots, qb: qbSlot, gun, carrier: carriers[0]?.i ?? null, problems };
  const compiled = slots.map((s) => compileSlot(draws[s.i]!, s, ctx));
  const plyt = playType({ ...draw, slots: draws });
  const isPass = [C.plyt.gunPass, C.plyt.ucPass, C.plyt.quick, C.plyt.rollout, C.plyt.screen, C.plyt.rpo, C.plyt.pa].includes(plyt);
  if (isPass && !draws.some((d) => d.k === 'route')) problems.push('a pass needs at least one receiver running a route');
  if ((plyt === C.plyt.runGun || plyt === C.plyt.readOption) && ctx.carrier === null) problems.push('a run needs a ball carrier');
  // progression: the receivers in the order given (PLPD holds five, each slot number in 3 bits), weights descending
  let prog: number[][] | undefined;
  if (draw.prog?.length) {
    const seen = new Set<number>(); prog = [];
    for (const [rcv, pct] of draw.prog) { const r = Number(rcv); if (!Number.isInteger(r) || !slots[r]) { problems.push(`progression: slot ${rcv} is not in the set`); continue; } if (r > 7) { problems.push(`progression: ${label(slots[r]!)} cannot be listed (the game numbers receivers among the first eight slots)`); continue; } if (!['route', 'release'].includes(draws[r]!.k)) { problems.push(`progression: ${label(slots[r]!)} is not running a route`); continue; } if (seen.has(r)) continue; seen.add(r); prog.push([r, clamp(Math.round(Number(pct) || PROG_PCT[prog.length] || 5), 1, 99)]); if (prog.length === 5) break; }
    if (!prog.length) prog = undefined;
  }
  let hole: number | undefined;
  if (ctx.carrier !== null) { const s = slots[ctx.carrier]!; const pts = legsOf(draws[s.i]!.p).pts; for (let i = 1; i < pts.length; i++) { const y0 = s.y + pts[i - 1]![1], y1 = s.y + pts[i]![1]; if (y0 < 0 && y1 >= 0) { hole = holeOf(s.x + pts[i - 1]![0] + (pts[i]![0] - pts[i - 1]![0]) * ((0 - y0) / (y1 - y0))); break; } } hole ??= holeOf(s.x + (pts[pts.length - 1]?.[0] ?? 0)); }
  if (problems.length) throw new CompileError(problems);
  const pb = (C.pbpl as Record<string, { PLF_: number; vpos: number; SRMM: number; SITT: number }>)[String(plyt)] ?? { PLF_: 33, vpos: 1, SRMM: 0, SITT: 2 };
  return { name: draw.n.trim(), plyt, sitt: pb.SITT, plf: pb.PLF_, vpos: pb.vpos, srmm: 0, slots: compiled, ...(prog ? { prog } : {}), ...(hole !== undefined ? { hole } : {}) };
}

// ---- the site's view of a compiled play, through the extractor's own classifier ---------------------------------------
export const stepRows = (steps: Step[], psal = 0): PlaybookRow[] => steps.map((s, i) => ({ PSAL: psal, step: i, code: s[0], val1: s[1], val2: s[2], val3: s[3] }));
export function artRow(art: ArtSeg[], artl = 0): PlaybookRow {
  const row: PlaybookRow = { ARTL: artl, acnt: art.length };
  for (let i = 1; i <= 12; i++) { const k = String(i).padStart(2, '0'); const s = art[i - 1]; row['sp' + k] = s ? s.sp : 0; row['ls' + k] = 0; row['lt' + k] = 0; row['at' + k] = s ? s.at : 0; row['ct' + k] = s ? s.ct : 0; row['au' + k] = s ? s.au : 0; row['av' + k] = s ? s.av : 0; row['ax' + k] = s ? s.ax : 0; row['ay' + k] = s ? s.ay : 0; }
  return row;
}
export function compiledToBook(c: CompiledPlay): { play: Omit<Play, 'id' | 'a'>; asg: Assign[] } {
  const asg: Assign[] = c.slots.map((s) => { const k = offenseKind(stepRows(s.steps), s.role, s.poso); const art = artPath(s.art.length ? artRow(s.art) : undefined); return { r: s.role, k, ...(art.p.length ? { p: art.p, c: art.cap } : {}) }; });
  return { play: { n: c.name, t: c.plyt, sit: c.sitt, f: c.plf, v: c.vpos, ...(c.hole !== undefined ? { h: c.hole } : {}), ...(c.prog ? { prog: c.prog } : {}) }, asg };
}
// composeBook's `custom` hook: a drawn play that does not compile is left out of the book (the save endpoint refuses such
// edits, so this only happens to edits saved before a compiler change)
export const compileCustom = (_cid: string, draw: DrawnPlay, set: SetDef) => { try { return compiledToBook(compileDrawn(draw, set)); } catch { return null; } };
// every custom play's problems, for the save endpoint: cid -> messages
export function compileProblems(custom: Record<string, DrawnPlay>, setOf: (setl: number) => SetDef | undefined): string[] {
  const out: string[] = [];
  for (const [cid, d] of Object.entries(custom)) { const set = setOf(d.set); if (!set) { out.push(`${cid} "${d.n}": its set ${d.set} is not in the book`); continue; } try { compileDrawn(d, set); } catch (e) { out.push(...(e instanceof CompileError ? e.problems : [String((e as Error).message)]).map((m) => `${d.n || cid}: ${m}`)); } }
  return out;
}
