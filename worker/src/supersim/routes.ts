// Supersim (coaching mode): the member calls every play of their own team's current-week game from the team's real
// NCAA 14 playbook; the server resolves one snap per request with fresh randomness, keeps the live game in
// supersim_live and, at the final whistle, writes the official result into supersim_games (the outbox the league
// server polls, unchanged from v1). The other sideline is the CPU unless that team belongs to another member, in
// which case both members call their plays and the snap resolves when the second call arrives. Any other signed-in
// member can watch a game that has a live row (live or final): the same payload, read-only, polled by the browser.
//
//   GET  /d/<slug>/supersim                        page shell (coach.js + coach.css): your current-week game
//   GET  /d/<slug>/supersim/<week>/<game_no>       page shell for that game (coach it when it is yours, else watch)
//   GET  /d/<slug>/supersim/watch/<week>/<game_no> page shell, watching
//   GET  /d/<slug>/supersim/data[?game=<week>:<game_no>[&watch=1]]
//        { input, you, watch, controls, coaches, opponentHuman, books, bookUrls, state, recent, version, final, liveGames? }
//        books: stock book ids per side [away, home]; bookUrls: the same shape, the URL of a team's composed book
//        (/d/<slug>/playbook/<tgid>/<off|def>.json) where its coach saved playbook edits, else null (load the stock book)
//        or, for a member with no game to show, { noGame: message, liveGames }
//   POST /d/<slug>/supersim/data[?game=...]  { action: 'start' | 'play' | 'auto' | 'delay' | 'timeout' | 'tempo' | 'abandon', version, play?, tempo?, plays?, elapsed? }
//
// The clocks are real in a coached game against the CPU: the play clock starts when the previous play is over and the
// game clock runs through it when it was left running. The browser counts down and sends how long the coach took
// (elapsed); the server charges at least the time it saw itself (minus the playback it allowed for), so the reading at
// the snap is what the coach watched. A CPU offense snaps at a point rolled when the huddle starts (state.huddle.cpuAt),
// which the browser counts down to. When the play clock runs out on the coach, the browser sends 'delay' and the
// engine applies the delay of game (or the end of the period). Games between two members keep the tempo model.
import type { Env } from '../env.js';
import type { Dynasty, GameRow, MemberRow } from '../db/queries.js';
import { getMembers, getGames, getGame, getTeam, getTeams, teamMap, getPlayers, getCoaches, getDepthChart, getFormationSubs, getPendingDepthEdit, listPendingPlayerEdits, type FormationSub } from '../db/queries.js';
import { teamLogoUrl, headshotUrl } from '../pages/common.js';
import { syntheticRoster, autoDepthChart } from './generic.js';
import { html, page } from '../html.js';
import { recordLines } from '../odds.js';
import { allowedGame, sameOrigin } from './access.js';
import { bracketGameFor, bracketControls, finishBracketGame, type BracketGame } from './playoff-games.js';
import { loadBook, loadIndex, teamBooks, loadTeamBook, composeEdits } from './coach/books.js';
import { playbookJsonUrl } from '../pages/playbook-edit.js';
import type { BookEdits } from '@ncaa/ncaa14';
import { newGame, mulberry32, type Rng } from './coach/engine.js';
import { act, actingOff, RECENT_PLAYS, type ActionBody, type ActionError, type LiveState } from './coach/session.js';
export { RECENT_PLAYS };
import { buildResult, buildEnvelope, sideOf } from './coach/result.js';
import type { Book, GameInput, GameState, PlayDetail, PlayerInput, Side, TeamInput } from './coach/types.js';

export type SimEnv = Env & { SUPERSIM_SESSION_SECRET?: string; SUPERSIM_ENABLED?: string; SUPERSIM_QUARTER_SECONDS?: string };
export const actionSeed = (seed: number, n: number, version: number) => (Math.imul((seed >>> 0) ^ 0x9e3779b9, 2654435761) ^ Math.imul(n + 1, 0x85ebca6b) ^ Math.imul(version + 1, 0xc2b2ae35)) >>> 0;
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store', vary: 'Cookie', 'x-content-type-options': 'nosniff' } });
const fail = (msg: string, status: number) => Object.assign(new Error(msg), { status });
// The stored input also freezes each team's playbook edits (web_playbook_edits, the site's Playbook page) as they stood at
// kickoff, per side ([away, home]), so a game is played from one book throughout; the browser gets bookUrls instead
// (slimInput). null: the team runs its stock book (offBook / defBook).
type BookEditsPair = { off: BookEdits | null; def: BookEdits | null };
export type SimInput = GameInput & { bookEdits?: [BookEditsPair, BookEditsPair] };
type Run = { id: string; status: string; input_json: string; result_json: string; envelope_json: string };
type LiveRow = { dynasty_id: number; season_year: number; week: number; game_no: number; snapshot_id: number; home_tgid: number; away_tgid: number; started_by: number; status: string; version: number; input_json: string; state_json: string };

// A game named explicitly: ?game=<week>:<game_no> on the data endpoint, /supersim/<week>/<game_no> as a page.
export interface GameKey { week: number; gameNo: number }
export const parseGameKey = (s: string | null | undefined): GameKey | null => { const m = /^(\d{1,3}):(\d{1,4})$/.exec(s ?? ''); return m ? { week: Number(m[1]), gameNo: Number(m[2]) } : null; };

/** May this member coach this game? Today: their own team's game in the dynasty's current week (allowedGame). The
 *  playoff rounds will relax the current-week rule here; watching is decided separately (any member, any live row). */
export function coachAccess(dyn: Dynasty, member: MemberRow | null | undefined, game: GameRow | null | undefined): boolean {
  return !!member && !!game && allowedGame(dyn, member, game);
}
// who coaches a team: the member who owns it (a web-only member's team included), else the CPU
const coachOf = (members: MemberRow[], tgid: number) => members.find((m) => m.tgid === tgid);
const coachNames = (members: MemberRow[], away: number, home: number): [string, string] => [coachOf(members, away)?.persona ?? 'CPU', coachOf(members, home)?.persona ?? 'CPU'];

// bracket: the FCS playoff game this row carries (worker/src/supersim/playoff-games.ts); drive: a member who is in neither
// team starts a CPU-vs-CPU bracket game and lets it play out (start / auto / abandon only, shown as a spectator)
export interface Current { member: MemberRow; members: MemberRow[]; game: GameRow; run: Run | null; live: LiveRow | null; other: MemberRow | undefined; watch: boolean; bracket: BracketGame | null; drive: boolean }
// Identity: the acting member resolved by the site's session layer (signed-in account once the dynasty is locked).
// Without a key: the member's own current-week game, to coach. With a key: that game, coached when coachAccess allows
// it (and forceWatch is off), else watched, which needs a supersim_live row. Errors flagged noGame carry the members
// so the GET can answer with the live-games list instead.
export async function resolveCurrent(env: SimEnv, dyn: Dynasty, acting: MemberRow | null, key: GameKey | null = null, forceWatch = false): Promise<Current> {
  if (!acting) throw fail('Sign in as a dynasty member to coach your game.', 401);
  const members = await getMembers(env.DB, dyn.id);
  const member = members.find((m) => m.blaze_id === acting.blaze_id);
  if (!member) throw fail('You are not a member of this dynasty.', 403);
  const noGame = (msg: string, status = 403) => Object.assign(fail(msg, status), { noGame: true, members });
  let game: GameRow | undefined;
  if (key) { game = (await getGame(env.DB, dyn.id, dyn.season_year, key.week, key.gameNo)) ?? undefined; if (!game) throw noGame('No such game this season.', 404); }
  else { const games = await getGames(env.DB, dyn.id, dyn.season_year, { week: dyn.week, tgid: member.tgid }); if (games.length === 1) game = games[0]; }
  const bracket = key && game ? await bracketGameFor(env.DB, dyn, game) : null;
  if (bracket && game) { // an FCS playoff game: coached by the members whose teams are in it, driven by any member when both are CPU
    const live = await env.DB.prepare('SELECT * FROM supersim_live WHERE dynasty_id=? AND season_year=? AND week=? AND game_no=?').bind(dyn.id, dyn.season_year, game.week, game.game_no).first<LiveRow>();
    const c = bracketControls(bracket, member, members);
    const coaching = !forceWatch && bracket.open && c.sides.length > 0;
    const drive = !forceWatch && bracket.open && !coaching && c.mayStart;
    if (!coaching && !drive) {
      if (!live) throw noGame(bracket.open ? 'This playoff game has not started yet.' : 'This playoff game is over.', 404);
      return { member, members, game, run: null, live, other: undefined, watch: true, bracket, drive: false };
    }
    const other = coaching ? coachOf(members, game.home_tgid === member.tgid ? game.away_tgid : game.home_tgid) : undefined;
    return { member, members, game, run: null, live, other, watch: false, bracket, drive };
  }
  const coaching = !!game && !forceWatch && coachAccess(dyn, member, game);
  if (!game || (!key && !coaching)) throw noGame('No eligible current-week game for your team (bye week, offseason, or missing membership).');
  const run = await env.DB.prepare('SELECT * FROM supersim_games WHERE dynasty_id=? AND season_year=? AND week=? AND game_no=?').bind(dyn.id, dyn.season_year, game.week, game.game_no).first<Run>();
  const live = await env.DB.prepare('SELECT * FROM supersim_live WHERE dynasty_id=? AND season_year=? AND week=? AND game_no=?').bind(dyn.id, dyn.season_year, game.week, game.game_no).first<LiveRow>();
  if (!coaching) { // a spectator: any member may watch a game that is (or was) played in Supersim; nothing is written
    if (!live) throw noGame('This game is not being played in Supersim.', 404);
    return { member, members, game, run, live, other: undefined, watch: true, bracket: null, drive: false };
  }
  if (game.status >= 2 && !run) throw fail('This game has already been completed on the console.', 409);
  const other = coachOf(members, game.home_tgid === member.tgid ? game.away_tgid : game.home_tgid);
  // a web-only member's team is a CPU team to the console: a game against a console member is that member's to play there
  if (member.web_only === 1 && !run && !live) {
    if (members.some((m) => m.web_only !== 1 && m.tgid === member.tgid)) throw fail('A console member now controls your team, so its games are played on the console.', 409);
    if (other && other.web_only !== 1) throw fail(`${other.persona} coaches your opponent on the console, so this game is played there.`, 409);
  }
  return { member, members, game, run, live, other, watch: false, bracket: null, drive: false };
}
// Coached games use 12-minute quarters (SUPERSIM_QUARTER_SECONDS overrides), independent of the dynasty's console setting.
const quarterSecondsFor = (env: SimEnv, _dyn: Dynasty) => { const q = Number(env.SUPERSIM_QUARTER_SECONDS); return Number.isFinite(q) && q >= 60 && q <= 900 ? q : 720; };

// The dynasty's games being coached right now (status 'live', this season), for the start screen's Watch list.
export interface LiveTeam { tgid: number; name: string; abbr: string; logo: string }
export interface LiveGame { week: number; gameNo: number; home: LiveTeam; away: LiveTeam; score: [number, number]; q: number; clock: number; coaches: [string, string] }
type LiveListRow = { week: number; game_no: number; home_tgid: number; away_tgid: number; a: number | null; h: number | null; q: number | null; clock: number | null };
export async function listLiveGames(env: SimEnv, dyn: Dynasty, members: MemberRow[]): Promise<LiveGame[]> {
  const rows = (await env.DB.prepare("SELECT week, game_no, home_tgid, away_tgid, json_extract(state_json,'$.score[0]') AS a, json_extract(state_json,'$.score[1]') AS h, json_extract(state_json,'$.q') AS q, json_extract(state_json,'$.clock') AS clock FROM supersim_live WHERE dynasty_id=? AND season_year=? AND status='live' ORDER BY week, game_no").bind(dyn.id, dyn.season_year).all<LiveListRow>()).results;
  if (!rows.length) return [];
  const teams = teamMap(await getTeams(env.DB, dyn.id));
  const team = (tgid: number): LiveTeam => { const t = teams.get(tgid); return { tgid, name: t?.name ?? `Team ${tgid}`, abbr: t?.abbr ?? '?', logo: t ? teamLogoUrl(t, 'lg') : '' }; };
  return rows.map((r) => ({ week: r.week, gameNo: r.game_no, home: team(r.home_tgid), away: team(r.away_tgid), score: [r.a ?? 0, r.h ?? 0], q: r.q ?? 1, clock: r.clock ?? 0, coaches: coachNames(members, r.away_tgid, r.home_tgid) }));
}

export async function buildInput(env: SimEnv, dyn: Dynasty, game: GameRow, ownedTeamId: number, origin: string): Promise<SimInput> {
  const index = await loadIndex(env.ASSETS, origin);
  const edits = await listPendingPlayerEdits(env.DB, dyn.id); // site edits the console has not loaded yet count here
  const built = await Promise.all([game.away_tgid, game.home_tgid].map(async (tgid): Promise<{ team: TeamInput; bookEdits: BookEditsPair }> => {
    const [team, players, consoleChart, consoleSubs, pendingChart] = await Promise.all([getTeam(env.DB, dyn.id, tgid), getPlayers(env.DB, dyn.id, tgid), getDepthChart(env.DB, dyn.id, tgid, dyn.current_snapshot_id), getFormationSubs(env.DB, dyn.id, tgid, dyn.current_snapshot_id), getPendingDepthEdit(env.DB, dyn.id, tgid, dyn.season_year, dyn.week ?? 0)]);
    if (!team) throw fail('Team missing from the current snapshot.', 409);
    // the head coach's run/pass lean for CPU play-calling (COCH sim tendency, taken as 0 run .. 100 pass; missing = balanced)
    const hc = await getCoaches(env.DB, dyn.id, tgid).then((cs) => cs.find((c) => c.position_code === 0)).catch(() => undefined);
    const lean = Number((hc as { sim_rp_off?: number } | undefined)?.sim_rp_off); const runPass = Number.isFinite(lean) && lean >= 0 && lean <= 100 ? lean : undefined;
    // a pending redshirt / position / jersey change applies at once (a transfer the game sat down plays once un-redshirted)
    for (const e of edits) { if (e.tgid !== tgid) continue; const p = players.find((x) => x.pgid === e.pgid); if (!p) continue; if (e.redshirt !== null) p.redshirt = e.redshirt; if (e.pos !== null) p.pos = e.pos; if (e.jersey !== null) p.jersey = e.jersey; }
    // the pending depth chart and formation subs from the site's Depth Chart page, else the console's own
    let depthChart = consoleChart; let fsubs: Record<string, number> | undefined;
    const subKey = (side: 'o' | 'd', set: number, slot: number) => `${side}:${set}:${slot}`;
    if (pendingChart) {
      try {
        const c = JSON.parse(pendingChart.chart_json) as Record<string, number[]>; const subs = JSON.parse(pendingChart.subs_json) as FormationSub[];
        depthChart = Object.entries(c).flatMap(([pos, ids]) => ids.map((pgid, depth) => ({ pos: Number(pos), depth, pgid })).filter((r) => r.pgid > 0));
        if (subs.length) fsubs = Object.fromEntries(subs.map((s) => [subKey(s.side === 'off' ? 'o' : 'd', s.set, s.slot), s.pgid]));
      } catch { /* malformed edit: the console's chart */ }
    } else if (consoleSubs.length) fsubs = Object.fromEntries(consoleSubs.map((s) => [subKey(s.side === 1 ? 'o' : 'd', s.set_id, s.slot), s.pgid]));
    let raw: Record<string, unknown> | null = null; try { raw = JSON.parse(team.raw_json || 'null'); } catch { /* ignore */ }
    const books = teamBooks(index, raw); // the stock book ids stay the browser's `books`; edits saved on the Playbook page ride along frozen (bookEdits)
    const [offTb, defTb] = await Promise.all([loadTeamBook(env, origin, dyn.id, team, 'off'), loadTeamBook(env, origin, dyn.id, team, 'def')]);
    const bookEdits: BookEditsPair = { off: offTb.custom ? offTb.edits : null, def: defTb.custom ? defTb.edits : null };
    const eligible = players.filter((p) => p.redshirt !== 1);
    let roster: PlayerInput[] = eligible.map((p) => ({ id: p.pgid, name: `${p.first_name} ${p.last_name}`, number: p.jersey, photoUrl: headshotUrl(p), pos: p.pos, overall: p.overall, ratings: JSON.parse(p.ratings_json || '{}') }));
    // the game keeps no roster (and no depth chart) for the generic FCS slots; Supersim plays them with placeholders
    const synthetic = roster.length === 0;
    if (synthetic) { roster = syntheticRoster(tgid, `${dyn.id}:${dyn.season_year}`); depthChart = autoDepthChart(roster); }
    else if (!depthChart.length) depthChart = autoDepthChart(roster);
    if (!depthChart.length) throw fail(`Depth chart missing for ${team.name}; sync the dynasty before simulating.`, 409);
    return { team: { id: tgid, name: team.name, abbr: team.abbr, logo: teamLogoUrl(team, 'lg'), offBook: books.offBook, defBook: books.defBook, depthChart, ...(fsubs ? { fsubs } : {}), players: roster, ...(synthetic ? { synthetic: true } : {}), ...(runPass !== undefined ? { runPass } : {}) }, bookEdits };
  }));
  const [away, home] = built as [typeof built[number], typeof built[number]];
  const anyEdits = built.some((b) => b.bookEdits.off || b.bookEdits.def);
  return { dynasty: dyn.name, dynastyId: dyn.id, season: dyn.season_year, week: game.week, gameNo: game.game_no, gameId: `${dyn.id}:${dyn.season_year}:${game.week}:${game.game_no}`, snapshot: dyn.current_snapshot_id, ownedTeamId, quarterSeconds: quarterSecondsFor(env, dyn), teams: [away.team, home.team], backUrl: `/d/${dyn.slug}/game/${game.week}/${game.game_no}`, home: game.home_tgid, away: game.away_tgid, ...(anyEdits ? { bookEdits: [away.bookEdits, home.bookEdits] as [BookEditsPair, BookEditsPair] } : {}) };
}
// the browser does not need every rating (they stay in the stored input for the engine) nor the frozen playbook edits (it
// loads the composed book from bookUrls): strip them
const slimInput = ({ bookEdits: _e, ...input }: SimInput) => ({ ...input, teams: input.teams.map((t) => ({ ...t, players: t.players.map(({ ratings: _r, ...p }) => p) })) });
// where the browser loads a team's book of one side: the composed book when the team's edits were frozen into this game, else null (the stock book by id)
const bookUrls = (slug: string, input: SimInput): { off: [string | null, string | null]; def: [string | null, string | null] } => {
  const one = (side: Side, kind: 'off' | 'def') => (input.bookEdits?.[side]?.[kind] ? playbookJsonUrl(slug, input.teams[side].id, kind) : null);
  return { off: [one(0, 'off'), one(1, 'off')], def: [one(0, 'def'), one(1, 'def')] };
};

// The book one sideline plays from, as frozen at kickoff: composed from the edits in the live input (cached per isolate by
// live game and side), else the stock book by id. Edits that stop composing mid-game fall back to the stock book.
const frozen = new Map<string, Promise<Book>>();
function sideBook(env: SimEnv, origin: string, input: SimInput, st: GameState, side: Side, kind: 'off' | 'def'): Promise<Book> {
  const t = input.teams[side]; const stockId = kind === 'off' ? t.offBook : t.defBook; const edits = input.bookEdits?.[side]?.[kind];
  if (!edits) return loadBook(env.ASSETS, origin, stockId);
  const key = `${st.id}:${side}:${kind}`; let p = frozen.get(key);
  if (!p) {
    p = composeEdits(env.ASSETS, origin, edits).catch((e: Error) => { console.error(`frozen playbook edits of game ${st.id} (${kind}, side ${side}) do not compose; using the stock book: ${e.message}`); return loadBook(env.ASSETS, origin, stockId); });
    if (frozen.size > 64) frozen.clear();
    frozen.set(key, p); p.catch(() => frozen.delete(key));
  }
  return p;
}
async function booksFor(env: SimEnv, origin: string, input: SimInput, st: GameState): Promise<{ off: Book; def: Book }> {
  const off: Side = st.phase === 'kickoff' ? st.kicking! : st.off; const def = (1 - off) as Side;
  const [o, d] = await Promise.all([sideBook(env, origin, input, st, off, 'off'), sideBook(env, origin, input, st, def, 'def')]);
  return { off: o, def: d };
}

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'";
// rest: the path parts after `resource` (/supersim/<week>/<game_no> -> resource '<week>', rest ['<game_no>'];
// /supersim/watch/<week>/<game_no> -> resource 'watch', rest ['<week>', '<game_no>'])
export async function handleSupersim(req: Request, env: SimEnv, dyn: Dynasty, resource: string | undefined, acting: MemberRow | null, rest: string[] = []): Promise<Response> {
  const url = new URL(req.url); const origin = url.origin;
  try {
    if (env.SUPERSIM_ENABLED !== 'true') return reply({ error: 'Supersim is disabled for this site.' }, 503);
    if (resource !== 'data') { // page shells: your current game, a named game to coach, a named game to watch
      if (req.method !== 'GET') return reply({ error: 'Not found' }, 404);
      const watch = resource === 'watch'; const parts = resource === undefined ? [] : watch ? rest : [resource, ...rest];
      if (parts.length !== (resource === undefined ? 0 : 2) || !parts.every((p) => /^\d{1,4}$/.test(p))) return reply({ error: 'Not found' }, 404);
      const query = parts.length ? `?game=${Number(parts[0])}:${Number(parts[1])}${watch ? '&watch=1' : ''}` : '';
      return page(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Supersim | ${dyn.name}</title><link rel="stylesheet" href="/css/coach.css"></head><body><div id="coach" data-endpoint="/d/${dyn.slug}/supersim/data${query}" data-mode="${watch ? 'watch' : 'coach'}" data-books="/data/playbooks/" data-back="/d/${dyn.slug}"></div><script type="module" src="/js/supersim/coach.js"></script></body></html>`, 200, { 'cache-control': 'private, no-store', vary: 'Cookie', 'content-security-policy': CSP });
    }
    if (rest.length) return reply({ error: 'Not found' }, 404);
    const keyParam = url.searchParams.get('game'); const gameKey = parseGameKey(keyParam);
    if (keyParam !== null && !gameKey) return reply({ error: 'Bad game key; use ?game=<week>:<game_no>.' }, 400);
    let cur: Current;
    try { cur = await resolveCurrent(env, dyn, acting, gameKey, url.searchParams.get('watch') === '1'); }
    catch (e) { // nothing to coach or watch here: a signed-in member still gets the start screen with the live games
      const err = e as { noGame?: boolean; members?: MemberRow[]; message?: string };
      if (req.method === 'GET' && err.noGame && err.members) return reply({ noGame: err.message, liveGames: await listLiveGames(env, dyn, err.members), now: Date.now() });
      throw e;
    }
    const { member, members, game, run, live, other, watch, bracket, drive } = cur;
    const payload = async (liveRow: LiveRow | null, extra: Record<string, unknown> = {}) => {
      const input: SimInput = liveRow ? JSON.parse(liveRow.input_json) : await buildInput(env, dyn, game, member.tgid, origin);
      const st: LiveState | null = liveRow ? JSON.parse(liveRow.state_json) : null;
      const you = watch || drive ? null : sideOf(input, member.tgid);
      const pending = st?.pending ?? null;
      // a bracket game's final lives in the playoff state, not the console outbox
      const bracketFinal = bracket && st && liveRow?.status === 'final' ? { id: st.id, status: 'playoff', result: buildResult(st, input) } : null;
      const coaches = coachNames(members, input.teams[0].id, input.teams[1].id);
      return { input: slimInput(input), you, watch: watch || drive, drive, bracket: bracket ? { round: bracket.game.round, idx: bracket.game.idx, open: bracket.open } : null, controls: you === null ? [] : [you], coaches, opponentHuman: watch ? coaches.every((c) => c !== 'CPU') : !!other, books: { off: [input.teams[0].offBook, input.teams[1].offBook], def: [input.teams[0].defBook, input.teams[1].defBook] }, bookUrls: bookUrls(dyn.slug, input), state: st ? { ...st, seed: st.final ? st.seed : 0, pending: undefined, recent: undefined, decision: st.decision ? { ...st.decision, alt: undefined } : undefined } : null, recent: st?.recent ?? [], pendingSide: pending ? pending.side : null, pendingMine: pending ? pending.by === member.blaze_id : false, version: liveRow?.version ?? 0, status: liveRow?.status ?? null, final: run ? { id: run.id, status: run.status, result: JSON.parse(run.result_json) } : bracketFinal, now: Date.now(), ...extra };
    };
    if (req.method === 'GET') return reply(await payload(live, live ? {} : { liveGames: await listLiveGames(env, dyn, members) }));
    if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
    if (!sameOrigin(req)) return reply({ error: 'Same-origin JSON request required.' }, 403);
    if (watch) return reply({ error: 'You are watching this game; only its two coaches can act.' }, 403);
    const text = await req.text(); if (text.length > 4096) return reply({ error: 'Request too large' }, 413);
    const body = JSON.parse(text) as ActionBody;
    const key = [dyn.id, dyn.season_year, game.week, game.game_no] as const;
    if (drive && !['start', 'auto', 'abandon'].includes(String(body.action))) return reply({ error: 'This playoff game is between two CPU teams: start it and let it play out; nobody calls its plays.' }, 403);
    if (bracket && !bracket.open) return reply({ error: 'This playoff game is over.' }, 409);
    if (body.action === 'start') {
      if (run) return reply({ error: 'This game already has an official result.' }, 409);
      if (live) return reply(await payload(live));
      const input = await buildInput(env, dyn, game, member.tgid, origin);
      if (bracket) input.backUrl = `/d/${dyn.slug}/bracket`;
      if (dyn.od_id === null) return reply({ error: 'Supersim requires an online dynasty.' }, 409);
      const seed = crypto.getRandomValues(new Uint32Array(1))[0]!; const id = crypto.randomUUID();
      const st: LiveState = { ...newGame(input, seed, id, { toss: true }), pending: null };
      await env.DB.prepare('INSERT OR IGNORE INTO supersim_live(dynasty_id,season_year,week,game_no,snapshot_id,home_tgid,away_tgid,started_by,input_json,state_json) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(...key, dyn.current_snapshot_id ?? 0, game.home_tgid, game.away_tgid, member.blaze_id, JSON.stringify(input), JSON.stringify(st)).run();
      const row = await env.DB.prepare('SELECT * FROM supersim_live WHERE dynasty_id=? AND season_year=? AND week=? AND game_no=?').bind(...key).first<LiveRow>();
      await recordLines(env.DB, dyn); // kickoff: the line this game closes at
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
    const input: SimInput = JSON.parse(live.input_json); const st: LiveState = JSON.parse(live.state_json);
    const you: Side | null = sideOf(input, member.tgid) ?? (drive ? 0 : null); if (you === null) return reply({ error: 'You are not part of this game.' }, 403); // a driver stands in on the away sideline; the CPU calls both
    // each action's randomness comes from the game's own seed and the action's place in the game (play number and stored
    // version), so a finished game can be re-run exactly from its seed and calls; the seed never leaves the server while
    // the game is live (payload), so nothing can be read ahead
    const rng: Rng = mulberry32(actionSeed(st.seed, st.n, live.version));
    const otherSide = (1 - you) as Side; const humanOther = !!other && sideOf(input, other.tgid) === otherSide;
    // the action itself (coach/session.ts: the same code Quickplay runs in the browser); the state is changed in place
    let details: PlayDetail[];
    try { ({ details } = await act({ input, st, you, humanOther, by: member.blaze_id, rng, books: (s) => booksFor(env, origin, input, s) }, body)); }
    catch (e) { const err = e as ActionError; if (err.stale) return reply({ error: err.message, stale: true, ...(await payload(live)) }, err.status); throw e; }
    // persist with the version guard
    let finalRun: Run | null = null;
    if (st.final && !run && bracket) { // the playoff bracket takes the final (and the next round follows); nothing goes to the console outbox
      const state = await finishBracketGame(env.DB, dyn, game, st, input, st.id);
      if (!state) return reply({ error: 'The bracket moved on while this game was running; the result was not recorded.' }, 409);
    } else if (st.final && !run) {
      const id = crypto.randomUUID(); const result = buildResult(st, input); const envelope = buildEnvelope(st, input, { runId: id, blazeId: live.started_by, odId: dyn.od_id ?? 0, webMember: members.find((m) => m.blaze_id === live.started_by)?.web_only === 1 });
      const starter = input.ownedTeamId;
      await env.DB.prepare(`INSERT INTO supersim_games(id,dynasty_id,season_year,week,game_no,snapshot_id,blaze_id,owned_tgid,home_tgid,away_tgid,seed,input_json,result_json,envelope_json)
        SELECT ?,d.id,d.season_year,d.week,g.game_no,?,?,?,g.home_tgid,g.away_tgid,?,?,?,?
        FROM dynasties d JOIN games g ON g.dynasty_id=d.id AND g.season_year=d.season_year AND g.week=d.week
        WHERE d.id=? AND d.season_year=? AND d.week=? AND g.game_no=? AND g.status<2 AND g.home_tgid=? AND g.away_tgid=?
        ON CONFLICT(dynasty_id,season_year,week,game_no) DO NOTHING`)
        .bind(id, live.snapshot_id, live.started_by, starter, st.seed, JSON.stringify(slimInput(input)), JSON.stringify(result), JSON.stringify(envelope), dyn.id, dyn.season_year, game.week, game.game_no, game.home_tgid, game.away_tgid).run();
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
