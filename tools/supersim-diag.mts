// Calibration probe for the field simulation (worker/src/supersim/coach/field.ts): runs N single snaps from 1st & 10 at
// the offense's 30 with the CPU's play calls on both sides and prints distributions of what happened on the field.
//   npx tsx tools/supersim-diag.mts [snaps] [offBook] [defBook]
import { readFileSync } from 'node:fs';
import { newGame, mulberry32, findPlay, lineup, playFamily, PASS_SUB } from '../worker/src/supersim/coach/engine.ts';
import { cpuOffense, cpuDefense } from '../worker/src/supersim/coach/cpu.ts';
import { simulateScrimmage, SNAP_T } from '../worker/src/supersim/coach/field.ts';
import type { Book, GameInput } from '../worker/src/supersim/coach/types.ts';

const N = Number(process.argv[2] ?? 600), offId = Number(process.argv[3] ?? 236), defId = Number(process.argv[4] ?? 109);
const book = (id: number) => JSON.parse(readFileSync(`worker/public/data/playbooks/${id}.json`, 'utf8')) as Book;
const ob = book(offId), db = book(defId);
const rng = mulberry32(Number(process.env.SEED ?? 5));
import { roster } from './supersim-diag-roster.mts';

const qo = Number(process.env.QO ?? 76), qd = Number(process.env.QD ?? 76);
const input: GameInput = { dynasty: 'Diag', dynastyId: 1, season: 2013, week: 1, gameNo: 1, gameId: 'diag', snapshot: 1, ownedTeamId: 1, quarterSeconds: 900, teams: [roster(1, qo, offId, defId, rng), roster(2, qd, offId, defId, rng)], backUrl: '/', home: 2, away: 1 };
const st = newGame(input, 1, 'diag'); st.phase = 'snap'; st.off = 0; st.ball = 30; st.down = 1; st.toGo = 10;
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN; };
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pass = { n: 0, comp: 0, yds: [] as number[], tThrow: [] as number[], sep: [] as number[], sack: 0, scr: 0, int: 0, away: 0, drop: 0, pd: 0, air: [] as number[], yac: [] as number[], press: 0, results: new Map<string, number>() };
const run = { n: 0, yds: [] as number[], contact: [] as number[], tries: 0, made: 0, handoff: 0, pitch: 0, tEnd: [] as number[] };
const hold = { n: 0 }; const fc: Record<string, number> = {}; const bigYac: string[] = []; const minRush: number[] = []; let ms = 0;
for (let k = 0; k < N; k++) {
  const offCall = cpuOffense(ob, st, input, 0, rng), defCall = cpuDefense(db, st, input, 1, rng);
  const op = findPlay(ob, offCall)!, dp = findPlay(db, defCall)!; const fam = playFamily(ob, op.play, op.form);
  if (!['pass', 'run', 'option'].includes(fam)) continue;
  const O = lineup(input.teams[0], op.set), D = lineup(input.teams[1], dp.set);
  const oa = O.map((_, i) => ob.asg[op.play.a[i] ?? -1] ?? { r: 0, k: 'move' }), da = D.map((_, i) => db.asg[dp.play.a[i] ?? -1] ?? { r: 0, k: 'move' });
  const t0 = performance.now();
  const r = simulateScrimmage({ rng, family: fam as 'pass', sub: PASS_SUB(op.play.t), playType: op.play.t, O, D, oa, da, oSlots: op.set.slots, dSlots: dp.set.slots, prog: op.play.prog, ball: 30 });
  ms += performance.now() - t0;
  if (r.holding) hold.n++;
  const tries = r.contacts.filter((c) => c.on === r.carrier);
  if (fam === 'pass' && !r.scramble) {
    pass.n++; const th = r.pass;
    if (r.sackBy && !th) { pass.sack++; continue; }
    if (!th) continue;
    { const qa = r.agents.find((a) => a === r.passer || (a.s === 'o' && a.p === r.passer?.p))!; const at = (a: { rec: number[][] }, tt: number) => { const R = a.rec; for (let i = 1; i < R.length; i++) { const u = R[i - 1]!, w = R[i]!; if (tt <= w[0]!) { const f = (tt - u[0]!) / ((w[0]! - u[0]!) || 1); return [u[1]! + (w[1]! - u[1]!) * f, u[2]! + (w[2]! - u[2]!) * f]; } } return [R[R.length - 1]![1]!, R[R.length - 1]![2]!]; }; let mn = 99; for (let tt = SNAP_T + 0.5; tt < th.t; tt += 0.1) { const q = at(qa, tt); for (const a of r.agents) if (a.s === 'd') { const p = at(a, tt); mn = Math.min(mn, Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!)); } } minRush.push(mn); }
    pass.tThrow.push(th.t - SNAP_T); pass.results.set(th.result, (pass.results.get(th.result) ?? 0) + 1);
    if (th.hurried) pass.press++;
    if (th.result === 'away') pass.away++; if (th.result === 'int') pass.int++; if (th.result === 'drop') pass.drop++; if (th.result === 'pd') pass.pd++;
    if (th.result === 'catch') { pass.comp++; pass.yds.push(Math.round(r.x)); pass.air.push(Math.round(th.cx)); pass.yac.push(Math.round(r.x - th.cx)); } else if (th.result !== 'int') pass.yds.push(0);
    const tArr = r.events.find((e) => e.t > th.t && ['catch', 'incomplete', 'interception'].includes(e.k))?.t ?? th.t; const near = Math.min(...r.agents.filter((a) => a.s === 'd').map((a) => { const R = a.rec; let p = R[R.length - 1]!; for (let i = 1; i < R.length; i++) { const u = R[i - 1]!, w = R[i]!; if (tArr <= w[0]!) { const f = (tArr - u[0]!) / ((w[0]! - u[0]!) || 1); p = [tArr, u[1]! + (w[1]! - u[1]!) * f, u[2]! + (w[2]! - u[2]!) * f]; break; } } return Math.hypot(p[1]! - th.cx, p[2]! - th.cy); }));
    pass.sep.push(near);
    if (th.result === 'catch' && r.x - th.cx > 15) { const at = (a: { rec: number[][] }, tt: number) => { const R = a.rec; for (let i = 1; i < R.length; i++) { const u = R[i - 1]!, w = R[i]!; if (tt <= w[0]!) { const f = (tt - u[0]!) / ((w[0]! - u[0]!) || 1); return [u[1]! + (w[1]! - u[1]!) * f, u[2]! + (w[2]! - u[2]!) * f]; } } return [R[R.length - 1]![1]!, R[R.length - 1]![2]!]; }; const c = r.carrier!; const cp = at(c, tArr), cp2 = at(c, tArr + 1); const ds = r.agents.filter((a) => a.s === 'd').map((a) => { const p = at(a, tArr), p2 = at(a, tArr + 1); return [Math.hypot(p[0]! - cp[0]!, p[1]! - cp[1]!), Math.hypot(p2[0]! - cp2[0]!, p2[1]! - cp2[1]!), a.mode] as const; }).sort((a, b) => a[0] - b[0]).slice(0, 3); bigYac.push(`${op.play.n} vs ${dp.play.n}: catch at ${th.cx.toFixed(0)},${th.cy.toFixed(0)} YAC ${(r.x - th.cx).toFixed(0)} end ${r.end} contacts ${r.contacts.length}(${r.contacts.filter((k) => k.made).length} made) nearest at catch / +1s: ${ds.map((d) => d[0].toFixed(1) + '/' + d[1].toFixed(1) + ' ' + d[2]).join(', ')}`); }
  } else if (fam === 'pass' && r.scramble) { pass.n++; pass.scr++; pass.yds.push(Math.round(r.x)); }
  else { { const c0 = r.contacts.find((k) => k.on === r.carrier); if (c0 && r.firstContact !== undefined && r.firstContact < 0) { const k = c0.by.a.k + (c0.by.x0 < 2.5 ? ' line' : c0.by.x0 < 7 ? ' 2nd' : ' deep') + ' t+' + (Math.round(((c0.t - (r.handoff ?? SNAP_T))) * 2) / 2) + (c0.by.wasHeld ? ' was-blocked' : ' never-blocked'); fc[k] = (fc[k] ?? 0) + 1; } }
    run.n++; run.yds.push(Math.round(r.x)); if (r.firstContact !== undefined) run.contact.push(r.firstContact); run.tries += tries.length; run.made += tries.filter((c) => c.made).length; if (r.pitch) run.pitch++; else if (r.handoff) run.handoff++; run.tEnd.push(r.tEnd - SNAP_T); }
}
const f1 = (n: number) => n.toFixed(1);
console.log(`snaps ${N}, ${f1(ms / N)} ms/snap; holding flags ${hold.n}`);
console.log(`PASS dropbacks ${pass.n}: comp ${pass.comp}/${pass.n - pass.sack - pass.scr} (${f1((100 * pass.comp) / Math.max(1, pass.n - pass.sack - pass.scr))}%) yds/att ${f1(avg(pass.yds))} sack ${f1((100 * pass.sack) / pass.n)}% scramble ${f1((100 * pass.scr) / pass.n)}% INT ${f1((100 * pass.int) / pass.n)}% hurried ${f1((100 * pass.press) / pass.n)}%`);
console.log(`  results ${JSON.stringify(Object.fromEntries(pass.results))}; time to throw p25/50/75 ${f1(q(pass.tThrow, 0.25))}/${f1(q(pass.tThrow, 0.5))}/${f1(q(pass.tThrow, 0.75))}s; nearest defender at the ball p25/50/75 ${f1(q(pass.sep, 0.25))}/${f1(q(pass.sep, 0.5))}/${f1(q(pass.sep, 0.75))}yd; air ${f1(avg(pass.air))} YAC ${f1(avg(pass.yac))} (p90 ${q(pass.yac, 0.9)})`);
console.log(`RUN ${run.n}: ${f1(avg(run.yds))} yd/carry, p10/25/50/75/90 ${[0.1, 0.25, 0.5, 0.75, 0.9].map((p) => q(run.yds, p)).join('/')}; first contact at p25/50/75 ${f1(q(run.contact, 0.25))}/${f1(q(run.contact, 0.5))}/${f1(q(run.contact, 0.75))}yd; tackle tries ${f1(run.tries / Math.max(1, run.n))}/carry made ${f1((100 * run.made) / Math.max(1, run.tries))}%; 20+ ${f1((100 * run.yds.filter((y) => y >= 20).length) / Math.max(1, run.n))}% 40+ ${f1((100 * run.yds.filter((y) => y >= 40).length) / Math.max(1, run.n))}%; handoffs ${run.handoff} pitches ${run.pitch}; play length p50 ${f1(q(run.tEnd, 0.5))}s`);

console.log(`closest defender to the QB before the throw p10/25/50/75: ${[0.1, 0.25, 0.5, 0.75].map((p) => q(minRush, p).toFixed(1)).join("/")} (n ${minRush.length})`);
console.log(JSON.stringify(Object.entries((globalThis as any).PITCH ?? {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 10)));
console.log("TFL first contacts:", JSON.stringify(Object.entries(fc).sort((a, b) => b[1] - a[1]).slice(0, 12)));
