// Quickplay: a whole Supersim game played in the browser, with no dynasty, no account and nothing sent to a server.
// Source for worker/public/js/supersim/quickplay.js (bundled with the engine: `npm run build:quickplay -w worker`).
//
// coach.js talks to it through api(method, body) in place of the dynasty data endpoint (data-endpoint="local" on the
// page shell): the same requests, the same payload. The two teams come from the static Quickplay rosters
// (/data/quickplay/<tgid>.json, tools/quickplay-data.mts), the game runs on the same engine and play loop as a dynasty
// game (coach/engine.ts, coach/session.ts), and the state is kept in sessionStorage so a refresh resumes it.
//
// Page parameters: ?away=<tgid>&home=<tgid>&side=away|home|watch&q=<minutes per quarter>
import { newGame, mulberry32 } from '../src/supersim/coach/engine.ts';
import { act } from '../src/supersim/coach/session.ts';
import { buildResult } from '../src/supersim/coach/result.ts';

const params = new URLSearchParams(location.search);
const AWAY = Number(params.get('away')), HOME = Number(params.get('home'));
const SIDE = params.get('side') === 'home' ? 1 : 0; // a watched (CPU against CPU) game is driven from the away sideline
export const WATCH = params.get('side') === 'watch';
const MINUTES = [3, 5, 8, 12].includes(Number(params.get('q'))) ? Number(params.get('q')) : 5;
const KEY = `quickplay:${AWAY}:${HOME}:${params.get('side') || 'away'}:${MINUTES}`;
const DATA = '/data/quickplay/', BOOKS = '/data/playbooks/';

const fail = (msg, status, data) => Object.assign(new Error(msg), { status, data });
const json = async (url) => { const r = await fetch(url, { credentials: 'same-origin' }); if (!r.ok) throw fail(`Could not load ${url} (${r.status}).`, r.status); return r.json(); };

let game = null; // { input, st, version }
const books = new Map(); const book = (id) => { let p = books.get(id); if (!p) { p = json(`${BOOKS}${id}.json`); books.set(id, p); p.catch(() => books.delete(id)); } return p; };
const booksFor = async (input, st) => { const off = st.phase === 'kickoff' ? st.kicking : st.off; const [o, d] = await Promise.all([book(input.teams[off].offBook), book(input.teams[1 - off].defBook)]); return { off: o, def: d }; };

async function load() {
  if (game) return game;
  if (!Number.isInteger(AWAY) || !Number.isInteger(HOME) || AWAY === HOME) throw fail('Pick two different teams on the Quickplay page.', 400);
  const [away, home] = await Promise.all([json(`${DATA}${AWAY}.json`), json(`${DATA}${HOME}.json`)]);
  away.kit = away.kits?.away; home.kit = home.kits?.home; // the visitors wear their Away set, the home side its Home set
  const input = { dynasty: 'Quickplay', dynastyId: 0, season: 2026, week: 0, gameNo: 0, gameId: `quickplay-${AWAY}-${HOME}`, snapshot: null, ownedTeamId: [away, home][SIDE].id, quarterSeconds: MINUTES * 60, teams: [away, home], backUrl: `/quickplay?away=${AWAY}&home=${HOME}`, home: home.id, away: away.id };
  let st = null, version = 0;
  try { const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (saved?.st?.v === 2) { st = saved.st; version = saved.version || 1; } } catch { /* start fresh */ }
  return (game = { input, st, version });
}
function save() { try { if (game.st) sessionStorage.setItem(KEY, JSON.stringify({ st: game.st, version: game.version })); else sessionStorage.removeItem(KEY); } catch { /* storage full or blocked: the game still plays, it just will not survive a refresh */ } }

function payload(extra = {}) {
  const { input, st, version } = game; const you = SIDE;
  return {
    quick: true, input, you, watch: false, drive: false, bracket: null, controls: [you], coaches: WATCH ? ['CPU', 'CPU'] : you === 0 ? ['You', 'CPU'] : ['CPU', 'You'], opponentHuman: false,
    books: { off: [input.teams[0].offBook, input.teams[1].offBook], def: [input.teams[0].defBook, input.teams[1].defBook] }, bookUrls: { off: [null, null], def: [null, null] },
    state: st ? { ...st, pending: undefined, recent: undefined, decision: st.decision ? { ...st.decision, alt: undefined } : undefined } : null, recent: st?.recent ?? [], pendingSide: null, pendingMine: false, version, status: st ? (st.final ? 'final' : 'live') : null,
    final: st?.final ? { id: st.id, status: 'quickplay', result: buildResult(st, input) } : null, now: Date.now(), ...extra,
  };
}

// the same contract as the dynasty data endpoint: GET returns the payload; POST { action, ... } applies it
export async function api(method, body) {
  await load();
  if (method === 'GET' || !body) return payload();
  const { input } = game;
  if (body.action === 'start') {
    if (!game.st) { const seed = crypto.getRandomValues(new Uint32Array(1))[0]; game.st = { ...newGame(input, seed, `qp-${seed.toString(36)}`, { toss: true }), pending: null }; game.version = 1; save(); }
    return payload();
  }
  if (!game.st) throw fail('No game in progress. Start one first.', 409);
  if (body.action === 'abandon') { game.st = null; game.version = 0; save(); return payload(); }
  if (game.st.final) return payload();
  // work on a copy, so an action that is refused leaves the game untouched
  const st = structuredClone(game.st); const rng = mulberry32(crypto.getRandomValues(new Uint32Array(1))[0]);
  const { details, waiting } = await act({ input, st, you: SIDE, humanOther: false, by: 0, rng, books: (s) => booksFor(input, s) }, body);
  game.st = st; game.version += 1; save();
  return payload({ details, detail: details[details.length - 1] ?? null, waiting });
}
