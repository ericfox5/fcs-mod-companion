// Prints one simulated snap every 0.5 s: each player's mode and position (calibration aid for field.ts).
//   npx tsx tools/supersim-trace.mts [pass|run] [seed]
import { readFileSync } from 'node:fs';
import { mulberry32, findPlay, lineup, playFamily, PASS_SUB, POS } from '../worker/src/supersim/coach/engine.ts';
import { simulateScrimmage, SNAP_T } from '../worker/src/supersim/coach/field.ts';
import type { Book } from '../worker/src/supersim/coach/types.ts';
process.argv[2] ??= 'pass';
const want = process.argv[2], seed = Number(process.argv[3] ?? 1);
const book = (id: number) => JSON.parse(readFileSync(`worker/public/data/playbooks/${id}.json`, 'utf8')) as Book;
const ob = book(236), db = book(109); const rng = mulberry32(seed);
const { roster } = await import('./supersim-diag-roster.mts');
const off = roster(1, 76, 236, 109, rng), dfn = roster(2, 76, 236, 109, rng);
const ids = Object.keys(ob.plays).map(Number); const dids = Object.keys(db.plays).map(Number);
for (let k = 0; k < 500; k++) {
  const op = findPlay(ob, ids[Math.floor(rng() * ids.length)]!); const dp = findPlay(db, dids[Math.floor(rng() * dids.length)]!); if (!op || !dp) continue;
  const fam = playFamily(ob, op.play, op.form); if (dp.form.t !== 11 || (want === 'pass' ? fam !== 'pass' : fam !== 'run')) continue;
  const O = lineup(off, op.set), D = lineup(dfn, dp.set);
  const oa = O.map((_, i) => ob.asg[op.play.a[i] ?? -1] ?? { r: 0, k: 'move' }), da = D.map((_, i) => db.asg[dp.play.a[i] ?? -1] ?? { r: 0, k: 'move' });
  if (process.env.MINX) { const rr = simulateScrimmage({ rng: mulberry32(seed * 1000 + k), family: fam as 'pass', sub: PASS_SUB(op.play.t), playType: op.play.t, O, D, oa, da, oSlots: op.set.slots, dSlots: dp.set.slots, prog: op.play.prog, ball: 30 }); if (rr.x < Number(process.env.MINX)) continue; }
  console.log(`${op.form.n}/${op.set.n} ${op.play.n} (t ${op.play.t}) vs ${dp.form.n}/${dp.set.n} ${dp.play.n}`);
  console.log('O', oa.map((a, i) => `${POS[O[i]!.pos]}:${a.k}${a.p ? `[${a.p.map((q) => q.map((v) => v.toFixed(0)).join(',')).join(' ')}]` : ''}`).join('  '));
  console.log('D', da.map((a, i) => `${POS[D[i]!.pos]}:${a.k}${a.p ? `[${a.p.map((q) => q.map((v) => v.toFixed(0)).join(',')).join(' ')}]` : ''}${a.t ? ` t${a.t}` : ''}${a.z ? ` z${a.z}` : ''}`).join('  '));
  const r = simulateScrimmage({ rng, family: fam as 'pass', sub: PASS_SUB(op.play.t), playType: op.play.t, O, D, oa, da, oSlots: op.set.slots, dSlots: dp.set.slots, prog: op.play.prog, ball: 30 });
  const at = (a: { rec: number[][] }, t: number) => { const R = a.rec; if (t <= R[0]![0]!) return R[0]!; for (let i = 1; i < R.length; i++) { const p = R[i - 1]!, q = R[i]!; if (t <= q[0]!) { const f = (t - p[0]!) / ((q[0]! - p[0]!) || 1); return [t, p[1]! + (q[1]! - p[1]!) * f, p[2]! + (q[2]! - p[2]!) * f]; } } return R[R.length - 1]!; };
  for (let t = SNAP_T; t <= r.tEnd + 0.01; t += 0.5) console.log(`t=${(t - SNAP_T).toFixed(1)} ` + r.agents.map((a) => { const p = at(a, t); return `${a.s}${POS[a.p.pos]}(${p[1]!.toFixed(0)},${p[2]!.toFixed(0)})`; }).join(' '));
  console.log('end', r.end, 'x', r.x.toFixed(1), 'pass', r.pass ? `${r.pass.result} t=${(r.pass.t - SNAP_T).toFixed(2)} to ${POS[r.pass.target.p.pos]} at (${r.pass.cx.toFixed(1)},${r.pass.cy.toFixed(1)})` : '-', 'events', r.events.map((e) => `${e.k}@${(e.t - SNAP_T).toFixed(1)}`).join(' '));
  console.log('contacts', r.contacts.map((c) => `${POS[c.by.p.pos]}@${(c.t - SNAP_T).toFixed(1)}:${c.made ? 'MADE' : 'miss'}(${c.move})`).join(' ')); console.log('modes', r.agents.map((a) => `${a.s}${POS[a.p.pos]}:${a.mode}`).join(' '));
  if (!process.env.MINX || r.x >= Number(process.env.MINX)) break;
}
