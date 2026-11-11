// Fits the odds model (packages/ncaa14/src/odds.ts) to Supersim: plays CPU-vs-CPU games between random teams of the
// roster save and regresses each side's points on its offense-against-defense edge, then reports how the fitted
// lines did (spread error, favourites' record, how often each win-probability band came in).
//   npx tsx tools/odds-calibrate.mts [games=200] [--seed N]
// Copy `base`, `perPoint` and `sd` into ODDS_PARAMS when they move. homeField stays the real FCS figure (the engine
// has no crowd beyond road false starts), so it is not fitted here.
import { mulberry32 } from '../worker/src/supersim/coach/engine.ts';
import { matchupOdds, offenseEdge, teamUnits, ODDS_PARAMS, type TeamUnits } from '../packages/ncaa14/src/odds.ts';
import { loadLeague, playGame } from './supersim-real.mts';

const args = process.argv.slice(2); const games = Number(args.find((a) => /^\d+$/.test(a)) ?? 200); const seed = Number(args[args.indexOf('--seed') + 1] ?? 5) || 5;
const L = loadLeague(); const rng = mulberry32(seed);
const units = new Map<number, TeamUnits>(L.teams.map((t) => [t.id, teamUnits(t.players, t.depthChart)]));
const xs: number[] = [], ys: number[] = []; const rows: { eh: number; ea: number; h: number; a: number; uh: TeamUnits; ua: TeamUnits }[] = [];
for (let g = 0; g < games; g++) {
  const a = L.teams[Math.floor(rng() * L.teams.length)]!; let h = L.teams[Math.floor(rng() * L.teams.length)]!; while (h.id === a.id) h = L.teams[Math.floor(rng() * L.teams.length)]!;
  const { st } = playGame(a, h, seed * 100000 + g); const uh = units.get(h.id)!, ua = units.get(a.id)!;
  const eh = offenseEdge(uh, ua), ea = offenseEdge(ua, uh);
  xs.push(eh, ea); ys.push(st.score[1], st.score[0]); rows.push({ eh, ea, h: st.score[1], a: st.score[0], uh, ua });
}
const n = xs.length; const mx = xs.reduce((s, x) => s + x, 0) / n, my = ys.reduce((s, y) => s + y, 0) / n;
const sxy = xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0), sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0), syy = ys.reduce((s, y) => s + (y - my) ** 2, 0);
const perPoint = sxy / sxx, base = my - perPoint * mx; const r = sxy / Math.sqrt(sxx * syy);
const params = { ...ODDS_PARAMS, base, perPoint, homeField: 0 };
const resid = rows.map((g) => g.h - g.a - (matchupOdds(g.uh, g.ua, { params }).margin)); const sd = Math.sqrt(resid.reduce((s, x) => s + x * x, 0) / resid.length);
console.log(`${games} games: edge mean ${mx.toFixed(2)} sd ${Math.sqrt(sxx / n).toFixed(2)}; points mean ${my.toFixed(1)}`);
console.log(`fit: base ${base.toFixed(1)}  perPoint ${perPoint.toFixed(2)}  sd ${sd.toFixed(1)}   (r = ${r.toFixed(2)} between edge and points; current ${JSON.stringify(ODDS_PARAMS)})`);
// how the fitted lines did
const fitted = { ...params, sd }; let favWins = 0, decided = 0, absErr = 0, totErr = 0; const bands: Record<string, [number, number]> = {};
for (const g of rows) {
  const o = matchupOdds(g.uh, g.ua, { params: fitted }); const m = g.h - g.a; absErr += Math.abs(m - o.margin); totErr += g.h + g.a - (o.homePoints + o.awayPoints);
  if (m !== 0) { decided++; if ((o.margin > 0) === (m > 0)) favWins++; }
  const pFav = Math.max(o.homeWin, o.awayWin); const band = pFav < 0.6 ? '50-60%' : pFav < 0.7 ? '60-70%' : pFav < 0.8 ? '70-80%' : pFav < 0.9 ? '80-90%' : '90%+'; const b = (bands[band] ??= [0, 0]); b[1]++; if ((o.margin > 0) === (m > 0)) b[0]++;
}
console.log(`favourites won ${favWins} of ${decided} (${(100 * favWins / decided).toFixed(0)}%); mean absolute spread error ${(absErr / rows.length).toFixed(1)} points; total bias ${(totErr / rows.length).toFixed(1)}`);
console.log('calibration by favourite win probability: ' + Object.entries(bands).sort().map(([k, [w, t]]) => `${k}: ${w}/${t} (${(100 * w / t).toFixed(0)}%)`).join('  '));
