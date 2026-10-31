// CPU play-calling for the side the member does not control: situational family mix (run/pass/kick), then a play of
// that family from the team's own playbook, weighted by the game's AI usage tables (PBA*, summed over situations).
import type { Book, GameInput, GameState, Play, Side } from './types.js';
import { PASS_SUB, playFamily, R, type Rng } from './engine.js';

const weighted = <T>(rng: Rng, list: T[], w: (x: T) => number): T => { const ws = list.map((x) => Math.max(0.01, w(x))); const total = ws.reduce((a, b) => a + b, 0); let r = rng() * total; for (let i = 0; i < list.length; i++) { r -= ws[i]!; if (r <= 0) return list[i]!; } return list[list.length - 1]!; };
const SPECIAL_SETS = new Set(['Special Teams', 'QB Kneel', 'Stop Clock', 'Field Goal', 'Hail Mary', 'Punt Max Protect', 'Tight Max Protect', 'Tight Max Protect Fake', 'FakePuntDirectSnap', 'NCAA', 'Field Goal Return', 'Field Goal Block', 'Punt Return Safe', 'Punt Return Normal', 'NCAA Onside Return', 'NCAA Kick Return', 'Normal Kick Return']);

interface Cand { play: Play; set: string; form: string; formType: number; weight: number }
function candidates(book: Book): Cand[] {
  const usage = new Map<number, number>(); for (const list of Object.values(book.ai)) for (const [id, w] of list) usage.set(id!, (usage.get(id!) ?? 0) + w!);
  const out: Cand[] = [];
  for (const f of book.formations) for (const s of f.sets) for (const id of s.plays) { const p = book.plays[String(id)]; if (p) out.push({ play: p, set: s.n, form: f.n, formType: f.t, weight: 1 + Math.log1p(usage.get(id) ?? 0) }); }
  return out;
}
const byName = (cs: Cand[], re: RegExp) => cs.filter((c) => re.test(c.play.n));
const depthOf = (book: Book, p: Play) => Math.max(0, ...p.a.map((ai) => Math.max(0, ...((book.asg[ai]?.k === 'route' ? book.asg[ai]?.p : undefined) ?? [[0, 0]]).map((q) => q[1] ?? 0))));

export function cpuOffense(book: Book, st: GameState, input: GameInput, side: Side, rng: Rng): number {
  const cs = candidates(book); const lead = st.score[side] - st.score[1 - side as Side]; const late4 = st.q >= 4 && !st.ot && st.clock < 180; const kicker = input.teams[side].players.find((p) => p.pos === 19);
  if (st.phase === 'kickoff') {
    const ko = cs.filter((c) => c.formType === 2 || c.set === 'NCAA');
    const onside = lead < 0 && lead >= -16 && st.q >= 4 && st.clock < 150 && !st.ot;
    const pool = onside ? ko.filter((c) => /onside/i.test(c.play.n)) : ko.filter((c) => !/onside|squib/i.test(c.play.n));
    return (pool[0] ?? ko[0] ?? cs[0])!.play.id;
  }
  const normal = cs.filter((c) => c.formType === 1 && !SPECIAL_SETS.has(c.set) && !SPECIAL_SETS.has(c.form) && c.form !== 'Hail Mary' && playFamily(book, c.play, { t: c.formType }) !== 'fg' && playFamily(book, c.play, { t: c.formType }) !== 'punt' && ![37, 38, 104, 105, 106, 154, 155].includes(c.play.t));
  const fg = cs.find((c) => c.set === 'Field Goal' && c.play.t === 21), punt = cs.find((c) => c.play.t === 21 && book.asg.some((a, i) => c.play.a.includes(i) && a.k === 'punt') && !/max|tight/i.test(c.set)) ?? cs.find((c) => c.play.t === 21 && c.form === 'Special Teams');
  if (st.phase === 'pat') {
    const need = -lead; const goTwo = (st.ot && st.ot.period >= 3) || (st.q >= 4 && !st.ot && st.clock < 420 && [2, 5, 10, 16, 18].includes(need - 6)) || (st.q >= 4 && need - 6 === 2);
    if (!goTwo && fg) return fg.play.id;
    const two = normal.filter((c) => playFamily(book, c.play, { t: 1 }) !== 'option' && !/screen|draw/i.test(c.play.n)); return weighted(rng, two.length ? two : normal, (c) => c.weight).play.id;
  }
  // clock management
  const half = st.q === 2 || st.q >= 4;
  if (!st.ot && st.q >= 4 && lead > 0 && st.clock <= 40 * (4 - st.down) + 5 && (st.to[1 - side as Side] === 0 || st.clock < 45)) { const k = cs.find((c) => c.play.t === 37); if (k) return k.play.id; }
  if (!st.ot && half && lead <= 0 && st.running && st.clock < 35 && st.to[side] === 0 && st.down < 4) { const sp = cs.find((c) => c.play.t === 38); if (sp) return sp.play.id; }
  if (!st.ot && half && lead < 0 && st.clock < 8 && 100 - st.ball > 35) { const hm = cs.find((c) => c.play.t === 104); if (hm) return hm.play.id; }
  // fourth down
  const dist = 100 - st.ball + 17; const range = 44 + (kicker ? (R(kicker, 'PKPR') - 70) / 3 : 0);
  if (st.down === 4) {
    const desperate = lead < 0 && ((st.q >= 4 && st.clock < 300) || st.ot) ;
    if (fg && dist <= range && !(desperate && lead < -3 && st.clock < 120)) return fg.play.id;
    if (!desperate && !(st.toGo <= 2 && st.ball > 55) && punt && st.ball < 62) return punt.play.id;
    if (!desperate && punt && st.ball < 62 && st.toGo > 4) return punt.play.id;
  }
  // family mix
  let passP = 0.5; const long = st.toGo >= 8, short = st.toGo <= 3;
  if (st.down === 1) passP = 0.47; else if (st.down === 2) passP = long ? 0.62 : short ? 0.35 : 0.5; else passP = short ? 0.4 : long ? 0.85 : 0.7;
  if (st.ball >= 90) passP -= 0.12; if (late4 && lead < 0) passP = Math.max(passP, 0.8); if (st.q >= 4 && lead > 8) passP -= 0.2; if (st.toGo >= 15) passP = 0.9;
  const wantPass = rng() < passP;
  const pool = normal.filter((c) => { const fam = playFamily(book, c.play, { t: 1 }); return wantPass ? fam === 'pass' : fam === 'run' || fam === 'option'; });
  if (!pool.length) return (normal[0] ?? cs[0])!.play.id;
  return weighted(rng, pool, (c) => {
    let w = c.weight; const sub = PASS_SUB(c.play.t);
    if (/goal line|heavy|jumbo/i.test(c.form) || /goal|jumbo|heavy/i.test(c.set)) w *= st.ball >= 92 || (short && st.ball > 50) ? 3 : 0.03;
    if (/wildcat/i.test(c.form)) w *= 0.25;
    if (wantPass) { const d = depthOf(book, c.play); if (st.toGo >= 10) w *= d >= 12 ? 1.6 : 0.8; if (short) w *= d <= 8 ? 1.5 : 0.6; if (sub === 'screen') w *= long ? 1.2 : 0.6; if (sub === 'hailmary') w *= 0.05; if (100 - st.ball < d + 2) w *= 0.3; }
    else { if (short && /dive|iso|sneak|blast|power|wedge/i.test(c.play.n)) w *= 1.8; if (/sneak/i.test(c.play.n) && st.toGo > 1) w *= 0.05; if (long && /draw/i.test(c.play.n)) w *= 1.5; }
    return w;
  }).play.id;
}

export function cpuDefense(book: Book, st: GameState, input: GameInput, side: Side, rng: Rng): number {
  const cs = candidates(book); const opp = 1 - side as Side; const lead = st.score[side] - st.score[opp];
  if (st.phase === 'kickoff') {
    const expectOnside = lead > 0 && lead <= 16 && st.q >= 4 && st.clock < 150 && !st.ot;
    const ret = cs.filter((c) => c.formType === 12 || /kick return|return middle/i.test(c.play.n) || c.set === 'NCAA Kick Return' || (c.set === 'Normal' && c.form === 'Special Teams'));
    if (expectOnside) { const h = cs.find((c) => /onside/i.test(c.play.n)); if (h) return h.play.id; }
    return (ret.find((c) => c.formType === 12) ?? ret[0] ?? cs[0])!.play.id;
  }
  const normal = cs.filter((c) => c.formType === 11 && !SPECIAL_SETS.has(c.set) && !SPECIAL_SETS.has(c.form) && c.form !== 'Special Teams' && c.play.t !== 35 && c.play.t < 49);
  if (st.phase === 'pat') { const need = st.score[opp] - st.score[side]; const expectTwo = (st.ot && st.ot.period >= 3) || (st.q >= 4 && [2, 5, 10, 16, 18].includes(need - 6)); if (!expectTwo) { const b = cs.find((c) => c.play.t === 51 || c.play.t === 50); if (b) return b.play.id; } return weighted(rng, normal.filter((c) => /goal|gl/i.test(c.form) || /goal/i.test(c.set)).length ? normal.filter((c) => /goal|gl/i.test(c.form) || /goal/i.test(c.set)) : normal, (c) => c.weight).play.id; }
  // fourth-and-long or punt range: punt return / FG block looks
  const oppDist = 100 - st.ball + 17;
  if (st.down === 4 && !st.ot) { if (oppDist <= 50 && oppDist > 20) { const b = cs.find((c) => c.play.t === 50 || c.play.t === 49) ?? cs.find((c) => c.play.t === 51); if (b && rng() < 0.85) return b.play.id; } else if (st.ball < 62 && st.toGo > 2) { const pr = cs.find((c) => /pr middle|punt return|pr safe/i.test(c.play.n)) ?? cs.find((c) => c.play.t === 35 && /punt|pr /i.test(c.play.n)); if (pr && rng() < 0.9) return pr.play.id; } }
  // coverage / pressure mix by situation
  const long = st.toGo >= 8, short = st.toGo <= 2, goalLine = st.ball >= 95;
  const kindW = (t: number) => {
    if (goalLine) return t === 36 ? 3 : [33, 46].includes(t) ? 2 : 1;
    if (short) return [33, 46, 36].includes(t) ? 2.2 : t === 45 ? 0.3 : 1;
    if (long) return t === 45 ? 2 : t === 43 ? 1.6 : t === 47 ? 1.4 : t === 42 ? 1.2 : t === 46 ? 0.8 : t === 36 ? 0.1 : 1;
    if (st.down === 3) return t === 47 || t === 46 ? 1.6 : t === 34 ? 1.3 : 1;
    return t === 36 ? 0.2 : 1;
  };
  const formW = (f: string) => (goalLine ? (/goal/i.test(f) ? 4 : 0.3) : short ? (/goal|4-4|46|5-2/i.test(f) ? 1.6 : /dime|quarter|dollar/i.test(f) ? 0.3 : 1) : long ? (/dime|quarter|nickel|dollar/i.test(f) ? 1.6 : /goal/i.test(f) ? 0.05 : 1) : /goal/i.test(f) ? 0.05 : /dime|quarter|dollar/i.test(f) ? 0.6 : 1);
  const prevent = st.q >= 4 && lead > 0 && st.clock < 120 && !st.ot;
  return weighted(rng, normal, (c) => c.weight * kindW(c.play.t) * formW(c.form) * (prevent ? (/prevent/i.test(c.play.n) ? 4 : c.play.t === 45 ? 1.5 : 0.6) : /prevent/i.test(c.play.n) ? 0.05 : 1)).play.id;
}
