// Single-snap probe on real rosters: N snaps from 1st & 10 at the offense's 30 between random teams of the roster
// save, CPU calls on both sides, and a breakdown of what decided the play (who got the sack and how, where runs were
// first hit, how passes ended). The companion of supersim-calibrate.mts when a game-level number is off.
//   npx tsx tools/supersim-probe.mts [snaps=1500] [--seed N]
import { newGame, mulberry32, findPlay, lineup, playFamily, PASS_SUB } from '../worker/src/supersim/coach/engine.ts';
import { cpuOffense, cpuDefense } from '../worker/src/supersim/coach/cpu.ts';
import { simulateScrimmage, SNAP_T } from '../worker/src/supersim/coach/field.ts';
import type { GameInput } from '../worker/src/supersim/coach/types.ts';
import { book, loadLeague } from './supersim-real.mts';

const args = process.argv.slice(2); const N = Number(args.find((a) => /^\d+$/.test(a)) ?? 1500); const seed = Number(args[args.indexOf('--seed') + 1] ?? 11) || 11;
const L = loadLeague(); const rng = mulberry32(seed);
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN; };
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f1 = (n: number) => n.toFixed(1); const pct = (a: number, b: number) => `${f1((100 * a) / Math.max(1, b))}%`;
const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
const P = { n: 0, sack: 0, scr: 0, scrY: [] as number[], att: 0, comp: 0, int: 0, yds: [] as number[], air: [] as number[], yac: [] as number[], tThrow: [] as number[], hurried: 0, res: {} as Record<string, number>, sackT: [] as number[], sackHow: {} as Record<string, number>, sub: {} as Record<string, number>, rushers: [] as number[], why: {} as Record<string, number> };
const Rn = { why: {} as Record<string, number>, n: 0, yds: [] as number[], fc: [] as number[], tfl: 0, how: {} as Record<string, number>, tries: 0, made: 0, fum: 0 };
for (let k = 0; k < N; k++) {
  const a = L.teams[Math.floor(rng() * L.teams.length)]!; let h = L.teams[Math.floor(rng() * L.teams.length)]!; if (h === a) h = L.teams[(L.teams.indexOf(a) + 1) % L.teams.length]!;
  const input: GameInput = { dynasty: 'Probe', dynastyId: 1, season: 2026, week: 1, gameNo: 1, gameId: 'probe', snapshot: 1, ownedTeamId: a.id, quarterSeconds: 900, teams: [a, h], backUrl: '/', home: h.id, away: a.id };
  const st = newGame(input, 1, 'probe'); st.phase = 'snap'; st.off = 0; st.ball = 30; st.down = 1 + Math.floor(rng() * 3); st.toGo = st.down === 1 ? 10 : 2 + Math.floor(rng() * 10);
  const ob = book(a.offBook), db = book(h.defBook);
  const op = findPlay(ob, cpuOffense(ob, st, input, 0, rng))!, dp = findPlay(db, cpuDefense(db, st, input, 1, rng))!; const fam = playFamily(ob, op.play, op.form);
  if (fam !== 'pass' && fam !== 'run' && fam !== 'option') continue;
  const O = lineup(a, op.set), D = lineup(h, dp.set);
  const oa = O.map((_, i) => ob.asg[op.play.a[i] ?? -1] ?? { r: 0, k: 'move' }), da = D.map((_, i) => db.asg[dp.play.a[i] ?? -1] ?? { r: 0, k: 'move' });
  const r = simulateScrimmage({ rng, family: fam, sub: PASS_SUB(op.play.t), playType: op.play.t, O, D, oa, da, oSlots: op.set.slots, dSlots: dp.set.slots, prog: op.play.prog, ball: 30 });
  if (fam === 'pass') {
    P.n++; bump(P.sub, PASS_SUB(op.play.t)); P.rushers.push(da.filter((x) => x.k === 'rush').length);
    if (r.scramble) { P.scr++; P.scrY.push(Math.round(r.x)); continue; }
    const th = r.pass;
    if (r.sackBy && !th) { P.sack++; P.sackT.push(r.tEnd - SNAP_T); bump(P.sackHow, `${r.sackBy.a.k}${r.sackBy.wasHeld ? ' beat-block' : ' unblocked'}`); if (!r.sackBy.wasHeld) { const sb = r.sackBy; const bl = r.agents.filter((x) => x.s === 'o' && (x.mode === 'pblock' || x.pick)); const mine = bl.find((x) => x.pick === sb); bump(P.why, `${da.filter((x) => x.k === 'rush').length} rush v ${bl.length} block; ${mine ? `assigned to ${['QB','HB','FB','WR','TE','OL','OL','OL','OL','OL'][mine.p.pos] ?? '?'} who ${mine.blk ? 'was on another man' : 'never reached him'}` : 'nobody assigned'}; from ${sb.x0 < 2.5 ? 'line' : '2nd'} ${Math.abs(sb.y0) > 5 ? 'edge' : 'inside'}`); } continue; }
    if (!th) { bump(P.res, `none:${r.end}`); continue; }
    P.att++; bump(P.res, th.result); P.tThrow.push(th.t - SNAP_T); if (th.hurried) P.hurried++;
    if (th.result === 'catch') { P.comp++; P.yds.push(Math.round(r.x)); P.air.push(Math.round(th.cx)); P.yac.push(Math.round(r.x - th.cx)); } else { P.yds.push(0); if (th.result === 'int') P.int++; }
  } else {
    Rn.n++; const y = Math.round(r.x); Rn.yds.push(y); if (r.firstContact !== undefined) Rn.fc.push(r.firstContact); if (r.fumble) Rn.fum++;
    const tries = r.contacts.filter((c) => c.on === r.carrier); Rn.tries += tries.length; Rn.made += tries.filter((c) => c.made).length;
    if (y < 0) { Rn.tfl++; const c0 = tries[0]; if (c0 && !c0.by.wasHeld) { const mine = r.agents.find((x) => x.s === 'o' && x.pick === c0.by); bump(Rn.why, `${da.filter((x) => x.k === 'rush').length} rush; ${mine ? 'assigned, never reached' : 'nobody assigned'}; ${c0.by.a.k} from ${c0.by.x0 < 2.5 ? 'line' : c0.by.x0 < 7 ? '2nd' : 'deep'} ${Math.abs(c0.by.y0) > 6 ? 'edge' : 'inside'} at t+${(Math.round((c0.t - (r.handoff ?? SNAP_T)) * 2) / 2).toFixed(1)}`); } if (c0) bump(Rn.how, `${c0.by.a.k}${c0.by.x0 < 2.5 ? ' line' : c0.by.x0 < 7 ? ' 2nd' : ' deep'}${c0.by.wasHeld ? ' beat-block' : ' unblocked'}`); }
  }
}
const top = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ');
console.log(`PASS ${P.n} dropbacks (${top(P.sub)}); rushers p50 ${q(P.rushers, 0.5)} mean ${f1(avg(P.rushers))}`);
console.log(`  sacks ${pct(P.sack, P.n)} (real ~6%)  scrambles ${pct(P.scr, P.n)} for ${f1(avg(P.scrY))}  attempts ${P.att}: comp ${pct(P.comp, P.att)} (real ~59%)  yds/att ${f1(avg(P.yds))} (real ~7.0)  INT ${pct(P.int, P.att)} (real ~2.7%)  hurried ${pct(P.hurried, P.att)}`);
console.log(`  results: ${top(P.res)}; time to throw p25/50/75 ${[0.25, 0.5, 0.75].map((p) => f1(q(P.tThrow, p))).join('/')} s; air ${f1(avg(P.air))} YAC ${f1(avg(P.yac))}`);
console.log(`  sack time p25/50/75 ${[0.25, 0.5, 0.75].map((p) => f1(q(P.sackT, p))).join('/')} s; by: ${top(P.sackHow)}`);
console.log(`  unblocked sacks: ${top(P.why)}`);
console.log(`RUN ${Rn.n}: ${f1(avg(Rn.yds))} per carry (real ~4.6 without sacks); p10/25/50/75/90 ${[0.1, 0.25, 0.5, 0.75, 0.9].map((p) => q(Rn.yds, p)).join('/')}; 10+ ${pct(Rn.yds.filter((y) => y >= 10).length, Rn.n)}; for a loss ${pct(Rn.tfl, Rn.n)} (real ~9%); fumbles ${pct(Rn.fum, Rn.n)}`);
console.log(`  first contact p25/50/75 ${[0.25, 0.5, 0.75].map((p) => f1(q(Rn.fc, p))).join('/')} yd; tackle tries ${f1(Rn.tries / Math.max(1, Rn.n))} per carry, made ${pct(Rn.made, Rn.tries)}; losses first hit by: ${top(Rn.how)}`);
console.log(`  unblocked run losses: ${top(Rn.why)}`);
