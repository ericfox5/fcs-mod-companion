// End-to-end smoke test of the Supersim coaching API against a running Worker (wrangler dev by default): signs in
// with the local test account, starts the member's game, calls plays for the member's side (picking from the real
// playbook), lets the server run the other sideline, and plays to the final.
//   npx tsx tools/supersim-api-smoke.mts [host] [accountJson]
import { readFileSync } from 'node:fs';
const host = process.argv[2] ?? 'http://localhost:8787';
const acct = JSON.parse(readFileSync(process.argv[3] ?? 'worker/.dev-account.json', 'utf8')) as { dynasty: string; username: string; password: string };
let cookie = '';
const login = await fetch(`${host}/d/${acct.dynasty}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: acct.username, password: acct.password, back: `/d/${acct.dynasty}` }) });
const set = login.headers.get('set-cookie') ?? ''; const m = /od_session=([0-9a-f]+)/.exec(set); if (!m) { console.error('login failed', login.status, set.slice(0, 60)); process.exit(1); }
cookie = `od_session=${m[1]}`;
const api = `${host}/d/${acct.dynasty}/supersim/data`;
const get = async () => { const r = await fetch(api, { headers: { cookie } }); return { status: r.status, body: await r.json() as any }; };
const post = async (body: unknown) => { const t0 = Date.now(); const r = await fetch(api, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: host }, body: JSON.stringify(body) }); return { status: r.status, ms: Date.now() - t0, body: await r.json() as any }; };
const books = new Map<number, any>();
const book = async (id: number) => { if (!books.has(id)) books.set(id, await (await fetch(`${host}/data/playbooks/${id}.json`)).json()); return books.get(id); };
let d = await get(); console.log('GET', d.status, 'you', d.body.you, 'state', d.body.state ? d.body.state.phase : null, 'final', d.body.final?.status ?? null, 'version', d.body.version);
if (d.body.final) { console.log('an official result already exists; nothing to test'); process.exit(0); }
if (!d.body.state) { const s = await post({ action: 'start' }); console.log('start', s.status, s.ms + 'ms', s.body.error ?? `phase ${s.body.state?.phase} version ${s.body.version}`); if (s.status >= 400) process.exit(1); d = await get(); }
const you = d.body.you as number; let plays = 0, maxMs = 0, totalMs = 0;
// pick the first eligible play for the phase from my book (offense when I have the ball / am kicking, else defense)
const pickMine = async (st: any, input: any) => {
  const offSide = st.phase === 'kickoff' ? st.kicking : st.off; const mine = offSide === you;
  const b = await book(mine ? input.teams[you].offBook : input.teams[you].defBook);
  const forms = b.formations.filter((f: any) => st.phase === 'kickoff' ? (mine ? f.t === 2 : f.t === 12) : mine ? f.t === 1 && f.n !== 'Special Teams' && f.n !== 'Hail Mary' : f.t === 11 && f.n !== 'Special Teams');
  if (st.phase === 'pat' && mine) { const fg = b.formations.flatMap((f: any) => f.sets).find((s: any) => s.n === 'Field Goal'); if (fg) return fg.plays[0]; }
  if (st.phase === 'snap' && mine && st.down === 4 && st.ball < 60) { const p = b.formations.flatMap((f: any) => f.sets).find((s: any) => s.n === 'Special Teams')?.plays.find((id: number) => b.plays[id].n === 'Punt'); if (p) return p; }
  const sets = forms.flatMap((f: any) => f.sets).filter((s: any) => s.plays.length); const set = sets[plays % sets.length]; return set.plays[plays % set.plays.length];
};
while (!d.body.state.final && plays < 400) {
  const st = d.body.state; const play = await pickMine(st, d.body.input);
  const r = await post({ action: 'play', play, tempo: 'normal', version: d.body.version });
  if (r.status !== 200) { console.log('play failed', r.status, JSON.stringify(r.body).slice(0, 300)); if (r.body.stale) { d = await get(); continue; } process.exit(1); }
  plays++; maxMs = Math.max(maxMs, r.ms); totalMs += r.ms; const det = r.body.detail;
  if (plays <= 6 || det.scoring || det.kind === 'clock') console.log(`#${det.n} Q${det.q} ${Math.floor(det.clock / 60)}:${String(det.clock % 60).padStart(2, '0')} ${det.offPlay.form}/${det.offPlay.set} ${det.offPlay.n} vs ${det.defPlay.n} -> ${det.headline}: ${det.text} [${det.score.join('-')}] actors ${det.anim.actors.length} ball ${det.anim.ball.length} ${r.ms}ms`);
  d = { status: 200, body: r.body };
  if (plays === 8) { const t = await post({ action: 'timeout', version: d.body.version }); console.log('timeout', t.status, t.body.error ?? `to ${JSON.stringify(t.body.state.to)}`); if (t.status === 200) d = { status: 200, body: t.body }; }
  if (plays === 12) { const a = await post({ action: 'auto', plays: 15, version: d.body.version }); console.log('auto 15', a.status, a.ms + 'ms', a.body.error ?? `${a.body.details.length} plays, now Q${a.body.state.q} ${a.body.state.score.join('-')}`); if (a.status === 200) { d = { status: 200, body: a.body }; plays += a.body.details.length; } }
  if (plays > 40 && plays % 20 === 0) { const a = await post({ action: 'auto', plays: 40, version: d.body.version }); if (a.status === 200) { d = { status: 200, body: a.body }; plays += a.body.details.length; console.log('auto 40', a.ms + 'ms', `-> Q${a.body.state.q} ${a.body.state.score.join('-')} final ${a.body.state.final}`); } else { console.log('auto failed', a.status, JSON.stringify(a.body).slice(0, 200)); break; } }
}
const st = d.body.state; console.log(`\nFINAL ${d.body.input.teams[0].abbr} ${st.score[0]} - ${d.body.input.teams[1].abbr} ${st.score[1]} after ${st.n} plays; requests ${plays}, avg ${(totalMs / Math.max(1, plays)).toFixed(0)}ms max ${maxMs}ms; status ${d.body.status}; official ${JSON.stringify(d.body.final ? { id: d.body.final.id, status: d.body.final.status, score: d.body.final.result.score } : null)}`);
const again = await post({ action: 'play', play: 1, version: d.body.version }); console.log('play after final ->', again.status, again.body.error ?? 'payload');
