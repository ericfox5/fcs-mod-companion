// Supersim over HTTP: two members on opposite sidelines of one game (calls pending until the second lands), a third
// member watching, and the final recorded once. Drives handleSupersim against an in-memory D1 (fake-d1.ts) and the
// real playbooks (skipped when they are absent: run `npx tsx tools/playbooks-extract.mts` first).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { handleSupersim, coachAccess, parseGameKey, RECENT_PLAYS, type SimEnv } from '../src/supersim/routes.js';
import type { Dynasty, GameRow, MemberRow } from '../src/db/queries.js';
import { cpuOffense, cpuDefense } from '../src/supersim/coach/cpu.js';
import { mulberry32 } from '../src/supersim/coach/engine.js';
import type { Book, GameInput, GameState, PlayDetail, Side } from '../src/supersim/coach/types.js';
import { FakeD1, type Row } from './fake-d1.js';

const dir = new URL('../public/data/playbooks/', import.meta.url);
const have = existsSync(new URL('index.json', dir));
const ORIGIN = 'https://league.test';
const DYN = { id: 1, slug: 'test', name: 'Test League', season_year: 2025, week: 3, stage: 0, week_type: 0, current_snapshot_id: 1, updated_at: null, od_id: 77, abbr: 'TL', description: null, state: 1, od_file_id: 1, od_file_saved_at: null, od_created_at: null, settings_json: '{}' } as unknown as Dynasty;
const member = (blaze_id: number, persona: string, tgid: number, extra: Partial<MemberRow> = {}): MemberRow & Row => ({ dynasty_id: 1, blaze_id, persona, ncid: 0, tgid, ccid: 0, commissioner: 0, team_file_id: 0, web_only: 0, ...extra } as MemberRow & Row);
const alice = member(101, 'Alice', 1, { commissioner: 1 }), bob = member(102, 'Bob', 2), cara = member(103, 'Cara', 7); // Cara: bye week, so she can only watch
const game = (week: number, game_no: number, home_tgid: number, away_tgid: number, status = 0): GameRow & Row => ({ dynasty_id: 1, season_year: 2025, week, game_no, snapshot_id: 1, status, home_tgid, away_tgid, home_score: 0, away_score: 0, stadium_id: 0, kickoff_minutes: 0, day_of_week: 0, week_type: 0, overtime: 0, user_played: 0, user_team_game: 1, cpu_pick: 0, home_pick: 0, source: 'game' } as GameRow & Row);
const teamRow = (tgid: number, name: string, abbr: string): Row => ({ dynasty_id: 1, tgid, snapshot_id: 1, name, long_name: name, mascot: 'Bears', abbr, conf_label: '', cgid: 0, dgid: 0, team_type: 0, asset_slot: '', stadium_id: 0, wins: 0, losses: 0, conf_wins: 0, conf_losses: 0, streak: 0, rank_bcs: 0, rank_coaches: 0, rank_media: 0, prestige: 3, overall: 70, logo_key: null, raw_json: null });
// a real roster for a team: players rows + depth chart rows as the bridge imports them (same shape as coach.test.ts)
const KEYS = ['PSPD', 'PACC', 'PAGI', 'PSTR', 'PAWR', 'PCTH', 'PCAR', 'PBTK', 'PTHA', 'PTHP', 'PPBK', 'PRBK', 'PTAK', 'PBSH', 'PPMV', 'PFMV', 'PMCV', 'PZCV', 'PRTR', 'PKAC', 'PKPR', 'PBCV'];
function rosterRows(tgid: number, rng: () => number): { players: Row[]; chart: Row[] } {
  const counts: Record<number, number> = { 0: 2, 1: 3, 2: 1, 3: 5, 4: 2, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 1, 12: 3, 13: 1, 14: 2, 15: 1, 16: 4, 17: 1, 18: 1, 19: 1, 20: 1 };
  const players: Row[] = []; const chart: Row[] = []; let id = tgid * 1000;
  for (const [pos, n] of Object.entries(counts)) for (let d = 0; d < n; d++) {
    const ovr = Math.round(74 - d * 6 + (rng() - 0.5) * 8); const ratings: Record<string, number> = {}; for (const k of KEYS) ratings[k] = Math.max(30, Math.min(99, Math.round(ovr + (rng() - 0.5) * 20)));
    players.push({ dynasty_id: 1, pgid: ++id, snapshot_id: 1, tgid, first_name: 'Player', last_name: String(id), pos: Number(pos), year: 2, redshirt: 0, jersey: 1 + (id % 98), overall: ovr, height: 72, weight: 210, games_played: 0, ratings_json: JSON.stringify(ratings), photo_key: null, head_id: null });
    chart.push({ dynasty_id: 1, tgid, pos: Number(pos), depth: d, snapshot_id: 1, pgid: id });
  }
  const at = (pos: number) => players.find((p) => p.pos === pos)!.pgid;
  for (const [pos, pgid] of [[21, at(3)], [22, at(3)], [23, at(19)], [24, at(7)]] as [number, number][]) chart.push({ dynasty_id: 1, tgid, pos, depth: 0, snapshot_id: 1, pgid });
  return { players, chart };
}
function makeDb(): FakeD1 {
  const rng = mulberry32(42); const a = rosterRows(1, rng), b = rosterRows(2, rng);
  return new FakeD1({
    dynasties: [{ ...(DYN as unknown as Row) }],
    od_members: [alice, bob, cara],
    teams: [teamRow(1, 'Alder', 'ALD'), teamRow(2, 'Birch', 'BIR'), teamRow(7, 'Cedar', 'CED'), teamRow(9, 'Dogwood', 'DOG')],
    players: [...a.players, ...b.players], depth_chart: [...a.chart, ...b.chart],
    games: [game(3, 1, 2, 1), game(3, 2, 9, 11), game(2, 1, 1, 7, 2)], // this week: Alice at Bob, a CPU game; last week: a played game
  });
}
// the Worker's static assets: the playbook JSON files on disk
const assets = { fetch: async (req: Request) => { const path = new URL(req.url).pathname; const file = new URL(path.slice('/data/playbooks/'.length), dir); if (!path.startsWith('/data/playbooks/') || !existsSync(file)) return new Response('not found', { status: 404 }); return new Response(readFileSync(file), { headers: { 'content-type': 'application/json' } }); } };
const books = new Map<number, Book>(); const book = (id: number): Book => { let b = books.get(id); if (!b) { b = JSON.parse(readFileSync(new URL(`${id}.json`, dir), 'utf8')) as Book; books.set(id, b); } return b; };

type Payload = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
describe.skipIf(!have)('Supersim over HTTP: two members, a spectator, one final', () => {
  const db = makeDb();
  const env = { DB: db as unknown as D1Database, ASSETS: assets as unknown as Fetcher, SUPERSIM_ENABLED: 'true', SUPERSIM_QUARTER_SECONDS: '60', SITE_NAME: 't', BASE_YEAR: '2013' } as unknown as SimEnv;
  const call = async (who: MemberRow | null, method: 'GET' | 'POST', body?: unknown, query = '?game=3:1'): Promise<{ status: number; data: Payload }> => {
    const req = new Request(`${ORIGIN}/d/test/supersim/data${query}`, { method, headers: method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}, body: method === 'POST' ? JSON.stringify(body) : undefined });
    const res = await handleSupersim(req, env, DYN, 'data', who, []);
    return { status: res.status, data: (await res.json()) as Payload };
  };
  const liveRow = () => db.table('supersim_live')[0]!;
  const liveState = () => JSON.parse(String(liveRow().state_json)) as GameState & { pending?: { side: Side; play: number; by: number } | null; recent?: PlayDetail[] };
  const liveInput = () => JSON.parse(String(liveRow().input_json)) as GameInput;
  const rng = mulberry32(9);
  // a legal call for one sideline in the current situation, from that team's real book (what the picker would offer)
  const pick = (side: Side): number => {
    const st = liveState(), input = liveInput(); const off = st.phase === 'kickoff' ? st.kicking! : st.off;
    return side === off ? cpuOffense(book(input.teams[off].offBook), st, input, side, rng) : cpuDefense(book(input.teams[side].defBook), st, input, side, rng);
  };
  const version = () => Number(liveRow().version);
  // one snap between the two members: `first` calls, the call goes pending, the other resolves it
  const snap = async (first: Side): Promise<Payload> => {
    const who = (s: Side) => (s === 0 ? alice : bob); const n0 = liveState().n;
    const a = await call(who(first), 'POST', { action: 'play', play: pick(first), version: version() });
    expect(a.status, a.data.error).toBe(200); expect(a.data.waiting).toBe(true); expect(a.data.pendingSide).toBe(first); expect(a.data.pendingMine).toBe(true); expect(a.data.details).toEqual([]);
    const peek = await call(who((1 - first) as Side), 'GET'); expect(peek.data.pendingSide).toBe(first); expect(peek.data.pendingMine).toBe(false); expect(peek.data.state.n).toBe(n0);
    const b = await call(who((1 - first) as Side), 'POST', { action: 'play', play: pick((1 - first) as Side), version: version() });
    expect(b.status, b.data.error).toBe(200); expect(b.data.waiting).toBe(false); expect(b.data.pendingSide).toBeNull(); expect(b.data.details).toHaveLength(1); expect(b.data.detail.n).toBe(n0 + 1); expect(b.data.state.n).toBe(n0 + 1);
    return b.data;
  };

  it('resolves coaching access by key and parses game keys', () => {
    expect(coachAccess(DYN, alice, game(3, 1, 2, 1))).toBe(true); expect(coachAccess(DYN, bob, game(3, 1, 2, 1))).toBe(true);
    expect(coachAccess(DYN, cara, game(3, 1, 2, 1))).toBe(false); expect(coachAccess(DYN, alice, game(2, 1, 1, 7, 2))).toBe(false); expect(coachAccess(DYN, null, game(3, 1, 2, 1))).toBe(false);
    expect(parseGameKey('3:1')).toEqual({ week: 3, gameNo: 1 }); expect(parseGameKey('x')).toBeNull(); expect(parseGameKey(null)).toBeNull();
  });
  it('shows the coach the matchup and a bye-week member the (empty) live list', async () => {
    const a = await call(alice, 'GET', undefined, ''); // no ?game: her current-week game
    expect(a.status).toBe(200); expect(a.data.state).toBeNull(); expect(a.data.you).toBe(0); expect(a.data.controls).toEqual([0]); expect(a.data.watch).toBe(false);
    expect(a.data.opponentHuman).toBe(true); expect(a.data.coaches).toEqual(['Alice', 'Bob']); expect(a.data.liveGames).toEqual([]); expect(a.data.input.gameNo).toBe(1);
    const c = await call(cara, 'GET', undefined, ''); expect(c.status).toBe(200); expect(c.data.noGame).toMatch(/No eligible/); expect(c.data.liveGames).toEqual([]);
    const c2 = await call(cara, 'GET'); expect(c2.status).toBe(200); expect(c2.data.noGame).toMatch(/not being played/); // nothing live yet
    const anon = await call(null, 'GET'); expect(anon.status).toBe(401);
    expect((await call(alice, 'GET', undefined, '?game=bad')).status).toBe(400);
  });
  it('lets both members join one live row and sees the other sideline as human', async () => {
    const start = await call(alice, 'POST', { action: 'start' }); expect(start.status).toBe(201); expect(start.data.state.phase).toBe('toss'); expect(start.data.version).toBe(1);
    const join = await call(bob, 'POST', { action: 'start' }); expect(join.status).toBe(200); expect(join.data.state.id).toBe(start.data.state.id); expect(join.data.version).toBe(1);
    expect(join.data.you).toBe(1); expect(join.data.controls).toEqual([1]); expect(join.data.opponentHuman).toBe(true); expect(join.data.coaches).toEqual(['Alice', 'Bob']);
    expect(db.table('supersim_live')).toHaveLength(1);
    const c = await call(cara, 'GET', undefined, ''); expect(c.data.liveGames).toHaveLength(1); // the game is in the live list now
    expect(c.data.liveGames[0]).toMatchObject({ week: 3, gameNo: 1, score: [0, 0], q: 1, coaches: ['Alice', 'Bob'], home: { tgid: 2, abbr: 'BIR' }, away: { tgid: 1, abbr: 'ALD' } });
  });
  it('plays the coin toss between the two coaches', async () => {
    const wrong = await call(bob, 'POST', { action: 'toss', call: 'heads', version: version() }); expect(wrong.status).toBe(409); // the visitors (Alice) call it
    const flip = await call(alice, 'POST', { action: 'toss', call: 'heads', version: version() }); expect(flip.status, flip.data.error).toBe(200);
    const t = flip.data.state.toss; expect(['heads', 'tails']).toContain(t.result); expect([0, 1]).toContain(t.winner); expect(flip.data.state.phase).toBe('toss');
    const winner = t.winner === 0 ? alice : bob, loser = t.winner === 0 ? bob : alice;
    const no = await call(loser, 'POST', { action: 'toss', choice: 'receive', version: version() }); expect(no.status).toBe(409);
    const choose = await call(winner, 'POST', { action: 'toss', choice: 'receive', version: version() }); expect(choose.status, choose.data.error).toBe(200);
    expect(choose.data.state.phase).toBe('kickoff'); expect(choose.data.state.off).toBe(t.winner); expect(choose.data.recent).toEqual([]);
  });
  it('resolves snaps when the second call lands, keeps a pending call through tempo and timeout, and feeds the spectator ring', async () => {
    const stale = await call(alice, 'POST', { action: 'play', play: pick(0), version: version() - 1 }); expect(stale.status).toBe(409); expect(stale.data.stale).toBe(true);
    for (let i = 0; i < 4; i++) await snap((i % 2) as Side); // alternate who calls first
    // Alice's call is in; Bob changes tempo (a version bump): her call survives and resolves against his play
    const v0 = version(); const a = await call(alice, 'POST', { action: 'play', play: pick(0), version: v0 }); expect(a.data.waiting).toBe(true);
    const tempo = await call(bob, 'POST', { action: 'tempo', tempo: 'hurry', version: version() }); expect(tempo.status).toBe(200); expect(tempo.data.version).toBe(v0 + 2); expect(tempo.data.pendingSide).toBe(0); expect(tempo.data.state.tempo).toBe('hurry');
    const again = await call(alice, 'POST', { action: 'play', play: pick(0), version: version() }); expect(again.status).toBe(409); expect(again.data.error).toMatch(/Your call is in/);
    const n0 = liveState().n; const b = await call(bob, 'POST', { action: 'play', play: pick(1), version: version() }); expect(b.status, b.data.error).toBe(200); expect(b.data.state.n).toBe(n0 + 1); expect(b.data.pendingSide).toBeNull();
    // a timeout by the other sideline while a call is pending (when one is available with the clock running)
    for (let i = 0; i < 2; i++) await snap(1);
    { const st = liveState(); if (st.phase === 'snap' && st.running && st.to[1] > 0) {
      const p = await call(alice, 'POST', { action: 'play', play: pick(0), version: version() }); expect(p.data.waiting).toBe(true);
      const to = await call(bob, 'POST', { action: 'timeout', version: version() }); expect(to.status, to.data.error).toBe(200); expect(to.data.pendingSide).toBe(0); expect(to.data.state.to[1]).toBe(st.to[1] - 1); expect(to.data.state.running).toBe(false);
      const n1 = liveState().n; const r = await call(bob, 'POST', { action: 'play', play: pick(1), version: version() }); expect(r.status, r.data.error).toBe(200); expect(r.data.state.n).toBe(n1 + 1);
    } }
    // the spectator: read-only, both sidelines someone else's, the ring of the last plays in order
    const st = liveState(); expect(st.n).toBeGreaterThanOrEqual(7);
    const c = await call(cara, 'GET'); expect(c.status).toBe(200);
    expect(c.data.watch).toBe(true); expect(c.data.controls).toEqual([]); expect(c.data.you).toBeNull(); expect(c.data.coaches).toEqual(['Alice', 'Bob']); expect(c.data.pendingMine).toBe(false);
    expect(c.data.state.n).toBe(st.n); expect(c.data.state.recent).toBeUndefined(); expect(c.data.state.pending).toBeUndefined();
    const ring = c.data.recent as PlayDetail[]; expect(ring).toHaveLength(Math.min(RECENT_PLAYS, st.n)); expect(ring[ring.length - 1]!.n).toBe(st.n);
    for (let i = 1; i < ring.length; i++) expect(ring[i]!.n).toBe(ring[i - 1]!.n + 1);
    expect(c.data.final).toBeNull(); expect(c.data.liveGames).toBeUndefined();
    const write = await call(cara, 'POST', { action: 'play', play: 1, version: version() }); expect(write.status).toBe(403); expect(db.log.filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s)).length).toBe(db.log.filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s)).length);
    // a coach may watch his own game too (?watch=1), and the ring grows with the next snap
    const w = await call(alice, 'GET', undefined, '?game=3:1&watch=1'); expect(w.data.watch).toBe(true); expect(w.data.controls).toEqual([]);
    await snap(0); const c2 = await call(cara, 'GET'); expect((c2.data.recent as PlayDetail[]).at(-1)!.n).toBe(st.n + 1);
  });
  it('serves the page shells for a named game and for watching', async () => {
    const shell = async (resource: string | undefined, rest: string[]) => { const res = await handleSupersim(new Request(`${ORIGIN}/d/test/supersim/${[resource, ...rest].filter(Boolean).join('/')}`), env, DYN, resource, alice, rest); return { status: res.status, text: await res.text() }; };
    const watch = await shell('watch', ['3', '1']); expect(watch.status).toBe(200); expect(watch.text).toContain('data-endpoint="/d/test/supersim/data?game=3:1&amp;watch=1"'); expect(watch.text).toContain('data-mode="watch"');
    const coach = await shell('3', ['1']); expect(coach.status).toBe(200); expect(coach.text).toContain('data-endpoint="/d/test/supersim/data?game=3:1"'); expect(coach.text).toContain('data-mode="coach"');
    const plain = await shell(undefined, []); expect(plain.status).toBe(200); expect(plain.text).toContain('data-endpoint="/d/test/supersim/data"');
    expect((await shell('x', ['1'])).status).toBe(404); expect((await shell('3', [])).status).toBe(404); expect((await shell('watch', ['3'])).status).toBe(404); expect((await shell('data', ['extra'])).status).toBe(404);
  });
  it('sims to the final with both sidelines calling and records the result once', async () => {
    let guard = 0;
    while (!liveState().final && guard++ < 600) { // auto puts a CPU call in for the caller; the other side's auto resolves it
      const first = (guard % 2) as Side; const who = (s: Side) => (s === 0 ? alice : bob);
      const a = await call(who(first), 'POST', { action: 'auto', plays: 1, version: version() }); expect(a.status, a.data.error).toBe(200);
      if (liveState().final) break;
      const b = await call(who((1 - first) as Side), 'POST', { action: 'auto', plays: 1, version: version() }); expect(b.status, b.data.error).toBe(200);
    }
    const st = liveState(); expect(st.final).toBe(true); expect(st.winner).not.toBeNull(); expect(st.pending ?? null).toBeNull();
    expect(liveRow().status).toBe('final'); expect(db.table('supersim_games')).toHaveLength(1);
    const run = db.table('supersim_games')[0]!; expect(run.week).toBe(3); expect(run.game_no).toBe(1); expect(run.blaze_id).toBe(101); expect(run.owned_tgid).toBe(1);
    expect(JSON.parse(String(run.result_json)).score).toEqual(st.score);
    // everyone sees the same final; a late play is answered with the final payload, not an error; the ring is full
    const a = await call(alice, 'GET'); expect(a.data.state.final).toBe(true); expect(a.data.final.status).toBe('pending'); expect(a.data.status).toBe('final');
    const late = await call(bob, 'POST', { action: 'play', play: 1, version: version() }); expect(late.status).toBe(200); expect(late.data.state.final).toBe(true); expect(db.table('supersim_games')).toHaveLength(1);
    const c = await call(cara, 'GET'); expect(c.data.watch).toBe(true); expect(c.data.state.final).toBe(true); expect(c.data.final.id).toBe(run.id); expect(c.data.recent).toHaveLength(RECENT_PLAYS);
    expect((c.data.recent as PlayDetail[]).at(-1)!.n).toBe(st.n);
    const none = await call(cara, 'GET', undefined, ''); expect(none.data.liveGames).toEqual([]); // final games leave the live list
    const sched = await db.prepare('SELECT * FROM supersim_schedule WHERE dynasty_id = ? AND season_year = ? AND week = ? AND game_no = ?').bind(1, 2025, 3, 1).first<GameRow>();
    expect(sched!.source).toBe('supersim'); expect(sched!.status).toBe(st.winner === 1 ? 3 : 2);
    expect(JSON.stringify(st).length).toBeLessThan(2_000_000); // the ring keeps the stored state within reason
  });
});
