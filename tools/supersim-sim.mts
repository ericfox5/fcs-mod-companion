// Offline smoke test for the coaching engine: plays whole games CPU-vs-CPU with real playbooks and synthetic rosters,
// then prints the box score and aggregate sanity numbers.   npx tsx tools/supersim-sim.mts [games] [offBook] [defBook]
import { readFileSync } from 'node:fs';
import { newGame, runPlay, mulberry32, POS } from '../worker/src/supersim/coach/engine.ts';
import { cpuOffense, cpuDefense } from '../worker/src/supersim/coach/cpu.ts';
import { buildResult, buildEnvelope } from '../worker/src/supersim/coach/result.ts';
import type { Book, GameInput, PlayerInput, TeamInput, GameState } from '../worker/src/supersim/coach/types.ts';

const games = Number(process.argv[2] ?? 3), offId = Number(process.argv[3] ?? 236), defId = Number(process.argv[4] ?? 109);
const book = (id: number) => JSON.parse(readFileSync(`worker/public/data/playbooks/${id}.json`, 'utf8')) as Book;
const books = new Map<number, Book>(); for (const id of [offId, defId, 105, 112]) books.set(id, book(id));
const rng = mulberry32(Number(process.env.SEED ?? 7));
const KEYS = ['PSPD', 'PACC', 'PAGI', 'PSTR', 'PAWR', 'PCTH', 'PCAR', 'PBTK', 'PTHA', 'PTHP', 'PPBK', 'PRBK', 'PTAK', 'PBSH', 'PPMV', 'PFMV', 'PMCV', 'PZCV', 'PPRS', 'PRTR', 'PKAC', 'PKPR', 'PBCV', 'PHIT'];
function roster(tgid: number, quality: number): TeamInput {
  const counts: Record<number, number> = { 0: 3, 1: 4, 2: 2, 3: 6, 4: 3, 5: 2, 6: 2, 7: 2, 8: 2, 9: 2, 10: 2, 11: 2, 12: 4, 13: 2, 14: 3, 15: 2, 16: 5, 17: 2, 18: 2, 19: 1, 20: 1 };
  const players: PlayerInput[] = []; let id = tgid * 1000; const depth: TeamInput['depthChart'] = [];
  for (const [pos, n] of Object.entries(counts)) for (let d = 0; d < n; d++) { const ovr = Math.round(quality - d * 6 + (rng() - 0.5) * 8); const ratings: Record<string, number> = {}; for (const k of KEYS) ratings[k] = Math.max(30, Math.min(99, Math.round(ovr + (rng() - 0.5) * 20))); if (Number(pos) >= 5 && Number(pos) <= 9) ratings['PSPD'] = 50; if (Number(pos) === 3 || Number(pos) === 16) ratings['PSPD'] = Math.min(99, ratings['PSPD']! + 8); players.push({ id: ++id, name: `${POS[Number(pos)]} ${d + 1} T${tgid}`, number: 1 + Math.floor(rng() * 98), pos: Number(pos), overall: ovr, ratings }); depth.push({ pos: Number(pos), depth: d, pgid: id }); }
  // KR/PR/KO/LS from existing players
  const fastest = players.filter((p) => p.pos === 3).sort((a, b) => b.ratings['PSPD']! - a.ratings['PSPD']!)[0]!; depth.push({ pos: 21, depth: 0, pgid: fastest.id }, { pos: 22, depth: 0, pgid: fastest.id }, { pos: 23, depth: 0, pgid: players.find((p) => p.pos === 19)!.id }, { pos: 24, depth: 0, pgid: players.find((p) => p.pos === 7)!.id });
  return { id: tgid, name: `Team ${tgid}`, abbr: `T${tgid}`, logo: '', offBook: tgid === 1 ? offId : 105, defBook: tgid === 1 ? defId : 112, players, depthChart: depth };
}
const totals = { plays: 0, pass: 0, comp: 0, passYds: 0, int: 0, sack: 0, rush: 0, rushYds: 0, pts: 0, fga: 0, fgm: 0, punts: 0, fum: 0, pen: 0, td: 0, ot: 0, maxPlays: 0, minutes: 0 };
for (let g = 0; g < games; g++) {
  const input: GameInput = { dynasty: 'Test', dynastyId: 1, season: 2013, week: 3, gameNo: 1, gameId: `t:${g}`, snapshot: 1, ownedTeamId: 1, quarterSeconds: 15 * 60, teams: [roster(1, 72 + rng() * 10), roster(2, 72 + rng() * 10)], backUrl: '/', home: 2, away: 1 };
  const st: GameState = newGame(input, 1000 + g, `run-${g}`);
  let guard = 0;
  while (!st.final && guard++ < 400) {
    const off = st.phase === 'kickoff' ? st.kicking! : st.off; const def = (1 - off) as 0 | 1;
    const ob = books.get(input.teams[off].offBook)!, db = books.get(input.teams[def].defBook)!;
    const calls = { off: cpuOffense(ob, st, input, off, rng), def: cpuDefense(db, st, input, def, rng) };
    try { const d = runPlay(st, input, { off: ob, def: db }, calls, rng); if (process.env.VERBOSE) console.log(`Q${d.q} ${Math.floor(d.clock / 60)}:${String(d.clock % 60).padStart(2, '0')} [${d.offPlay.form}/${d.offPlay.set}] ${d.offPlay.n} vs ${d.defPlay.n} -> ${d.headline}: ${d.text} ${d.score.join('-')}`); }
    catch (e) { console.error('play failed', (e as Error).stack, JSON.stringify({ phase: st.phase, calls, q: st.q, clock: st.clock, down: st.down, toGo: st.toGo, ball: st.ball })); process.exit(1); }
  }
  const r = buildResult(st, input); totals.plays += st.n; totals.maxPlays = Math.max(totals.maxPlays, st.n); totals.pts += st.score[0] + st.score[1]; if (st.ot) totals.ot += 1;
  for (const s of [0, 1] as const) { totals.pass += st.team[s].pa; totals.comp += st.team[s].pc; totals.passYds += st.team[s].py; totals.rush += st.team[s].ra; totals.rushYds += st.team[s].ry; totals.pen += st.team[s].pen; totals.sack += st.team[s].sk; for (const p of Object.values(st.stats[s])) { totals.int += p.pi; totals.fga += p.fga; totals.fgm += p.fgm; totals.punts += p.pt; totals.fum += p.fum; totals.td += p.ptd + p.rtd; } }
  const kinds = new Map<string, number>(); for (const e of st.log) kinds.set(e.k, (kinds.get(e.k) ?? 0) + 1);
  console.log(`game ${g}: ${input.teams[0].abbr} ${st.score[0]} - ${input.teams[1].abbr} ${st.score[1]}${st.ot ? ` (OT${st.ot.period})` : ''} plays ${st.n} drives ${st.drives.length} | ${[...kinds.entries()].map(([k, n]) => `${k}:${n}`).join(' ')} | yds ${st.team[0].yds}/${st.team[1].yds} pass ${st.team[0].pc}/${st.team[0].pa}-${st.team[0].py} rush ${st.team[0].ra}-${st.team[0].ry} 3rd ${st.team[0].t3c}/${st.team[0].t3a} TOP ${Math.round(st.team[0].top / 60)}:${String(st.team[0].top % 60).padStart(2, '0')}`);
  if (g === 0) { const env = buildEnvelope(st, input, { runId: 'x', blazeId: 1, odId: 1 }); console.log('envelope', JSON.stringify(env.gameResult), 'box rows', env.boxScores.length, 'state bytes', JSON.stringify(st).length, 'last anim actors', st.last?.anim.actors.length, 'ball frames', st.last?.anim.ball.length); console.log('drives:', st.drives.slice(0, 6).map((d) => `${input.teams[d.off].abbr} Q${d.q} from ${d.start}: ${d.plays} plays ${d.yds} yds ${d.result}`).join(' | ')); }
}
const per = (n: number) => (n / games / 2).toFixed(1);
console.log(`\nper team per game: plays ${per(totals.plays)} pts ${per(totals.pts)} pass ${per(totals.comp)}/${per(totals.pass)} (${(100 * totals.comp / Math.max(1, totals.pass)).toFixed(0)}%) ${per(totals.passYds)} yds (${(totals.passYds / Math.max(1, totals.pass)).toFixed(1)}/att) INT ${per(totals.int)} sacks ${per(totals.sack)} | rush ${per(totals.rush)} for ${per(totals.rushYds)} (${(totals.rushYds / Math.max(1, totals.rush)).toFixed(1)}/carry) | FG ${totals.fgm}/${totals.fga} punts ${per(totals.punts)} fumbles ${per(totals.fum)} pen ${per(totals.pen)} TD ${per(totals.td)} OT games ${totals.ot} max plays ${totals.maxPlays}`);
