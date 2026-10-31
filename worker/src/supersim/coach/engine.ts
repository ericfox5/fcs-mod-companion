// Supersim coaching engine: one play at a time. The browser sends the two play calls (the member's own and, for the
// other side, the CPU's pick made on the server), this resolves the snap with fresh randomness, updates the game
// state and returns a play detail with an animation script (22 player paths + ball) built from the playbook art.
// Nothing is pre-generated: the next play's outcome does not exist until it is called.
import type { Actor, Anim, Assign, Book, Drive, GameInput, GameState, KickFlight, LogEntry, PStat, Play, PlayDetail, PlayerInput, SetDef, Side, Slot, TStat, TeamInput, TossChoice } from './types.js';

export const POS = ['QB', 'HB', 'FB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT', 'LE', 'RE', 'DT', 'LLB', 'MLB', 'RLB', 'CB', 'FS', 'SS', 'K', 'P', 'KR', 'PR', 'KO', 'LS'];
export const ENGINE_VERSION = '2.0.0';

// ---- randomness ---------------------------------------------------------------------------------------------------
export type Rng = () => number;
export function mulberry32(seed: number): Rng { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const gauss = (rng: Rng, m = 0, sd = 1) => { const u = Math.max(1e-9, rng()), v = rng(); return m + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const pick = <T>(rng: Rng, list: T[]): T => list[Math.min(list.length - 1, Math.floor(rng() * list.length))]!;
const weighted = <T>(rng: Rng, list: T[], w: (x: T) => number): T => { const ws = list.map(w); const total = ws.reduce((a, b) => a + b, 0); let r = rng() * total; for (let i = 0; i < list.length; i++) { r -= ws[i]!; if (r <= 0) return list[i]!; } return list[list.length - 1]!; };
const round1 = (n: number) => Math.round(n * 10) / 10;

// ---- ratings -------------------------------------------------------------------------------------------------------
export const R = (p: PlayerInput | undefined, key: string, dflt?: number) => { const n = p?.ratings?.[key]; if (Number.isFinite(n) && (n as number) > 0) return clamp(n as number, 1, 99); return dflt ?? clamp(p?.overall ?? 60, 1, 99); };
const avg = (ns: number[]) => (ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 60);
const speedYps = (p: PlayerInput | undefined) => 6.2 + ((R(p, 'PSPD') - 50) / 49) * 3.2; // 50 -> 6.2, 99 -> 9.4 yd/s
const short = (p: PlayerInput | undefined) => { if (!p) return 'the player'; const parts = p.name.trim().split(/\s+/); return parts.length > 1 ? `${parts[0]![0]}. ${parts.slice(1).join(' ')}` : p.name; };
const yd = (n: number) => `${n} yard${Math.abs(n) === 1 ? '' : 's'}`;

// ---- personnel ----------------------------------------------------------------------------------------------------
const GROUP: Record<number, number[]> = { 0: [0], 1: [1, 2, 21, 22], 2: [2, 1, 4], 3: [3, 21, 22, 1], 4: [4, 2, 5, 9], 5: [5, 9, 6, 8, 7], 6: [6, 8, 7, 5, 9], 7: [7, 6, 8], 8: [8, 6, 7, 9, 5], 9: [9, 5, 8, 6, 7], 10: [10, 11, 12, 15, 13], 11: [11, 10, 12, 13, 15], 12: [12, 10, 11], 13: [13, 15, 14, 18], 14: [14, 13, 15, 18], 15: [15, 13, 14, 18], 16: [16, 17, 18, 3], 17: [17, 18, 16], 18: [18, 17, 16, 14], 19: [19, 20, 23], 20: [20, 19], 21: [21, 22, 3, 1, 16], 22: [22, 21, 3, 16, 1], 23: [23, 19, 20], 24: [24, 7, 4, 6] };
// Fills a set's slots from the depth chart (pos + depth), falling back to the next depth, then the best player at a
// related position; never repeats a player within the eleven.
export function lineup(team: TeamInput, set: SetDef): PlayerInput[] {
  const used = new Set<number>(); const byId = new Map(team.players.map((p) => [p.id, p]));
  const out: PlayerInput[] = [];
  for (const slot of set.slots) {
    let chosen: PlayerInput | undefined;
    const chart = team.depthChart.filter((d) => d.pos === slot.pos).sort((a, b) => a.depth - b.depth);
    for (const d of [...chart.filter((d) => d.depth >= slot.depth), ...chart]) { const p = byId.get(d.pgid); if (p && !used.has(p.id)) { chosen = p; break; } }
    if (!chosen) for (const pos of GROUP[slot.pos] ?? [slot.pos]) { const cands = team.players.filter((p) => p.pos === pos && !used.has(p.id)).sort((a, b) => b.overall - a.overall); if (cands[0]) { chosen = cands[0]; break; } }
    if (!chosen) chosen = team.players.filter((p) => !used.has(p.id)).sort((a, b) => b.overall - a.overall)[0];
    if (!chosen) throw new Error(`${team.name}: not enough players to fill ${POS[slot.pos]}`);
    used.add(chosen.id); out.push(chosen);
  }
  return out;
}

// The team with its per-game substitutions laid over the depth chart (positions listed in subs replace their chart rows).
export function withSubs(team: TeamInput, subs: Record<string, number[]> | undefined): TeamInput {
  if (!subs || !Object.keys(subs).length) return team;
  const over = new Set(Object.keys(subs).map(Number));
  return { ...team, depthChart: [...team.depthChart.filter((d) => !over.has(d.pos)), ...Object.entries(subs).flatMap(([pos, ids]) => ids.map((pgid, depth) => ({ pos: Number(pos), depth, pgid })))] };
}
// field ends: teams change ends after every quarter (overtime periods alternate too)
export const flipFor = (q: number) => q % 2 === 0;

// ---- play lookup --------------------------------------------------------------------------------------------------
export interface Found { play: Play; set: SetDef; form: { id: number; n: string; t: number } }
export function findPlay(book: Book, id: number): Found | null {
  const play = book.plays[String(id)]; if (!play) return null;
  for (const f of book.formations) for (const s of f.sets) if (s.plays.includes(id)) return { play, set: s, form: { id: f.id, n: f.n, t: f.t } };
  return null;
}
const asg = (book: Book, play: Play, i: number): Assign => book.asg[play.a[i] ?? -1] ?? { r: 0, k: 'move' };
const isKind = (book: Book, play: Play, ks: string[]) => play.a.some((ai) => ks.includes(book.asg[ai]?.k ?? ''));
export const playFamily = (book: Book, play: Play, form: { t: number }): 'kickoff' | 'fg' | 'punt' | 'kneel' | 'spike' | 'pass' | 'run' | 'option' => {
  if (form.t === 2 || form.t === 3 || (play.t === 21 && isKind(book, play, ['cover']) && !isKind(book, play, ['punt', 'hold']))) return play.t === 21 && isKind(book, play, ['punt']) ? 'punt' : 'kickoff';
  if (play.t === 37) return 'kneel';
  if (play.t === 38) return 'spike';
  if (play.t === 21) return isKind(book, play, ['punt']) ? 'punt' : 'fg';
  if ([1, 3, 4, 5, 6, 7, 20, 100, 101, 102, 103, 104, 105, 106, 157, 159].includes(play.t)) return 'pass';
  if (play.t >= 162 && play.t <= 172 || play.t === 17) return 'option';
  return 'run';
};
export const PASS_SUB = (t: number) => (t === 5 || t === 100 ? 'screen' : t === 101 ? 'quick' : t === 4 || t === 1 || t === 157 ? 'pa' : t === 7 ? 'rollout' : t === 104 ? 'hailmary' : t === 6 ? 'rpo' : 'drop');

// ---- state ----------------------------------------------------------------------------------------------------------
const emptyP = (): PStat => ({ pa: 0, pc: 0, py: 0, ptd: 0, pi: 0, ra: 0, ry: 0, rtd: 0, fum: 0, rec: 0, rey: 0, retd: 0, tgt: 0, tk: 0, sk: 0, int: 0, iry: 0, dtd: 0, tfl: 0, pd: 0, fga: 0, fgm: 0, fgl: 0, xpa: 0, xpm: 0, pt: 0, pty: 0, kr: 0, kry: 0, pr: 0, pry: 0, krtd: 0, lp: 0, lr: 0, lc: 0, yac: 0, yco: 0, bt: 0, r20: 0, drp: 0, sacked: 0, ff: 0, fr: 0, sfty: 0, blk: 0, ast: 0, lir: 0, sa: 0, pk: 0, fa29: 0, fm29: 0, fa39: 0, fm39: 0, fa49: 0, fm49: 0, fa50: 0, fm50: 0, fgb: 0, xpb: 0, ko: 0, kotb: 0, p20: 0, ptb: 0, pnet: 0, plong: 0, pbl: 0, krl: 0, prl: 0, prtd: 0, tp2: 0, tr2: 0, tc2: 0 });
const emptyT = (): TStat => ({ fd: 0, yds: 0, py: 0, ry: 0, pa: 0, pc: 0, ra: 0, t3a: 0, t3c: 0, t4a: 0, t4c: 0, to: 0, pen: 0, peny: 0, top: 0, plays: 0, rz: 0, rztd: 0, sk: 0, rzfg: 0, ptd: 0, rtd: 0, tp2a: 0, tp2c: 0 });
// opts.toss: start at the coin toss (coached games); without it the toss is settled here (simulations, tests)
export function newGame(input: GameInput, seed: number, id: string, opts: { toss?: boolean } = {}): GameState {
  const rng = mulberry32(seed);
  const tossWinner: Side = rng() < 0.5 ? 0 : 1; const receives: Side = rng() < 0.6 ? tossWinner : ((1 - tossWinner) as Side);
  const st: GameState = { v: 2, id, seed, n: 0, q: 1, clock: input.quarterSeconds, qs: input.quarterSeconds, score: [0, 0], off: receives, ball: 35, down: 1, toGo: 10, phase: 'kickoff', kicking: (1 - receives) as Side, running: false, to: [3, 3], drives: [], log: [], stats: [{}, {}], team: [emptyT(), emptyT()], usage: {}, opened: receives, ot: null, winner: null, final: false, tempo: 'normal' };
  if (opts.toss) { st.phase = 'toss'; st.toss = { caller: 0 }; }
  return st;
}
// ---- coin toss ----------------------------------------------------------------------------------------------------
export function coinToss(st: GameState, rng: Rng, call: 'heads' | 'tails') {
  const t = st.toss!; const result = rng() < 0.5 ? 'heads' : 'tails'; const winner = (call === result ? t.caller : 1 - t.caller) as Side;
  st.toss = { ...t, call, result, winner };
}
export const cpuTossChoice = (rng: Rng): TossChoice => (rng() < 0.75 ? 'defer' : 'receive');
export function tossChoice(st: GameState, input: GameInput, choice: TossChoice): string {
  const t = st.toss!; const w = t.winner!; const other = (1 - w) as Side;
  const receives: Side = choice === 'receive' ? w : other; st.h2 = choice === 'defer' ? w : other;
  st.toss = { ...t, choice }; st.opened = receives; st.off = receives; st.kicking = (1 - receives) as Side;
  st.phase = 'kickoff'; st.ball = 35; st.running = false;
  const T = input.teams; const verb = choice === 'defer' ? 'defers to the second half' : choice === 'receive' ? 'elects to receive' : 'elects to kick off';
  const text = `Coin toss: ${T[t.caller].name} call ${t.call}, it is ${t.result}. ${T[w].name} win the toss and ${verb}; ${T[receives].name} will receive the opening kickoff.`;
  st.log.push({ n: st.n, q: 1, clk: st.clock, off: receives, ball: 35, d: 0, tg: 0, op: 0, dp: 0, k: 'toss', y: 0, s: [0, 0], t: text });
  return text;
}
const pstat = (st: GameState, side: Side, id: number): PStat => { const k = String(id); const cur = st.stats[side][k]; if (cur && cur.yac !== undefined) return cur; return (st.stats[side][k] = { ...emptyP(), ...(cur ?? {}) }); };

// ---- geometry helpers for the animation ------------------------------------------------------------------------------
type KF = number[][];
const kf = (path: KF, t: number, x: number, y: number) => { path.push([round1(t), round1(x), round1(y)]); };
const last = (path: KF) => path[path.length - 1] ?? [0, 0, 0];
// move along a polyline (relative to the player's alignment) at speed from time t0; returns the arrival time
function follow(path: KF, pts: number[][] | undefined, ax: number, ay: number, t0: number, spd: number, maxX?: number): number {
  let t = t0, cx = ax, cy = ay;
  if (!pts || pts.length < 2) return t;
  for (let i = 1; i < pts.length; i++) {
    const [px, py] = pts[i]!; let nx = ax + (py ?? 0), ny = ay + (px ?? 0); // art: p[k] = [x right, y downfield] -> field (x downfield, y right)
    if (maxX !== undefined && nx > maxX) { const prev = last(path); const f = clamp((maxX - prev[1]!) / Math.max(0.1, nx - prev[1]!), 0, 1); nx = maxX; ny = prev[2]! + (ny - prev[2]!) * f; }
    const d = Math.hypot(nx - cx, ny - cy); t += d / spd; kf(path, t, nx, ny); cx = nx; cy = ny;
    if (maxX !== undefined && nx >= maxX) break;
  }
  return t;
}
const alignXY = (slot: Slot, side: 'o' | 'd'): [number, number] => (side === 'o' ? [slot.y, slot.x] : [slot.y, slot.x]); // x downfield (defense already positive), y right
function arrive(path: KF, t: number, x: number, y: number, spd: number, minT = 0): number { const p = last(path); const d = Math.hypot(x - p[1]!, y - p[2]!); const at = Math.max(minT, p[0]! + d / spd); kf(path, at, x, y); return at; }

// ---- per-play context ---------------------------------------------------------------------------------------------
interface Ctx {
  st: GameState; input: GameInput; rng: Rng; off: Side; def: Side; offTeam: TeamInput; defTeam: TeamInput; offBook: Book; defBook: Book;
  op: Found; dp: Found; O: PlayerInput[]; D: PlayerInput[]; oa: Assign[]; da: Assign[]; actors: Actor[]; events: { t: number; k: string }[]; ball: KF; people: PlayDetail['people']; kick?: KickFlight;
}
interface Outcome { kind: string; yards: number; text: string; headline: string; elapsed: number; stop: boolean; td?: boolean; safety?: boolean; turnover?: 'int' | 'fumble' | 'downs' | 'punt' | 'kick' | 'fg-miss' | 'fg-good'; spot?: number; ret?: number; dist?: number; tackler?: number; end: number[]; dur: number; pat?: 'good' | 'miss' | 'two-good' | 'two-miss'; penalty?: string; autoFirst?: boolean; replay?: boolean; onsideRecovered?: boolean; touchback?: boolean }

function mkCtx(st: GameState, input: GameInput, books: { off: Book; def: Book }, calls: { off: number; def: number }, rng: Rng): Ctx {
  const off: Side = st.phase === 'kickoff' ? st.kicking! : st.off; const def = (1 - off) as Side;
  const op = findPlay(books.off, calls.off), dp = findPlay(books.def, calls.def);
  if (!op) throw Object.assign(new Error('Unknown offensive play.'), { status: 400 });
  if (!dp) throw Object.assign(new Error('Unknown defensive play.'), { status: 400 });
  const offTeam = withSubs(input.teams[off], st.subs?.[off]), defTeam = withSubs(input.teams[def], st.subs?.[def]);
  const O = lineup(offTeam, op.set), D = lineup(defTeam, dp.set);
  const oa = O.map((_, i) => asg(books.off, op.play, i)), da = D.map((_, i) => asg(books.def, dp.play, i));
  const actors: Actor[] = [];
  O.forEach((p, i) => { const s = op.set.slots[i]!; const [x, y] = alignXY(s, 'o'); actors.push({ s: 'o', i, id: p.id, num: p.number, pos: p.pos, k: oa[i]!.k, path: [[0, round1(x), round1(y)]] }); });
  D.forEach((p, i) => { const s = dp.set.slots[i]!; const [x, y] = alignXY(s, 'd'); actors.push({ s: 'd', i, id: p.id, num: p.number, pos: p.pos, k: da[i]!.k, path: [[0, round1(x), round1(y)]] }); });
  for (const p of [...O, ...D]) st.usage[String(p.id)] = (st.usage[String(p.id)] ?? 0) + 1;
  return { st, input, rng, off, def, offTeam, defTeam, offBook: books.off, defBook: books.def, op, dp, O, D, oa, da, actors, events: [], ball: [], people: [] };
}
const A = (c: Ctx, side: 'o' | 'd', i: number) => c.actors[side === 'o' ? i : 11 + i]!;
const slotOf = (c: Ctx, side: 'o' | 'd', i: number) => (side === 'o' ? c.op.set.slots[i] : c.dp.set.slots[i])!;
const SNAP = 0.8;

// defenders converge on the ball carrier's end point; the nearest ones make the tackle
function converge(c: Ctx, endX: number, endY: number, tEnd: number, exclude: number[] = [], from = SNAP + 0.4) {
  const order = c.D.map((p, i) => ({ i, p, d: Math.hypot(last(A(c, 'd', i).path)[1]! - endX, last(A(c, 'd', i).path)[2]! - endY) })).filter((x) => !exclude.includes(x.i)).sort((a, b) => a.d - b.d);
  order.forEach((x, rank) => { const a = A(c, 'd', x.i); const spd = speedYps(x.p); const lag = rank < 2 ? 0 : rank < 5 ? 0.6 : 1.4; const p = last(a.path); if (p[0]! < from) kf(a.path, from, p[1]!, p[2]!); arrive(a.path, tEnd, endX + (rank < 2 ? 0 : gauss(c.rng, 0, 1.5)), endY + (rank < 2 ? 0 : gauss(c.rng, 0, 2)), spd * 0.9, tEnd + lag); });
  return order.slice(0, 2).map((x) => x.i);
}
function blockersMove(c: Ctx, tEnd: number, pass: boolean) {
  c.O.forEach((p, i) => { const k = c.oa[i]!.k; const a = A(c, 'o', i); if (!['block', 'pblock', 'cover', 'move'].includes(k)) return; const spd = speedYps(p) * 0.8; const [ax, ay] = [a.path[0]![1]!, a.path[0]![2]!]; const pts = c.oa[i]!.p; if (pts && pts.length > 1 && k !== 'pblock') { follow(a.path, pts, ax, ay, SNAP, spd, pass ? ax + 2 : undefined); } else { kf(a.path, SNAP, ax, ay); kf(a.path, SNAP + 0.6, ax + (k === 'pblock' ? -1 : 1.5), ay); } const l = last(a.path); if (l[0]! < tEnd) kf(a.path, tEnd, l[1]! + gauss(c.rng, 0, 0.5), l[2]!); });
}
// defenders not otherwise scripted drift along their own art (zone drops, rush lanes) after the snap
function defenseBase(c: Ctx, tStop: number, qbX: number, qbY: number) {
  c.D.forEach((p, i) => { const a = A(c, 'd', i); if (a.path.length > 1) return; const k = c.da[i]!.k; const spd = speedYps(p); const [ax, ay] = [a.path[0]![1]!, a.path[0]![2]!]; kf(a.path, SNAP, ax, ay); if (k === 'rush') { arrive(a.path, tStop, qbX + gauss(c.rng, 1.5, 1), qbY + gauss(c.rng, 0, 2), spd * 0.55); } else if (c.da[i]!.p && c.da[i]!.p!.length > 1) { follow(a.path, c.da[i]!.p, ax, ay, SNAP, spd * 0.7); } });
}

// ---- pass ------------------------------------------------------------------------------------------------------------
function resolvePass(c: Ctx): Outcome {
  const { rng, st } = c; const sub = PASS_SUB(c.op.play.t);
  const qbI = c.oa.findIndex((a) => ['qb', 'qbpa', 'qbopt', 'hold', 'punt'].includes(a.k)); const qi = qbI >= 0 ? qbI : 0; const qb = c.O[qi]!;
  const receivers = c.O.map((p, i) => ({ p, i, a: c.oa[i]! })).filter((x) => ['route', 'screen'].includes(x.a.k));
  const blockers = c.O.map((p, i) => ({ p, i })).filter((x) => ['pblock', 'block'].includes(c.oa[x.i]!.k));
  const rushers = c.D.map((p, i) => ({ p, i })).filter((x) => c.da[x.i]!.k === 'rush');
  const manD = c.D.map((p, i) => ({ p, i })).filter((x) => c.da[x.i]!.k === 'man');
  const under = c.D.filter((_, i) => c.da[i]!.k === 'under').length, deep = c.D.filter((_, i) => c.da[i]!.k === 'deep').length;
  const slotO = (i: number) => slotOf(c, 'o', i), slotD = (i: number) => slotOf(c, 'd', i);
  // man matchups by proximity at the snap
  const cover = new Map<number, number>(); const freeD = [...manD];
  for (const r of receivers.slice().sort((a, b) => Math.abs(slotO(b.i).x) - Math.abs(slotO(a.i).x))) { if (!freeD.length) break; freeD.sort((a, b) => Math.hypot(slotD(a.i).x - slotO(r.i).x, slotD(a.i).y - slotO(r.i).y) - Math.hypot(slotD(b.i).x - slotO(r.i).x, slotD(b.i).y - slotO(r.i).y)); cover.set(r.i, freeD.shift()!.i); }
  const protQ = avg(blockers.map((b) => R(b.p, 'PPBK'))), rushQ = avg(rushers.slice().sort((a, b) => R(b.p, 'PPMV') + R(b.p, 'PFMV') - R(a.p, 'PPMV') - R(a.p, 'PFMV')).slice(0, 4).map((r) => (R(r.p, 'PPMV') + R(r.p, 'PFMV')) / 2));
  const timing = sub === 'quick' || sub === 'screen' ? 1.5 : sub === 'pa' ? 2.9 : sub === 'rollout' ? 2.6 : sub === 'hailmary' ? 3.6 : 2.5;
  const maxDepth = Math.max(0, ...receivers.map((r) => Math.max(0, ...(r.a.p ?? []).map((q) => q[1] ?? 0))));
  const pressure = clamp(0.24 + 0.08 * (rushers.length - blockers.length) + (rushQ - protQ) / 140 + (timing - 2.5) * 0.08, 0.04, 0.85);
  const mobility = (R(qb, 'PAGI') + R(qb, 'PAWR')) / 2;
  const pressured = rng() < pressure;
  const sackP = (sub === 'quick' || sub === 'screen' ? 0.12 : sub === 'pa' ? 0.4 : maxDepth > 18 ? 0.42 : 0.3) * (1 - (mobility - 60) / 150);
  const qbA = A(c, 'o', qi); const [qx, qy] = [qbA.path[0]![1]!, qbA.path[0]![2]!]; const underC = qx > -3; // under centre vs shotgun
  let dropX = underC ? -6.5 : qx - 1.5, dropY = qy; const tDrop = SNAP + (underC ? 1.4 : 0.7);
  const qbArt = c.oa[qi]!.p;
  if (qbArt && qbArt.length > 2) { const e = qbArt[qbArt.length - 1]!; dropX = qx + (e[1] ?? -5); dropY = qy + (e[0] ?? 0); } else if (sub === 'rollout') { dropX = qx - 4; dropY = qy + (rng() < 0.5 ? 7 : -7); }
  kf(qbA.path, SNAP, qx, qy); if (qbArt && qbArt.length > 2 && sub !== 'drop') follow(qbA.path, qbArt, qx, qy, SNAP, speedYps(qb) * 0.8); else kf(qbA.path, tDrop, dropX, dropY);
  // receivers run their routes
  const rcvEnd = new Map<number, number>();
  for (const r of receivers) { const a = A(c, 'o', r.i); const spd = speedYps(r.p) * 0.92; kf(a.path, SNAP, a.path[0]![1]!, a.path[0]![2]!); rcvEnd.set(r.i, follow(a.path, r.a.p, a.path[0]![1]!, a.path[0]![2]!, SNAP, spd)); }
  // ---- sack / scramble
  if (pressured && rng() < sackP) {
    const rusher = rushers.length ? weighted(rng, rushers, (r) => R(r.p, 'PPMV') + R(r.p, 'PFMV')) : { p: c.D[0]!, i: 0 };
    const loss = -clamp(Math.round(gauss(rng, 6.5, 2.2)), 1, 14); const tSack = SNAP + timing * 0.8 + 0.3;
    kf(qbA.path, tSack, dropX - 1, dropY); const ra = A(c, 'd', rusher.i); kf(ra.path, SNAP, ra.path[0]![1]!, ra.path[0]![2]!); arrive(ra.path, tSack, dropX - 1, dropY, speedYps(rusher.p));
    blockersMove(c, tSack, true); defenseBase(c, tSack + 0.5, dropX, dropY); converge(c, dropX - 1, dropY, tSack + 0.6, [rusher.i]);
    for (const p of qbA.path) kf(c.ball, p[0]!, p[1]!, p[2]!);
    pstat(st, c.def, rusher.p.id).sk += 1; pstat(st, c.def, rusher.p.id).tk += 1; pstat(st, c.def, rusher.p.id).tfl += 1; st.team[c.def].sk += 1;
    pstat(st, c.off, qb.id).sacked += 1; const line = blockers.filter((b) => b.p.pos >= 5 && b.p.pos <= 9); if (line.length) pstat(st, c.off, weighted(rng, line, (b) => 110 - R(b.p, 'PPBK')).p.id).sa += 1;
    const fumble = rng() < 0.07;
    c.people.push({ id: rusher.p.id, side: c.def, role: 'SACK' }, { id: qb.id, side: c.off, role: 'QB' });
    const text = `${short(qb)} is sacked by ${short(rusher.p)} for a loss of ${yd(-loss)}${fumble ? ' and FUMBLES; the defense recovers' : ''}.`;
    if (fumble) { pstat(st, c.off, qb.id).fum += 1; pstat(st, c.def, rusher.p.id).ff += 1; pstat(st, c.def, rusher.p.id).fr += 1; }
    return { kind: 'sack', yards: loss, text, headline: fumble ? 'STRIP SACK' : 'SACK', elapsed: 5 + rng() * 3, stop: fumble, tackler: rusher.p.id, ...(fumble ? { turnover: 'fumble' as const, spot: st.ball + loss } : {}), end: [dropX - 1, dropY], dur: tSack + 1 };
  }
  if (pressured && R(qb, 'PSPD') >= 78 && rng() < 0.3 && sub !== 'screen') {
    const gain = clamp(Math.round(gauss(rng, 5.5, 4.5)), -3, 25); const left = 100 - st.ball; const yards = Math.min(gain, left); const endX = yards, endY = dropY + gauss(rng, 0, 6);
    const tEnd = SNAP + timing * 0.9 + Math.hypot(endX - dropX, endY - dropY) / speedYps(qb); kf(qbA.path, SNAP + timing * 0.8, dropX, dropY); kf(qbA.path, tEnd, endX, endY);
    for (const p of qbA.path) kf(c.ball, p[0]!, p[1]!, p[2]!);
    blockersMove(c, tEnd, true); defenseBase(c, SNAP + timing * 0.8, dropX, dropY); const tk = converge(c, endX, endY, tEnd + 0.2);
    const ps = pstat(st, c.off, qb.id); ps.ra += 1; ps.ry += yards; ps.lr = Math.max(ps.lr, yards); if (yards >= 20) ps.r20 += 1; if (tk[0] !== undefined) pstat(st, c.def, c.D[tk[0]]!.id).tk += 1;
    c.people.push({ id: qb.id, side: c.off, role: 'QB' });
    const td = st.ball + yards >= 100; if (td) ps.rtd += 1;
    return { kind: 'scramble', yards, text: `${short(qb)} escapes the pressure and scrambles for ${yd(yards)}${td ? ' and a TOUCHDOWN' : ''}.`, headline: td ? 'TOUCHDOWN' : 'QB SCRAMBLE', elapsed: 6 + rng() * 3, stop: td, td, tackler: tk[0] !== undefined ? c.D[tk[0]]!.id : undefined, end: [endX, endY], dur: tEnd + 0.8 };
  }
  // ---- target selection
  const qbAcc = R(qb, 'PTHA'), qbAwr = R(qb, 'PAWR');
  const cands = receivers.map((r) => {
    const depth = Math.max(0, ...(r.a.p ?? [[0, 0]]).map((q) => q[1] ?? 0)); const lateral = (r.a.p?.[r.a.p.length - 1]?.[0] ?? 0);
    let open: number; const dI = cover.get(r.i);
    if (dI !== undefined) { const d = c.D[dI]!; open = 0.5 + sigmoid((R(r.p, 'PRTR') * 0.4 + R(r.p, 'PSPD') * 0.35 + R(r.p, 'PAGI') * 0.25 - (R(d, 'PMCV') * 0.6 + R(d, 'PSPD') * 0.4)) / 22) * 0.5 - 0.25; }
    else { const density = depth < 10 ? under / 4 : depth < 20 ? (under + deep) / 7 : deep / 3; open = clamp(0.92 - density * 0.62 + (sub === 'screen' ? 0.1 : 0), 0.15, 0.95); }
    open = clamp(open + gauss(rng, 0, 0.09), 0.05, 0.98); if (pressured && depth > 14) open *= 0.55;
    const pct = c.op.play.prog?.find((q) => q[0] === r.i)?.[1] ?? (depth < 6 ? 20 : depth < 14 ? 45 : 35);
    return { ...r, depth, lateral, open, pct, dI };
  });
  if (!cands.length) return { kind: 'incomplete', yards: 0, text: `${short(qb)} throws the ball away.`, headline: 'INCOMPLETE', elapsed: 4, stop: true, end: [dropX, dropY], dur: SNAP + timing + 1 };
  const target = weighted(rng, cands, (r) => Math.pow(Math.max(1, r.pct) * (0.3 + r.open) / (1 + r.depth / 22), clamp(qbAwr / 65, 0.6, 1.6)));
  const tgtP = target.p; const defender = target.dI !== undefined ? c.D[target.dI] : undefined;
  const air = clamp(Math.round(target.depth + gauss(rng, 0, 1.6)), -4, 100 - st.ball);
  const throwaway = pressured && Math.max(...cands.map((r) => r.open)) < 0.22 && rng() < 0.6;
  const z = 0.42 + 1.4 * (target.open - 0.5) + (qbAcc - 70) / 50 + (R(tgtP, 'PCTH') - 70) / 60 - (air - 7) / 19 - (pressured ? 0.65 : 0) + (sub === 'screen' ? 0.5 : 0);
  const complete = !throwaway && rng() < sigmoid(z);
  pstat(st, c.off, qb.id).pa += 1; pstat(st, c.off, tgtP.id).tgt += 1; st.team[c.off].pa += 1;
  // geometry: the catch point on the receiver's route at the air depth
  const ta = A(c, 'o', target.i); const catchX = air; const catchY = ta.path[0]![2]! + (target.lateral ?? 0) * clamp(air / Math.max(1, target.depth), 0, 1) + (air < 2 ? gauss(rng, 0, 1) : 0);
  const tCatch = Math.max(SNAP + timing + 0.2, Math.min(rcvEnd.get(target.i) ?? SNAP + timing, SNAP + timing + 0.9)); const flight = clamp(Math.hypot(catchX - dropX, catchY - dropY) / 20, 0.3, 1.6); const tThrow = Math.max(SNAP + 0.5, tCatch - flight);
  // trim the target's route at the catch point
  ta.path = ta.path.filter((p) => p[0]! <= tThrow); kf(ta.path, tCatch, catchX, catchY);
  kf(qbA.path, tThrow, dropX, dropY); c.events.push({ t: tThrow, k: 'throw' }); kf(c.ball, tThrow, dropX, dropY);
  const defA = defender ? A(c, 'd', target.dI!) : undefined;
  if (defA) { kf(defA.path, SNAP, defA.path[0]![1]!, defA.path[0]![2]!); const cushion = slotOf(c, 'd', target.dI!).y - 1; kf(defA.path, tCatch, catchX + cushion * 0.3 + 1, catchY + (catchY > 0 ? -1 : 1)); }
  blockersMove(c, tCatch, true); defenseBase(c, tThrow + 0.4, dropX, dropY);
  if (!complete) {
    const intP = throwaway ? 0 : clamp(0.055 + (air - 8) / 220 + (pressured ? 0.04 : 0) - (qbAcc - 70) / 500 + (defender ? (R(defender, 'PCTH', 55) - 55) / 400 : -0.02), 0.01, 0.3);
    if (rng() < intP) {
      const picker = defender ?? c.D.map((p, i) => ({ p, i })).filter((x) => !['rush'].includes(c.da[x.i]!.k)).sort((a, b) => Math.hypot(last(A(c, 'd', a.i).path)[1]! - catchX, last(A(c, 'd', a.i).path)[2]! - catchY) - Math.hypot(last(A(c, 'd', b.i).path)[1]! - catchX, last(A(c, 'd', b.i).path)[2]! - catchY))[0]?.p ?? c.D[10]!;
      const pi = c.D.indexOf(picker); const pa = A(c, 'd', pi); pa.path = pa.path.filter((p) => p[0]! < tCatch); kf(pa.path, tCatch, catchX, catchY); kf(c.ball, tCatch, catchX, catchY);
      const ret = clamp(Math.round(Math.abs(gauss(rng, 6, 9))), 0, 100); const endX = Math.max(catchX - ret, -(st.ball)); const endY = catchY + gauss(rng, 0, 6); const tEnd = arrive(pa.path, tCatch, endX, endY, speedYps(picker));
      kf(c.ball, tEnd, endX, endY); c.events.push({ t: tCatch, k: 'interception' });
      c.O.forEach((p, i) => { const a = A(c, 'o', i); const l = last(a.path); if (l[0]! < tEnd) kf(a.path, tEnd, l[1]! + (endX - l[1]!) * 0.4, l[2]! + (endY - l[2]!) * 0.4); });
      const ds = pstat(st, c.def, picker.id); ds.int += 1; ds.iry += catchX - endX; ds.lir = Math.max(ds.lir, Math.round(catchX - endX)); pstat(st, c.off, qb.id).pi += 1; st.team[c.off].to += 1;
      const spot = st.ball + endX; const td = spot <= 0; if (td) ds.dtd += 1;
      c.people.push({ id: picker.id, side: c.def, role: 'INTERCEPTION' }, { id: qb.id, side: c.off, role: 'QB' });
      return { kind: 'interception', yards: 0, text: `${short(qb)}'s pass intended for ${short(tgtP)} is INTERCEPTED by ${short(picker)}${td ? ' and returned for a TOUCHDOWN' : ret ? `, returned ${yd(catchX - endX)}` : ''}.`, headline: td ? 'PICK SIX' : 'INTERCEPTED', elapsed: 6 + rng() * 3, stop: true, turnover: 'int', spot: clamp(spot, 0, 100), td, ret: Math.round(catchX - endX), end: [endX, endY], dur: tEnd + 1 };
    }
    kf(c.ball, tCatch, catchX + 1.5, catchY + gauss(rng, 0, 1.5)); c.events.push({ t: tCatch, k: 'incomplete' });
    if (defender && rng() < 0.4) pstat(st, c.def, defender.id).pd += 1;
    c.people.push({ id: qb.id, side: c.off, role: 'QB' }, { id: tgtP.id, side: c.off, role: 'TARGET' });
    const drop = !throwaway && target.open > 0.55 && rng() < 0.22; if (drop) pstat(st, c.off, tgtP.id).drp += 1;
    const why = throwaway ? 'throws it away under pressure' : drop ? 'DROPPED' : defender && target.open < 0.4 ? `pass broken up by ${short(defender)}` : rng() < 0.5 ? 'pass falls incomplete' : `overthrows ${short(tgtP)}`;
    return { kind: 'incomplete', yards: 0, text: `${short(qb)} ${why === 'throws it away under pressure' ? why : `to ${short(tgtP)}: ${why}`}.`, headline: 'INCOMPLETE', elapsed: 4 + rng() * 2, stop: true, end: [catchX, catchY], dur: tCatch + 0.8 };
  }
  // completion: yards after the catch, tackle
  const elus = (R(tgtP, 'PSPD') + R(tgtP, 'PAGI') + R(tgtP, 'PBTK')) / 3;
  let yac = Math.round(Math.max(0, (sub === 'screen' ? 6 : air < 6 ? 3.8 : 2.4) * Math.exp(gauss(rng, 0, 0.7)) * (0.55 + target.open * 0.8) + (elus - 72) / 18));
  let broke = false; if (rng() < 0.035 + (elus - 78) / 600 && target.open > 0.55) { yac += 8 + Math.round(rng() * 30); broke = true; }
  const left = 100 - st.ball - air; yac = Math.min(yac, left); const yards = air + yac; const td = st.ball + yards >= 100;
  const fumble = !td && rng() < 0.011; const endX = yards, endY = catchY + gauss(rng, 0, 3);
  kf(c.ball, tCatch, catchX, catchY); c.events.push({ t: tCatch, k: 'catch' }); const tEnd = arrive(ta.path, tCatch, endX, endY, speedYps(tgtP)); kf(c.ball, tEnd, endX, endY);
  const tk = converge(c, endX, endY, tEnd + 0.15, defender ? [target.dI!] : []); if (defA) arrive(defA.path, tEnd + 0.1, endX, endY, speedYps(defender!));
  const tackler = defender && rng() < 0.5 ? defender : tk[0] !== undefined ? c.D[tk[0]] : undefined;
  const ps = pstat(st, c.off, qb.id); ps.pc += 1; ps.py += yards; ps.lp = Math.max(ps.lp, yards); const rs = pstat(st, c.off, tgtP.id); rs.rec += 1; rs.rey += yards; rs.lc = Math.max(rs.lc, yards); rs.yac += Math.max(0, yac); if (broke || (yac >= 5 && rng() < 0.25)) rs.bt += 1;
  if (!pressured && rng() < 0.35) { const line = blockers.filter((b) => b.p.pos >= 5 && b.p.pos <= 9); if (line.length) pstat(st, c.off, weighted(rng, line, (b) => R(b.p, 'PPBK')).p.id).pk += 1; }
  const helper = tk.map((i) => c.D[i]).find((p) => p && p !== tackler); if (!td && tackler && helper && rng() < 0.3) pstat(st, c.def, helper.id).ast += 1;
  st.team[c.off].pc += 1; st.team[c.off].py += yards; st.team[c.off].yds += yards;
  if (td) { ps.ptd += 1; rs.retd += 1; } else if (tackler) pstat(st, c.def, tackler.id).tk += 1;
  if (fumble) { rs.fum += 1; st.team[c.off].to += 1; const rec = tackler ?? c.D[0]!; if (tackler) pstat(st, c.def, tackler.id).ff += 1; pstat(st, c.def, rec.id).fr += 1; }
  c.people.push({ id: tgtP.id, side: c.off, role: 'RECEIVER' }, { id: qb.id, side: c.off, role: 'QB' });
  const oob = !td && !fumble && Math.abs(endY) > 24;
  return { kind: 'pass', yards, text: `${short(qb)} completes to ${short(tgtP)} for ${yd(yards)}${td ? ' and a TOUCHDOWN' : fumble ? `; ${short(tgtP)} FUMBLES and the defense recovers` : tackler ? `, tackled by ${short(tackler)}` : ''}${oob ? ' (out of bounds)' : ''}.`, headline: td ? 'TOUCHDOWN' : fumble ? 'FUMBLE' : yards >= 20 ? 'BIG GAIN' : 'COMPLETE', elapsed: 5 + rng() * 3, stop: td || fumble || oob, td, tackler: tackler?.id, ...(fumble ? { turnover: 'fumble' as const, spot: st.ball + yards } : {}), end: [endX, endY], dur: tEnd + 1 };
}

// ---- run -------------------------------------------------------------------------------------------------------------
function resolveRun(c: Ctx, option: boolean): Outcome {
  const { rng, st } = c;
  const carriers = c.O.map((p, i) => ({ p, i })).filter((x) => ['carry', 'qbopt', 'hold'].includes(c.oa[x.i]!.k) && !(c.oa[x.i]!.k === 'hold' && c.op.play.t === 21));
  const qbI = Math.max(0, c.oa.findIndex((a) => ['qb', 'qbpa', 'qbopt', 'handoff', 'kneel', 'spike'].includes(a.k)));
  const hb = carriers.find((x) => c.oa[x.i]!.k === 'carry') ?? carriers[0];
  const qbKeeps = option && (!hb || rng() < 0.42 + (R(c.O[qbI], 'PSPD') - 80) / 150);
  const carrier = qbKeeps || !hb ? { p: c.O[qbI]!, i: qbI } : hb;
  const cp = carrier.p; const ca = A(c, 'o', carrier.i); const path = c.oa[carrier.i]!.p ?? [[0, 0], [2, 4]];
  const endPt = path[path.length - 1]!; const lateral = (endPt[0] ?? 0) + slotOf(c, 'o', carrier.i).x; const edge = Math.abs(lateral) > 5.5;
  const box = c.D.filter((_, i) => { const s = slotOf(c, 'd', i); return s.y <= 7.5 && Math.abs(s.x) <= 9 && c.da[i]!.k !== 'deep'; });
  const blockers = c.O.filter((_, i) => ['block', 'pblock'].includes(c.oa[i]!.k));
  const blkQ = avg(blockers.map((b) => R(b, 'PRBK'))), defQ = avg(box.map((d) => (R(d, 'PTAK') * 0.4 + R(d, 'PBSH') * 0.35 + R(d, 'PSPD') * 0.25)));
  const stuffP = clamp(0.23 + (box.length - 6) * 0.045 + (defQ - blkQ) / 220 + (edge ? 0.03 : 0), 0.08, 0.55);
  let yards: number; let big = false;
  if (rng() < stuffP) yards = clamp(Math.round(gauss(rng, -1, 2)), -6, 1);
  else {
    const vision = (R(cp, 'PBCV', 70) + R(cp, 'PBTK') + R(cp, 'PAGI')) / 3;
    const base = 3.9 + (blkQ - defQ) / 16 + (6.5 - box.length) * 0.6 + (vision - 70) / 20 + (edge ? 0.5 : 0) + (option ? 0.6 : 0);
    yards = Math.max(1, Math.round(Math.max(0.8, base) * Math.exp(gauss(rng, 0, 0.5))));
    if (rng() < 0.022 + Math.max(0, R(cp, 'PSPD') - 84) / 400 + (box.length < 6 ? 0.02 : 0)) { yards += 10 + Math.round(rng() * 40); big = true; }
  }
  const left = 100 - st.ball; yards = Math.min(yards, left); const td = st.ball + yards >= 100;
  const fumbleP = clamp(0.012 * ((100 - R(cp, 'PCAR')) / 35), 0.003, 0.03); const fumble = !td && rng() < fumbleP;
  // animation: mesh, hole, then the run to the spot
  const qbA = A(c, 'o', qbI); const [qx, qy] = [qbA.path[0]![1]!, qbA.path[0]![2]!]; const underC = qx > -3;
  const meshT = SNAP + (underC ? 0.9 : 0.6); const [cx0, cy0] = [ca.path[0]![1]!, ca.path[0]![2]!];
  if (carrier.i !== qbI) { kf(qbA.path, SNAP, qx, qy); kf(qbA.path, meshT, underC ? -3.5 : qx - 0.5, qy + (cy0 - qy) * 0.5); kf(qbA.path, meshT + 1.2, underC ? -5 : qx - 1.5, qy + (cy0 > qy ? -3 : 3)); c.events.push({ t: meshT, k: 'handoff' }); kf(c.ball, SNAP, qx, qy); kf(c.ball, meshT, underC ? -3.5 : qx - 0.5, qy + (cy0 - qy) * 0.5); }
  else { kf(c.ball, SNAP, qx, qy); }
  kf(ca.path, SNAP, cx0, cy0); const spd = speedYps(cp);
  const holeX = Math.min(yards, Math.max(1, endPt[1] ?? 3)); const tHole = follow(ca.path, path, cx0, cy0, Math.max(SNAP, meshT - 0.3), spd * 0.85, holeX);
  const endX = yards, endY = clamp(lateral + gauss(rng, 0, 2) + (big ? gauss(rng, 0, 6) : 0), -25, 25);
  const tEnd = arrive(ca.path, tHole, endX, endY, spd, tHole + 0.2); for (const p of ca.path) if (p[0]! >= meshT) kf(c.ball, p[0]!, p[1]!, p[2]!);
  blockersMove(c, tEnd, false); defenseBase(c, meshT + 0.6, qx - 2, qy);
  const tk = converge(c, endX, endY, tEnd + 0.1, [], SNAP + 0.3); const tackler = tk[0] !== undefined ? c.D[tk[0]] : undefined;
  const ps = pstat(st, c.off, cp.id); ps.ra += 1; ps.ry += yards; ps.lr = Math.max(ps.lr, yards); st.team[c.off].ra += 1; st.team[c.off].ry += yards; st.team[c.off].yds += yards;
  if (yards > 0) ps.yco += Math.max(0, Math.round(yards - holeX)); if (big || (yards >= 3 && rng() < 0.22 + (R(cp, 'PBTK') - 70) / 200)) ps.bt += 1; if (yards >= 20) ps.r20 += 1;
  if (yards >= 3 && rng() < 0.8) { const line = blockers.filter((b) => b.pos >= 5 && b.pos <= 9); for (let n = rng() < 0.4 ? 2 : 1; n > 0 && line.length; n--) pstat(st, c.off, weighted(rng, line, (b) => R(b, 'PRBK')).id).pk += 1; }
  if (td) ps.rtd += 1; else if (tackler) { const ts = pstat(st, c.def, tackler.id); ts.tk += 1; if (yards < 0) ts.tfl += 1; const helper = tk[1] !== undefined ? c.D[tk[1]] : undefined; if (helper && helper !== tackler && rng() < 0.35) pstat(st, c.def, helper.id).ast += 1; }
  if (fumble) { ps.fum += 1; st.team[c.off].to += 1; const rec = tackler ?? c.D[0]!; if (tackler) pstat(st, c.def, tackler.id).ff += 1; pstat(st, c.def, rec.id).fr += 1; }
  c.people.push({ id: cp.id, side: c.off, role: qbKeeps ? 'QB KEEPER' : 'BALL CARRIER' }); if (tackler && !td) c.people.push({ id: tackler.id, side: c.def, role: 'TACKLE' });
  const oob = !td && !fumble && Math.abs(endY) > 24;
  const verb = option ? (qbKeeps ? 'keeps' : 'pitches to the back who runs') : edge ? 'runs outside' : 'runs up the middle';
  return { kind: option && qbKeeps ? 'scramble' : 'run', yards, text: `${short(cp)} ${option && !qbKeeps ? 'takes the pitch and runs' : verb} for ${yards < 0 ? `a loss of ${yd(-yards)}` : yd(yards)}${td ? ' and a TOUCHDOWN' : fumble ? ' and FUMBLES; the defense recovers' : tackler ? `, brought down by ${short(tackler)}` : ''}${oob ? ' (out of bounds)' : ''}.`, headline: td ? 'TOUCHDOWN' : fumble ? 'FUMBLE' : big ? 'BIG RUN' : yards <= 0 ? 'STUFFED' : 'RUSH', elapsed: 5 + rng() * 3, stop: td || fumble || oob, td, tackler: tackler?.id, ...(fumble ? { turnover: 'fumble' as const, spot: st.ball + yards } : {}), end: [endX, endY], dur: tEnd + 1 };
}

// ---- kicks -------------------------------------------------------------------------------------------------------------
function kickerSlot(c: Ctx, kinds: string[]) { const byPos = c.op.set.slots.findIndex((s, i) => (kinds.includes('punt') ? s.pos === 20 : s.pos === 19 || s.pos === 23) && kinds.includes(c.oa[i]!.k)); if (byPos >= 0) return byPos; const i = c.oa.findIndex((a) => kinds.includes(a.k)); return i >= 0 ? i : 0; }
function resolveFieldGoal(c: Ctx, pat: boolean): Outcome {
  const { rng, st } = c; const ki = kickerSlot(c, ['kick']); const k = c.O[ki]!; const dist = pat ? 20 : 100 - st.ball + 17;
  const blockPlay = c.dp.play.t === 51; const blockP = (pat ? (blockPlay ? 0.02 : 0.005) : blockPlay ? 0.05 : 0.012) + (R(k, 'PKAC') < 60 ? 0.01 : 0); // PATs are rarely blocked (~1%), FGs a little more
  const z = 2.9 - Math.max(0, dist - 25) * 0.12 + (R(k, 'PKAC') - 70) / 20 + (dist > 40 ? (R(k, 'PKPR') - 70) / 40 : 0);
  const blocked = rng() < blockP; const good = !blocked && rng() < (pat ? 0.96 + (R(k, 'PKAC') - 70) / 1000 : sigmoid(z));
  const ka = A(c, 'o', ki); const hi = c.oa.findIndex((a) => a.k === 'hold'); const tKick = SNAP + 1.3;
  kf(c.ball, SNAP, 0, 0); kf(c.ball, SNAP + 0.6, -7, 0); kf(ka.path, SNAP, ka.path[0]![1]!, ka.path[0]![2]!); kf(ka.path, tKick, -6, 0.5); if (hi >= 0) { const ha = A(c, 'o', hi); kf(ha.path, SNAP, ha.path[0]![1]!, ha.path[0]![2]!); kf(ha.path, SNAP + 0.6, -7, 0); }
  // the flight: through the uprights (18'6" apart, +/-3.08 yd), wide to the kicker's left (-y) or right (+y), short, or
  // off an upright and in or out; the uprights stand on the end line, 10 yards past the goal line
  const doink = !blocked && rng() < (good ? 0.015 : 0.1);
  const isShort = !blocked && !good && !doink && rng() < (dist >= 50 ? 0.5 : dist >= 43 ? 0.3 : 0.08);
  const side: 1 | -1 = rng() < 0.5 ? -1 : 1; const sideName = side < 0 ? 'left' : 'right';
  const res: KickFlight['res'] = blocked ? 'blocked' : doink ? 'post' : good ? 'good' : isShort ? 'short' : 'wide';
  const ky = res === 'good' ? round1((rng() * 2 - 1) * 2.2) : res === 'post' ? side * 3.1 : res === 'wide' ? round1(side * (3.8 + rng() * 3.5)) : round1(gauss(rng, 0, res === 'short' ? 1.2 : 2.5));
  const kh = res === 'short' || res === 'blocked' ? 0 : round1(Math.max(3.9, 8.2 - dist * 0.07 + rng() * 1.8)); // yards up at the end line (crossbar 3.33)
  const land = res === 'short' ? round1(2 + rng() * 5) : 0; const post = 100 - st.ball + 10;
  const t1 = round1(tKick + (blocked ? 0.3 : 0.9 + dist * 0.018));
  c.events.push({ t: tKick, k: 'kick' }); kf(c.ball, tKick, -7, 0);
  if (res === 'blocked') { kf(c.ball, t1, -4, ky); kf(c.ball, t1 + 0.7, -2 + round1(rng() * 5), round1(ky * 1.8)); }
  else if (res === 'short') { kf(c.ball, t1, post - land, ky); kf(c.ball, t1 + 0.6, post - land + 2, ky); }
  else { kf(c.ball, t1, post, ky); if (res === 'post') kf(c.ball, t1 + 0.6, good ? post + 2 : post - 4, good ? side * 1.4 : side * 5.5); else kf(c.ball, t1 + 0.55, post + 3, round1(ky * 1.1)); }
  c.events.push({ t: t1, k: res === 'good' ? 'good' : res === 'post' ? (good ? 'doinkin' : 'doink') : res === 'wide' ? `wide${side < 0 ? 'l' : 'r'}` : res });
  c.kick = { t0: tKick, t1, res, y: ky, h: kh, good, ...(land ? { land } : {}) };
  blockersMove(c, tKick + 0.3, true); defenseBase(c, tKick + 0.2, -7, 0);
  const ks = pstat(st, c.off, k.id); if (pat) { ks.xpa += 1; if (good) ks.xpm += 1; if (blocked) ks.xpb += 1; } else { ks.fga += 1; if (good) { ks.fgm += 1; ks.fgl = Math.max(ks.fgl, dist); } if (blocked) ks.fgb += 1;
    if (dist <= 29) { ks.fa29 += 1; if (good) ks.fm29 += 1; } else if (dist <= 39) { ks.fa39 += 1; if (good) ks.fm39 += 1; } else if (dist <= 49) { ks.fa49 += 1; if (good) ks.fm49 += 1; } else { ks.fa50 += 1; if (good) ks.fm50 += 1; } }
  if (blocked) pstat(st, c.def, c.D[Math.floor(rng() * c.D.length)]!.id).blk += 1;
  c.people.push({ id: k.id, side: c.off, role: 'KICKER' });
  const what = pat ? `${short(k)}'s extra point` : `${short(k)}'s ${dist}-yard field goal attempt`;
  const how = res === 'blocked' ? 'is BLOCKED' : res === 'good' ? (pat ? 'is good' : 'is GOOD') : res === 'post' ? `hits the ${sideName} upright and bounces ${good ? `through. ${pat ? 'Good' : 'GOOD'}` : 'out. No good'}` : res === 'wide' ? `is no good, wide ${sideName}` : 'is no good, short';
  const made = pat ? 'EXTRA POINT' : `${dist}-YARD FIELD GOAL`;
  const headline = good ? (res === 'post' ? `DOINK! ${made}` : made) : res === 'blocked' ? (pat ? 'XP BLOCKED' : 'BLOCKED') : `NO GOOD · ${res === 'wide' ? `WIDE ${sideName.toUpperCase()}` : res === 'short' ? 'SHORT' : 'OFF THE UPRIGHT'}`;
  const text = `${what} ${how}.`; const dur = t1 + 1.1;
  if (pat) return { kind: 'xp', yards: 0, text, headline, elapsed: 4, stop: true, pat: good ? 'good' : 'miss', end: [20, 0], dur };
  return { kind: 'fg', yards: 0, text, headline, elapsed: 5, stop: true, dist, turnover: good ? 'fg-good' : 'fg-miss', spot: good ? 35 : blocked ? clamp(100 - st.ball + 8, 1, 99) : dist - 17 > 20 ? 100 - st.ball + 7 : 80, end: [100 - st.ball + 12, 0], dur };
}
function returnRun(c: Ctx, returner: PlayerInput | undefined, ri: number, catchX: number, catchY: number, tCatch: number, meanRet: number, coverage: PlayerInput[]): { yards: number; tEnd: number; endX: number; endY: number; big: boolean } {
  const { rng } = c; const cov = avg(coverage.map((p) => (R(p, 'PSPD') + R(p, 'PTAK')) / 2)); const ret = returner ? (R(returner, 'PSPD') + R(returner, 'PAGI') + R(returner, 'PBTK')) / 3 : 70;
  let yards = Math.max(0, Math.round(meanRet * Math.exp(gauss(rng, 0, 0.45)) + (ret - cov) / 12)); let big = false;
  if (rng() < 0.025 + Math.max(0, ret - 85) / 400) { yards += 25 + Math.round(rng() * 60); big = true; }
  const endX = catchX - yards; const endY = clamp(catchY + gauss(rng, 0, 7), -25, 25); let tEnd = tCatch + 0.3;
  if (returner) { const ra = A(c, 'd', ri); tEnd = arrive(ra.path, tCatch, endX, endY, speedYps(returner), tCatch + 0.4); }
  return { yards, tEnd, endX, endY, big };
}
function resolvePunt(c: Ctx): Outcome {
  const { rng, st } = c; const pi = kickerSlot(c, ['punt']); const p = c.O[pi]!;
  const blockPlay = c.dp.play.n.toLowerCase().includes('block'); const maxProt = c.op.set.n.toLowerCase().includes('max');
  const blocked = rng() < (blockPlay ? 0.06 : 0.012) * (maxProt ? 0.4 : 1);
  const pa = A(c, 'o', pi); kf(pa.path, SNAP, pa.path[0]![1]!, pa.path[0]![2]!); const tKick = SNAP + 1.5; kf(pa.path, tKick, -12.5, 0.5); kf(c.ball, SNAP, 0, 0); kf(c.ball, SNAP + 0.7, -13, 0); kf(c.ball, tKick, -13, 0); c.events.push({ t: tKick, k: 'punt' });
  blockersMove(c, tKick + 0.5, true); defenseBase(c, tKick, -13, 0);
  const ps = pstat(st, c.off, p.id); ps.pt += 1; c.people.push({ id: p.id, side: c.off, role: 'PUNTER' });
  if (blocked) { ps.pbl += 1; pstat(st, c.def, c.D[Math.floor(rng() * c.D.length)]!.id).blk += 1; const spot = clamp(st.ball - 8 + Math.round(rng() * 6), 1, 99); kf(c.ball, tKick + 0.3, -9, gauss(rng, 0, 2)); kf(c.ball, tKick + 1.2, spot - st.ball, gauss(rng, 0, 4)); return { kind: 'punt', yards: 0, text: `${short(p)}'s punt is BLOCKED! The defense takes over at the ${spot < 50 ? `${c.offTeam.abbr} ${spot}` : `${c.defTeam.abbr} ${100 - spot}`}.`, headline: 'PUNT BLOCKED', elapsed: 6, stop: true, turnover: 'punt', spot: 100 - spot, end: [spot - st.ball, 0], dur: tKick + 2 }; }
  const dist = clamp(Math.round(38 + (R(p, 'PKPR') - 60) / 3.5 + gauss(rng, 0, 5)), 22, 72); const hang = 3.8 + (R(p, 'PKPR') - 60) / 60 + gauss(rng, 0, 0.3);
  ps.pty += dist; ps.plong = Math.max(ps.plong, dist); const land = st.ball + dist; const ri = c.da.findIndex((a) => a.k === 'ret'); const returner = ri >= 0 ? c.D[ri] : undefined;
  if (land >= 100) { ps.ptb += 1; ps.pnet += dist - 20; kf(c.ball, tKick + hang, 100 - st.ball + 5, gauss(rng, 0, 8)); return { kind: 'punt', yards: 0, text: `${short(p)} punts ${dist} yards into the end zone; touchback.`, headline: 'PUNT', elapsed: 7, stop: true, turnover: 'punt', spot: 20, touchback: true, end: [100 - st.ball, 0], dur: tKick + hang + 0.5 }; }
  const catchX = dist, catchY = gauss(rng, 0, 9); kf(c.ball, tKick + hang, catchX, catchY);
  const fair = !returner || land >= 90 || rng() < 0.32 + (hang - 4) * 0.25;
  if (returner) { const ra = A(c, 'd', ri); kf(ra.path, SNAP, ra.path[0]![1]!, ra.path[0]![2]!); kf(ra.path, tKick + hang, catchX, catchY); }
  if (fair) { ps.pnet += dist; if (land >= 80) ps.p20 += 1; c.events.push({ t: tKick + hang, k: 'faircatch' }); return { kind: 'punt', yards: 0, text: `${short(p)} punts ${dist} yards${returner ? `, fair catch by ${short(returner)}` : ''} at the ${land < 50 ? `${c.offTeam.abbr} ${land}` : `${c.defTeam.abbr} ${100 - land}`}.`, headline: 'PUNT', elapsed: 7, stop: true, turnover: 'punt', spot: 100 - land, end: [catchX, catchY], dur: tKick + hang + 0.6 }; }
  const coverage = c.O.filter((_, i) => ['cover', 'pblock', 'block', 'move'].includes(c.oa[i]!.k));
  const r = returnRun(c, returner, ri, catchX, catchY, tKick + hang, 7, coverage); c.events.push({ t: tKick + hang, k: 'catch' });
  for (const kp of A(c, 'd', ri).path) if (kp[0]! > tKick + hang) kf(c.ball, kp[0]!, kp[1]!, kp[2]!);
  c.O.forEach((pp, i) => { const a = A(c, 'o', i); if (c.oa[i]!.k === 'punt') return; const l = last(a.path); arrive(a.path, r.tEnd, r.endX + gauss(rng, 0, 2), r.endY + gauss(rng, 0, 3), speedYps(pp) * 0.9, Math.max(r.tEnd, l[0]! + 0.2)); });
  const rs = pstat(st, c.def, returner!.id); rs.pr += 1; rs.pry += r.yards; rs.prl = Math.max(rs.prl, r.yards); const spot = land - r.yards; const td = spot <= 0; if (td) rs.prtd += 1; const muff = !td && rng() < 0.012;
  ps.pnet += muff ? dist : dist - r.yards; if (!td && (muff ? land : spot) >= 80) ps.p20 += 1;
  c.people.push({ id: returner!.id, side: c.def, role: 'RETURNER' });
  if (muff) { ps.pty -= 0; return { kind: 'punt', yards: 0, text: `${short(p)} punts ${dist} yards; ${short(returner)} MUFFS the return and the kicking team recovers!`, headline: 'MUFFED PUNT', elapsed: 8, stop: true, spot: clamp(land, 1, 99), turnover: 'kick', end: [r.endX, r.endY], dur: r.tEnd + 1 }; }
  return { kind: 'punt', yards: 0, text: `${short(p)} punts ${dist} yards, returned ${yd(r.yards)} by ${short(returner)}${td ? ' for a TOUCHDOWN' : ''}.`, headline: td ? 'PUNT RETURN TD' : r.big ? 'BIG RETURN' : 'PUNT', elapsed: 8 + rng() * 3, stop: true, turnover: 'punt', spot: clamp(100 - spot, 0, 100), td, ret: r.yards, end: [r.endX, r.endY], dur: r.tEnd + 1 };
}
function resolveKickoff(c: Ctx): Outcome {
  const { rng, st } = c; const ki = kickerSlot(c, ['kick']); const k = c.O[ki]!; const name = c.op.play.n.toLowerCase();
  const onside = name.includes('onside') || c.op.set.n === 'NCAA'; const squib = name.includes('squib'); const hands = c.da.some((a) => a.k === 'recover');
  const ka = A(c, 'o', ki); kf(ka.path, SNAP, ka.path[0]![1]!, ka.path[0]![2]!); const tKick = SNAP + 1.4; kf(ka.path, tKick, 0, 0); c.events.push({ t: tKick, k: 'kick' }); kf(c.ball, tKick, 0, 0);
  const ks = pstat(st, c.off, k.id); ks.ko += 1; c.people.push({ id: k.id, side: c.off, role: 'KICKER' });
  const from = st.freeKick ? 20 : 35;
  if (onside) {
    const rec = rng() < (hands ? 0.1 : 0.24); const spot = from + 10 + Math.round(rng() * 5); kf(c.ball, tKick + 1.2, spot - from, gauss(rng, 8, 4));
    c.O.forEach((p, i) => { const a = A(c, 'o', i); kf(a.path, SNAP, a.path[0]![1]!, a.path[0]![2]!); arrive(a.path, tKick + 1.6, spot - from + gauss(rng, 0, 2), gauss(rng, 8, 4), speedYps(p)); }); c.D.forEach((p, i) => { const a = A(c, 'd', i); kf(a.path, SNAP, a.path[0]![1]!, a.path[0]![2]!); arrive(a.path, tKick + 1.5, spot - from + gauss(rng, 0, 2), gauss(rng, 8, 4), speedYps(p)); });
    return { kind: 'kickoff', yards: 0, text: `Onside kick by ${short(k)}: ${rec ? `recovered by the kicking team at the ${spot}!` : 'the receiving team recovers.'}`, headline: rec ? 'ONSIDE RECOVERED' : 'ONSIDE KICK', elapsed: 4, stop: true, turnover: 'kick', spot: rec ? spot : 100 - spot, onsideRecovered: rec, end: [spot - from, 8], dur: tKick + 2 };
  }
  const dist = squib ? 42 + Math.round(gauss(rng, 0, 5)) : clamp(Math.round(62 + (R(k, 'PKPR') - 70) / 2.5 + gauss(rng, 0, 4)), 40, 75); const land = from + dist;
  const ri = c.da.findIndex((a) => a.k === 'ret'); const returner = ri >= 0 ? c.D[ri] : c.D[0]; const catchX = Math.min(dist, 100 - from + 5), catchY = gauss(rng, 0, 6); const hang = squib ? 2.2 : 3.9;
  kf(c.ball, tKick + hang, catchX, catchY);
  c.O.forEach((p, i) => { if (i === ki) return; const a = A(c, 'o', i); kf(a.path, SNAP, a.path[0]![1]!, a.path[0]![2]!); });
  if (land >= 100 && !squib && rng() < 0.65) { ks.kotb += 1; c.O.forEach((p, i) => { if (i === ki) return; arrive(A(c, 'o', i).path, tKick + hang, catchX - 10 + gauss(rng, 0, 3), gauss(rng, 0, 10), speedYps(p) * 0.9); }); return { kind: 'kickoff', yards: 0, text: `${short(k)} kicks it through the end zone; touchback.`, headline: 'KICKOFF', elapsed: 4, stop: true, turnover: 'kick', spot: 25, touchback: true, end: [catchX, catchY], dur: tKick + hang + 0.5 }; }
  const ra = A(c, 'd', ri >= 0 ? ri : 0); kf(ra.path, SNAP, ra.path[0]![1]!, ra.path[0]![2]!); kf(ra.path, tKick + hang, catchX, catchY); c.events.push({ t: tKick + hang, k: 'catch' });
  const coverage = c.O.filter((_, i) => i !== ki);
  const r = returnRun(c, returner, ri >= 0 ? ri : 0, catchX, catchY, tKick + hang, squib ? 12 : 21, coverage);
  for (const kp of ra.path) if (kp[0]! > tKick + hang) kf(c.ball, kp[0]!, kp[1]!, kp[2]!);
  c.O.forEach((p, i) => { if (i === ki) return; const a = A(c, 'o', i); arrive(a.path, r.tEnd, r.endX + gauss(rng, 0, 2), r.endY + gauss(rng, 0, 3), speedYps(p) * 0.92, r.tEnd); });
  c.D.forEach((p, i) => { if (i === (ri >= 0 ? ri : 0)) return; const a = A(c, 'd', i); kf(a.path, SNAP, a.path[0]![1]!, a.path[0]![2]!); arrive(a.path, r.tEnd, r.endX + 4 + gauss(rng, 0, 3), r.endY + gauss(rng, 0, 4), speedYps(p) * 0.8, r.tEnd); });
  const spotFromKicker = Math.min(land, 100 + from) - r.yards; // yards from the kicking team's goal line
  const recvSpot = clamp(100 - (from + catchX - r.yards), 0, 100); const td = recvSpot >= 100;
  const rs = pstat(st, c.def, returner!.id); rs.kr += 1; rs.kry += r.yards; rs.krl = Math.max(rs.krl, r.yards); if (td) rs.krtd += 1;
  c.people.push({ id: returner!.id, side: c.def, role: 'RETURNER' });
  void spotFromKicker;
  return { kind: 'kickoff', yards: 0, text: `${short(k)} kicks off ${dist} yards; ${short(returner)} returns it ${yd(r.yards)}${td ? ' for a TOUCHDOWN' : ''}.`, headline: td ? 'KICK RETURN TD' : r.big ? 'BIG RETURN' : 'KICKOFF', elapsed: 6 + rng() * 3, stop: true, turnover: 'kick', spot: recvSpot, td, ret: r.yards, end: [r.endX, r.endY], dur: r.tEnd + 1 };
}
function resolveKneel(c: Ctx): Outcome { const qb = c.O[0]!; const a = A(c, 'o', 0); kf(a.path, SNAP, a.path[0]![1]!, a.path[0]![2]!); kf(a.path, SNAP + 0.8, -1.5, a.path[0]![2]!); for (const p of a.path) kf(c.ball, p[0]!, p[1]!, p[2]!); blockersMove(c, SNAP + 0.8, true); defenseBase(c, SNAP + 0.8, -1, 0); c.people.push({ id: qb.id, side: c.off, role: 'QB' }); const ps = pstat(c.st, c.off, qb.id); ps.ra += 1; ps.ry -= 1; c.st.team[c.off].ra += 1; c.st.team[c.off].ry -= 1; c.st.team[c.off].yds -= 1; return { kind: 'kneel', yards: -1, text: `${short(qb)} takes a knee.`, headline: 'KNEEL', elapsed: 3, stop: false, end: [-1.5, 0], dur: SNAP + 1.5 }; }
function resolveSpike(c: Ctx): Outcome { const qb = c.O[0]!; const a = A(c, 'o', 0); kf(a.path, SNAP, a.path[0]![1]!, a.path[0]![2]!); kf(a.path, SNAP + 0.3, -0.5, a.path[0]![2]!); kf(c.ball, SNAP + 0.3, -1, 0); blockersMove(c, SNAP + 0.5, true); defenseBase(c, SNAP + 0.5, -1, 0); const ps = pstat(c.st, c.off, qb.id); ps.pa += 1; c.st.team[c.off].pa += 1; c.people.push({ id: qb.id, side: c.off, role: 'QB' }); return { kind: 'incomplete', yards: 0, text: `${short(qb)} spikes the ball to stop the clock.`, headline: 'SPIKE', elapsed: 1, stop: true, end: [-1, 0], dur: SNAP + 1 }; }

// ---- penalties (light touch) --------------------------------------------------------------------------------------------
function penalty(c: Ctx, family: string): Outcome | null {
  const { rng, st } = c; if (family === 'kneel' || family === 'spike' || family === 'kickoff' || rng() > 0.045) return null;
  const r = rng();
  const hold = (side: Side, text: string, yards: number, autoFirst = false) => { st.team[side].pen += 1; st.team[side].peny += Math.abs(yards); return { kind: 'penalty', yards, text, headline: 'PENALTY', elapsed: 2, stop: true, replay: true, autoFirst, penalty: text, end: [0, 0], dur: 1 } as Outcome; };
  if (r < 0.35) return hold(c.off, `False start on ${c.offTeam.abbr}: 5-yard penalty, replay the down.`, -Math.min(5, st.ball - 1));
  if (r < 0.6) return hold(c.off, `Holding on ${c.offTeam.abbr}: 10-yard penalty, replay the down.`, -Math.min(10, st.ball - 1));
  if (r < 0.85) return hold(c.def, `Offside on ${c.defTeam.abbr}: 5-yard penalty, replay the down.`, Math.min(5, 99 - st.ball));
  if (family === 'pass') return hold(c.def, `Pass interference on ${c.defTeam.abbr}: 15 yards and an automatic first down.`, Math.min(15, 99 - st.ball), true);
  return hold(c.def, `Facemask on ${c.defTeam.abbr}: 15 yards and an automatic first down.`, Math.min(15, 99 - st.ball), true);
}

// ---- game flow -------------------------------------------------------------------------------------------------------------
// 40-second play clock: when the game clock is running between plays, the offense snaps with this much of it left
const PLAY_CLOCK = 40;
const PC_LEFT: Record<GameState['tempo'], [number, number]> = { normal: [8, 16], hurry: [24, 30], chew: [0, 3] };
function startDrive(st: GameState, off: Side, spot: number, startQ = st.q) { st.off = off; st.ball = clamp(spot, 1, 99); st.down = 1; st.toGo = Math.min(10, 100 - st.ball); st.phase = 'snap'; st.drives.push({ off, q: startQ, start: st.ball, plays: 0, yds: 0, time: 0, result: 'in progress' }); }
function endDrive(st: GameState, result: string) { const d = st.drives[st.drives.length - 1]; if (d && d.result === 'in progress') { d.result = result; d.end = st.ball; } }
function kickoffNext(st: GameState, kicking: Side, freeKick = false) { endDrive(st, st.drives[st.drives.length - 1]?.result ?? 'end'); st.phase = 'kickoff'; st.kicking = kicking; st.off = (1 - kicking) as Side; st.ball = freeKick ? 20 : 35; st.freeKick = freeKick; st.running = false; st.down = 1; st.toGo = 10; }
function otPossession(st: GameState, off: Side) { st.ot!.possessions += 1; startDrive(st, off, 75); st.running = false; }
function finish(st: GameState) { st.phase = 'final'; st.final = true; st.winner = st.score[0] === st.score[1] ? null : st.score[0] > st.score[1] ? 0 : 1; endDrive(st, 'end of game'); }
function quarterEnd(st: GameState, input: GameInput): boolean {
  if (st.clock > 0 || st.ot) return false;
  if (st.q === 4) { if (st.score[0] !== st.score[1]) { finish(st); return true; } st.ot = { period: 1, first: st.opened, possessions: 0 }; st.q = 5; st.clock = 0; endDrive(st, 'end of regulation'); otPossession(st, (1 - st.opened) as Side); return true; }
  st.q += 1; st.clock = input.quarterSeconds; st.running = false;
  if (st.q === 3) { kickoffNext(st, st.h2 !== undefined ? ((1 - st.h2) as Side) : st.opened); st.to = [3, 3]; return true; } // the coin-toss choice decides the second-half receiver
  return false;
}
function afterScore(st: GameState, scorer: Side, kind: 'td' | 'fg' | 'safety' | 'pat') {
  if (st.ot) {
    const o = st.ot; const otherHad = o.possessions % 2 === 0; // after this possession ends, has the other team gone in this period?
    if (!otherHad) { otPossession(st, (1 - st.off) as Side); return; }
    if (st.score[0] !== st.score[1]) { finish(st); return; }
    o.period += 1; st.q += 1; o.first = (1 - o.first) as Side; otPossession(st, o.first); return;
  }
  if (kind === 'safety') kickoffNext(st, (1 - scorer) as Side, true); else kickoffNext(st, scorer);
}
// one possession ends in OT without points (turnover, downs, missed FG)
function otTurnover(st: GameState) { const o = st.ot!; if (o.possessions % 2 === 1) { otPossession(st, (1 - st.off) as Side); return; } if (st.score[0] !== st.score[1]) { finish(st); return; } o.period += 1; st.q += 1; o.first = (1 - o.first) as Side; otPossession(st, o.first); }

export function runPlay(st: GameState, input: GameInput, books: { off: Book; def: Book }, calls: { off: number; def: number }, rng: Rng, tempo: GameState['tempo'] = st.tempo): PlayDetail {
  if (st.final) throw Object.assign(new Error('The game is over.'), { status: 409 });
  if (st.phase === 'toss') throw Object.assign(new Error('Call the coin toss first.'), { status: 409 });
  st.tempo = tempo; st.team = [{ ...emptyT(), ...st.team[0] }, { ...emptyT(), ...st.team[1] }];
  const c = mkCtx(st, input, books, calls, rng);
  const family = playFamily(c.offBook, c.op.play, c.op.form);
  const phase = st.phase; const before = { q: st.q, clock: st.clock, ball: st.ball, down: st.down, toGo: st.toGo, off: st.off, score: [...st.score] as [number, number] };
  // phase gates
  if (phase === 'kickoff' && family !== 'kickoff') throw Object.assign(new Error('A kickoff play is required.'), { status: 400 });
  if (phase !== 'kickoff' && family === 'kickoff') throw Object.assign(new Error('Kickoff plays are only for kickoffs.'), { status: 400 });
  if (phase === 'pat' && (family === 'punt' || family === 'kneel' || family === 'spike')) throw Object.assign(new Error('Choose a kick or a two-point play.'), { status: 400 });
  // clock runoff between plays when the previous play ended with the clock running
  const [pcLo, pcHi] = PC_LEFT[tempo]; const pcLeft = pcLo + Math.round(rng() * (pcHi - pcLo));
  if (phase === 'snap' && st.running && !st.ot) { const run = Math.min(st.clock, PLAY_CLOCK - pcLeft); st.clock -= run; const d = st.drives[st.drives.length - 1]; if (d) d.time += run; st.team[st.off].top += run; }
  const snapClock = st.clock;
  if (phase === 'snap' && st.clock <= 0 && !st.ot) {
    quarterEnd(st, input);
    if (st.phase !== 'snap' || st.final) { // halftime, overtime or the final: the play never happened
      st.n += 1; const text = st.final ? 'Time expires before the snap. That is the ball game.' : st.ot ? 'Time expires before the snap. Overtime.' : 'Time expires before the snap. Halftime.';
      const anim: Anim = { dur: 1, los: c.off === 0 ? before.ball : 100 - before.ball, fd: c.off === 0 ? before.ball : 100 - before.ball, off: c.off, dir: c.off === 0 ? 1 : -1, actors: c.actors, ball: [[0, 0, 0]], events: [], end: [0, 0] };
      const detail: PlayDetail = { n: st.n, headline: st.final ? 'FINAL' : st.ot ? 'OVERTIME' : 'HALFTIME', text, kind: 'clock', yards: 0, off: c.off, offPlay: { id: c.op.play.id, n: c.op.play.n, set: c.op.set.n, form: c.op.form.n }, defPlay: { id: c.dp.play.id, n: c.dp.play.n, set: c.dp.set.n, form: c.dp.form.n }, anim, score: [...st.score] as [number, number], q: st.q, clock: st.clock, drive: st.drives[st.drives.length - 1], people: [] };
      st.log.push({ n: st.n, q: before.q, clk: before.clock, off: c.off, ball: before.ball, d: 0, tg: 0, op: 0, dp: 0, k: 'clock', y: 0, s: [...st.score] as [number, number], t: text }); st.last = detail; return detail;
    }
  }
  let o: Outcome | null = phase === 'snap' ? penalty(c, family) : null;
  if (!o) {
    if (phase === 'kickoff') o = resolveKickoff(c);
    else if (phase === 'pat') {
      if (family === 'fg') o = resolveFieldGoal(c, true);
      else { // two-point try: not a touchdown and no yards or turnovers in the box score, only a conversion attempt
        const save = st.ball, snap = JSON.stringify([st.stats, st.team]); st.ball = 97; o = family === 'pass' ? resolvePass(c) : resolveRun(c, family === 'option'); st.ball = save;
        const good = !!o.td; o.pat = good ? 'two-good' : 'two-miss'; o.td = false; [st.stats, st.team] = JSON.parse(snap);
        const team = st.team[st.patTeam ?? c.off]; team.tp2a += 1; if (good) team.tp2c += 1;
        const pid = (r: string) => c.people.find((p) => p.role === r)?.id;
        if (good) { const rec = pid('RECEIVER'), qb = pid('QB'), car = pid('BALL CARRIER') ?? pid('QB KEEPER'); if (o.kind === 'pass' && rec !== undefined) { pstat(st, c.off, rec).tc2 += 1; if (qb !== undefined) pstat(st, c.off, qb).tp2 += 1; } else if (car !== undefined) pstat(st, c.off, car).tr2 += 1; else if (qb !== undefined) pstat(st, c.off, qb).tr2 += 1; }
      }
    }
    else if (family === 'fg') o = resolveFieldGoal(c, false);
    else if (family === 'punt') o = resolvePunt(c);
    else if (family === 'kneel') o = resolveKneel(c);
    else if (family === 'spike') o = resolveSpike(c);
    else if (family === 'pass') o = resolvePass(c);
    else o = resolveRun(c, family === 'option');
  }
  // bookkeeping
  st.n += 1; const off = c.off, def = c.def; const T = st.team[off]; let scoring: string | undefined; let driveNote: Drive | undefined;
  const scoreTd = (side: Side) => { st.score[side] += 6; };
  const elapsed = Math.min(st.clock, Math.round(o.elapsed));
  if (!st.ot && phase !== 'pat') { st.clock -= elapsed; const d = st.drives[st.drives.length - 1]; if (d && phase === 'snap') { d.time += elapsed; st.team[off].top += elapsed; } }
  // scoring summary rows (console SCOS); the PAT result is filled in by the try that follows
  const who = (r: string) => c.people.find((p) => p.role === r)?.id ?? -1;
  const addScore = (side: Side, type: number, y: number, ti: number, fi: number, drv?: Drive) => { (st.sc ??= []).push({ side, q: before.q, clk: Math.max(0, st.clock), type, y: Math.max(0, Math.round(y)), ti, fi, pi: -1, pf: -1, pt: 16, sc: drv ? (drv.start <= 50 ? -drv.start : 100 - drv.start) : 0, de: drv?.time ?? 0, dp: drv?.plays ?? 0 }); };
  if (phase === 'kickoff') {
    st.freeKick = false;
    if (o.onsideRecovered) { startDrive(st, off, o.spot!); }
    else if (o.td) { scoreTd(def); scoring = `${c.defTeam.abbr} kick return touchdown`; addScore(def, 6, o.ret ?? 0, who('RETURNER'), -1); endDrive(st, 'kickoff'); st.phase = 'pat'; st.off = def; st.patTeam = def; }
    else startDrive(st, def, o.spot!);
    st.running = false;
  } else if (phase === 'pat') {
    const team = st.patTeam ?? off;
    const ev = st.sc?.slice().reverse().find((e) => e.side === team && e.type !== 5);
    if (ev && ev.pt === 16) { if (family === 'fg') { ev.pt = o.pat === 'good' ? 14 : 11; ev.pi = who('KICKER'); } else { ev.pt = o.pat === 'two-good' ? 15 : 12; const rec = who('RECEIVER'); if (o.kind === 'pass' && rec >= 0) { ev.pi = rec; ev.pf = who('QB'); } else ev.pi = [who('BALL CARRIER'), who('QB KEEPER'), who('QB')].find((x) => x >= 0) ?? -1; } }
    if (o.pat === 'good') { st.score[team] += 1; scoring = `${input.teams[team].abbr} extra point`; } else if (o.pat === 'two-good') { st.score[team] += 2; scoring = `${input.teams[team].abbr} two-point conversion`; }
    afterScore(st, team, 'pat');
  } else if (o.replay) {
    st.ball = clamp(st.ball + o.yards, 1, 99); if (o.autoFirst) { st.down = 1; st.toGo = Math.min(10, 100 - st.ball); } else st.toGo = Math.max(1, st.toGo - o.yards); st.running = false;
  } else {
    T.plays += 1; const d = st.drives[st.drives.length - 1]; if (d) { d.plays += 1; d.yds += o.yards; }
    if (d && !d.rz && before.ball >= 80) { d.rz = true; T.rz += 1; }
    if (st.down === 3) { T.t3a += 1; if (o.yards >= st.toGo && !o.turnover) T.t3c += 1; } if (st.down === 4 && family !== 'punt' && family !== 'fg') { T.t4a += 1; if (o.yards >= st.toGo && !o.turnover) T.t4c += 1; }
    if (o.td) {
      scoreTd(off); scoring = `${c.offTeam.abbr} touchdown`; if (d?.rz) T.rztd += 1;
      if (o.kind === 'pass') { T.ptd += 1; addScore(off, 0, o.yards, who('RECEIVER'), who('QB'), d); } else { T.rtd += 1; addScore(off, 1, o.yards, [who('BALL CARRIER'), who('QB KEEPER'), who('QB')].find((x) => x >= 0) ?? -1, -1, d); }
      endDrive(st, 'touchdown'); st.ball = 100; st.phase = 'pat'; st.patTeam = off; st.running = false;
    } else if (o.turnover === 'int' || o.turnover === 'fumble') {
      const spot = clamp(o.spot ?? st.ball + o.yards, 0, 100); endDrive(st, o.turnover === 'int' ? 'interception' : 'fumble');
      if (o.turnover === 'int' && spot <= 0) { scoreTd(def); scoring = `${c.defTeam.abbr} defensive touchdown`; addScore(def, 4, o.ret ?? 0, who('INTERCEPTION'), -1); st.phase = 'pat'; st.patTeam = def; st.off = def; st.ball = 100; }
      else if (st.ot) otTurnover(st); else startDrive(st, def, 100 - spot);
      st.running = false;
    } else if (o.turnover === 'punt' || o.turnover === 'kick') {
      endDrive(st, o.turnover === 'punt' ? 'punt' : 'muffed punt');
      if (o.td) { scoreTd(def); addScore(def, o.turnover === 'punt' ? 7 : 6, o.ret ?? 0, who('RETURNER'), -1); st.phase = 'pat'; st.patTeam = def; st.off = def; }
      else if (o.turnover === 'kick') startDrive(st, off, o.spot!); else startDrive(st, def, o.spot!);
      st.running = false;
    } else if (o.turnover === 'fg-good') {
      st.score[off] += 3; scoring = `${c.offTeam.abbr} field goal`; if (d?.rz) T.rzfg += 1; addScore(off, 5, o.dist ?? 0, who('KICKER'), -1, d); endDrive(st, 'field goal'); st.running = false; afterScore(st, off, 'fg');
    } else if (o.turnover === 'fg-miss') {
      endDrive(st, 'missed field goal'); st.running = false; if (st.ot) otTurnover(st); else startDrive(st, def, clamp(o.spot!, 1, 99));
    } else {
      const newBall = st.ball + o.yards;
      if (newBall <= 0) { // safety
        st.score[def] += 2; scoring = `${c.defTeam.abbr} safety`; if (o.tackler !== undefined) pstat(st, def, o.tackler).sfty += 1; endDrive(st, 'safety'); st.running = false; o.headline = 'SAFETY'; o.text = o.text.replace(/\.$/, '') + ' in the end zone: SAFETY.'; afterScore(st, def, 'safety');
      } else if (o.yards >= st.toGo) { st.ball = newBall; st.down = 1; st.toGo = Math.min(10, 100 - st.ball); T.fd += 1; st.running = !o.stop; if (st.running) st.clock = Math.max(0, st.clock - 4); }
      else if (st.down === 4) { st.ball = newBall; endDrive(st, 'downs'); st.running = false; if (st.ot) otTurnover(st); else startDrive(st, def, 100 - st.ball); }
      else { st.ball = newBall; st.down += 1; st.toGo -= o.yards; st.running = !o.stop; }
    }
  }
  // the quarter (or regulation) ends once the clock is out and no PAT is pending; a kickoff due in a new quarter stays due
  if (!st.final && !st.ot && st.clock <= 0 && (st.phase === 'snap' || st.phase === 'kickoff')) quarterEnd(st, input);
  driveNote = st.drives[st.drives.length - 1]; let detailHeadline = o.headline;
  // the animation script
  const flip = flipFor(before.q); const fl = (x: number) => (flip ? 100 - x : x); // the teams change ends every quarter
  const dir: 1 | -1 = (off === 0) !== flip ? 1 : -1; const losAbs = fl(off === 0 ? before.ball : 100 - before.ball);
  const fdAbs = phase === 'snap' ? fl(off === 0 ? before.ball + before.toGo : 100 - before.ball - before.toGo) : losAbs;
  for (const a of c.actors) { if (a.path.length === 1) { kf(a.path, SNAP, a.path[0]![1]!, a.path[0]![2]!); kf(a.path, o.dur, a.path[0]![1]! + gauss(rng, 0, 0.5), a.path[0]![2]!); } a.path.sort((p, q) => p[0]! - q[0]!); }
  if (!c.ball.length) { kf(c.ball, 0, 0, 0); }
  const anim: Anim = { dur: round1(o.dur + 0.6), los: losAbs, fd: fdAbs, off, dir, actors: c.actors, ball: c.ball, events: c.events, end: o.end, ...(c.kick ? { kick: c.kick } : {}) };
  const text = o.text; const kind = o.kind; if (scoring?.endsWith('safety')) detailHeadline = 'SAFETY';
  const detail: PlayDetail = { n: st.n, headline: detailHeadline, text, kind, yards: o.yards, off, offPlay: { id: c.op.play.id, n: c.op.play.n, set: c.op.set.n, form: c.op.form.n }, defPlay: { id: c.dp.play.id, n: c.dp.play.n, set: c.dp.set.n, form: c.dp.form.n }, anim, score: [...st.score] as [number, number], q: st.q, clock: st.clock, drive: driveNote, scoring, people: c.people, penalty: o.penalty, clk0: before.clock, snap: snapClock, pc: phase === 'snap' ? pcLeft : undefined, pq: before.q, flip };
  const entry: LogEntry = { n: st.n, q: before.q, clk: before.clock, off, ball: before.ball, d: before.down, tg: before.toGo, op: c.op.play.id, dp: c.dp.play.id, k: kind, y: o.yards, s: [...st.score] as [number, number], t: text, p: c.people.slice(0, 3).map((p) => p.id) };
  if (phase !== 'snap') { entry.d = 0; }
  st.log.push(entry); st.last = detail;
  return detail;
}

// Display helpers shared with the browser (also exported for the result builder)
export const spotLabel = (input: GameInput, off: Side, ball: number) => (ball === 50 ? '50' : ball < 50 ? `${input.teams[off].abbr} ${ball}` : `${input.teams[1 - off as Side].abbr} ${100 - ball}`);
