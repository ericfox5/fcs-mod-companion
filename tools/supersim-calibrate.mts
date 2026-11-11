// Supersim realism check on real rosters: plays CPU-vs-CPU games between teams of the FCS roster save and compares the
// per-team-per-game averages with this season's real FCS averages (tools/fcs-benchmarks.json, built by
// tools/fcs-benchmarks.mts from the NCAA.com team tables).
//   npx tsx tools/supersim-calibrate.mts [games=40] [--seed N] [--json out.json] [--pair TGID,TGID]
// Pairings are drawn across the whole strength range (seeded), each team at home half the time.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mulberry32 } from '../worker/src/supersim/coach/engine.ts';
import { loadLeague, playGame } from './supersim-real.mts';

const args = process.argv.slice(2); const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const games = Number(args.find((a) => /^\d+$/.test(a)) ?? 40), seed = Number(flag('seed') ?? 2026);
const league = loadLeague(); const rng = mulberry32(seed);
const pair = flag('pair')?.split(',').map(Number);
const byId = new Map(league.teams.map((t) => [t.id, t]));

interface Row { away: number; home: number; a: number; h: number; ovrA: number; ovrH: number; ot: boolean }
const rows: Row[] = [];
const sum: Record<string, number> = {}; const add = (k: string, v: number) => { sum[k] = (sum[k] ?? 0) + v; };
let ms = 0, snaps = 0;
for (let g = 0; g < games; g++) {
  const a = pair ? byId.get(pair[0]!)! : league.teams[Math.floor(rng() * league.teams.length)]!;
  let h = pair ? byId.get(pair[1]!)! : league.teams[Math.floor(rng() * league.teams.length)]!;
  while (h.id === a.id) h = league.teams[Math.floor(rng() * league.teams.length)]!;
  const { st, ms: t } = playGame(a, h, seed * 1000 + g); ms += t; snaps += st.n;
  rows.push({ away: a.id, home: h.id, a: st.score[0], h: st.score[1], ovrA: league.overall.get(a.id)!, ovrH: league.overall.get(h.id)!, ot: !!st.ot });
  add('ot', st.ot ? 0.5 : 0);
  for (const s of [0, 1] as const) {
    const T = st.team[s], P = Object.values(st.stats[s]);
    const tot = (k: keyof (typeof P)[number]) => P.reduce((n, p) => n + (p[k] as number), 0);
    add('pts', st.score[s]); add('plays', T.plays); add('yds', T.yds); add('rush_att', T.ra); add('rush_yds', T.ry); add('pass_att', T.pa); add('pass_comp', T.pc); add('pass_yds', T.py);
    add('sacks', st.team[1 - s as 0 | 1].sk); add('int', tot('pi')); add('fum_lost', tot('fum')); add('pen', T.pen); add('pen_yds', T.peny); add('fd', T.fd);
    add('t3a', T.t3a); add('t3c', T.t3c); add('t4a', T.t4a); add('t4c', T.t4c); add('fga', tot('fga')); add('fgm', tot('fgm')); add('punts', tot('pt')); add('punt_yds', tot('pty')); add('punt_net', tot('pnet'));
    add('xpa', tot('xpa')); add('xpm', tot('xpm')); add('sfty', tot('sfty')); add('tfl', tot('tfl')); add('rz', T.rz); add('rztd', T.rztd); add('rzfg', T.rzfg);
    add('kr', tot('kr')); add('kry', tot('kry')); add('pr', tot('pr')); add('pry', tot('pry')); add('kotb', tot('kotb')); add('ko', tot('ko')); add('top', T.top);
  }
}
const n = games * 2; const per = (k: string) => (sum[k] ?? 0) / n; const ratio = (a: string, b: string) => (sum[a] ?? 0) / Math.max(1, sum[b] ?? 0);
const sim: Record<string, number> = {
  points: per('pts'), plays: per('plays'), yards: per('yds'), yards_per_play: ratio('yds', 'plays'),
  rush_att: per('rush_att'), rush_yds: per('rush_yds'), yards_per_carry: ratio('rush_yds', 'rush_att'),
  pass_att: per('pass_att'), completion_pct: 100 * ratio('pass_comp', 'pass_att'), pass_yds: per('pass_yds'), yards_per_att: ratio('pass_yds', 'pass_att'),
  sacks: per('sacks'), tfl: per('tfl'), interceptions: per('int'), fumbles_lost: per('fum_lost'), turnovers: per('int') + per('fum_lost'),
  penalties: per('pen'), penalty_yds: per('pen_yds'), first_downs: per('fd'), third_down_pct: 100 * ratio('t3c', 't3a'), fourth_down_pct: 100 * ratio('t4c', 't4a'),
  fg_att: per('fga'), fg_pct: 100 * ratio('fgm', 'fga'), xp_pct: 100 * ratio('xpm', 'xpa'), punts: per('punts'), punt_avg: ratio('punt_yds', 'punts'), punt_net: ratio('punt_net', 'punts'),
  red_zone_score_pct: 100 * ((sum['rztd'] ?? 0) + (sum['rzfg'] ?? 0)) / Math.max(1, sum['rz'] ?? 0), kick_return_avg: ratio('kry', 'kr'), punt_return_avg: ratio('pry', 'pr'),
  touchback_pct: 100 * ratio('kotb', 'ko'), safeties: per('sfty'), overtime_games_pct: 100 * (sum['ot'] ?? 0) / games * 2,
};
const bench: Record<string, { mean: number; lo: number; hi: number }> = existsSync('tools/fcs-benchmarks.json') ? JSON.parse(readFileSync('tools/fcs-benchmarks.json', 'utf8')).stats : {};
console.log(`${games} games on real rosters (seed ${seed}), ${(ms / snaps).toFixed(2)} ms per snap, ${(ms / games).toFixed(0)} ms per game\n`);
console.log('stat'.padEnd(22) + 'sim'.padStart(8) + 'FCS'.padStart(8) + '   range (10th-90th team)   verdict');
let off = 0;
for (const [k, v] of Object.entries(sim)) {
  const b = bench[k]; const verdict = !b ? '' : v < b.lo ? 'LOW' : v > b.hi ? 'HIGH' : 'ok'; if (verdict === 'LOW' || verdict === 'HIGH') off++;
  console.log(k.padEnd(22) + v.toFixed(2).padStart(8) + (b ? b.mean.toFixed(2).padStart(8) + `   ${b.lo.toFixed(2)} - ${b.hi.toFixed(2)}`.padEnd(27) + verdict : ''));
}
// does the better roster win, and by how much
const dec = rows.filter((r) => r.a !== r.h); const fav = dec.filter((r) => (r.ovrH + 1 > r.ovrA) === (r.h > r.a)).length;
const mx = rows.reduce((s, r) => s + (r.ovrH - r.ovrA), 0) / rows.length, my = rows.reduce((s, r) => s + (r.h - r.a), 0) / rows.length;
const sxy = rows.reduce((s, r) => s + (r.ovrH - r.ovrA - mx) * (r.h - r.a - my), 0), sxx = rows.reduce((s, r) => s + (r.ovrH - r.ovrA - mx) ** 2, 0);
console.log(`\nbetter-rated side won ${fav} of ${dec.length}; home margin ${my.toFixed(1)}; points per rating point ${(sxy / Math.max(1e-9, sxx)).toFixed(2)}; ${off} stats outside the FCS range`);
if (flag('json')) writeFileSync(flag('json')!, JSON.stringify({ games, seed, sim, rows }, null, 1));
