// Supersim coaching engine: one play at a time. The browser sends the two play calls (the member's own and, for the
// other side, the CPU's pick made on the server); scrimmage plays and returns are played out on the field by
// field.ts with fresh randomness, kicks are resolved here, and this updates the game state and returns a play detail
// whose animation is the simulation's recorded movement. Nothing is pre-generated: the next play's outcome does not
// exist until it is called.
import { simulateScrimmage, simulateReturn, type ReturnInput } from './field.js';
import type { Actor, Anim, Assign, Book, Drive, GameInput, GameState, KickFlight, LogEntry, PStat, Play, PlayDetail, PlayerInput, SetDef, Side, Slot, SnapState, TStat, TeamInput, TossChoice } from './types.js';

export const POS = ['QB', 'HB', 'FB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT', 'LE', 'RE', 'DT', 'LLB', 'MLB', 'RLB', 'CB', 'FS', 'SS', 'K', 'P', 'KR', 'PR', 'KO', 'LS'];
export const ENGINE_VERSION = '3.0.0';

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
export const GROUP: Record<number, number[]> = { 0: [0], 1: [1, 2, 21, 22], 2: [2, 1, 4], 3: [3, 21, 22, 1], 4: [4, 2, 5, 9], 5: [5, 9, 6, 8, 7], 6: [6, 8, 7, 5, 9], 7: [7, 6, 8], 8: [8, 6, 7, 9, 5], 9: [9, 5, 8, 6, 7], 10: [10, 11, 12, 15, 13], 11: [11, 10, 12, 13, 15], 12: [12, 10, 11], 13: [13, 15, 14, 18], 14: [14, 13, 15, 18], 15: [15, 13, 14, 18], 16: [16, 17, 18, 3], 17: [17, 18, 16], 18: [18, 17, 16, 14], 19: [19, 20, 23], 20: [20, 19], 21: [21, 22, 3, 1, 16], 22: [22, 21, 3, 16, 1], 23: [23, 19, 20], 24: [24, 7, 4, 6] };
// Fills a set's slots from the depth chart (pos + depth), falling back to the next depth, then the best player at a
// related position; never repeats a player within the eleven. A formation sub set on the site for this set's slot
// (team.fsubs) takes the slot first.
export function lineup(team: TeamInput, set: SetDef, side?: 'o' | 'd'): PlayerInput[] {
  const used = new Set<number>(); const byId = new Map(team.players.map((p) => [p.id, p]));
  const out: PlayerInput[] = [];
  for (const slot of set.slots) {
    let chosen: PlayerInput | undefined;
    const sub = side && team.fsubs ? byId.get(team.fsubs[`${side}:${set.id}:${slot.i}`] ?? -1) : undefined;
    if (sub && !used.has(sub.id)) chosen = sub;
    const chart = team.depthChart.filter((d) => d.pos === slot.pos).sort((a, b) => a.depth - b.depth);
    if (!chosen) for (const d of [...chart.filter((d) => d.depth >= slot.depth), ...chart]) { const p = byId.get(d.pgid); if (p && !used.has(p.id)) { chosen = p; break; } }
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
  const st: GameState = { v: 2, id, seed, n: 0, q: 1, clock: input.quarterSeconds, qs: input.quarterSeconds, score: [0, 0], off: receives, ball: 35, down: 1, toGo: 10, phase: 'kickoff', kicking: (1 - receives) as Side, running: false, to: [3, 3], drives: [], log: [], stats: [{}, {}], team: [emptyT(), emptyT()], usage: {}, opened: receives, ot: null, winner: null, final: false, tempo: 'normal', pc: PLAY_CLOCK_SHORT };
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
  const O = lineup(offTeam, op.set, 'o'), D = lineup(defTeam, dp.set, 'd');
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

// ---- scrimmage plays: played out on the field (field.ts); this turns what happened into the result, stats and text ----
const lane = (y: number) => (y < -8 ? 'around the left end' : y < -3 ? 'off left tackle' : y > 8 ? 'around the right end' : y > 3 ? 'off right tackle' : 'up the middle');
const area = (x: number, y: number) => `${x >= 20 ? 'deep' : x >= 10 ? '' : 'short'} ${y < -8 ? 'left' : y > 8 ? 'right' : 'middle'}`.trim();
function resolveScrimmage(c: Ctx, family: 'pass' | 'run' | 'option'): Outcome {
  const { rng, st } = c;
  const res = simulateScrimmage({ rng, family, sub: PASS_SUB(c.op.play.t), playType: c.op.play.t, O: c.O, D: c.D, oa: c.oa, da: c.da, oSlots: c.op.set.slots, dSlots: c.dp.set.slots, prog: c.op.play.prog, ball: st.ball });
  for (const ag of res.agents) A(c, ag.s, ag.i).path = ag.rec;
  c.ball = [[0, 0, 0], ...res.ball]; c.events.push(...res.events);
  const off = c.off, def = c.def; const qb = res.passer!.p; const T = st.team[off];
  const th = res.pass; const carrier = res.carrier;
  const left = 100 - st.ball;
  const lostFumble = !!res.fumble && res.fumble.rec.s !== res.fumble.by.s && res.fumble.by.s === 'o';
  // a fumble counts the yards to where he lost it; the ball goes over where it was recovered (or the offense keeps it there)
  let yards = clamp(Math.round(res.fumble ? (lostFumble ? res.fumble.at : res.fumble.x) : res.x), -st.ball, left); const td = res.end === 'td' && carrier?.s === 'o';
  if (td) yards = left;
  // the spot is rounded, but a safety needs the ball behind the goal line: downed short of it, the ball is at the 1
  const endAt = res.fumble ? (lostFumble ? res.fumble.at : res.fumble.x) : res.x; if (st.ball + endAt > 0 && st.ball + yards <= 0) yards = 1 - st.ball;
  // a turnover downed in the defense's own end zone is a touchback (the ball comes out to its 20)
  const tbSpot = (spot: number) => (spot >= 100 ? 80 : clamp(spot, 0, 100));
  const fumSpot = () => ({ turnover: 'fumble' as const, spot: tbSpot(st.ball + Math.round(res.fumble!.x)) });
  const sacked = !!res.sackBy && !th && !res.scramble;
  const intercepted = th?.result === 'int';
  const oob = res.end === 'oob';
  const missed = carrier ? res.contacts.filter((k) => k.on === carrier && !k.made) : [];
  const elapsed = Math.max(3, Math.round(res.tEnd - SNAP + 1.2 + rng()));
  const base = { elapsed, end: [res.x, res.y], dur: res.dur };
  // holding: the defense takes the flag when the play went the offense's way
  const h = res.holding;
  if (h && !intercepted && !lostFumble && (yards > 0 || td) && !(th && th.result !== 'catch')) {
    const pen = -Math.min(10, st.ball - 1); st.team[off].pen += 1; st.team[off].peny += -pen;
    const text = `Holding on ${c.offTeam.abbr}, #${h.p.number} ${short(h.p)}: ${td ? 'the touchdown' : `the ${yd(yards)} gain`} comes back. 10-yard penalty, replay the down.`;
    c.people.push({ id: h.p.id, side: off, role: 'FLAG' });
    return { kind: 'penalty', yards: pen, text, headline: 'FLAG: HOLDING', stop: true, replay: true, penalty: text, ...base };
  }
  // ---- tackles, missed tackles, pancakes
  const tk = res.tackler && !td && (res.end === 'tackle' || res.end === 'sack' || res.end === 'fumble') ? res.tackler : null;
  const tackleStats = (lossOk: boolean) => {
    if (!tk) return; const side = tk.s === 'd' ? def : off; const ts = pstat(st, side, tk.p.id); ts.tk += 1; if (lossOk && yards < 0) ts.tfl += 1;
    const helper = res.assists[0]; if (helper) pstat(st, helper.s === 'd' ? def : off, helper.p.id).ast += 1;
  };
  for (const b of res.pancakes) pstat(st, off, b.p.id).pk += 1;
  const brokeText = missed.length ? `, ${missed.length > 1 ? `breaking ${missed.length} tackles` : `shaking off ${short(missed[0]!.by.p)} with a ${missed[0]!.move}`}` : '';
  const tkText = tk && !td ? `, brought down by ${short(tk.p)}${res.assists[0] ? ` and ${short(res.assists[0].p)}` : ''}` : '';
  const fumText = () => { const f = res.fumble!; return `${f.by === carrier || f.by.p.id === qb.id ? ' and FUMBLES' : `; ${short(f.by.p)} FUMBLES`}${f.forced ? ` (forced by ${short(f.forced.p)})` : ''} and ${f.rec.s === f.by.s ? `${short(f.rec.p)} falls on it` : `${short(f.rec.p)} recovers for ${(f.rec.s === 'd' ? c.defTeam : c.offTeam).abbr}`}`; };
  const fumStats = () => { const f = res.fumble; if (!f) return; const by = pstat(st, f.by.s === 'o' ? off : def, f.by.p.id); if (f.rec.s !== f.by.s) { by.fum += 1; if (f.by.s === 'o') T.to += 1; } if (f.forced) pstat(st, f.forced.s === 'd' ? def : off, f.forced.p.id).ff += 1; if (f.rec.s !== f.by.s) pstat(st, f.rec.s === 'd' ? def : off, f.rec.p.id).fr += 1; };
  // ---- sack
  if (sacked) {
    const s = res.sackBy!; const ds = pstat(st, def, s.p.id); ds.sk += 1; ds.tk += 1; ds.tfl += 1; st.team[def].sk += 1;
    pstat(st, off, qb.id).sacked += 1; if (res.beaten) pstat(st, off, res.beaten.p.id).sa += 1;
    c.people.push({ id: s.p.id, side: def, role: 'SACK' }, { id: qb.id, side: off, role: 'QB' });
    fumStats();
    const text = `${short(qb)} is sacked by ${short(s.p)} for ${yards < 0 ? `a loss of ${yd(-yards)}` : 'no gain'}${res.beaten ? `, beating ${short(res.beaten.p)}` : ''}${res.fumble ? fumText() : ''}.`;
    return { kind: 'sack', yards: lostFumble ? 0 : yards, text, headline: lostFumble ? 'STRIP SACK' : 'SACK', stop: lostFumble, tackler: s.p.id, ...(lostFumble ? fumSpot() : {}), ...base };
  }
  // ---- passes
  if (th && !res.scramble) {
    const tgt = th.target.p; const ps = pstat(st, off, qb.id); ps.pa += 1; T.pa += 1;
    if (th.result === 'away') return { kind: 'incomplete', yards: 0, text: `${short(qb)} is flushed and throws it away.`, headline: 'INCOMPLETE', stop: true, ...base };
    pstat(st, off, tgt.id).tgt += 1;
    if (th.result === 'int') {
      const by = th.by!.p; const ds = pstat(st, def, by.id); const ret = Math.max(0, Math.round((res.retFrom ?? res.x) - res.x)); ds.int += 1; ds.iry += ret; ds.lir = Math.max(ds.lir, ret); ps.pi += 1; T.to += 1;
      const spot = st.ball + Math.round(res.x); const ptd = res.end === 'td'; const tb = !ptd && spot >= 100;
      if (ptd) ds.dtd += 1; else if (tk) tackleStats(false);
      c.people.push({ id: by.id, side: def, role: 'INTERCEPTION' }, { id: qb.id, side: off, role: 'QB' }, { id: tgt.id, side: off, role: 'TARGET' });
      const text = `${short(qb)}${th.hurried ? ', under pressure,' : ''} throws ${area(th.cx, th.cy)} for ${short(tgt)}: INTERCEPTED by ${short(by)}${ptd ? ` and returned ${yd(ret)} for a TOUCHDOWN` : tb ? ' in the end zone; touchback' : ret ? `, returned ${yd(ret)}${tkText}` : ''}.`;
      return { kind: 'interception', yards: 0, text, headline: ptd ? 'PICK SIX' : 'INTERCEPTED', stop: true, turnover: 'int', spot: tbSpot(spot), td: ptd, ret, ...base };
    }
    if (th.result !== 'catch') {
      if (th.result === 'drop') pstat(st, off, tgt.id).drp += 1;
      if (th.result === 'pd' && th.by) pstat(st, def, th.by.p.id).pd += 1;
      c.people.push({ id: qb.id, side: off, role: 'QB' }, { id: tgt.id, side: off, role: 'TARGET' }); if (th.by) c.people.push({ id: th.by.p.id, side: def, role: 'BROKEN UP' });
      const why = th.result === 'drop' ? `${short(tgt)} gets both hands on it and DROPS it` : th.result === 'pd' ? `broken up by ${short(th.by!.p)}` : Math.hypot(th.cx - th.target.x, th.cy - th.target.y) > 3 ? (th.cx > th.target.x ? `overthrown${th.hurried ? ' under pressure' : ''}` : 'thrown behind him') : 'incomplete';
      return { kind: 'incomplete', yards: 0, text: `${short(qb)} throws ${area(th.cx, th.cy)} for ${short(tgt)}: ${why}.`, headline: th.result === 'drop' ? 'DROPPED' : th.result === 'pd' ? 'PASS BROKEN UP' : 'INCOMPLETE', stop: true, ...base };
    }
    // complete
    const air = Math.round(th.cx); const yac = yards - air; const rs = pstat(st, off, tgt.id);
    ps.pc += 1; ps.py += yards; ps.lp = Math.max(ps.lp, yards); rs.rec += 1; rs.rey += yards; rs.lc = Math.max(rs.lc, yards); rs.yac += Math.max(0, yac); rs.bt += missed.length;
    T.pc += 1; T.py += yards; T.yds += yards;
    if (td) { ps.ptd += 1; rs.retd += 1; } else tackleStats(true);
    fumStats();
    c.people.push({ id: tgt.id, side: off, role: 'RECEIVER' }, { id: qb.id, side: off, role: 'QB' }); if (tk) c.people.push({ id: tk.p.id, side: def, role: 'TACKLE' });
    const text = `${short(qb)} hits ${short(tgt)} ${area(th.cx, th.cy)} for ${yards < 0 ? `a loss of ${yd(-yards)}` : yards === 0 ? 'no gain' : yd(yards)}${yac >= 6 ? ` (${yac} after the catch)` : ''}${brokeText}${td ? ' and a TOUCHDOWN' : res.fumble ? fumText() : tkText}${oob ? ' (out of bounds)' : ''}.`;
    return { kind: 'pass', yards: lostFumble ? 0 : yards, text, headline: td ? 'TOUCHDOWN' : lostFumble ? 'FUMBLE' : yards >= 20 ? 'BIG GAIN' : 'COMPLETE', stop: td || lostFumble || oob, td, tackler: tk?.p.id, ...(lostFumble ? fumSpot() : {}), ...base };
  }
  // ---- runs, scrambles, option keepers
  const cp = carrier!.p; const ps = pstat(st, off, cp.id); const scramble = res.scramble;
  ps.ra += 1; ps.ry += yards; ps.lr = Math.max(ps.lr, yards); if (yards >= 20) ps.r20 += 1; ps.bt += missed.length;
  if (res.firstContact !== undefined && yards > 0) ps.yco += Math.max(0, Math.round(res.x - Math.max(0, res.firstContact)));
  T.ra += 1; T.ry += yards; T.yds += yards;
  if (td) ps.rtd += 1; else tackleStats(true);
  fumStats();
  const keeper = res.qbKeep && cp.id === qb.id;
  c.people.push({ id: cp.id, side: off, role: scramble ? 'QB' : keeper ? 'QB KEEPER' : 'BALL CARRIER' }); if (tk && !td) c.people.push({ id: tk.p.id, side: def, role: 'TACKLE' }); if (missed[0]) c.people.push({ id: missed[0].by.p.id, side: def, role: 'MISSED TACKLE' });
  const how = scramble ? 'escapes the rush and scrambles' : keeper ? (family === 'option' ? 'reads it, keeps it and runs' : 'keeps it and runs') : res.pitch ? `takes the pitch ${lane(res.y)}` : `runs ${lane(res.y)}`;
  const text = `${short(cp)} ${how}${scramble || keeper || res.pitch ? '' : ''} for ${yards < 0 ? `a loss of ${yd(-yards)}` : yards === 0 ? 'no gain' : yd(yards)}${brokeText}${td ? ' and a TOUCHDOWN' : res.fumble ? fumText() : tkText}${oob ? ' (out of bounds)' : ''}.`;
  return { kind: scramble || (keeper && family === 'option') ? 'scramble' : 'run', yards: lostFumble ? 0 : yards, text, headline: td ? 'TOUCHDOWN' : lostFumble ? 'FUMBLE' : scramble ? 'QB SCRAMBLE' : yards >= 20 ? 'BIG RUN' : yards <= 0 ? 'STUFFED' : missed.length >= 2 ? 'TACKLES BROKEN' : 'RUSH', stop: td || lostFumble || oob, td, tackler: tk?.p.id, ...(lostFumble ? fumSpot() : {}), ...base };
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
// a return played out on the field: coverage in lanes, the return wall, the returner's vision (field.ts)
function playReturn(c: Ctx, kind: 'kickoff' | 'punt', ki: number, ri: number, tKick: number, tCatch: number, cx: number, cy: number, kx: number, own: number, opts: Pick<ReturnInput, 'touchback' | 'fairCatch' | 'deep' | 'muff'> = {}) {
  const res = simulateReturn({ rng: c.rng, kind, K: c.O, R: c.D, ka: c.oa, ra: c.da, kSlots: c.op.set.slots, rSlots: c.dp.set.slots, kicker: ki, returner: ri, tKick, tCatch, cx, cy, kx, own, ...opts });
  for (const ag of res.agents) A(c, ag.s, ag.i).path = ag.rec;
  c.ball = [[0, 0, 0], ...res.ball]; c.events.push(...res.events.filter((e) => e.k !== 'catch' || e.t >= tCatch - 0.01));
  const missed = res.contacts.filter((k) => !k.made && k.on === res.carrier).length;
  const yards = Math.round(cx - res.x); const tk = res.tackler && res.end !== 'td' ? res.tackler : null;
  if (tk) { pstat(c.st, c.off, tk.p.id).tk += 1; const helper = res.assists[0]; if (helper) pstat(c.st, c.off, helper.p.id).ast += 1; }
  if (res.fumble) { const f = res.fumble; if (f.rec.s !== f.by.s) { pstat(c.st, c.def, f.by.p.id).fum += 1; pstat(c.st, c.off, f.rec.p.id).fr += 1; c.st.team[c.def].to += 1; } if (f.forced && !res.muffed) pstat(c.st, c.off, f.forced.p.id).ff += 1; }
  return { res, yards, tk, missed, lost: res.turnover === 'fumble', td: res.end === 'td', oob: res.end === 'oob', endX: res.x, endY: res.y, tEnd: res.tEnd, dur: res.dur };
}
function resolvePunt(c: Ctx): Outcome {
  const { rng, st } = c; const pi = kickerSlot(c, ['punt']); const p = c.O[pi]!;
  const blockPlay = c.dp.play.n.toLowerCase().includes('block'); const maxProt = c.op.set.n.toLowerCase().includes('max');
  const blocked = rng() < (blockPlay ? 0.06 : 0.012) * (maxProt ? 0.4 : 1);
  const pa = A(c, 'o', pi); kf(pa.path, SNAP, pa.path[0]![1]!, pa.path[0]![2]!); const tKick = SNAP + 1.5; kf(pa.path, tKick, -12.5, 0.5); kf(c.ball, SNAP, 0, 0); kf(c.ball, SNAP + 0.7, -13, 0); kf(c.ball, tKick, -13, 0); c.events.push({ t: tKick, k: 'punt' });
  const ps = pstat(st, c.off, p.id); ps.pt += 1; c.people.push({ id: p.id, side: c.off, role: 'PUNTER' });
  if (blocked) { blockersMove(c, tKick + 0.5, true); defenseBase(c, tKick, -13, 0); ps.pbl += 1; pstat(st, c.def, c.D[Math.floor(rng() * c.D.length)]!.id).blk += 1; const spot = clamp(st.ball - 8 + Math.round(rng() * 6), 1, 99); kf(c.ball, tKick + 0.3, -9, gauss(rng, 0, 2)); kf(c.ball, tKick + 1.2, spot - st.ball, gauss(rng, 0, 4)); return { kind: 'punt', yards: 0, text: `${short(p)}'s punt is BLOCKED! The defense takes over at the ${spot < 50 ? `${c.offTeam.abbr} ${spot}` : `${c.defTeam.abbr} ${100 - spot}`}.`, headline: 'PUNT BLOCKED', elapsed: 6, stop: true, turnover: 'punt', spot: 100 - spot, end: [spot - st.ball, 0], dur: tKick + 2 }; }
  const dist = clamp(Math.round(38 + (R(p, 'PKPR') - 60) / 3.5 + gauss(rng, 0, 5)), 22, 72); const hang = 3.8 + (R(p, 'PKPR') - 60) / 60 + gauss(rng, 0, 0.3);
  ps.pty += dist; ps.plong = Math.max(ps.plong, dist); const land = st.ball + dist;
  // the returner: the man the return call sends back for it, else whoever is deepest (he fields it and is downed)
  let ri = c.da.findIndex((a) => a.k === 'ret'); const noRet = ri < 0;
  if (noRet) ri = c.D.reduce((best, _, i) => (A(c, 'd', i).path[0]![1]! > A(c, 'd', best).path[0]![1]! ? i : best), 0);
  const returner = c.D[ri]!; const at = (x: number) => (x < 50 ? `${c.offTeam.abbr} ${x}` : x === 50 ? '50' : `${c.defTeam.abbr} ${100 - x}`);
  // the whole kick is played out (field.ts): the coverage down the field, and what the returner does when it comes down
  const tb = land >= 100; const catchX = tb ? Math.min(dist, 100 - st.ball + 4) : dist, catchY = clamp(gauss(rng, 0, 9), -22, 22);
  const r = playReturn(c, 'punt', pi, ri, tKick, tKick + hang, catchX, catchY, -13, -st.ball, { touchback: tb, fairCatch: noRet ? true : 'auto', deep: land >= 90, muff: noRet ? 0 : 0.012 });
  const end = r.res.end; const elapsed = Math.max(7, Math.round(r.tEnd - SNAP + 1.5));
  if (end === 'touchback') { ps.ptb += 1; ps.pnet += dist - 20; return { kind: 'punt', yards: 0, text: `${short(p)} punts ${dist} yards into the end zone; touchback.`, headline: 'PUNT', elapsed, stop: true, turnover: 'punt', spot: 20, touchback: true, end: [r.endX, r.endY], dur: r.dur }; }
  c.people.push({ id: returner.id, side: c.def, role: 'RETURNER' });
  if (end === 'faircatch') { ps.pnet += dist; if (land >= 80) ps.p20 += 1; return { kind: 'punt', yards: 0, text: `${short(p)} punts ${dist} yards, fair catch by ${short(returner)} at the ${at(land)}.`, headline: 'PUNT', elapsed, stop: true, turnover: 'punt', spot: 100 - land, end: [r.endX, r.endY], dur: r.dur }; }
  if (r.res.muffed) {
    const rec = r.res.fumble!.rec; const spotX = clamp(st.ball + Math.round(r.endX), 1, 99); ps.pnet += dist;
    c.people.push({ id: rec.p.id, side: rec.s === 'o' ? c.off : c.def, role: 'RECOVERY' });
    if (r.lost) return { kind: 'punt', yards: 0, text: `${short(p)} punts ${dist} yards; ${short(returner)} MUFFS it and ${short(rec.p)} recovers for ${c.offTeam.abbr} at the ${at(spotX)}!`, headline: 'MUFFED PUNT', elapsed, stop: true, spot: spotX, turnover: 'kick', end: [r.endX, r.endY], dur: r.dur };
    return { kind: 'punt', yards: 0, text: `${short(p)} punts ${dist} yards; ${short(returner)} MUFFS it, but ${rec.p.id === returner.id ? 'falls on it himself' : `${short(rec.p)} falls on it`} at the ${at(spotX)}.`, headline: 'MUFFED PUNT', elapsed, stop: true, turnover: 'punt', spot: 100 - spotX, end: [r.endX, r.endY], dur: r.dur };
  }
  const rs = pstat(st, c.def, returner.id); rs.pr += 1; rs.pry += r.yards; rs.prl = Math.max(rs.prl, r.yards); if (r.td) rs.prtd += 1;
  const tbp = !r.td && !r.lost && land - r.yards >= 100; const spot = tbp ? 80 : land - r.yards; ps.pnet += tbp ? dist - 20 : dist - r.yards; if (tbp) ps.ptb += 1; else if (!r.td && spot >= 80) ps.p20 += 1;
  if (r.tk) c.people.push({ id: r.tk.p.id, side: c.off, role: 'TACKLE' });
  const tail = r.td ? ' for a TOUCHDOWN' : r.lost ? `, but FUMBLES and the kicking team recovers` : r.tk ? `, brought down by ${short(r.tk.p)}` : r.oob ? ' before stepping out of bounds' : '';
  const text = `${short(p)} punts ${dist} yards, returned ${yd(r.yards)} by ${short(returner)}${r.missed ? ` (${r.missed} missed tackle${r.missed > 1 ? 's' : ''})` : ''}${tail}.`;
  if (r.lost) return { kind: 'punt', yards: 0, text, headline: 'FUMBLE', elapsed, stop: true, spot: clamp(st.ball + Math.round(r.endX), 1, 99), turnover: 'kick', end: [r.endX, r.endY], dur: r.dur };
  return { kind: 'punt', yards: 0, text, headline: r.td ? 'PUNT RETURN TD' : r.yards >= 20 ? 'BIG RETURN' : 'PUNT', elapsed, stop: true, turnover: 'punt', spot: clamp(100 - spot, 0, 100), td: r.td, ret: r.yards, end: [r.endX, r.endY], dur: r.dur };
}
function resolveKickoff(c: Ctx): Outcome {
  const { rng, st } = c; const ki = kickerSlot(c, ['kick']); const k = c.O[ki]!; const name = c.op.play.n.toLowerCase();
  const onside = name.includes('onside') || c.op.set.n === 'NCAA'; const squib = name.includes('squib'); const hands = c.da.some((a) => a.k === 'recover');
  const tKick = SNAP + 1.4;
  const ks = pstat(st, c.off, k.id); ks.ko += 1; c.people.push({ id: k.id, side: c.off, role: 'KICKER' });
  const from = st.freeKick ? 20 : 35;
  if (onside) {
    const ka = A(c, 'o', ki); kf(ka.path, SNAP, ka.path[0]![1]!, ka.path[0]![2]!); kf(ka.path, tKick, 0, 0); c.events.push({ t: tKick, k: 'kick' }); kf(c.ball, tKick, 0, 0);
    const rec = rng() < (hands ? 0.1 : 0.24); const spot = from + 10 + Math.round(rng() * 5); kf(c.ball, tKick + 1.2, spot - from, gauss(rng, 8, 4));
    c.O.forEach((p, i) => { const a = A(c, 'o', i); kf(a.path, SNAP, a.path[0]![1]!, a.path[0]![2]!); arrive(a.path, tKick + 1.6, spot - from + gauss(rng, 0, 2), gauss(rng, 8, 4), speedYps(p)); }); c.D.forEach((p, i) => { const a = A(c, 'd', i); kf(a.path, SNAP, a.path[0]![1]!, a.path[0]![2]!); arrive(a.path, tKick + 1.5, spot - from + gauss(rng, 0, 2), gauss(rng, 8, 4), speedYps(p)); });
    return { kind: 'kickoff', yards: 0, text: `Onside kick by ${short(k)}: ${rec ? `recovered by the kicking team at the ${spot}!` : 'the receiving team recovers.'}`, headline: rec ? 'ONSIDE RECOVERED' : 'ONSIDE KICK', elapsed: 4, stop: true, turnover: 'kick', spot: rec ? spot : 100 - spot, onsideRecovered: rec, end: [spot - from, 8], dur: tKick + 2 };
  }
  const dist = squib ? 42 + Math.round(gauss(rng, 0, 5)) : clamp(Math.round(62 + (R(k, 'PKPR') - 70) / 2.5 + gauss(rng, 0, 4)), 40, 75); const land = from + dist;
  const ri = Math.max(0, c.da.findIndex((a) => a.k === 'ret')); const returner = c.D[ri]!; const catchX = Math.min(dist, 100 - from + 5), catchY = clamp(gauss(rng, 0, 6), -20, 20); const hang = squib ? 2.2 : 3.9;
  if (land >= 100 && !squib && rng() < 0.65) {
    const ka = A(c, 'o', ki); kf(ka.path, SNAP, ka.path[0]![1]!, ka.path[0]![2]!); kf(ka.path, tKick, 0, 0); c.events.push({ t: tKick, k: 'kick' }); kf(c.ball, tKick, 0, 0); kf(c.ball, tKick + hang, catchX, catchY);
    ks.kotb += 1; c.O.forEach((p, i) => { if (i === ki) return; const a = A(c, 'o', i); kf(a.path, SNAP, a.path[0]![1]!, a.path[0]![2]!); arrive(a.path, tKick + hang, catchX - 10 + gauss(rng, 0, 3), gauss(rng, 0, 10), speedYps(p) * 0.9); });
    return { kind: 'kickoff', yards: 0, text: `${short(k)} kicks it through the end zone; touchback.`, headline: 'KICKOFF', elapsed: 4, stop: true, turnover: 'kick', spot: 25, touchback: true, end: [catchX, catchY], dur: tKick + hang + 0.5 };
  }
  c.events.push({ t: tKick, k: 'kick' });
  const r = playReturn(c, 'kickoff', ki, ri, tKick, tKick + hang, catchX, catchY, 0, -from);
  const raw = 100 - (from + Math.round(r.endX)); const tbk = !r.td && raw <= 0; // downed in his own end zone: touchback
  const recvSpot = tbk ? 25 : clamp(raw, 0, 100);
  const rs = pstat(st, c.def, returner.id); rs.kr += 1; rs.kry += r.yards; rs.krl = Math.max(rs.krl, r.yards); if (r.td) rs.krtd += 1;
  c.people.push({ id: returner.id, side: c.def, role: 'RETURNER' }); if (r.tk) c.people.push({ id: r.tk.p.id, side: c.off, role: 'TACKLE' });
  const tail = r.td ? ' for a TOUCHDOWN' : r.lost ? ', but FUMBLES and the kicking team recovers' : tbk ? ', downed in the end zone; touchback' : r.tk ? `, brought down by ${short(r.tk.p)}` : r.oob ? ' before stepping out of bounds' : '';
  const text = `${short(k)} kicks off ${dist} yards; ${short(returner)} returns it ${yd(r.yards)}${r.missed ? ` (${r.missed} missed tackle${r.missed > 1 ? 's' : ''})` : ''}${tail}.`;
  if (r.lost) return { kind: 'kickoff', yards: 0, text, headline: 'FUMBLE', elapsed: 6, stop: true, turnover: 'kick', spot: clamp(from + Math.round(r.endX), 1, 99), onsideRecovered: true, end: [r.endX, r.endY], dur: r.dur };
  return { kind: 'kickoff', yards: 0, text, headline: r.td ? 'KICK RETURN TD' : r.yards >= 35 ? 'BIG RETURN' : 'KICKOFF', elapsed: Math.max(5, Math.round(r.tEnd - tKick + 1)), stop: true, turnover: 'kick', spot: recvSpot, td: r.td || recvSpot >= 100, ret: r.yards, end: [r.endX, r.endY], dur: r.dur };
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
// The play clock: 40 seconds after a play by the same offense, 25 after a stoppage (a score, a change of possession, a
// flag, a timeout, a kick, a new quarter). A CPU offense (and any auto-simmed snap) snaps with PC_LEFT of it showing for
// its tempo; a coached offense snaps when the coach does and the browser reports the reading (routes.ts).
export const PLAY_CLOCK = 40, PLAY_CLOCK_SHORT = 25;
export const PC_LEFT: Record<GameState['tempo'], [number, number]> = { normal: [8, 16], hurry: [24, 30], chew: [0, 3] };
export const rollPlayClock = (rng: Rng, tempo: GameState['tempo'], pc = PLAY_CLOCK) => { const [lo, hi] = PC_LEFT[tempo]; return Math.min(pc, lo + Math.round(rng() * (hi - lo))); };
const snapState = (st: GameState): SnapState => ({ phase: st.phase, off: st.off, kicking: st.kicking, ball: st.ball, down: st.down, toGo: st.toGo, q: st.q, clock: st.clock, score: [st.score[0], st.score[1]], to: [st.to[0], st.to[1]], running: st.running, patTeam: st.patTeam, freeKick: st.freeKick, pc: st.pc, final: st.final });
// a detail with no play in it (time ran out before the snap, a delay of game): the players stay where they are
function stillDetail(st: GameState, off: Side, before: SnapState, headline: string, text: string, kind: string, actors: Actor[] = [], extra: Partial<PlayDetail> = {}): PlayDetail {
  const los = before.phase === 'kickoff' ? 50 : off === 0 ? before.ball : 100 - before.ball;
  const anim: Anim = { dur: 1, los, fd: los, off, dir: off === 0 ? 1 : -1, actors, ball: [[0, 0, 0]], events: [], end: [0, 0] };
  const nothing = { id: 0, n: '—', set: '', form: '' };
  return { n: st.n, headline, text, kind, yards: 0, off, offPlay: nothing, defPlay: nothing, anim, score: [...st.score] as [number, number], q: st.q, clock: st.clock, drive: st.drives[st.drives.length - 1], people: [], clk0: before.clock, snap: st.clock, pq: before.q, flip: flipFor(before.q), pre: before, post: snapState(st), ...extra };
}
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

// The game clock runs through the play clock while the offense is in the huddle (phase snap, clock running). Returns the
// seconds used. pcLeft: the play-clock reading at the snap.
function huddleRunoff(st: GameState, pcLeft: number): number {
  if (st.phase !== 'snap' || !st.running || st.ot) return 0;
  const run = Math.max(0, Math.min(st.clock, (st.pc ?? PLAY_CLOCK) - pcLeft)); st.clock -= run;
  const d = st.drives[st.drives.length - 1]; if (d) d.time += run; st.team[st.off].top += run;
  return run;
}
// the clock ran out in the huddle: halftime, overtime or the final (null when the quarter simply rolled on to the next)
function timeExpired(st: GameState, input: GameInput, off: Side, before: SnapState, actors: Actor[]): PlayDetail | null {
  if (st.phase !== 'snap' || st.clock > 0 || st.ot) return null;
  quarterEnd(st, input);
  if (st.phase === 'snap' && !st.final) return null;
  st.n += 1; st.pc = PLAY_CLOCK_SHORT;
  const text = st.final ? 'Time expires before the snap. That is the ball game.' : st.ot ? 'Time expires before the snap. Overtime.' : 'Time expires before the snap. Halftime.';
  const detail = stillDetail(st, off, before, st.final ? 'FINAL' : st.ot ? 'OVERTIME' : 'HALFTIME', text, 'clock', actors);
  st.log.push({ n: st.n, q: before.q, clk: before.clock, off, ball: before.ball, d: 0, tg: 0, op: 0, dp: 0, k: 'clock', y: 0, s: [...st.score] as [number, number], t: text }); st.last = detail;
  return detail;
}
// The play clock ran out on a coached offense (routes.ts checks the time really passed): the game clock runs through it
// if it was running, and then it is either the end of the period or a delay of game (5 yards, half the distance inside
// the 10, replay the down, clock stopped).
export function expirePlayClock(st: GameState, input: GameInput): PlayDetail {
  if (st.final) throw Object.assign(new Error('The game is over.'), { status: 409 });
  if (st.phase !== 'snap') throw Object.assign(new Error('No play clock to run out.'), { status: 409 });
  st.team = [{ ...emptyT(), ...st.team[0] }, { ...emptyT(), ...st.team[1] }];
  const off = st.off; const before = snapState(st);
  huddleRunoff(st, 0);
  if (st.clock <= 0 && !st.ot) {
    const ended = timeExpired(st, input, off, before, []); if (ended) return ended;
    // the quarter rolled over with the ball still theirs: no flag, the next snap opens the next quarter
    st.n += 1; st.pc = PLAY_CLOCK_SHORT;
    const text = `Time expires in the ${['first', 'second', 'third', 'fourth'][before.q - 1] ?? `${before.q}th`} quarter.`;
    const detail = stillDetail(st, off, before, `END OF Q${before.q}`, text, 'clock');
    st.log.push({ n: st.n, q: before.q, clk: before.clock, off, ball: before.ball, d: 0, tg: 0, op: 0, dp: 0, k: 'clock', y: 0, s: [...st.score] as [number, number], t: text }); st.last = detail;
    return detail;
  }
  const yards = st.ball <= 10 ? Math.max(1, Math.floor(st.ball / 2)) : 5; const goal = before.ball + before.toGo >= 100;
  st.ball -= yards; st.toGo = goal ? 100 - st.ball : st.toGo + yards; st.running = false; st.pc = PLAY_CLOCK_SHORT;
  st.team[off].pen += 1; st.team[off].peny += yards; st.n += 1;
  const text = `Delay of game on ${input.teams[off].abbr}: the play clock ran out. ${yd(yards)} penalty, replay the down.`;
  const detail = stillDetail(st, off, before, 'DELAY OF GAME', text, 'penalty', [], { yards: -yards, penalty: text });
  st.log.push({ n: st.n, q: before.q, clk: before.clock, off, ball: before.ball, d: before.down, tg: before.toGo, op: 0, dp: 0, k: 'penalty', y: -yards, s: [...st.score] as [number, number], t: text }); st.last = detail;
  return detail;
}

export function runPlay(st: GameState, input: GameInput, books: { off: Book; def: Book }, calls: { off: number; def: number }, rng: Rng, tempo: GameState['tempo'] = st.tempo, opts: { pcLeft?: number } = {}): PlayDetail {
  if (st.final) throw Object.assign(new Error('The game is over.'), { status: 409 });
  if (st.phase === 'toss') throw Object.assign(new Error('Call the coin toss first.'), { status: 409 });
  st.tempo = tempo; st.team = [{ ...emptyT(), ...st.team[0] }, { ...emptyT(), ...st.team[1] }];
  const c = mkCtx(st, input, books, calls, rng);
  const family = playFamily(c.offBook, c.op.play, c.op.form);
  const phase = st.phase; const pre = snapState(st); const before = { q: st.q, clock: st.clock, ball: st.ball, down: st.down, toGo: st.toGo, off: st.off, score: [...st.score] as [number, number] };
  // phase gates
  if (phase === 'kickoff' && family !== 'kickoff') throw Object.assign(new Error('A kickoff play is required.'), { status: 400 });
  if (phase !== 'kickoff' && family === 'kickoff') throw Object.assign(new Error('Kickoff plays are only for kickoffs.'), { status: 400 });
  if (phase === 'pat' && (family === 'punt' || family === 'kneel' || family === 'spike')) throw Object.assign(new Error('Choose a kick or a two-point play.'), { status: 400 });
  // clock runoff between plays when the previous play ended with the clock running
  const pcLen = st.pc ?? PLAY_CLOCK; const pcLeft = clamp(Math.round(opts.pcLeft ?? rollPlayClock(rng, tempo, pcLen)), 0, pcLen);
  huddleRunoff(st, pcLeft);
  const snapClock = st.clock;
  const ended = timeExpired(st, input, c.off, pre, c.actors); if (ended) return ended; // halftime, overtime or the final: the play never happened
  // the quarter can roll over in the huddle (first to second, third to fourth): the play then belongs to the new quarter
  const snapQ = st.q; const rolled = snapQ !== before.q; const atSnap = snapState(st);
  let o: Outcome | null = phase === 'snap' ? penalty(c, family) : null;
  if (!o) {
    if (phase === 'kickoff') o = resolveKickoff(c);
    else if (phase === 'pat') {
      if (family === 'fg') o = resolveFieldGoal(c, true);
      else { // two-point try: not a touchdown and no yards or turnovers in the box score, only a conversion attempt
        const save = st.ball, snap = JSON.stringify([st.stats, st.team]); st.ball = 97; o = resolveScrimmage(c, family === 'pass' ? 'pass' : family === 'option' ? 'option' : 'run'); st.ball = save;
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
    else o = resolveScrimmage(c, family === 'pass' ? 'pass' : family === 'option' ? 'option' : 'run');
  }
  // bookkeeping
  st.n += 1; const off = c.off, def = c.def; const T = st.team[off]; let scoring: string | undefined; let driveNote: Drive | undefined;
  const scoreTd = (side: Side) => { st.score[side] += 6; };
  const elapsed = Math.min(st.clock, Math.round(o.elapsed));
  if (!st.ot && phase !== 'pat') { st.clock -= elapsed; const d = st.drives[st.drives.length - 1]; if (d && phase === 'snap') { d.time += elapsed; st.team[off].top += elapsed; } }
  // scoring summary rows (console SCOS); the PAT result is filled in by the try that follows
  const who = (r: string) => c.people.find((p) => p.role === r)?.id ?? -1;
  const addScore = (side: Side, type: number, y: number, ti: number, fi: number, drv?: Drive) => { (st.sc ??= []).push({ side, q: snapQ, clk: Math.max(0, st.clock), type, y: Math.max(0, Math.round(y)), ti, fi, pi: -1, pf: -1, pt: 16, sc: drv ? (drv.start <= 50 ? -drv.start : 100 - drv.start) : 0, de: drv?.time ?? 0, dp: drv?.plays ?? 0 }); };
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
    // a touchdown on a turnover (a pick six, a punt return) is the defense's: those branches come first
    if (o.td && !o.turnover) {
      scoreTd(off); scoring = `${c.offTeam.abbr} touchdown`; if (d?.rz) T.rztd += 1;
      if (o.kind === 'pass') { T.ptd += 1; addScore(off, 0, o.yards, who('RECEIVER'), who('QB'), d); } else { T.rtd += 1; addScore(off, 1, o.yards, [who('BALL CARRIER'), who('QB KEEPER'), who('QB')].find((x) => x >= 0) ?? -1, -1, d); }
      endDrive(st, 'touchdown'); st.ball = 100; st.phase = 'pat'; st.patTeam = off; st.running = false;
    } else if (o.turnover === 'int' || o.turnover === 'fumble') {
      const spot = clamp(o.spot ?? st.ball + o.yards, 0, 100); endDrive(st, o.turnover === 'int' ? 'interception' : 'fumble');
      if (o.td || spot <= 0) { scoreTd(def); scoring = `${c.defTeam.abbr} defensive touchdown`; addScore(def, 4, o.ret ?? 0, o.turnover === 'int' ? who('INTERCEPTION') : who('RECOVERY'), -1); st.phase = 'pat'; st.patTeam = def; st.off = def; st.ball = 100; }
      else if (st.ot) otTurnover(st); else startDrive(st, def, 100 - spot);
      st.running = false;
    } else if (o.turnover === 'punt' || o.turnover === 'kick') {
      endDrive(st, o.turnover === 'punt' ? 'punt' : 'muffed punt');
      if (o.td) { scoreTd(def); scoring = `${c.defTeam.abbr} punt return touchdown`; addScore(def, o.turnover === 'punt' ? 7 : 6, o.ret ?? 0, who('RETURNER'), -1); st.phase = 'pat'; st.patTeam = def; st.off = def; st.ball = 100; }
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
  // the next play clock: the full 40 only when the same offense keeps the ball after an ordinary play
  st.pc = phase === 'snap' && st.phase === 'snap' && st.off === off && !o.replay && !o.turnover && !o.td && !scoring && st.q === snapQ && !st.final ? PLAY_CLOCK : PLAY_CLOCK_SHORT;
  driveNote = st.drives[st.drives.length - 1]; let detailHeadline = o.headline;
  // the animation script
  const flip = flipFor(snapQ); const fl = (x: number) => (flip ? 100 - x : x); // the teams change ends every quarter
  const dir: 1 | -1 = (off === 0) !== flip ? 1 : -1; const losAbs = fl(off === 0 ? before.ball : 100 - before.ball);
  const fdAbs = phase === 'snap' ? fl(off === 0 ? before.ball + before.toGo : 100 - before.ball - before.toGo) : losAbs;
  for (const a of c.actors) { if (a.path.length === 1) { kf(a.path, SNAP, a.path[0]![1]!, a.path[0]![2]!); kf(a.path, o.dur, a.path[0]![1]! + gauss(rng, 0, 0.5), a.path[0]![2]!); } a.path.sort((p, q) => p[0]! - q[0]!); }
  if (!c.ball.length) { kf(c.ball, 0, 0, 0); }
  const anim: Anim = { dur: round1(o.dur + 0.6), los: losAbs, fd: fdAbs, off, dir, actors: c.actors, ball: c.ball, events: c.events, end: o.end, ...(c.kick ? { kick: c.kick } : {}) };
  const text = o.text; const kind = o.kind; if (scoring?.endsWith('safety')) detailHeadline = 'SAFETY';
  const detail: PlayDetail = { n: st.n, headline: detailHeadline, text, kind, yards: o.yards, off, offPlay: { id: c.op.play.id, n: c.op.play.n, set: c.op.set.n, form: c.op.form.n }, defPlay: { id: c.dp.play.id, n: c.dp.play.n, set: c.dp.set.n, form: c.dp.form.n }, anim, score: [...st.score] as [number, number], q: st.q, clock: st.clock, drive: driveNote, scoring, people: c.people, penalty: o.penalty, clk0: rolled ? snapClock : before.clock, snap: snapClock, pc: phase === 'snap' ? pcLeft : undefined, pcLen: phase === 'snap' ? pcLen : undefined, pq: snapQ, flip, pre: atSnap, post: snapState(st) };
  const entry: LogEntry = { n: st.n, q: snapQ, clk: rolled ? snapClock : before.clock, off, ball: before.ball, d: before.down, tg: before.toGo, op: c.op.play.id, dp: c.dp.play.id, k: kind, y: o.yards, s: [...st.score] as [number, number], t: text, p: c.people.slice(0, 3).map((p) => p.id) };
  if (phase !== 'snap') { entry.d = 0; }
  st.log.push(entry); st.last = detail;
  return detail;
}

// Display helpers shared with the browser (also exported for the result builder)
export const spotLabel = (input: GameInput, off: Side, ball: number) => (ball === 50 ? '50' : ball < 50 ? `${input.teams[off].abbr} ${ball}` : `${input.teams[1 - off as Side].abbr} ${100 - ball}`);
