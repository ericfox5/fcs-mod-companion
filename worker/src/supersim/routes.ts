// Supersim (coaching mode): the member calls every play of their own team's current-week game from the team's real
// NCAA 14 playbook; the server resolves one snap per request with fresh randomness, keeps the live game in
// supersim_live and, at the final whistle, writes the official result into supersim_games (the outbox the league
// server polls, unchanged from v1). The other sideline is the CPU unless that team belongs to another member, in
// which case both members call their plays and the snap resolves when the second call arrives.
//
//   GET  /d/<slug>/supersim          page shell (coach.js + coach.css)
//   GET  /d/<slug>/supersim/data     { input, you, controls, opponentHuman, books, state, version, final }
//   POST /d/<slug>/supersim/data     { action: 'start' | 'play' | 'auto' | 'timeout' | 'tempo' | 'abandon', version, play?, tempo?, plays? }
import type { Env } from '../env.js';
import type { Dynasty, GameRow, MemberRow } from '../db/queries.js';
import { getMembers, getGames, getTeam, getPlayers } from '../db/queries.js';
import { teamLogoUrl, headshotUrl } from '../pages/common.js';
import { html, page } from '../html.js';
import { allowedGame, sameOrigin } from './access.js';
import { loadBook, loadIndex, teamBooks } from './coach/books.js';
import { newGame, runPlay, mulberry32, type Rng, coinToss, tossChoice, cpuTossChoice } from './coach/engine.js';
import { cpuOffense, cpuDefense } from './coach/cpu.js';
import { buildResult, buildEnvelope, sideOf } from './coach/result.js';
import type { Book, GameInput, GameState, PlayDetail, Side, TeamInput, TossChoice } from './coach/types.js';

export type SimEnv = Env & { SUPERSIM_SESSION_SECRET?: string; SUPERSIM_ENABLED?: string; SUPERSIM_QUARTER_SECONDS?: string };
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store', vary: 'Cookie', 'x-content-type-options': 'nosniff' } });
const fail = (msg: string, status: number) => Object.assign(new Error(msg), { status });
type Run = { id: string; status: string; input_json: string; result_json: string; envelope_json: string };
type LiveRow = { dynasty_id: number; season_year: number; week: number; game_no: number; snapshot_id: number; home_tgid: number; away_tgid: number; started_by: number; status: string; version: number; input_json: string; state_json: string };
interface Pending { side: Side; play: number; tempo: GameState['tempo']; by: number }
type LiveState = GameState & { pending?: Pending | null };

// Identity: the acting member resolved by the site's session layer (signed-in account once the dynasty is locked).
export async function resolveCurrent(env: SimEnv, dyn: Dynasty, acting: MemberRow | null) {
  if (!acting) throw fail('Sign in as a dynasty member to coach your game.', 401);
  const members = await getMembers(env.DB, dyn.id);
  const member = members.find((m) => m.blaze_id === acting.blaze_id);
  const games = member ? await getGames(env.DB, dyn.id, dyn.season_year, { week: dyn.week, tgid: member.tgid }) : [];
  if (games.length !== 1 || !allowedGame(dyn, member, games[0])) throw fail('No eligible current-week game for your team (bye week, offseason, or missing membership).', 403);
  const game = games[0]!;
  const run = await env.DB.prepare('SELECT * FROM supersim_games WHERE dynasty_id=? AND season_year=? AND week=? AND game_no=?').bind(dyn.id, dyn.season_year, dyn.week, game.game_no).first<Run>();
  if (game.status >= 2 && !run) throw fail('This game has already been completed on the console.', 409);
  const live = await env.DB.prepare('SELECT * FROM supersim_live WHERE dynasty_id=? AND season_year=? AND week=? AND game_no=?').bind(dyn.id, dyn.season_year, dyn.week, game.game_no).first<LiveRow>();
  const other = members.find((m) => m.tgid === (game.home_tgid === member!.tgid ? game.away_tgid : game.home_tgid));
  return { member: member!, members, game, run, live, other };
}
// Coached games use 12-minute quarters (SUPERSIM_QUARTER_SECONDS overrides), independent of the dynasty's console setting.
const quarterSecondsFor = (env: SimEnv, _dyn: Dynasty) => { const q = Number(env.SUPERSIM_QUARTER_SECONDS); return Number.isFinite(q) && q >= 60 && q <= 900 ? q : 720; };

export async function buildInput(env: SimEnv, dyn: Dynasty, game: GameRow, ownedTeamId: number, origin: string): Promise<GameInput> {
  const index = await loadIndex(env.ASSETS, origin);
  const teams = await Promise.all([game.away_tgid, game.home_tgid].map(async (tgid): Promise<TeamInput> => {
    const [team, players, depth] = await Promise.all([getTeam(env.DB, dyn.id, tgid), getPlayers(env.DB, dyn.id, tgid), env.DB.prepare('SELECT pos,depth,pgid FROM depth_chart WHERE dynasty_id=? AND tgid=? AND snapshot_id=? ORDER BY pos,depth').bind(dyn.id, tgid, dyn.current_snapshot_id).all<{ pos: number; depth: number; pgid: number }>()]);
    if (!team) throw fail('Team missing from the current snapshot.', 409);
    if (!depth.results.length) throw fail(`Depth chart missing for ${team.name}; sync the dynasty before simulating.`, 409);
    let raw: Record<string, unknown> | null = null; try { raw = JSON.parse((team as unknown as { raw_json?: string }).raw_json || 'null'); } catch { /* ignore */ }
    const books = teamBooks(index, raw);
    const eligible = players.filter((p) => p.redshirt !== 1);
    return { id: tgid, name: team.name, abbr: team.abbr, logo: teamLogoUrl(team, 'lg'), offBook: books.offBook, defBook: books.defBook, depthChart: depth.results, players: eligible.map((p) => ({ id: p.pgid, name: `${p.first_name} ${p.last_name}`, number: p.jersey, photoUrl: headshotUrl(p), pos: p.pos, overall: p.overall, ratings: JSON.parse(p.ratings_json || '{}') })) };
  }));
  return { dynasty: dyn.name, dynastyId: dyn.id, season: dyn.season_year, week: dyn.week, gameNo: game.game_no, gameId: `${dyn.id}:${dyn.season_year}:${dyn.week}:${game.game_no}`, snapshot: dyn.current_snapshot_id, ownedTeamId, quarterSeconds: quarterSecondsFor(env, dyn), teams: [teams[0]!, teams[1]!], backUrl: `/d/${dyn.slug}/game/${game.week}/${game.game_no}`, home: game.home_tgid, away: game.away_tgid };
}
// the browser does not need every rating: strip them (they stay in the stored input for the engine)
const slimInput = (input: GameInput) => ({ ...input, teams: input.teams.map((t) => ({ ...t, players: t.players.map(({ ratings: _r, ...p }) => p) })) });

async function booksFor(env: SimEnv, origin: string, input: GameInput, st: GameState): Promise<{ off: Book; def: Book }> {
  const off: Side = st.phase === 'kickoff' ? st.kicking! : st.off; const def = (1 - off) as Side;
  const [o, d] = await Promise.all([loadBook(env.ASSETS, origin, input.teams[off].offBook), loadBook(env.ASSETS, origin, input.teams[def].defBook)]);
  return { off: o, def: d };
}
// the side that must choose next on each sideline: on kickoffs the kicking team "has the ball"
const actingOff = (st: GameState): Side => (st.phase === 'kickoff' ? st.kicking! : st.off);
// the CPU offense hurries when trailing late in a half and bleeds the clock when protecting a fourth-quarter lead
const cpuTempo = (st: GameState, side: Side): GameState['tempo'] => { const lead = st.score[side] - st.score[1 - side as Side]; if (st.ot) return 'normal'; if (lead < 0 && (st.q === 2 || st.q >= 4) && st.clock < 150) return 'hurry'; if (lead > 0 && st.q >= 4 && st.clock < 360) return 'chew'; return 'normal'; };

export async function handleSupersim(req: Request, env: SimEnv, dyn: Dynasty, resource: string | undefined, acting: MemberRow | null): Promise<Response> {
  const url = new URL(req.url); const origin = url.origin;
  try {
    if (env.SUPERSIM_ENABLED !== 'true') return reply({ error: 'Supersim is disabled for this site.' }, 503);
    if (resource !== undefined && resource !== 'data') return reply({ error: 'Not found' }, 404);
    if (req.method === 'GET' && !resource) {
      return page(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Supersim | ${dyn.name}</title><link rel="stylesheet" href="/css/coach.css"></head><body><div id="coach" data-endpoint="/d/${dyn.slug}/supersim/data" data-books="/data/playbooks/" data-back="/d/${dyn.slug}"></div><script type="module" src="/js/supersim/coach.js"></script></body></html>`, 200, { 'cache-control': 'private, no-store', vary: 'Cookie', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
    }
    const { member, game, run, live, other } = await resolveCurrent(env, dyn, acting);
    const payload = async (liveRow: LiveRow | null, extra: Record<string, unknown> = {}) => {
      const input: GameInput = liveRow ? JSON.parse(liveRow.input_json) : await buildInput(env, dyn, game, member.tgid, origin);
      const st: LiveState | null = liveRow ? JSON.parse(liveRow.state_json) : null;
      const you = sideOf(input, member.tgid);
      const pending = st?.pending ?? null;
      return { input: slimInput(input), you, controls: [you], opponentHuman: !!other, books: { off: [input.teams[0].offBook, input.teams[1].offBook], def: [input.teams[0].defBook, input.teams[1].defBook] }, state: st ? { ...st, pending: undefined } : null, pendingSide: pending ? pending.side : null, pendingMine: pending ? pending.by === member.blaze_id : false, version: liveRow?.version ?? 0, status: liveRow?.status ?? null, final: run ? { id: run.id, status: run.status, result: JSON.parse(run.result_json) } : null, ...extra };
    };
    if (req.method === 'GET') return reply(await payload(live));
    if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
    if (!sameOrigin(req)) return reply({ error: 'Same-origin JSON request required.' }, 403);
    const text = await req.text(); if (text.length > 4096) return reply({ error: 'Request too large' }, 413);
    const body = JSON.parse(text) as { action?: string; version?: number; play?: number; tempo?: GameState['tempo']; plays?: number; snapshot?: number | null; call?: string; choice?: string; pos?: number; depth?: number; pgid?: number };
    const key = [dyn.id, dyn.season_year, dyn.week, game.game_no] as const;
    if (body.action === 'start') {
      if (run) return reply({ error: 'This game already has an official result.' }, 409);
      if (live) return reply(await payload(live));
      const input = await buildInput(env, dyn, game, member.tgid, origin);
      if (dyn.od_id === null) return reply({ error: 'Supersim requires an online dynasty.' }, 409);
      const seed = crypto.getRandomValues(new Uint32Array(1))[0]!; const id = crypto.randomUUID();
      const st: LiveState = { ...newGame(input, seed, id, { toss: true }), pending: null };
      await env.DB.prepare('INSERT OR IGNORE INTO supersim_live(dynasty_id,season_year,week,game_no,snapshot_id,home_tgid,away_tgid,started_by,input_json,state_json) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(...key, dyn.current_snapshot_id ?? 0, game.home_tgid, game.away_tgid, member.blaze_id, JSON.stringify(input), JSON.stringify(st)).run();
      const row = await env.DB.prepare('SELECT * FROM supersim_live WHERE dynasty_id=? AND season_year=? AND week=? AND game_no=?').bind(...key).first<LiveRow>();
      return reply(await payload(row), 201);
    }
    if (!live) return reply({ error: 'No game in progress. Start one first.' }, 409);
    if (body.action === 'abandon') { // throw the live game away (nothing official exists until the final): the starter or a commissioner
      if (live.status !== 'live') return reply({ error: 'This game is already final.' }, 409);
      if (live.started_by !== member.blaze_id && !member.commissioner) return reply({ error: 'Only the member who started the game (or a commissioner) can abandon it.' }, 403);
      await env.DB.prepare('DELETE FROM supersim_live WHERE dynasty_id=? AND season_year=? AND week=? AND game_no=? AND status=?').bind(...key, 'live').run();
      return reply(await payload(null));
    }
    if (live.status === 'final') return reply(await payload(live));
    if (!Number.isInteger(body.version) || body.version !== live.version) return reply({ error: 'The game moved on since you loaded it. Reloading…', stale: true, ...(await payload(live)) }, 409);
    const input: GameInput = JSON.parse(live.input_json); const st: LiveState = JSON.parse(live.state_json);
    const you = sideOf(input, member.tgid); if (you === null) return reply({ error: 'You are not part of this game.' }, 403);
    const rng: Rng = mulberry32(crypto.getRandomValues(new Uint32Array(1))[0]!); // fresh randomness every call: nothing is predetermined
    const details: PlayDetail[] = [];
    const resolve = async (mine: { side: Side; play: number; tempo: GameState['tempo'] } | null, cpuMine = false) => {
      const off = actingOff(st); const def = (1 - off) as Side; const books = await booksFor(env, origin, input, st);
      const callFor = (side: Side): number => (side === off ? cpuOffense(books.off, st, input, side, rng) : cpuDefense(books.def, st, input, side, rng));
      const otherSide = (1 - you) as Side; const humanOther = !!other && sideOf(input, other.tgid) === otherSide;
      let myCall = mine && !cpuMine ? mine.play : callFor(you);
      if (mine && !cpuMine) { /* validate the member's play belongs to the book they are calling from */ const book = you === off ? books.off : books.def; if (!book.plays[String(mine.play)]) throw fail('That play is not in your playbook for this situation.', 400); }
      let theirCall: number | null = null;
      if (humanOther) {
        if (st.pending && st.pending.side === otherSide) theirCall = st.pending.play;
        else { st.pending = { side: you, play: myCall, tempo: mine?.tempo ?? st.tempo, by: member.blaze_id }; return false; }
      } else theirCall = callFor(otherSide);
      const calls = you === off ? { off: myCall, def: theirCall! } : { off: theirCall!, def: myCall };
      const tempo = off === you ? (mine?.tempo ?? st.tempo) : humanOther ? (st.pending?.tempo ?? st.tempo) : cpuTempo(st, off);
      const detail = runPlay(st, input, books, calls, rng, tempo); details.push(detail); st.pending = null; return true;
    };
    // coin toss: the away team calls it (the CPU calls for a CPU side); a human winner then picks receive / kick / defer
    const humanSide = (side: Side) => side === you || (!!other && sideOf(input, other.tgid) === side);
    const settleToss = (call: 'heads' | 'tails' | null, choice: TossChoice | null) => {
      const t = st.toss!; if (!t.result) coinToss(st, rng, call ?? (rng() < 0.5 ? 'heads' : 'tails'));
      const w = st.toss!.winner!; if (!humanSide(w)) tossChoice(st, input, cpuTossChoice(rng)); else if (choice) tossChoice(st, input, choice);
    };
    if (body.action === 'toss') {
      if (st.phase !== 'toss' || !st.toss) return reply({ error: 'The coin toss is over.' }, 409);
      const call = body.call === 'heads' || body.call === 'tails' ? body.call : null; const choice = ['receive', 'kick', 'defer'].includes(String(body.choice)) ? (body.choice as TossChoice) : null;
      if (!st.toss.result) {
        if (humanSide(st.toss.caller) && st.toss.caller !== you) return reply({ error: 'Waiting for the other coach to call the toss.' }, 409);
        if (st.toss.caller === you && !call) return reply({ error: 'Call heads or tails.' }, 400);
        settleToss(call, null);
      } else {
        if (st.toss.winner !== you) return reply({ error: 'The other coach won the toss and is choosing.' }, 409);
        if (!choice) return reply({ error: 'Choose to receive, kick or defer.' }, 400);
        settleToss(null, choice);
      }
    } else if (body.action === 'sub' || body.action === 'subreset') {
      // substitutions: put a player at a depth-chart slot of a position for the rest of this game (your team only)
      const team = input.teams[you]; const subs = (st.subs ??= [{}, {}]);
      if (body.action === 'subreset') subs[you] = {};
      else {
        const posN = Number(body.pos), depth = Math.max(0, Math.min(9, Number(body.depth) || 0)), pgid = Number(body.pgid);
        if (!Number.isInteger(posN) || posN < 0 || posN > 24) return reply({ error: 'Unknown position.' }, 400);
        if (!team.players.some((p) => p.id === pgid)) return reply({ error: 'That player is not on your roster.' }, 400);
        const current = subs[you][String(posN)] ?? team.depthChart.filter((d) => d.pos === posN).sort((a, b) => a.depth - b.depth).map((d) => d.pgid);
        const order = current.filter((id) => id !== pgid); order.splice(Math.min(depth, order.length), 0, pgid);
        subs[you][String(posN)] = order.slice(0, 12);
      }
    } else if (body.action === 'tempo') { if (['normal', 'hurry', 'chew'].includes(String(body.tempo))) st.tempo = body.tempo!; }
    else if (body.action === 'timeout') {
      if (st.phase === 'snap' && st.to[you] > 0 && st.running && !st.final) { st.to[you] -= 1; st.running = false; } else return reply({ error: 'No timeout available right now.' }, 400);
    } else if (body.action === 'play') {
      if (st.final) return reply({ error: 'The game is over.' }, 409);
      if (!Number.isInteger(body.play)) return reply({ error: 'Choose a play.' }, 400);
      if (st.pending && st.pending.side === you) return reply({ error: 'Your call is in; waiting for the other sideline.' }, 409);
      await resolve({ side: you, play: body.play!, tempo: ['normal', 'hurry', 'chew'].includes(String(body.tempo)) ? body.tempo! : st.tempo });
    } else if (body.action === 'auto') {
      // the CPU calls the member's plays too (skip ahead); bounded per request to keep each call short
      const n = Math.min(60, Math.max(1, Number(body.plays) || 1));
      if (st.phase === 'toss') settleToss(null, 'defer'); // simming from the start: the toss is called and a human winner defers
      for (let i = 0; i < n && !st.final; i++) { const ok = await resolve(null, true); if (!ok) break; }
    } else return reply({ error: 'Unknown action.' }, 400);
    // persist with the version guard
    let finalRun: Run | null = null;
    if (st.final && !run) {
      const id = crypto.randomUUID(); const result = buildResult(st, input); const envelope = buildEnvelope(st, input, { runId: id, blazeId: live.started_by, odId: dyn.od_id ?? 0 });
      const starter = input.ownedTeamId;
      await env.DB.prepare(`INSERT INTO supersim_games(id,dynasty_id,season_year,week,game_no,snapshot_id,blaze_id,owned_tgid,home_tgid,away_tgid,seed,input_json,result_json,envelope_json)
        SELECT ?,d.id,d.season_year,d.week,g.game_no,?,?,?,g.home_tgid,g.away_tgid,?,?,?,?
        FROM dynasties d JOIN games g ON g.dynasty_id=d.id AND g.season_year=d.season_year AND g.week=d.week
        WHERE d.id=? AND d.season_year=? AND d.week=? AND g.game_no=? AND g.status<2 AND g.home_tgid=? AND g.away_tgid=?
        ON CONFLICT(dynasty_id,season_year,week,game_no) DO NOTHING`)
        .bind(id, live.snapshot_id, live.started_by, starter, st.seed, JSON.stringify(slimInput(input)), JSON.stringify(result), JSON.stringify(envelope), dyn.id, dyn.season_year, dyn.week, game.game_no, game.home_tgid, game.away_tgid).run();
      finalRun = await env.DB.prepare('SELECT * FROM supersim_games WHERE dynasty_id=? AND season_year=? AND week=? AND game_no=?').bind(...key).first<Run>();
      if (!finalRun) return reply({ error: 'The schedule changed while the game was running (the console may have played it). The result was not recorded.' }, 409);
    }
    const upd = await env.DB.prepare("UPDATE supersim_live SET state_json=?, version=version+1, status=?, updated_at=CURRENT_TIMESTAMP WHERE dynasty_id=? AND season_year=? AND week=? AND game_no=? AND version=?").bind(JSON.stringify(st), st.final ? 'final' : 'live', ...key, live.version).run();
    if (!upd.meta.changes) return reply({ error: 'Another call landed first. Reloading…', stale: true }, 409);
    const row = await env.DB.prepare('SELECT * FROM supersim_live WHERE dynasty_id=? AND season_year=? AND week=? AND game_no=?').bind(...key).first<LiveRow>();
    const out = await payload(row, { details, detail: details[details.length - 1] ?? null, waiting: !!st.pending });
    if (finalRun) out.final = { id: finalRun.id, status: finalRun.status, result: JSON.parse(finalRun.result_json) };
    return reply(out);
  } catch (e: unknown) { const err = e as { status?: number; message?: string }; return reply({ error: err.status ? err.message : `Supersim error: ${err.message ?? 'unknown'}` }, err.status || 500); }
}

/** Call only AFTER bridgeAuthorized() in handleBridge. The signed result never comes from a browser. */
export async function handleSupersimBridge(req: Request, env: SimEnv, path: string[]): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'GET') {
    const od = Number(url.searchParams.get('od')); if (!Number.isSafeInteger(od) || od <= 0) return reply({ error: 'Valid od required' }, 400);
    const rows = await env.DB.prepare("SELECT s.id,s.status,s.envelope_json FROM supersim_games s JOIN dynasties d ON d.id=s.dynasty_id WHERE d.od_id=? AND s.status IN ('pending','accepted') ORDER BY s.created_at LIMIT 50").bind(od).all<{ id: string; status: string; envelope_json: string }>();
    return reply({ runs: rows.results.map((r) => ({ id: r.id, status: r.status, envelope: JSON.parse(r.envelope_json) })) });
  }
  if (req.method === 'POST' && path[1] && path[2] === 'receipt') {
    const body = (await req.json()) as { status?: string; proof?: unknown }; if (!['accepted', 'synced', 'conflict'].includes(body.status || '')) return reply({ error: 'Invalid receipt' }, 400);
    if (!body.proof) return reply({ error: 'Receipt proof required' }, 400);
    const status = body.status!;
    await env.DB.prepare(`UPDATE supersim_games SET status=?,receipt_json=?,accepted_at=CASE WHEN ?='accepted' THEN CURRENT_TIMESTAMP ELSE accepted_at END,synced_at=CASE WHEN ?='synced' THEN CURRENT_TIMESTAMP ELSE synced_at END WHERE id=? AND (status='pending' OR (status='accepted' AND ? IN ('synced','conflict')))`).bind(status, JSON.stringify(body.proof), status, status, path[1], status).run();
    return reply({ ok: true });
  }
  return reply({ error: 'Not found' }, 404);
}
