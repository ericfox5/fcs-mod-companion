// Supersim field simulation (engine 3). A snap is played out on a 2D field at 20 ticks a second: every player carries
// out his playbook assignment (route, run or pass block, rush lane, man or zone coverage) and moves with his own
// speed, acceleration and agility, so cuts round off or snap and faster players pull away. Every contest is settled at
// the moment it happens from the ratings involved: block against shed, press against release, the quarterback's read
// of who is open and his throw, catch against coverage, the ball carrier's vision and moves against the tackler. No
// result exists before the snap: the outcome is wherever the simulation ends, and the animation is the recorded
// movement of the 22 players and the ball.
//
// Coordinates are the animation's: x yards downfield from the line of scrimmage (offense direction), y yards to the
// offense's right; the ball is spotted mid-field, so the sidelines are at y = +/-26.65.
import type { Assign, PlayerInput, Slot } from './types.js';

export type Rng = () => number;
export const DT = 0.05;
export const SNAP_T = 0.8;
const SIDE = 26.65;
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
const sig = (z: number) => 1 / (1 + Math.exp(-z));
const gauss = (rng: Rng, m = 0, sd = 1) => { const u = Math.max(1e-9, rng()), v = rng(); return m + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const r1 = (n: number) => Math.round(n * 10) / 10;
// Fatigue: the engine sets each player's energy (1 fresh .. 0 spent) before a play; below 0.7 his physical ratings
// drop, up to about 15 points when he is spent. Reads, hands, discipline and kicking are not affected.
const PHYSICAL = new Set(['PSPD', 'PACC', 'PAGI', 'PSTR', 'PJMP', 'PBTK', 'PTRK', 'PJMV', 'PSMV', 'PSAR', 'PPBK', 'PPBS', 'PPBF', 'PRBK', 'PRBS', 'PBFW', 'PIBL', 'PTAK', 'PHIT', 'PPMV', 'PFMV', 'PBSH', 'PPRS', 'PMCV', 'PZCV', 'PRTR', 'RELS', 'PYRS']);
let ENERGY: Record<string, number> | null = null;
export const setEnergy = (e: Record<string, number> | null | undefined) => { ENERGY = e ?? null; };
export const tired = (p: PlayerInput | undefined) => { const e = p && ENERGY ? ENERGY[String(p.id)] : undefined; return e === undefined || e >= 0.7 ? 0 : (0.7 - Math.max(0, e)) * 22; };
export const rate = (p: PlayerInput | undefined, key: string, dflt?: number) => { const n = p?.ratings?.[key]; const drop = ENERGY && PHYSICAL.has(key) ? tired(p) : 0; if (Number.isFinite(n) && (n as number) > 0) return clamp((n as number) - drop, 1, 99); return dflt ?? clamp((p?.overall ?? 60) - drop, 1, 99); };

// ---- players ----------------------------------------------------------------------------------------------------------
export interface Agent {
  s: 'o' | 'd'; i: number; p: PlayerInput; a: Assign;
  x: number; y: number; vx: number; vy: number; x0: number; y0: number;
  top: number; acc: number; turn: number;
  mode: string; tx: number; ty: number; want: number;
  route?: number[][]; ri: number; settle?: boolean;
  blk: Agent | null; held: Agent[]; engT: number; engX: number; push?: [number, number];
  stun: number; react: number; react2: number; lastTry: number; press?: number; free?: number; wasHeld?: boolean; // free: no new block on him until then (he just got off one)
  man?: Agent; pick?: Agent; zone?: [number, number]; deep?: boolean; bite?: number; // pick: the rusher a pass blocker has in the protection
  hist: number[][]; rec: number[][];
}
const topSpeed = (p: PlayerInput) => 6.3 + ((rate(p, 'PSPD') - 40) / 59) * 3.6; // yd/s: 70 -> 8.1, 89 -> 9.3, 98 -> 9.8
const accel = (p: PlayerInput) => 6 + ((rate(p, 'PACC') - 40) / 59) * 5; // yd/s^2: 70 -> 8.5, 90 -> 10.2
const turnRate = (p: PlayerInput) => 8 + ((rate(p, 'PAGI') - 40) / 59) * 9; // lateral yd/s^2

export interface Contact { t: number; by: Agent; on: Agent; made: boolean; move: string }
// a foul seen on the field: pass interference / defensive holding in coverage, a facemask on a tackle, a late hit on
// the passer, a block in the back on a return; x: where it happened
export interface Flag { k: 'dpi' | 'dhold' | 'facemask' | 'rough' | 'back'; by: Agent; x: number }
// how foul-prone a player is: discipline (PDIS 0..7, 4 = average) and awareness
export const foulRate = (p: PlayerInput) => { const d = p.ratings?.['PDIS']; return clamp(1 + (4 - clamp(Number.isFinite(d) ? (d as number) : 4, 0, 7)) / 6 + (70 - rate(p, 'PAWR')) / 120, 0.4, 2.2); };
export // a back met behind the line on a run has room to slip the first man: real offenses lose yards on about one run in eleven
const BACKFIELD_SLIP = 0.28;
const LIVE_FOUL = { holding: 0.42, dpi: 0.34, dhold: 0.08, facemask: 0.03, rough: 0.15, back: 0.05 };
export interface ThrowInfo { t: number; x: number; y: number; air: number; cx: number; cy: number; target: Agent; result: 'catch' | 'drop' | 'pd' | 'int' | 'miss' | 'away'; by?: Agent; contested?: boolean; hurried?: boolean }
export interface SimResult {
  end: 'tackle' | 'oob' | 'td' | 'incomplete' | 'sack' | 'time' | 'fumble' | 'faircatch' | 'touchback';
  agents: Agent[]; ball: number[][]; events: { t: number; k: string }[]; dur: number; tEnd: number;
  carrier: Agent | null; passer: Agent | null; tackler: Agent | null; assists: Agent[];
  x: number; y: number; firstContact?: number;
  pass?: ThrowInfo; handoff?: number; scramble: boolean; sackBy?: Agent; beaten?: Agent;
  contacts: Contact[]; fumble?: { by: Agent; forced: Agent; rec: Agent; t: number; x: number; at: number }; // at: where he lost it, x: where it was recovered
  turnover?: 'int' | 'fumble'; retFrom?: number; holding?: Agent; pancakes: Agent[];
  qbKeep?: boolean; pitch?: boolean;
  flags: Flag[]; // fouls by the defense during the play (the offense's holding is `holding`)
  muffed?: boolean; // a return: the ball came loose at the catch
  nearAtCatch?: number; // a return: how close the nearest cover man was when the ball came down (yards)
}
export interface ScrimmageInput {
  rng: Rng; family: 'pass' | 'run' | 'option'; sub: string; playType: number;
  O: PlayerInput[]; D: PlayerInput[]; oa: Assign[]; da: Assign[]; oSlots: Slot[]; dSlots: Slot[];
  prog?: number[][]; ball: number;
}
export interface ReturnInput {
  rng: Rng; kind: 'kickoff' | 'punt';
  K: PlayerInput[]; R: PlayerInput[]; ka: Assign[]; ra: Assign[]; kSlots: Slot[]; rSlots: Slot[];
  kicker: number; returner: number; tKick: number; tCatch: number; cx: number; cy: number; kx: number; // kx: where the ball is kicked from
  own: number; // the kicking team's goal line as an x (negative): a return past it is a touchdown
  touchback?: boolean; // the ball is coming down in the end zone: the returner lets it go (the coverage still runs down)
  fairCatch?: boolean | 'auto'; // true: he signals for it whatever the coverage; 'auto': he decides by how close it is
  deep?: boolean; // a punt coming down inside the 10: he fair catches it unless nobody is near
  muff?: number; // chance the catch is bobbled and the ball comes loose
}
type Air = { x0: number; y0: number; x1: number; y1: number; t0: number; t1: number; to: Agent | null; kind: 'snap' | 'pass' | 'pitch' | 'loose' | 'away' };

// ---- the field ------------------------------------------------------------------------------------------------------
class Field {
  t = SNAP_T; A: Agent[] = []; O: Agent[] = []; D: Agent[] = [];
  carrier: Agent | null = null; lastCarrier: Agent | null = null; dir = 1; // dir: where the carrier is going (+1 offense, -1 a return)
  ballXY: [number, number] = [0, 0]; ballRec: number[][] = []; events: { t: number; k: string }[] = [];
  air: Air | null = null; over: SimResult['end'] | null = null; tEnd = 0;
  contacts: Contact[] = []; tackler: Agent | null = null; assists: Agent[] = []; firstContact?: number; holding?: Agent; pancakes = new Set<Agent>(); flags: Flag[] = [];
  goal = 100; own = -1e9; fum?: SimResult['fumble']; turnover?: 'o' | 'd'; retFrom?: number;
  recognized = 1e9; // when the defense can see who has the ball (handoff, catch, scramble)
  constructor(public rng: Rng) {}

  agent(s: 'o' | 'd', i: number, p: PlayerInput, a: Assign, slot: Slot): Agent {
    const x = slot.y, y = slot.x;
    const ag: Agent = { s, i, p, a, x, y, vx: 0, vy: 0, x0: x, y0: y, top: topSpeed(p), acc: accel(p), turn: turnRate(p), mode: 'idle', tx: x, ty: y, want: 0, ri: 1, blk: null, held: [], engT: 0, engX: 0, stun: 0, react: 0, react2: 1e9, lastTry: -9, hist: [], rec: [[0, x, y]] };
    this.A.push(ag); (s === 'o' ? this.O : this.D).push(ag); return ag;
  }
  route(a: Agent, pts?: number[][]) { if (!pts || pts.length < 2) return; a.route = pts.map((q) => [a.x0 + (q[1] ?? 0), a.y0 + (q[0] ?? 0)]); a.ri = 1; }
  go(a: Agent, x: number, y: number, want = a.top) { a.tx = x; a.ty = y; a.want = want; }
  dist(a: { x: number; y: number }, b: { x: number; y: number }) { return Math.hypot(a.x - b.x, a.y - b.y); }
  free(a: Agent) { return !a.blk && !a.held.length && a.stun <= this.t; }
  give(a: Agent | null) { this.carrier = a; if (a) this.lastCarrier = a; }
  runPlay = false; // a called run: tackles behind the line are less sure and the back falls forward (BACKFIELD_SLIP)

  // ---- movement: steer toward (tx, ty) at up to `want`, with acceleration, braking and turning limits ----
  steer(a: Agent) {
    const dx = a.tx - a.x, dy = a.ty - a.y; const d = Math.hypot(dx, dy); const sp = Math.hypot(a.vx, a.vy);
    let want = Math.min(a.want, a.top);
    if (d < 0.08) want = 0; else want = Math.min(want, Math.sqrt(2 * a.acc * 1.5 * d) + 0.4);
    const ux = d > 1e-6 ? dx / d : 0, uy = d > 1e-6 ? dy / d : 0;
    if (sp > 1.5) { const cos = (a.vx * ux + a.vy * uy) / sp; if (cos < 0.7) want *= Math.max(0.3, 0.55 + cos * 0.45); } // plant to cut
    let ax = (ux * want - a.vx) / DT, ay = (uy * want - a.vy) / DT;
    if (sp > 0.4) {
      const hx = a.vx / sp, hy = a.vy / sp; let at = ax * hx + ay * hy; let an = -ax * hy + ay * hx;
      at = clamp(at, -a.acc * 1.9, a.acc); an = clamp(an, -a.turn, a.turn); ax = at * hx - an * hy; ay = at * hy + an * hx;
    } else { const m = Math.hypot(ax, ay); if (m > a.acc) { ax *= a.acc / m; ay *= a.acc / m; } }
    a.vx += ax * DT; a.vy += ay * DT; const s2 = Math.hypot(a.vx, a.vy); if (s2 > a.top) { a.vx *= a.top / s2; a.vy *= a.top / s2; }
    a.x += a.vx * DT; a.y += a.vy * DT;
  }
  // follow a route: the next waypoint, then past the end either sit down in space or keep going
  runRoute(a: Agent, speed: number) {
    const R = a.route; if (!R) { this.go(a, a.x, a.y, 0); return; }
    while (a.ri < R.length && Math.hypot(R[a.ri]![0]! - a.x, R[a.ri]![1]! - a.y) < 0.9) a.ri++;
    if (a.ri < R.length) { this.go(a, R[a.ri]![0]!, R[a.ri]![1]!, speed); return; }
    const p = R[R.length - 1]!, q = R[R.length - 2] ?? [a.x0, a.y0]; const dx = p[0]! - q[0]!, dy = p[1]! - q[1]!; const L = Math.hypot(dx, dy) || 1;
    if (a.settle === undefined) a.settle = dx < 0.5 || L < 3; // comebacks, hooks, curls and short stems sit in the window
    if (a.settle) { const near = this.nearest(a, a.s === 'o' ? this.D : this.O); const ox = near ? clamp(a.x - near.x, -1, 1) : 0, oy = near ? clamp(a.y - near.y, -1, 1) : 0; this.go(a, a.x + ox, clamp(a.y + oy, -SIDE + 1, SIDE - 1), 1.8); }
    else this.go(a, a.x + (dx / L) * 8, clamp(a.y + (dy / L) * 8, -SIDE + 1.5, SIDE - 1.5), speed);
  }
  nearest(a: { x: number; y: number }, list: Agent[], ok: (b: Agent) => boolean = () => true) { let best: Agent | null = null, bd = 1e9; for (const b of list) { if (!ok(b)) continue; const d = Math.hypot(b.x - a.x, b.y - a.y); if (d < bd) { bd = d; best = b; } } return best; }
  // where a chaser runs to meet `c`: between straight chase and the intercept point, by pursuit skill
  pursuit(a: Agent, c: Agent): [number, number] {
    if (Math.hypot(c.x - a.x, c.y - a.y) < 3) return [c.x + c.vx * 0.3, c.y + c.vy * 0.3]; // close: straight at him, a step ahead
    // where he is going: his current line blended with a straight run at the goal line (that is where he ends up)
    const q = 0.35 + (rate(a.p, 'PPRS') / 99) * 0.6; const gvx = c.vx * 0.7 + this.dir * c.top * 0.3, gvy = c.vy * 0.7; let px = c.x, py = c.y;
    for (let k = 0; k < 3; k++) { const T = Math.hypot(px - a.x, py - a.y) / a.top; px = c.x + gvx * T; py = clamp(c.y + gvy * T, -SIDE, SIDE); }
    return [c.x + (px - c.x) * q, c.y + (py - c.y) * q];
  }

  // where a blocker goes to meet `d` on his way to `to` (the QB, the ball carrier): the nearest point of that path to
  // the blocker, at least a yard in front of the man. Running at where the man is now loses the race to anyone faster.
  cutoff(a: Agent, d: Agent, to: { x: number; y: number }, lead = 1.1): [number, number] {
    const ux = to.x - d.x, uy = to.y - d.y, L = Math.hypot(ux, uy) || 1; const f = clamp(((a.x - d.x) * ux + (a.y - d.y) * uy) / L, Math.min(lead, L), Math.max(lead, L - 0.6));
    return [d.x + (ux / L) * f, d.y + (uy / L) * f];
  }
  // ---- blocking: blocker.blk = the man he is on; that man's held = his blockers ----
  engage(b: Agent, d: Agent, push?: [number, number]) { if (d.held.length >= 2 || b.blk || b.held.length || (d.free ?? 0) > this.t) return; b.blk = d; d.held.push(b); d.wasHeld = true; b.engT = this.t; b.engX = d.x; b.push = push; }
  releaseAll(d: Agent, stunB = 0.45) { for (const b of d.held) { b.blk = null; b.stun = this.t + stunB; } d.held = []; }
  blockPower(b: Agent, pass: boolean) { return pass ? rate(b.p, 'PPBK') * 0.45 + rate(b.p, 'PPBS', rate(b.p, 'PSTR')) * 0.3 + rate(b.p, 'PSTR') * 0.25 : rate(b.p, 'PRBK') * 0.4 + rate(b.p, 'PRBS', rate(b.p, 'PSTR')) * 0.3 + rate(b.p, 'PIBL', 60) * 0.1 + rate(b.p, 'PSTR') * 0.2; }
  shedSkill(d: Agent, pass: boolean) { return pass ? Math.max(rate(d.p, 'PPMV') * 0.6 + rate(d.p, 'PSTR') * 0.4, rate(d.p, 'PFMV') * 0.6 + rate(d.p, 'PAGI') * 0.4) : rate(d.p, 'PBSH') * 0.65 + rate(d.p, 'PSTR') * 0.35; }
  holdSkill(b: Agent, d: Agent, pass: boolean) { if (!pass) return rate(b.p, 'PRBK') * 0.6 + rate(b.p, 'PBFW', rate(b.p, 'PRBK')) * 0.4; const power = rate(d.p, 'PPMV') >= rate(d.p, 'PFMV'); return rate(b.p, 'PPBK') * 0.55 + (power ? rate(b.p, 'PPBS', rate(b.p, 'PSTR')) : rate(b.p, 'PPBF', rate(b.p, 'PPBK'))) * 0.45; }
  // one tick of every engagement: the pair moves by whoever is winning; the blocked man may get off the block
  blocks(pass: boolean, target: () => { x: number; y: number } | null) {
    for (const d of this.A) {
      if (!d.held.length) continue;
      const tg = target() ?? { x: d.x - this.dir * 3, y: d.y }; const b0 = d.held[0]!;
      const B = d.held.reduce((s, b, k) => s + this.blockPower(b, pass) * (k ? 0.6 : 1), 0), Dp = (pass ? Math.max(rate(d.p, 'PPMV'), rate(d.p, 'PFMV')) * 0.5 : rate(d.p, 'PBSH') * 0.5) + rate(d.p, 'PSTR') * 0.5;
      const ux = tg.x - d.x, uy = tg.y - d.y, ul = Math.hypot(ux, uy) || 1;
      const px = b0.push ? b0.push[0] : -ux / ul, py = b0.push ? b0.push[1] : -uy / ul;
      const win = (Dp - B) / 40; const vd = clamp((pass ? 0.4 : 0.1) + win, -0.2, 1.8), vb = clamp((pass ? 0.05 : 0.95) - win, 0, 2.4);
      const vx = (ux / ul) * vd + px * vb, vy = (uy / ul) * vd + py * vb;
      d.vx = vx; d.vy = vy; d.x += vx * DT; d.y += vy * DT;
      for (const b of d.held) { const ox = b.x - d.x, oy = b.y - d.y, ol = Math.hypot(ox, oy) || 1; b.x = d.x + (ox / ol) * 0.95; b.y = d.y + (oy / ol) * 0.95; b.vx = vx; b.vy = vy; }
      const c = this.carrier; const near = !!c && c !== d && Math.hypot(c.x - d.x, c.y - d.y) < 3.5;
      // pass rush: about one rusher in eight beats his man inside 2.5 s at even ratings (team pressure ~40%, as measured
      // in the pros); run blocks give way faster, and much faster when the ball carrier is right there
      const lam = (pass ? 0.075 : 0.052) * Math.exp((this.shedSkill(d, pass) - this.holdSkill(b0, d, pass)) / 11) * (d.held.length > 1 ? 0.35 : 1) * (near && !pass ? 1.25 : 1) * (pass && this.t - b0.engT < 0.6 ? 0.4 : 1);
      if (this.rng() < 1 - Math.exp(-lam * DT)) {
        // beaten right at the ball: sometimes he grabs, and the flag comes out (discipline)
        if (near && !this.holding && b0.s !== d.s && b0.s === 'o' && this.rng() < LIVE_FOUL.holding * foulRate(b0.p)) this.holding = b0;
        this.releaseAll(d); d.stun = this.t + 0.12; d.free = this.t + 0.7; d.vx += (ux / ul) * 1.5; d.vy += (uy / ul) * 1.5;
      } else if (!pass && Math.abs(d.x - b0.engX) > 2.5 && (d.x - b0.engX) * this.dir > 0 && b0.s === 'o') this.pancakes.add(b0);
    }
  }
  separate() { const L = this.A; for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) { const a = L[i]!, b = L[j]!; if (a.blk === b || b.blk === a || a === this.carrier || b === this.carrier) continue; const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy); if (d > 0.01 && d < 0.75) { const k = (0.75 - d) / 2 / d; if (!a.held.length && !a.blk) { a.x -= dx * k; a.y -= dy * k; } if (!b.held.length && !b.blk) { b.x += dx * k; b.y += dy * k; } } } }

  // ---- the ball carrier picks his lane: forward gain against who can get there first (vision adds the noise) ----
  vision(c: Agent, chasers: Agent[]) {
    // a new read every 0.1 s (about a reaction time); in between he holds his line
    if (Math.round(this.t / DT) % 2 === 1 && c.want > 0) return;
    const v = rate(c.p, 'PBCV', 65); const noise = ((100 - v) / 100) * 2.6; let best = -1e9, bx = c.x + this.dir * 5, by = c.y;
    const goalNear = this.dir > 0 ? this.goal - c.x < 6 : c.x - this.own < 6; const behind = this.dir > 0 && c.s === 'o' && c.x < 0.5; const spd = Math.hypot(c.vx, c.vy); const cur = spd > 1 ? Math.atan2(c.vy, c.vx * this.dir) : 0;
    for (let k = -6; k <= 6; k++) {
      const ang = (k / 6) * (Math.PI * 0.47); const hx = Math.cos(ang) * this.dir, hy = Math.sin(ang);
      let score = 0;
      for (const L of [2.5, 5, 8]) {
        const px = c.x + hx * L, py = c.y + hy * L; if (Math.abs(py) > SIDE - 0.3) { score -= 6; break; }
        let danger = 0; const tc = L / Math.max(4, c.top);
        for (const d of chasers) { if (d.held.length || d.stun > this.t + tc) continue; const m = Math.hypot(d.x - px, d.y - py) / d.top - tc; danger += Math.exp(-Math.max(0, m) / 0.3) * (m < 0 ? 1.6 : 1); }
        score += hx * this.dir * L * (behind ? 0.95 : 0.6) - danger * 2.4; // behind the line he gets north: a loss is the worst lane
      }
      if (goalNear) score += hx * this.dir * 6;
      if (spd > 2) score -= Math.abs(ang - cur) * 0.9; // he keeps his line unless something is worth the cut
      score += gauss(this.rng, 0, noise);
      if (score > best) { best = score; bx = c.x + hx * 6; by = c.y + hy * 6; }
    }
    this.go(c, bx, clamp(by, -SIDE - 2, SIDE + 2), c.top);
  }
  // a tackle attempt by `d`: the carrier's best move against the tackler's form, the angle and the speed
  tryTackle(d: Agent, c: Agent, armOnly = false, dive = false, bonus = 0): boolean {
    d.lastTry = this.t; this.firstContact ??= c.x;
    const sp = Math.hypot(c.vx, c.vy) || 1; const hx = c.vx / sp, hy = c.vy / sp; const ox = d.x - c.x, oy = d.y - c.y, ol = Math.hypot(ox, oy) || 1;
    const facing = (hx * ox + hy * oy) / ol; // 1 head-on, -1 from behind
    const moves: [string, number][] = [
      ['juke', rate(c.p, 'PJMV') * 0.6 + rate(c.p, 'PAGI') * 0.25 + rate(c.p, 'PESV') * 0.15],
      ['spin', rate(c.p, 'PSMV') * 0.6 + rate(c.p, 'PAGI') * 0.2 + rate(c.p, 'PESV') * 0.2],
      ['stiff arm', rate(c.p, 'PSAR') * 0.65 + rate(c.p, 'PSTR') * 0.35],
      ['truck', rate(c.p, 'PTRK') * 0.6 + rate(c.p, 'PSTR') * 0.4 + (facing > 0.5 ? 4 : -6)],
    ];
    let mv = moves[0]!, mvs = -1e9; for (const m of moves) { const s = m[1] + gauss(this.rng, 0, 5); if (s > mvs) { mvs = s; mv = m; } }
    const evade = mv[1] * 0.65 + rate(c.p, 'PBTK') * 0.35;
    const tack = rate(d.p, 'PTAK') * 0.62 + rate(d.p, 'PHIT') * 0.13 + rate(d.p, 'PSTR') * 0.25;
    const z = 1.9 + (tack - evade) / 16 + (facing < -0.3 ? -0.8 : facing < 0.3 ? -0.3 : 0.1) - (sp > 7.5 ? 0.2 : 0) - (armOnly ? 2.4 : 0) - (dive ? 1.0 : 0) + bonus + (this.helpNear(c, d) ? 0.5 : 0) - (this.dir > 0 && c.s === 'o' && c.x < 0 && this.runPlay ? BACKFIELD_SLIP : 0);
    const made = this.rng() < sig(z);
    this.contacts.push({ t: this.t, by: d, on: c, made, move: mv[0] });
    if (!made) { d.stun = this.t + (dive ? 1.2 : 0.7) + this.rng() * 0.6; d.vx *= dive ? 0.1 : 0.3; d.vy *= dive ? 0.1 : 0.3; c.vx *= dive ? 0.8 : 0.62; c.vy *= dive ? 0.8 : 0.62; }
    return made;
  }
  helpNear(c: Agent, d: Agent) { const opp = c.s === 'o' ? this.D : this.O; return opp.some((e) => e !== d && !e.held.length && e.stun <= this.t && Math.hypot(e.x - c.x, e.y - c.y) < 1.6); }
  // contact: chasers in reach try to bring the carrier down; a made tackle ends the play with forward progress
  contactsTick() {
    const c = this.carrier; if (!c) return; const opp = c.s === 'o' ? this.D : this.O;
    for (const d of opp) {
      if (d.stun > this.t || this.t - d.lastTry < 0.6) continue; const dd = Math.hypot(d.x - c.x, d.y - c.y);
      // in reach he wraps up; a step further, and not gaining on him, he can leave his feet and dive at him
      const engaged = d.held.length > 0; const dive = !engaged && dd > 1.25; if (dd > (engaged ? 0.85 : 1.9)) continue;
      if (dive && this.rng() > 0.3) continue;
      if (this.attempt(d, c, engaged, dive)) return;
    }
  }
  attempt(d: Agent, c: Agent, armOnly = false, dive = false, bonus = 0): boolean {
    if (!this.tryTackle(d, c, armOnly, dive, bonus)) return false;
    const opp = c.s === 'o' ? this.D : this.O;
    const fwd = Math.max(0, c.vx * this.dir); const fall = clamp(0.55 + (this.dir > 0 && c.s === 'o' && c.x < 0 && this.runPlay ? 1.0 : 0) + fwd * 0.13 + (rate(c.p, 'PSTR') - rate(d.p, 'PSTR')) / 90 + rate(c.p, 'PTRK') / 260 + gauss(this.rng, 0, 0.25), 0, 2.2);
    c.x += this.dir * fall; this.tackler = d; this.assists = opp.filter((e) => e !== d && !e.held.length && Math.hypot(e.x - c.x, e.y - c.y) < 1.8);
    if (d.s === 'd' && c.s === 'o' && this.rng() < LIVE_FOUL.facemask * foulRate(d.p)) this.flags.push({ k: 'facemask', by: d, x: c.x });
    const fp = clamp(0.011 * (1 + (rate(d.p, 'PHIT') - 60) / 45) * (1 + (60 - rate(c.p, 'PCAR')) / 35) * (this.assists.length ? 1.25 : 1), 0.002, 0.04);
    if (this.rng() < fp) this.looseBall(c, d); else this.whistle('tackle');
    return true;
  }
  // the ball is out: it bounces, and whoever gets there first (distance and a scramble for it) comes up with it
  looseBall(c: Agent, forced: Agent) {
    const bx = c.x + gauss(this.rng, 0.5 * this.dir, 1.2), by = clamp(c.y + gauss(this.rng, 0, 1.4), -SIDE, SIDE);
    this.events.push({ t: this.t, k: 'fumble' });
    let best: Agent = forced, bt = 1e9;
    for (const a of this.A) { if (a === c) continue; const tt = Math.hypot(a.x - bx, a.y - by) / Math.max(4, a.top) + (a.held.length || a.blk ? 0.5 : 0) + this.rng() * 0.45; if (tt < bt) { bt = tt; best = a; } }
    for (const a of this.A) if (a !== c && Math.hypot(a.x - bx, a.y - by) < 7) { a.blk = null; a.held = []; this.go(a, bx, by, a.top); }
    const t1 = this.t + clamp(bt, 0.35, 1.3);
    this.fum = { by: c, forced, rec: best, t: t1, x: bx, at: c.x }; this.give(null); this.lastCarrier = c; c.stun = this.t + 2;
    this.air = { x0: c.x, y0: c.y, x1: bx, y1: by, t0: this.t, t1, to: best, kind: 'loose' };
  }
  whistle(end: SimResult['end']) { if (this.over) return; this.over = end; this.tEnd = this.t; }
  escort(d: Agent) { // after a turnover the other ten block for the man with the ball
    const c = this.carrier!; const chaser = this.nearest(c, d.s === 'd' ? this.O : this.D, (o) => o.held.length < 1 && o.stun <= this.t && Math.hypot(o.x - c.x, o.y - c.y) < 10);
    if (!chaser) { this.go(d, c.x + this.dir * 3, c.y + Math.sign(d.y - c.y || 1) * 3, d.top * 0.8); return; }
    if (this.dist(d, chaser) < 1.1 && !d.blk) this.engage(d, chaser, [this.dir, 0]); else this.go(d, (chaser.x + c.x) / 2, (chaser.y + c.y) / 2, d.top);
  }

  // ---- bookkeeping ----
  record() { for (const a of this.A) { a.rec.push([this.t, a.x, a.y]); a.hist.push([this.t, a.x, a.y, a.vx, a.vy]); if (a.hist.length > 30) a.hist.shift(); } this.ballRec.push([this.t, this.ballXY[0], this.ballXY[1]]); }
  ballTick() {
    if (this.air) { const f = clamp((this.t - this.air.t0) / Math.max(0.05, this.air.t1 - this.air.t0), 0, 1); this.ballXY = [this.air.x0 + (this.air.x1 - this.air.x0) * f, this.air.y0 + (this.air.y1 - this.air.y0) * f]; }
    else if (this.carrier) this.ballXY = [this.carrier.x + 0.25 * this.dir, this.carrier.y];
  }
  // after the whistle everyone pulls up
  coast(sec: number) {
    for (const a of this.A) { a.blk = null; a.held = []; a.tx = a.x + a.vx * 0.3; a.ty = a.y + a.vy * 0.3; a.want = 0; }
    const end = this.t + sec; const down = this.over === 'tackle' || this.over === 'sack' ? this.lastCarrier : null;
    while (this.t < end) { this.t += DT; for (const a of this.A) { if (a === down) { a.vx *= 0.4; a.vy *= 0.4; a.x += a.vx * DT; a.y += a.vy * DT; continue; } this.steer(a); } if (this.air) this.ballTick(); else if (this.carrier) this.ballTick(); this.record(); }
  }
  // keyframes: a sample is kept when straight-line playback between the kept ones would be more than eps off
  static simplify(rec: number[][], eps = 0.14): number[][] {
    const out: number[][] = []; const n = rec.length; if (!n) return out;
    const keep = new Uint8Array(n); keep[0] = 1; keep[n - 1] = 1; const stack: [number, number][] = [[0, n - 1]];
    while (stack.length) {
      const [i, j] = stack.pop()!; let worst = -1, wd = eps; const a = rec[i]!, b = rec[j]!; const span = b[0]! - a[0]! || 1;
      for (let k = i + 1; k < j; k++) { const p = rec[k]!; const f = (p[0]! - a[0]!) / span; const d = Math.hypot(a[1]! + (b[1]! - a[1]!) * f - p[1]!, a[2]! + (b[2]! - a[2]!) * f - p[2]!); if (d > wd) { wd = d; worst = k; } }
      if (worst > 0) { keep[worst] = 1; stack.push([i, worst], [worst, j]); }
    }
    for (let k = 0; k < n; k++) if (keep[k]) out.push([Math.round(rec[k]![0]! * 100) / 100, r1(rec[k]![1]!), r1(rec[k]![2]!)]);
    return out;
  }
  finish(extra: Partial<SimResult>): SimResult {
    if (!this.over) this.whistle('time');
    const lc = this.lastCarrier; const ex = this.over === 'incomplete' || this.over === 'fumble' ? this.ballXY[0] : lc ? lc.x : this.ballXY[0], ey = lc && this.over !== 'incomplete' ? lc.y : this.ballXY[1];
    this.events.push({ t: this.tEnd, k: this.over === 'oob' ? 'oob' : this.over === 'td' ? 'td' : this.over === 'tackle' || this.over === 'sack' ? 'down' : this.over! });
    this.coast(0.8);
    for (const a of this.A) a.rec = Field.simplify(a.rec);
    return { end: this.over!, agents: this.A, ball: Field.simplify(this.ballRec, 0.08), events: this.events, dur: this.t, tEnd: this.tEnd, carrier: lc, passer: null, tackler: this.tackler, assists: this.assists, x: ex, y: ey, firstContact: this.firstContact, scramble: false, contacts: this.contacts, fumble: this.fum, turnover: this.turnover === 'd' ? (this.fum ? 'fumble' : 'int') : this.turnover === 'o' ? 'fumble' : undefined, retFrom: this.retFrom, holding: this.holding, pancakes: [...this.pancakes], flags: this.flags, ...extra };
  }
}

// ---- scrimmage plays ----------------------------------------------------------------------------------------------------
const PASSER = ['qb', 'qbpa', 'qbopt', 'handoff', 'kneel', 'spike'];
export function simulateScrimmage(inp: ScrimmageInput): SimResult {
  const { rng, family, sub } = inp; const F = new Field(rng); F.goal = 100 - inp.ball; F.own = -inp.ball;
  inp.O.forEach((p, i) => F.agent('o', i, p, inp.oa[i]!, inp.oSlots[i]!)); inp.D.forEach((p, i) => F.agent('d', i, p, inp.da[i]!, inp.dSlots[i]!));
  const O = F.O, D = F.D; const pass = family === 'pass'; F.runPlay = !pass;
  // backed up to his own goal line the offense tightens up: nobody lines up in his own end zone
  for (const a of O) if (a.x0 < F.own + 0.4) { a.x = a.x0 = F.own + 0.4; a.rec[0] = [0, a.x, a.y]; }
  const qb = O[Math.max(0, O.findIndex((a) => PASSER.includes(a.a.k)))]!; const underC = qb.x0 > -3;
  // ---- offense
  const eligible = O.filter((a) => a !== qb && ['route', 'screen'].includes(a.a.k));
  let runner: Agent | null = null; let keeper = false;
  if (!pass) { const cs = O.filter((a) => a !== qb && ['carry', 'qbopt'].includes(a.a.k)); runner = cs.find((a) => a.a.k === 'carry') ?? cs[0] ?? null; if (!runner || qb.a.k === 'carry') { runner = qb; keeper = true; } }
  for (const a of O) {
    F.route(a, a.a.p); const k = a.a.k;
    if (a === qb) a.mode = 'qb';
    else if (k === 'route' || k === 'screen') a.mode = pass ? 'route' : 'stalk';
    else if (k === 'carry' || k === 'qbopt') a.mode = pass ? 'fake' : a === runner ? 'runner' : 'pitchman';
    else a.mode = pass ? (sub === 'screen' && k === 'block' ? 'release' : 'pblock') : 'rblock';
  }
  // ---- defense: rushers, man matchups by alignment, zone landmarks from the art
  const freeM = D.filter((d) => d.a.k === 'man');
  for (const r of eligible.concat(O.filter((a) => a.mode === 'fake')).sort((a, b) => Math.abs(b.y0) - Math.abs(a.y0))) {
    if (!freeM.length) break; freeM.sort((a, b) => Math.hypot(a.x0 - r.x0, a.y0 - r.y0) - Math.hypot(b.x0 - r.x0, b.y0 - r.y0)); freeM.shift()!.man = r;
  }
  for (const d of D) {
    const k = d.a.k; const ppr = rate(d.p, 'PPRC', 60); F.route(d, d.a.p);
    // the box reads run off the linemen's blocks quickly; the secondary later
    d.react = !pass && d.x0 < 6 && Math.abs(d.y0) < 10 ? 0.32 + ((99 - ppr) / 99) * 0.5 + rng() * 0.15 : 0.35 + ((99 - ppr) / 99) * 0.6 + rng() * 0.15;
    if (k === 'rush') { d.mode = 'rush'; continue; }
    if (k === 'man' && d.man) d.mode = 'man';
    else {
      const pts = d.a.p; const end = pts && pts.length > 1 ? pts[pts.length - 1]! : null; d.deep = k === 'deep';
      const zx = end ? d.x0 + (end[1] ?? 0) : d.deep ? 15 : 7, zy = end ? d.y0 + (end[0] ?? 0) : d.y0;
      d.zone = [d.deep ? clamp(zx, 13, 21) : clamp(zx, 4, 10), clamp(zy, -SIDE + 3, SIDE - 3)]; // the art draws drops long
      d.mode = 'zone';
    }
    // play action and RPO: second-level defenders step up on the fake until they read it
    if (pass && (sub === 'pa' || sub === 'rpo') && d.x0 < 9) d.bite = SNAP_T + 0.15 + ((99 - ppr) / 99) * 0.95 * rng();
  }
  // ---- the protection, set at the snap: rushers inside-out, each to the blocker whose lane he is in (linemen before
  // backs and tight ends); a rusher nobody can take is the free one; spare blockers help where they can
  const unblocked: Agent[] = [];
  if (pass) {
    const blockers = O.filter((a) => a.mode === 'pblock'); const free = [...blockers];
    for (const d of D.filter((d) => d.mode === 'rush').sort((a, b) => Math.abs(a.y0) - Math.abs(b.y0))) {
      let best: Agent | null = null, bc = 1e9; for (const b of free) { const c = Math.abs(b.y0 - d.y0) + (b.p.pos >= 5 && b.p.pos <= 9 ? 0 : 2.5); if (c < bc && c < 7) { bc = c; best = b; } }
      if (best) { best.pick = d; free.splice(free.indexOf(best), 1); } else unblocked.push(d);
    }
    // the line slides: a rusher with nobody in his lane goes to the nearest blocker still without a man (the centre
    // sliding to an overload, a back picking up the edge); only one more rusher than blockers comes free
    for (const d of unblocked.slice().sort((a, b) => Math.abs(a.y0) - Math.abs(b.y0))) {
      let best: Agent | null = null, bc = 1e9; for (const b of free) { const c = Math.abs(b.y0 - d.y0); if (c < bc && c < 13) { bc = c; best = b; } }
      if (best) { best.pick = d; free.splice(free.indexOf(best), 1); unblocked.splice(unblocked.indexOf(d), 1); }
    }
  }
  // run blocking scheme, set at the snap: the box from the line back (down linemen first, then linebackers), each to
  // the nearest run blocker by lane; blockers with a linebacker climb to him
  if (!pass) {
    const blockers = O.filter((a) => a.mode === 'rblock'); const free = [...blockers];
    for (const d of D.filter((d) => d.x0 < 8 && Math.abs(d.y0) < 11).sort((a, b) => a.x0 - b.x0 || Math.abs(a.y0) - Math.abs(b.y0))) {
      let best: Agent | null = null, bc = 1e9; for (const b of free) { const c = Math.abs(b.y0 - d.y0) + (b.p.pos >= 5 && b.p.pos <= 9 ? 0 : 1); if (c < bc && c < 6) { bc = c; best = b; } }
      if (best) { best.pick = d; free.splice(free.indexOf(best), 1); }
    }
    // a blitzer nobody has by lane goes to the nearest blocker still free (a back, a tight end, a pulling guard)
    for (const d of D.filter((d) => d.a.k === 'rush' && !blockers.some((b) => b.pick === d)).sort((a, b) => a.x0 - b.x0)) {
      let best: Agent | null = null, bc = 1e9; for (const b of free) { const c = Math.abs(b.y0 - d.y0); if (c < bc && c < 10) { bc = c; best = b; } }
      if (best) { best.pick = d; free.splice(free.indexOf(best), 1); }
    }
  }
  // the hot read: a rusher the protection cannot account for, and a QB who sees it, means the ball comes out on time
  const hot = unblocked.length > 0 && rng() < 0.35 + (rate(qb.p, 'PAWR') / 99) * 0.55;
  // ---- the pass plan: drop, timing, progression
  // backed up, the QB shortens his drop to stay out of his own end zone
  const dropRaw: [number, number] = (() => {
    const art = qb.a.p; if (art && art.length > 2) { const e = art[art.length - 1]!; return [qb.x0 + (e[1] ?? -5), qb.y0 + (e[0] ?? 0)]; }
    if (sub === 'rollout') return [qb.x0 - 3, qb.y0 + (rng() < 0.5 ? 7 : -7)];
    if (sub === 'quick' || sub === 'screen') return [underC ? -4.5 : qb.x0 - 0.8, qb.y0];
    return [underC ? -7.2 : qb.x0 - 1.8, qb.y0];
  })();
  const drop: [number, number] = [Math.max(dropRaw[0], F.own + 1), dropRaw[1]];
  const earliest = SNAP_T + (sub === 'quick' ? 0.85 : sub === 'screen' ? 1.15 : sub === 'pa' ? 2.1 : sub === 'rollout' ? 1.8 : sub === 'hailmary' ? 2.6 : 1.55);
  const progOrder: Agent[] = []; for (const [slot] of inp.prog ?? []) { const a = O[slot ?? -1]; if (a && eligible.includes(a)) progOrder.push(a); }
  for (const a of eligible.slice().sort((a, b) => routeDepth(b) - routeDepth(a))) if (!progOrder.includes(a)) progOrder.push(a);
  for (const a of O) if (a.mode === 'fake' && !progOrder.includes(a)) progOrder.push(a); // the back is the checkdown
  const awr = rate(qb.p, 'PAWR'); const readTime = 0.45 + ((99 - awr) / 99) * 0.55; let readI = 0, readT = earliest;
  const vBall = 17 + ((rate(qb.p, 'PTHP') - 50) / 49) * 9;
  let windup: { r: Agent; until: number; hurried: boolean } | null = null; // decided, not yet released
  let thrown: ThrowInfo | undefined; let scramble = false; let sackBy: Agent | undefined; let beaten: Agent | undefined; let handoffT: number | undefined; let pitched = false; let qbKeep = keeper;
  // the snap: under centre it is in his hands at once, in the gun it travels back to him
  F.air = { x0: 0, y0: 0, x1: qb.x0 + 0.3, y1: qb.y0, t0: SNAP_T, t1: SNAP_T + (underC ? 0.05 : 0.32), to: qb, kind: 'snap' };
  if (keeper) qb.mode = 'carrierDesign';
  // the mesh: the first point of the back's path the QB can reach by the time the back gets there (a toss is pitched)
  let mesh: [number, number] | null = null;
  if (!pass && runner && runner !== qb && runner.route && inp.playType !== 15) {
    const R = runner.route; let along = 0, best = 1e9, fallback: [number, number] | null = null;
    for (let k = 1; k < R.length && !mesh; k++) {
      const x0 = R[k - 1]![0]!, y0 = R[k - 1]![1]!, x1 = R[k]![0]!, y1 = R[k]![1]!; const L = Math.hypot(x1 - x0, y1 - y0);
      for (let f = 0; f <= 1; f += 0.1) {
        const x = x0 + (x1 - x0) * f, y = y0 + (y1 - y0) * f; if (x > 0.5) break;
        const tr = (along + L * f) / (runner.top * 0.7) + 0.25, tq = Math.hypot(x - qb.x0, y - qb.y0) / (qb.top * 0.85) + 0.15;
        const toward = (u: number, v: number): [number, number] => { const l = Math.hypot(qb.x0 - u, qb.y0 - v) || 1; return [u + ((qb.x0 - u) / l) * Math.min(0.5, l), v + ((qb.y0 - v) / l) * Math.min(0.5, l)]; };
        if (tq <= tr + 0.2) { mesh = toward(x, y); break; }
        if (tq - tr < best) { best = tq - tr; fallback = toward(x, y); }
      }
      along += L;
    }
    mesh ??= fallback;
  }

  for (F.t = SNAP_T; F.t < SNAP_T + 13 && !F.over; F.t += DT) {
    const t = F.t;
    // ---- the ball arriving somewhere
    if (F.air && t >= F.air.t1) {
      const air = F.air; F.air = null; F.ballXY = [air.x1, air.y1];
      if (air.kind === 'snap') { F.give(qb); if (keeper) F.recognized = t + 0.3; }
      else if (air.kind === 'loose') {
        const rec = F.fum!.rec; rec.x = air.x1; rec.y = air.y1; if (rec.s !== F.fum!.by.s) F.turnover = rec.s; F.events.push({ t, k: 'recovered' });
        // a defender who gets to it with nobody on him scoops it up and runs; in a crowd he falls on it
        const crowd = O.some((o) => o !== F.fum!.by && Math.hypot(o.x - rec.x, o.y - rec.y) < 2.2);
        if (rec.s === 'd' && F.fum!.by.s === 'o' && !crowd && rng() < 0.35 + (rate(rec.p, 'PCTH', 50) - 50) / 160) { F.give(rec); rec.mode = 'carrier'; rec.stun = 0; F.dir = -1; F.retFrom = rec.x; F.recognized = t; for (const a of F.A) { a.blk = null; a.held = []; } for (const o of O) o.mode = 'chase'; continue; }
        F.whistle('fumble'); break;
      }
      else if (air.kind === 'pitch') { F.give(air.to); air.to!.mode = 'carrierDesign'; F.events.push({ t, k: 'catch' }); F.recognized = Math.min(F.recognized, t); }
      else if (air.kind === 'away') { F.events.push({ t, k: 'incomplete' }); F.whistle('incomplete'); break; }
      else if (air.kind === 'pass') { catchContest(F, thrown!, rng); if (F.over) break; }
    }
    const c = F.carrier;
    // ---- offense
    for (const a of O) {
      if (a.blk) continue;
      if (a.stun > t) { F.go(a, a.x, a.y, 0); continue; }
      const m = a.mode;
      if (a === c && m === 'carrier') { F.vision(a, D); continue; }
      if (c && c.s === 'd') { const [px, py] = F.pursuit(a, c); F.go(a, px, py, a.top); continue; } // an interception: everyone chases
      if (m === 'qb') qbThink(a);
      else if (m === 'route') { if (thrown && F.air?.kind === 'pass' && thrown.target === a && t > thrown.t + 0.12) F.go(a, F.air.x1, F.air.y1, a.top); else if (pressRelease(F, a, t)) F.runRoute(a, a.top * 0.95); }
      else if (m === 'stalk') stalk(a);
      else if (m === 'fake') { if (a.route && a.ri < a.route.length && t < SNAP_T + 1.4) F.runRoute(a, a.top * 0.7); else a.mode = 'pblock'; }
      else if (m === 'pblock') passBlock(a);
      else if (m === 'rblock') runBlock(a);
      else if (m === 'release') { if (a.route && a.ri < a.route.length && t < SNAP_T + 2) F.runRoute(a, a.top * 0.85); else a.mode = 'convoy'; }
      else if (m === 'runner' || m === 'pitchman') runnerThink(a);
      else if (m === 'carrierDesign') designRun(a);
      else if (m === 'convoy') convoy(a);
      else if (m === 'pitched') { if (a.route && a.ri < a.route.length) F.runRoute(a, a.top * 0.9); else F.go(a, a.x + 1, a.y + Math.sign(a.vy || 1), a.top); }
      else F.go(a, a.x, a.y, 0);
    }
    // ---- defense
    for (const d of D) {
      if (d.held.length || d.blk) continue;
      if (d.stun > t) { F.go(d, d.x, d.y, 0); continue; }
      if (d === F.carrier) { F.vision(d, O); continue; }
      if (F.carrier && F.carrier.s === 'd') { F.escort(d); continue; }
      if (F.air?.kind === 'pass' && t >= d.react2) { F.go(d, F.air.x1, F.air.y1, d.top); continue; }
      const cc = F.carrier;
      const seen = !!cc && cc !== qb && t >= F.recognized + d.react * 0.7;
      if (seen || (cc && (cc.mode === 'carrier' || cc.mode === 'carrierDesign') && t >= F.recognized + d.react * 0.7) || (cc && cc.x > 1.2)) {
        const [px, py] = F.pursuit(d, cc!); F.go(d, px, py, d.top); continue;
      }
      if (d.mode === 'rush') rushThink(d); else if (d.mode === 'man') manThink(d); else zoneThink(d);
    }
    // ---- engagements, movement, contact
    F.blocks(pass && !handoffT && !scramble && !thrown, () => F.carrier ?? qb);
    for (const a of F.A) if (!a.blk && !a.held.length) F.steer(a);
    F.separate();
    // ---- boundaries and goal lines, then contact
    const cc = F.carrier;
    if (cc && !F.air) {
      if (Math.abs(cc.y) > SIDE) { cc.y = clamp(cc.y, -SIDE, SIDE); F.whistle('oob'); }
      else if (cc.s === 'o' && cc.x >= F.goal && cc.mode !== 'qb') F.whistle('td');
      else if (cc.s === 'd' && cc.x <= F.own) F.whistle('td');
    }
    if (!F.over) { if (F.carrier === qb && qb.mode === 'qb') { if (pass) sackCheck(); } else if (F.carrier) F.contactsTick(); }
    F.ballTick(); F.record();
    if (F.over) break;
  }
  return F.finish({ passer: qb, pass: thrown, handoff: handoffT, scramble, sackBy, beaten, qbKeep, pitch: pitched });

  // ---- behaviours ----
  function qbThink(a: Agent) {
    const t = F.t;
    if (!pass) {
      // the mesh: he heads for the mesh point, then meets the back where the back is about to be (never far from where he lined up)
      if (mesh && !handoffT && runner && runner !== qb) { const near = F.dist(a, runner) < 4.5 || F.t > SNAP_T + 0.5; let tx = near ? runner.x + runner.vx * 0.3 : mesh[0], ty = near ? runner.y + runner.vy * 0.3 : mesh[1]; const ox = tx - a.x0, oy = ty - a.y0, ol = Math.hypot(ox, oy); if (ol > 6) { tx = a.x0 + (ox / ol) * 6; ty = a.y0 + (oy / ol) * 6; } F.go(a, tx, ty, a.top); }
      else if (a.route && a.ri < a.route.length) F.runRoute(a, a.top * 0.65); else F.go(a, a.x - 0.5, a.y, 2);
      return;
    }
    if (thrown) { F.go(a, a.x + 0.3, a.y, 1); return; }
    if (windup) { F.go(a, a.x, a.y, 0); if (t >= windup.until) { const w = windup; windup = null; throwTo(a, w.r, openness(a, w.r).aim, w.hurried); } return; } // setting his feet and throwing
    if (F.carrier !== qb) { F.go(a, drop[0], drop[1], a.top * 0.7); return; } // the snap is still on its way
    if (sub === 'pa' && t < SNAP_T + 0.75) { const b = O.find((x) => x.mode === 'fake'); F.go(a, underC ? -2.5 : a.x0 - 0.3, a.y0 + (b ? clamp((b.y0 - a.y0) * 0.4, -1.5, 1.5) : 0), a.top * 0.7); return; }
    if (t < earliest - 0.15 && Math.hypot(drop[0] - a.x, drop[1] - a.y) > 0.4) { F.go(a, drop[0], drop[1], a.top * (sub === 'rollout' ? 0.85 : 0.75)); return; }
    // in the pocket: he feels a free rusher in front of him; one from the blind side only if his awareness catches it
    const rush = F.nearest(a, D, (d) => !d.held.length && d.stun <= t && d.mode !== 'zone' && d.mode !== 'man');
    const rd = rush ? F.dist(rush, a) : 99; const seen = !!rush && (rush.x > a.x - 0.5 || rng() < (awr / 99) * 0.12);
    const pressured = (rd < 2.6 || (hot && !!rush && unblocked.includes(rush) && rd < 4)) && seen;
    if (rush && seen && rd < 3.5) { const ox = a.x - rush.x, oy = a.y - rush.y, ol = Math.hypot(ox, oy) || 1; F.go(a, Math.max(F.own + 0.6, a.x + (ox / ol) * 0.9 + 0.3), clamp(a.y + (oy / ol) * 1.0, -SIDE + 3, SIDE - 3), a.top * 0.4); }
    else F.go(a, sub === 'rollout' ? a.x : Math.min(a.x + 0.4, drop[0] + 1.2), sub === 'rollout' ? a.y + Math.sign(drop[1] || 1) * 0.8 : a.y, 1.6);
    if (t < earliest) return;
    // scramble: pressure (or nothing there late) and a lane in front of him
    const held = t - earliest;
    if ((pressured || held > 2.2) && !scramble) {
      const mob = (rate(a.p, 'PSPD') + rate(a.p, 'PAGI') + rate(a.p, 'PESV')) / 3;
      if (laneOpen(a) && rng() < (pressured ? 0.3 : 0.12) * Math.max(0.15, (mob - 55) / 20)) { scramble = true; a.mode = 'carrier'; F.recognized = t; F.events.push({ t, k: 'scramble' }); return; }
    }
    // the read: he works the progression in order (awareness sets how fast), throwing when the man he is on is open
    // enough; a throw short of the sticks or behind the line has to be clearly open early on. Under pressure he
    // looks at everyone and takes the best he has, or throws it away.
    if (t - readT > readTime) { readI = (readI + 1) % Math.max(1, progOrder.length); readT = t; }
    const look = (r: Agent | undefined) => { if (!r || r.blk || r.mode === 'pblock') return null; const o = openness(a, r); return { r, m: o.m + gauss(rng, 0, ((100 - awr) / 100) * 1.4), aim: o.aim }; };
    const need = (r: Agent, aim: [number, number]) => 2.0 - held * 0.45 - (hot ? 1.3 : 0) + (aim[0] < 1 ? 0.8 : aim[0] < 4 ? 0.35 : 0) - (sub === 'quick' || sub === 'screen' ? 0.9 : 0) - (r === progOrder[0] && held < 0.4 ? 0.3 : 0);
    const cur = look(progOrder[readI]);
    if (cur && cur.m > need(cur.r, cur.aim) && routeReady(cur.r, t)) { windup = { r: cur.r, until: t + 0.15 + ((99 - rate(a.p, 'PTHP')) / 99) * 0.08, hurried: pressured }; return; }
    if (pressured || held > 3.2) {
      let best: { r: Agent; m: number; aim: [number, number] } | null = null; for (const r of progOrder) { const o = look(r); if (o && (!best || o.m > best.m)) best = o; }
      if (best && best.m > need(best.r, best.aim) - 1.0 && routeReady(best.r, t)) { windup = { r: best.r, until: t + 0.2, hurried: true }; return; }
      if (rd < 1.4 || held > 3.6) { if (best && best.m > -0.6 && rng() < 0.45) { windup = { r: best.r, until: t + 0.2, hurried: true }; return; } if (rng() < (awr / 99) * 0.6) throwAway(a); }
    }
  }
  function sackCheck() {
    const t = F.t; if (thrown || scramble) return;
    for (const d of D) {
      const held = d.held.length > 0; if (d.stun > t || t - d.lastTry < 0.6 || F.dist(d, qb) > (held ? 0.7 : 1.05)) continue;
      if (!F.tryTackle(d, qb, held)) continue;
      sackBy = d; beaten = lastBlockerOf(d); F.tackler = d; F.lastCarrier = qb;
      if (rng() < 0.07 + (rate(d.p, 'PHIT') - 60) / 500) F.looseBall(qb, d); else F.whistle(qb.x > 0 ? 'tackle' : 'sack');
      return;
    }
  }
  function laneOpen(a: Agent) { let worst = 99; for (const d of D) { if (d.held.length || d.stun > F.t) continue; const ahead = d.x - a.x; if (ahead < -1 || ahead > 7) continue; if (Math.abs(d.y - a.y) < 3.2) worst = Math.min(worst, F.dist(d, a)); } return worst > 3.2; }
  function routeReady(r: Agent, t: number) { if (sub === 'quick' || sub === 'screen' || r.mode === 'fake' || hot) return true; const R = r.route; if (!R) return true; return r.ri >= Math.min(R.length - 1, 2) || t > SNAP_T + 2.4; }
  // how open a receiver is where the ball would meet him: the closest defender's head start on that spot,
  // less for an underneath defender sitting in the throwing lane and for a long throw
  function openness(q: Agent, r: Agent) {
    let ax = r.x, ay = r.y, T = 0.3;
    for (let k = 0; k < 3; k++) { const d = Math.hypot(ax - q.x, ay - q.y); T = d / (vBall * (d > 25 ? 0.88 : 1)) + 0.15; ax = r.x + r.vx * T; ay = clamp(r.y + r.vy * T, -SIDE + 0.8, SIDE - 0.8); }
    let m = 6; for (const d of D) { if (d.held.length) continue; m = Math.min(m, Math.hypot(d.x - ax, d.y - ay) - d.top * Math.max(0, T - 0.25) * 0.85); }
    const L = Math.hypot(ax - q.x, ay - q.y);
    if (L > 6) for (const d of D) { if (d.held.length) continue; const f = ((d.x - q.x) * (ax - q.x) + (d.y - q.y) * (ay - q.y)) / (L * L); if (f < 0.2 || f > 0.85) continue; const off = Math.hypot(d.x - (q.x + (ax - q.x) * f), d.y - (q.y + (ay - q.y) * f)); if (off < 1.6) m -= (1.6 - off) * 1.2; }
    return { m: m - Math.max(0, L - 20) / 12, aim: [ax, ay] as [number, number] };
  }
  function throwTo(q: Agent, r: Agent, aim: [number, number], hurried: boolean) {
    const t = F.t; const dist = Math.hypot(aim[0] - q.x, aim[1] - q.y); const moving = Math.hypot(q.vx, q.vy) > 2.5;
    const sd = (0.68 + dist * 0.088) * (1.45 - (rate(q.p, 'PTHA') / 99) * 0.9) * (hurried ? 1.55 : 1) * (moving ? 1.35 : 1);
    const ex = gauss(rng, 0, sd * 1.25), ey = gauss(rng, 0, sd); const ux = (aim[0] - q.x) / (dist || 1), uy = (aim[1] - q.y) / (dist || 1);
    const x1 = aim[0] + ux * ex - uy * ey, y1 = aim[1] + uy * ex + ux * ey; const T = Math.hypot(x1 - q.x, y1 - q.y) / (vBall * (dist > 25 ? 0.88 : 1)) + 0.12;
    thrown = { t, x: q.x, y: q.y, air: Math.round(x1), cx: x1, cy: y1, target: r, result: 'miss', hurried };
    F.air = { x0: q.x + 0.3, y0: q.y, x1, y1, t0: t, t1: t + T, to: r, kind: 'pass' }; F.give(null); F.lastCarrier = null; F.events.push({ t, k: 'throw' });
    // a rusher already on top of him as he lets it go can arrive late; a man defender beaten badly can have grabbed
    const late = F.nearest(q, D, (d) => !d.held.length && d.stun <= t && d.mode === 'rush' && F.dist(d, q) < 1.7);
    if (late && rng() < LIVE_FOUL.rough * foulRate(late.p)) F.flags.push({ k: 'rough', by: late, x: q.x });
    for (const d of D) if (d.mode === 'man' && d.man && d.man.mode === 'route' && !d.held.length && F.dist(d, d.man) > 2.2 && d.man.x > 3 && rng() < LIVE_FOUL.dhold * foulRate(d.p)) { F.flags.push({ k: 'dhold', by: d, x: d.man.x }); break; }
    for (const d of D) { const cov = d.mode === 'man' ? rate(d.p, 'PMCV') : rate(d.p, 'PZCV'); d.react2 = d.held.length || Math.hypot(d.x - x1, d.y - y1) > (d.x > 10 ? 26 : 18) ? 1e9 : t + 0.1 + ((99 - cov) / 99) * 0.25 + ((99 - rate(d.p, 'PAWR')) / 99) * 0.15; }
  }
  function throwAway(q: Agent) { const t = F.t; const side = q.y >= 0 ? 1 : -1; thrown = { t, x: q.x, y: q.y, air: 0, cx: q.x + 8, cy: side * (SIDE + 2), target: progOrder[0] ?? q, result: 'away' }; F.air = { x0: q.x, y0: q.y, x1: q.x + 6 + rng() * 6, y1: side * (SIDE + 2), t0: t, t1: t + 0.9, to: null, kind: 'away' }; F.give(null); F.lastCarrier = null; F.events.push({ t, k: 'throw' }); }
  function passBlock(a: Agent) {
    const t = F.t;
    if (thrown || scramble || (F.carrier && F.carrier !== qb)) { // the ball is gone: go find someone to block
      const cc = F.carrier; if (cc && cc.s === 'o') { const d = F.nearest(cc, D, (d) => d.held.length < 2 && F.dist(d, cc) < 8); if (d) { if (F.dist(a, d) < 1.1) F.engage(a, d, [F.dir, 0]); else F.go(a, d.x, d.y, a.top * 0.9); return; } }
      F.go(a, a.x + 0.5, a.y, 2); return;
    }
    const home = a.y0; const mine = a.pick && !a.pick.held.length && a.pick.stun <= t && a.pick.mode === 'rush' && F.dist(a, a.pick) < 12 ? a.pick : null;
    const threat = mine ?? F.nearest(a, D, (d) => !d.held.length && d.stun <= t && d.mode === 'rush' && Math.abs(d.y - home) < 4.5 && d.x < 6 && !O.some((o) => o !== a && o.pick === d && !o.blk && o.stun <= t));
    // he sets up a yard in front of his man on the man's line to the QB, wherever the QB goes
    if (threat) { if (F.dist(a, threat) < 1.15) { F.engage(a, threat); return; } const [cx, cy] = F.cutoff(a, threat, qb); F.go(a, Math.min(cx, a.x0 + 0.3), cy, a.top); return; }
    const help = F.nearest(a, D, (d) => d.held.length === 1 && F.dist(d, a) < 2.2);
    if (help && F.dist(a, help) < 1.1) F.engage(a, help); else F.go(a, Math.max(qb.x + 1.5, a.x0 - 1.4), a.y0 * 0.9, 2.5);
  }
  function runBlock(a: Agent) {
    const t = F.t; const R = a.route; const dirx = R && R.length > 1 ? R[R.length - 1]![0]! - R[0]![0]! : 1, diry = R && R.length > 1 ? R[R.length - 1]![1]! - R[0]![1]! : 0; const dl = Math.hypot(dirx, diry) || 1;
    const push: [number, number] = [Math.max(0.35, dirx / dl), diry / dl];
    const mine = a.pick && a.pick.held.length < 2 && a.pick.stun <= t && F.dist(a, a.pick) < 9 && !a.pick.held.includes(a) ? a.pick : null;
    const target = mine ?? F.nearest(a, D, (d) => d.held.length < 2 && d.stun <= t && d.x - a.x > -1.2 && Math.abs(d.y - a.y - (diry / dl) * 2) < 3.2 && F.dist(a, d) < 5.5);
    if (target) { if (F.dist(a, target) < 1.15) F.engage(a, target, push); else F.go(a, target.x - 0.6, target.y - push[1] * 0.4, a.top * 0.9); return; }
    if (R && a.ri < R.length) F.runRoute(a, a.top * 0.85); else { const lb = F.nearest(a, D, (d) => d.held.length < 2 && d.x > a.x && d.x - a.x < 9); if (lb) F.go(a, lb.x, lb.y, a.top * 0.85); else F.go(a, a.x + 1, a.y, 2); }
  }
  function stalk(a: Agent) { if (a.route && a.ri < a.route.length && F.t < SNAP_T + 1.2) { F.runRoute(a, a.top * 0.7); return; } const d = F.nearest(a, D, (d) => d.held.length < 2 && Math.abs(d.y - a.y) < 6 && d.x > a.x - 2); if (d && F.dist(a, d) < 1.1) F.engage(a, d, [1, 0]); else if (d) F.go(a, d.x - 0.8, d.y, a.top * 0.85); else F.go(a, a.x, a.y, 0); }
  function runnerThink(a: Agent) {
    const t = F.t;
    if (a.mode === 'pitchman') { const c = F.carrier; if (c && c !== a && !pitched) F.go(a, c.x - 1.5, c.y + Math.sign(a.y0 - qb.y0 || 1) * 4, a.top * 0.85); else if (a.route) F.runRoute(a, a.top * 0.8); return; }
    // to the mesh with controlled aiming steps; he hits it full speed once the ball is his
    if (a.route && a.ri < a.route.length) F.runRoute(a, a.top * 0.75); else F.go(a, a.x + 2, a.y, a.top * 0.75);
    if (handoffT !== undefined || F.carrier !== qb) return;
    const d = F.dist(a, qb);
    if (family === 'option' && t >= SNAP_T + 0.55 && d < 2.2) { optionRead(a); return; }
    if (d < 2.2 && t > SNAP_T + 0.25) { handoff(a, t); return; }
    if ((!mesh && t > SNAP_T + 0.45) || t > SNAP_T + 1.6) { // toss, or a mesh that never happened: pitch it
      handoffT = t; pitched = true; F.air = { x0: qb.x, y0: qb.y, x1: a.x + a.vx * 0.35, y1: a.y + a.vy * 0.35, t0: t, t1: t + 0.35, to: a, kind: 'pitch' }; F.give(null); F.events.push({ t, k: 'pitch' }); a.mode = 'pitched'; qb.mode = 'carried';
    }
  }
  function handoff(a: Agent, t: number) { handoffT = t; F.give(a); a.mode = 'carrierDesign'; qb.mode = 'carried'; F.events.push({ t, k: 'handoff' }); F.recognized = t + 0.1; }
  // read option: the unblocked end decides it, and awareness decides whether the QB reads him right
  function optionRead(back: Agent) {
    const t = F.t; const bEnd = back.route ? back.route[back.route.length - 1]![1]! : back.y + 1;
    const key = F.nearest(qb, D, (d) => d.mode === 'rush' && !d.held.length && Math.sign(d.y - qb.y) !== Math.sign(bEnd - qb.y));
    const crash = key ? key.vy * Math.sign(back.y - key.y) > 1.5 || F.dist(key, back) < 2.5 : false;
    const keep = rng() < 0.6 + (awr / 99) * 0.36 ? crash : !crash;
    if (keep) { qbKeep = true; handoffT = t; qb.mode = 'carrierDesign'; back.mode = 'rblock'; F.events.push({ t, k: 'keep' }); F.recognized = t + 0.35; } else handoff(back, t);
  }
  function designRun(a: Agent) {
    // the designed path to the hole, then vision takes over (sooner when the hole is closing on a back who sees it)
    const R = a.route; const t = F.t;
    if (R && a.ri < R.length && a.x < 0.8) { const ahead = F.nearest(a, D, (d) => !d.held.length && d.stun <= t && d.x > a.x && F.dist(a, d) < 3); if (!ahead || rng() > rate(a.p, 'PBCV', 65) / 400) { F.runRoute(a, a.top); return; } }
    a.mode = 'carrier'; F.vision(a, D);
    for (const o of O) if (o !== a && (o.mode === 'stalk' || o.mode === 'pitchman' || o.mode === 'fake' || o.mode === 'carried')) o.mode = o.mode === 'carried' ? 'carried' : 'rblock';
  }
  function convoy(a: Agent) { const cc = F.carrier; if (!cc || cc.s !== 'o') { F.go(a, a.x, a.y, 0); return; } const d = F.nearest(cc, D, (d) => d.held.length < 2 && d.stun <= F.t && F.dist(d, cc) < 9 && F.dist(d, a) < 7); if (d) { if (F.dist(a, d) < 1.1) F.engage(a, d, [F.dir, 0]); else F.go(a, (d.x + cc.x) / 2, (d.y + cc.y) / 2, a.top); } else F.go(a, cc.x + 3, cc.y + Math.sign(a.y - cc.y || 1) * 3, a.top * 0.8); }
  function rushThink(d: Agent) {
    const t = F.t;
    if (d.bite && t < d.bite) { F.go(d, d.x0 - 1, d.y0, d.top * 0.5); return; }
    if (d.route && d.ri < d.route.length && t < SNAP_T + 0.45) { F.runRoute(d, d.top); return; }
    // a rusher keeps coming at the quarterback's spot until he has read the handoff, like everyone else
    const cr = F.carrier; const tg = cr && (cr === qb || t >= F.recognized + d.react * 0.7) ? cr : qb; const [px, py] = tg === qb ? [qb.x + 0.3, qb.y] : F.pursuit(d, tg);
    F.go(d, px, py, d.top);
    if (!pass || handoffT) for (const o of O) if (o.mode === 'rblock' && !o.blk && o.stun <= t && F.dist(o, d) < 1.0) { F.engage(o, d); break; }
  }
  function manThink(d: Agent) {
    const t = F.t; const r = d.man!;
    if (d.bite && t < d.bite) { F.go(d, d.x0 - 0.8, d.y0, d.top * 0.4); return; }
    // his man stays in to block: sit in the area, or come after the QB if he reads it
    if (r.mode === 'pblock' || r.blk) { if (rate(d.p, 'PPRC') > 70 && t > SNAP_T + 0.9) { d.mode = 'rush'; return; } F.go(d, Math.max(d.x0, 4), d.y0 * 0.8, d.top * 0.6); return; }
    const lag = 0.22 + ((99 - rate(d.p, 'PMCV')) / 99) * 0.3 + (rate(r.p, 'PRTR') - rate(d.p, 'PMCV')) / 250;
    let past = r.hist[0] ?? [t, r.x, r.y, 0, 0]; for (const s of r.hist) if (s[0]! <= t - lag) past = s;
    let ax = past[1]! + past[3]! * (lag + 0.25), ay = past[2]! + past[4]! * (lag + 0.25);
    if (r.x > 7) ax += 0.6; ay += r.y > d.y ? -0.3 : 0.3; // over the top, a little inside
    F.go(d, ax, ay, t < SNAP_T + 0.5 && d.x0 > 4 ? d.top * 0.75 : d.top);
  }
  function zoneThink(d: Agent) {
    const t = F.t; if (d.bite && t < d.bite) { F.go(d, d.x0 - 0.8, d.y0, d.top * 0.45); return; }
    const z = d.zone!; const radius = d.deep ? 16 : 10;
    const threats = O.filter((r) => (r.mode === 'route' || r.mode === 'fake') && Math.hypot(r.x - z[0], r.y - z[1]) < radius);
    let tx = z[0], ty = z[1];
    if (threats.length && t > SNAP_T + 0.45 + ((99 - rate(d.p, 'PZCV')) / 99) * 0.45) {
      // deep: the deepest man in the zone, staying over the top; underneath: the nearest one, sitting just behind him
      const r = d.deep ? threats.sort((a, b) => b.x - a.x)[0]! : threats.sort((a, b) => Math.hypot(a.x - z[0], a.y - z[1]) - Math.hypot(b.x - z[0], b.y - z[1]))[0]!;
      const w = 0.45 + (rate(d.p, 'PZCV') / 99) * 0.35;
      if (d.deep) { tx = Math.max(z[0] * (1 - w) + (r.x + 2.5) * w, r.x + 2); ty = z[1] + (r.y - z[1]) * w; }
      else { tx = z[0] + (r.x + 1.5 - z[0]) * w; ty = z[1] + (r.y - z[1]) * w; }
    }
    F.go(d, tx, ty, d.top * (t < SNAP_T + 1.2 ? 0.85 : 1));
  }
  function lastBlockerOf(d: Agent) { let best: Agent | undefined, bt = -1; for (const o of O) if (o.mode === 'pblock' && o.engT > bt && Math.hypot(o.x - d.x, o.y - d.y) < 4) { bt = o.engT; best = o; } return best; }
  function routeDepth(a: Agent) { return Math.max(0, ...(a.a.p ?? [[0, 0]]).map((q) => q[1] ?? 0)); }
}

// press at the line: a pressing man defender holds the receiver up until he wins the release
function pressRelease(F: Field, r: Agent, t: number): boolean {
  const d = F.D.find((x) => x.man === r && x.x0 < 2.2); if (!d || t > SNAP_T + 1.2) return true;
  if (r.press === undefined) { const edge = (rate(d.p, 'PYRS', 60) - rate(r.p, 'RELS', 60)) / 100; r.press = SNAP_T + clamp(0.15 + edge * 0.9 + gauss(F.rng, 0, 0.15), 0, 0.85); }
  if (t < r.press) { F.go(r, r.x + 0.4, r.y + (r.y > d.y ? 0.4 : -0.4), 2); return false; }
  return true;
}
function turnOver(F: Field, d0: Agent, t: number, bx: number) {
  F.events.push({ t, k: 'interception' }); F.give(d0); d0.mode = 'carrier'; F.dir = -1; F.turnover = 'd'; F.retFrom = bx; F.recognized = t;
  for (const a of F.A) { a.blk = null; a.held = []; } for (const o of F.O) o.mode = 'chase';
}
// the ball arrives: the target and any defender there play it
function catchContest(F: Field, th: ThrowInfo, rng: Rng) {
  const t = F.t; const r = th.target; const bx = th.cx, by = th.cy;
  if (Math.abs(by) > SIDE + 0.5) { th.result = 'miss'; F.events.push({ t, k: 'incomplete' }); F.whistle('incomplete'); return; }
  const dr = Math.hypot(r.x - bx, r.y - by); const reach = 0.7 + (rate(r.p, 'SPCT', 50) / 99) * 0.5 + (rate(r.p, 'PJMP', 60) / 99) * 0.2;
  const defs = F.D.filter((d) => !d.held.length && Math.hypot(d.x - bx, d.y - by) < 1.8).sort((a, b) => Math.hypot(a.x - bx, a.y - by) - Math.hypot(b.x - bx, b.y - by));
  const d0 = defs[0]; const dd = d0 ? Math.hypot(d0.x - bx, d0.y - by) : 99; th.contested = dd < 1.3;
  const cov = d0 ? Math.max(rate(d0.p, 'PMCV'), rate(d0.p, 'PZCV')) : 0;
  // a defender in front of the ball plays it first
  if (d0 && dd < 1.25 && dd < dr - 0.25) {
    const pInt = clamp(0.1 + (rate(d0.p, 'PCTH', 45) - 50) / 170 + (cov - 60) / 260 + (1.25 - dd) * 0.12, 0.03, 0.5);
    if (rng() < pInt) { th.result = 'int'; th.by = d0; turnOver(F, d0, t, bx); return; }
    if (rng() < 0.62) { th.result = 'pd'; th.by = d0; F.events.push({ t, k: 'incomplete' }); F.whistle('incomplete'); return; }
  }
  if (d0 && dd < 1.15 && dr <= reach + 0.6 && th.cx > 1 && rng() < LIVE_FOUL.dpi * foulRate(d0.p) * clamp(1 + (rate(r.p, 'PRTR') - cov) / 40, 0.5, 2)) F.flags.push({ k: 'dpi', by: d0, x: bx });
  if (dr <= reach) {
    // hands and reach first, then how close the coverage is: a defender on his hip takes about half of them away
    const hands = rate(r.p, 'PCTH'); const traffic = rate(r.p, 'TRAF', hands); const stretch = Math.max(0, dr - 0.6) / Math.max(0.2, reach - 0.6);
    let z = 1.9 + (hands - 70) / 14 - stretch * (1.6 - rate(r.p, 'SPCT', 50) / 130);
    const cf = clamp((1.8 - dd) / 1.5, 0, 1); z -= cf * (2.6 + (cov - 70) / 20 - (traffic - 70) / 20);
    if (rng() < sig(z)) {
      th.result = 'catch'; F.events.push({ t, k: 'catch' }); F.give(r); r.mode = 'carrier'; F.recognized = t;
      for (const d of F.D) d.react = d.react2 <= t ? 0.12 : Math.min(d.react, 0.5); // those who broke on the ball are already coming
      for (const o of F.O) if (o !== r && o.mode !== 'carried') o.mode = 'convoy';
      if (d0 && dd < 1.6 && d0.stun <= t) F.attempt(d0, r, false, false, 0.3); // the man in coverage is there as it arrives
      return;
    }
    if (d0 && dd < 1.3) { th.result = 'pd'; th.by = d0; } else th.result = stretch < 0.4 ? 'drop' : 'miss';
  } else if (d0 && dd < 1.0 && rng() < 0.12 + (rate(d0.p, 'PCTH', 45) - 50) / 300) { th.result = 'int'; th.by = d0; turnOver(F, d0, t, bx); return; }
  F.events.push({ t, k: 'incomplete' }); F.whistle('incomplete');
}

// ---- returns (kickoffs and punts): coverage down the field in lanes, a return wall, the returner's vision ----------
// Every kick is played out through the catch: the gunners release and run their lanes (the vices on them hold them up
// at the line for a moment), the interior protects and then covers, and what the returner does with the ball depends
// on where the coverage is when it comes down: a fair catch with a gunner on him, a touchback in the end zone, a muff
// now and then, otherwise the return behind his wall.
export function simulateReturn(inp: ReturnInput): SimResult {
  const { rng } = inp; const F = new Field(rng); F.goal = 1e9; F.own = inp.own; F.dir = -1; F.recognized = inp.tCatch;
  inp.K.forEach((p, i) => F.agent('o', i, p, inp.ka[i]!, inp.kSlots[i]!)); inp.R.forEach((p, i) => F.agent('d', i, p, inp.ra[i]!, inp.rSlots[i]!));
  const K = F.O, Rt = F.D; const ret = Rt[inp.returner]!; const kicker = K[inp.kicker]!; const punt = inp.kind === 'punt';
  for (const a of K) a.mode = a === kicker ? 'safety' : 'cover';
  for (const d of Rt) d.mode = d === ret ? 'ret' : 'wall';
  // the gunners (split wide on a punt) and the vices lined up over them: a jam at the snap that lasts a second or so
  const gunner = (a: Agent) => punt && a !== kicker && Math.abs(a.y0) >= 6;
  const jam = new Map<Agent, { on: Agent; until: number }>();
  if (punt) for (const d of Rt) { if (d === ret) continue; const g = K.find((k) => gunner(k) && Math.abs(k.y0 - d.y0) < 2.5 && d.x0 < 5 && ![...jam.values()].some((j) => j.on === k)); if (g) jam.set(d, { on: g, until: SNAP_T + 0.7 + rng() * 1.3 }); }
  const free = (a: Agent) => !a.held.length && a.stun <= F.t;
  let nearAtCatch: number | undefined; let muffed = false;
  for (F.t = SNAP_T; F.t < inp.tCatch + 14 && !F.over; F.t += DT) {
    const t = F.t; const caught = t >= inp.tCatch;
    if (F.air && F.air.kind === 'loose' && t >= F.air.t1) { const rec = F.fum!.rec; F.air = null; F.ballXY = [rec.x, rec.y]; if (rec.s === 'o') F.turnover = 'o'; F.events.push({ t, k: 'recovered' }); F.whistle('fumble'); break; }
    if (!caught) { if (t >= inp.tKick) { const f = (t - inp.tKick) / Math.max(0.1, inp.tCatch - inp.tKick); F.ballXY = [inp.kx + (inp.cx - inp.kx) * f, inp.cy * f]; } else if (punt) { const f = clamp((t - SNAP_T) / 0.7, 0, 1); F.ballXY = [inp.kx * f, 0]; } }
    else if (!F.carrier && !F.fum && nearAtCatch === undefined) {
      // the ball comes down: what the returner does with it
      ret.x = inp.cx; ret.y = inp.cy; ret.vx = 0; ret.vy = 0; F.ballXY = [inp.cx, inp.cy];
      const nearest = F.nearest(ret, K, (k) => free(k)); nearAtCatch = nearest ? F.dist(ret, nearest) : 99;
      if (inp.touchback) { F.events.push({ t, k: 'catch' }); F.lastCarrier = ret; F.whistle('touchback'); break; }
      // a fair catch: signalled when a cover man will be on him as it arrives (closer than about five yards, more when
      // he is pinned deep), with the returner's judgement adding some noise to where he draws the line
      const closing = nearest ? nearAtCatch / Math.max(4, nearest.top) : 9; // seconds until the nearest man is on him
      const judge = (rate(ret.p, 'PBCV', 65) - 65) / 35; // -1..1: a sharper returner holds out a little longer
      const line = (inp.deep ? 1.4 : 0.75) - judge * 0.15; // seconds of room he wants
      const fair = inp.fairCatch === true || (inp.fairCatch === 'auto' && closing < line + gauss(rng, 0, 0.15) && nearAtCatch < 12);
      if (fair) { F.events.push({ t, k: 'faircatch' }); F.lastCarrier = ret; F.whistle('faircatch'); break; }
      if (inp.muff && rng() < inp.muff) {
        // bobbled: the ball pops loose in front of him, and whoever gets there first falls on it
        muffed = true; const bx = inp.cx - 1 - rng() * 2, by = clamp(inp.cy + gauss(rng, 0, 1.5), -SIDE, SIDE);
        F.events.push({ t, k: 'fumble' });
        let best: Agent = ret, bt = 1e9;
        for (const a of F.A) { const tt = Math.hypot(a.x - bx, a.y - by) / Math.max(4, a.top) + (a.held.length || a.blk ? 0.5 : 0) + (a === ret ? 0.25 : 0) + rng() * 0.45; if (tt < bt) { bt = tt; best = a; } }
        for (const a of F.A) if (Math.hypot(a.x - bx, a.y - by) < 8) { a.blk = null; a.held = []; F.go(a, bx, by, a.top); }
        const t1 = t + clamp(bt, 0.4, 1.4);
        F.fum = { by: ret, forced: nearest ?? ret, rec: best, t: t1, x: bx, at: inp.cx }; F.lastCarrier = ret; ret.stun = t + 0.3;
        F.air = { x0: inp.cx, y0: inp.cy, x1: bx, y1: by, t0: t, t1, to: best, kind: 'loose' };
      } else { F.give(ret); ret.mode = 'carrier'; ret.vx = -2; F.events.push({ t, k: 'catch' }); }
    }
    const started = punt ? t >= SNAP_T : t >= inp.tKick - 0.6;
    for (const a of K) {
      if (a.blk || a.held.length) continue;
      if (a.stun > t || !started) { F.go(a, a.x, a.y, 0); continue; }
      const c = F.carrier;
      if (c) { const [px, py] = F.pursuit(a, c); F.go(a, px, py, a.top); continue; }
      if (F.fum && F.air) continue; // after the muff: everyone near it was sent to the ball
      if (a.mode === 'safety') { F.go(a, Math.max(a.x, inp.cx * 0.45), a.y0 * 0.4, a.top * 0.7); continue; }
      if (punt && !gunner(a) && t < inp.tKick + 0.3) { F.go(a, a.x0 + 0.5, a.y0, 2); continue; } // the punt team's line protects first
      // down the field in his lane, converging on where the ball is coming down; the gunners run flat out
      F.go(a, Math.min(inp.cx - 4, a.x + 12), clamp(a.y0 * 0.75 + inp.cy * 0.25, -SIDE + 2, SIDE - 2), gunner(a) ? a.top : a.top * 0.95);
    }
    for (const d of Rt) {
      if (d.blk || d.held.length) continue;
      if (d.stun > t) { F.go(d, d.x, d.y, 0); continue; }
      if (d === ret) { if (!caught) F.go(d, inp.cx, inp.cy, d.top * 0.8); else if (d === F.carrier) F.vision(d, K); continue; }
      if (F.fum && F.air) continue;
      const c = F.carrier ?? ret;
      // the vice on a gunner: jam him at the line, then run with him
      const j = jam.get(d);
      if (j && t < j.until && !j.on.held.length && j.on.stun <= t) { if (F.dist(d, j.on) < 1.2) F.engage(d, j.on, [-0.4, Math.sign(d.y0 - j.on.y0 || 1) * 0.6]); else F.go(d, j.on.x + 0.6, j.on.y, d.top); continue; }
      // the wall: get between the returner and a cover man, then block him
      const cov = F.nearest(d, K, (k) => !k.held.length && k.stun <= t && k.x - c.x < 6 && Math.abs(k.y - d.y) < 12);
      if (cov && t > inp.tKick + 0.3) { if (F.dist(d, cov) < 1.1) F.engage(d, cov, [1, Math.sign(cov.y - c.y) * 0.6]); else F.go(d, (cov.x + c.x) / 2 + 1.5, (cov.y + c.y) / 2, d.top * 0.95); }
      else F.go(d, Math.min(d.x, inp.cx - 8), d.y0 * 0.6, d.top * 0.7);
    }
    // a jam ends: the gunner gets off and goes
    for (const [d, j] of jam) if (t >= j.until && d.blk === j.on) F.releaseAll(j.on, 0.1);
    F.blocks(false, () => F.carrier ?? ret);
    for (const a of F.A) if (!a.blk && !a.held.length) F.steer(a);
    F.separate();
    const cc = F.carrier;
    if (cc) { if (Math.abs(cc.y) > SIDE) { cc.y = clamp(cc.y, -SIDE, SIDE); F.whistle('oob'); } else if (cc.x <= F.own) F.whistle('td'); }
    if (F.carrier && !F.over) F.contactsTick();
    F.ballTick(); F.record();
  }
  F.lastCarrier ??= ret;
  return F.finish({ muffed, nearAtCatch });
}
