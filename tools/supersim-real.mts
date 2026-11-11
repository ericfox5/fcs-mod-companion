// Real rosters for the offline Supersim tools: every team of a roster or dynasty save as engine input (players with
// their ratings, the save's own depth chart, the team's stock playbooks), and a whole CPU-vs-CPU game played on them.
// Used by supersim-calibrate.mts (engine realism against FCS season averages) and odds-calibrate.mts (the odds model).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTdb } from '@ncaa/tdb';
import { decodeDepthChart, decodePlayers, decodeTeams } from '@ncaa/ncaa14';
import { openDynastyFile } from '../bridge/src/od.ts';
import { newGame, runPlay, mulberry32 } from '../worker/src/supersim/coach/engine.ts';
import { cpuOffense, cpuDefense } from '../worker/src/supersim/coach/cpu.ts';
import type { Book, BookIndex, GameInput, GameState, TeamInput } from '../worker/src/supersim/coach/types.ts';

export const DEFAULT_SAVE = process.env.SUPERSIM_SAVE ?? 'C:/Users/efoxo/OneDrive/Desktop/FCS/Rosters/2026/out/BLUS31159-ROSTER-FCS2026/USR-DATA';
const BOOK_DIR = 'worker/public/data/playbooks';

const books = new Map<number, Book>();
export function book(id: number): Book {
  let b = books.get(id);
  if (!b) { b = JSON.parse(readFileSync(join(BOOK_DIR, `${id}.json`), 'utf8')) as Book; books.set(id, b); }
  return b;
}

export interface League { teams: TeamInput[]; overall: Map<number, number> }
// Every team with players. A roster save is a bare DB; a dynasty save wraps it.
export function loadLeague(path = DEFAULT_SAVE): League {
  if (!existsSync(path)) throw new Error(`no save at ${path} (set SUPERSIM_SAVE)`);
  if (!existsSync(join(BOOK_DIR, 'index.json'))) throw new Error('playbooks missing: run npx tsx tools/playbooks-extract.mts first');
  const bytes = new Uint8Array(readFileSync(path));
  const file = bytes[0] === 0x44 && bytes[1] === 0x42 ? parseTdb(bytes) : openDynastyFile(bytes).file;
  const index = JSON.parse(readFileSync(join(BOOK_DIR, 'index.json'), 'utf8')) as BookIndex;
  const players = decodePlayers(file), chart = decodeDepthChart(file);
  const teams: TeamInput[] = []; const overall = new Map<number, number>();
  for (const t of decodeTeams(file)) {
    const ps = players.filter((p) => p.tgid === t.tgid && p.redshirt !== 1);
    if (ps.length < 40) continue;
    const topb = Number(t.raw['TOPB']), tdpb = Number(t.raw['TDPB']);
    const off = index.books.find((b) => b.side === 'off' && b.bgid === topb) ?? index.books.find((b) => b.side === 'off' && b.name === 'Multiple') ?? index.books.find((b) => b.side === 'off')!;
    const def = index.books.find((b) => b.side === 'def' && b.bgid === tdpb) ?? index.books.find((b) => b.side === 'def' && b.name === '4-3') ?? index.books.find((b) => b.side === 'def')!;
    const ids = new Set(ps.map((p) => p.pgid));
    teams.push({
      id: t.tgid, name: t.name, abbr: t.abbr, logo: '', offBook: off.id, defBook: def.id,
      players: ps.map((p) => ({ id: p.pgid, name: `${p.firstName} ${p.lastName}`, number: p.jersey, pos: p.pos, overall: p.overall, ratings: p.ratings })),
      depthChart: chart.filter((d) => d.tgid === t.tgid && ids.has(d.pgid)).map((d) => ({ pos: d.pos, depth: d.depth, pgid: d.pgid })),
    });
    // strength of the first string: the mean overall of the 22 best-rated players
    overall.set(t.tgid, ps.map((p) => p.overall).sort((a, b) => b - a).slice(0, 22).reduce((a, b) => a + b, 0) / 22);
  }
  return { teams, overall };
}

export interface Played { st: GameState; input: GameInput; ms: number }
// away at home, CPU against CPU, 15-minute quarters (the real game's length, so totals compare with real box scores)
export function playGame(away: TeamInput, home: TeamInput, seed: number, quarterSeconds = 15 * 60): Played {
  const rng = mulberry32(seed);
  const input: GameInput = { dynasty: 'Calibrate', dynastyId: 1, season: 2026, week: 1, gameNo: 1, gameId: `cal:${seed}`, snapshot: 1, ownedTeamId: away.id, quarterSeconds, teams: [away, home], backUrl: '/', home: home.id, away: away.id };
  const st = newGame(input, seed, `cal-${seed}`);
  const t0 = performance.now(); let guard = 0;
  while (!st.final && guard++ < 600) {
    const off = st.phase === 'kickoff' ? st.kicking! : st.off; const def = (1 - off) as 0 | 1;
    const ob = book(input.teams[off].offBook), db = book(input.teams[def].defBook);
    runPlay(st, input, { off: ob, def: db }, { off: cpuOffense(ob, st, input, off, rng), def: cpuDefense(db, st, input, def, rng) }, rng, st.tempo, { cpu: [true, true] });
  }
  if (!st.final) throw new Error(`game ${seed} did not finish in 600 plays`);
  return { st, input, ms: performance.now() - t0 };
}
