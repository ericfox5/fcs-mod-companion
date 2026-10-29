import type { PageCtx } from '../index.js';
import { html, notFound, type Raw } from '../html.js';
import { layout, box } from '../layout.js';
import { getTeams, getGame, getGames, getGameLogs, getTeamSeasonStats, getTeamPlayerSeasonStats, getPlayersByIds, teamMap, type TeamRow, type GameRow, type PlayerRow, type StatRow } from '../db/queries.js';
import { teamLogo, teamLink, playerLink, headshot, weekLabel, rankOf, pos } from './common.js';

type Stats = Record<string, number>;
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const parse = (json: string | null | undefined): Stats => { try { return JSON.parse(json || '{}'); } catch { return {}; } };
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const r1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
const per = (total: number, games: number) => (games ? r1(total / games) : '0.0');

// One comparison row: away value | label | home value, the better side marked, with a split bar underneath.
function cmpRow(label: string, a: number, h: number, fmt: (v: number) => string | number, lowerIsBetter = false): Raw {
  const aBetter = a !== h && (lowerIsBetter ? a < h : a > h), hBetter = a !== h && (lowerIsBetter ? a > h : a < h);
  const tot = Math.abs(a) + Math.abs(h) || 1;
  return html`<tr><td class="${aBetter ? 'adv' : ''}">${fmt(a)}</td><th class="lbl">${label}</th><td class="${hBetter ? 'adv' : ''}">${fmt(h)}</td></tr>
    <tr><td colspan="3" class="bar"><div class="cmp-bar"><span class="l" style="width:${(Math.abs(a) / tot) * 100}%"></span><span class="r" style="width:${(Math.abs(h) / tot) * 100}%"></span></div></td></tr>`;
}
const cmpTable = (away: TeamRow, home: TeamRow, rows: Raw[]) => html`<table class="cmp"><tr><th>${teamLogo(away, 'xs')}${away.abbr}</th><th class="lbl"></th><th>${teamLogo(home, 'xs')}${home.abbr}</th></tr>${rows}</table>`;

export async function gamePage(ctx: PageCtx, week: number, gameNo: number) {
  const { env, dyn } = ctx;
  const db = env.DB, d = dyn.id, y = dyn.season_year;
  if (!Number.isFinite(week) || !Number.isFinite(gameNo)) return notFound('No such game');
  const g = await getGame(db, d, y, week, gameNo);
  if (!g) return notFound('No such game');
  const tm = teamMap(await getTeams(db, d));
  const home = tm.get(g.home_tgid), away = tm.get(g.away_tgid);
  if (!home || !away) return notFound('Unknown teams');
  const played = g.status >= 2;
  const side = (t: TeamRow, right = false) => html`<div class="gh-team ${right ? 'right' : ''}">${right ? '' : teamLogo(t, 'lg')}<div><div class="gh-rank">${rankOf(t) ? `#${rankOf(t)} · ` : ''}${t.wins}-${t.losses}</div><h2>${teamLink(dyn.slug, t)}</h2><div class="muted">${t.mascot}</div></div>${right ? teamLogo(t, 'lg') : ''}</div>`;
  const header = html`<section class="box gamehead">${side(away)}
    <div class="gh-score">${played ? html`<span class="${g.status === 2 ? 'won' : ''}">${g.away_score}</span><span class="dash">-</span><span class="${g.status === 3 ? 'won' : ''}">${g.home_score}</span>` : html`<span class="vs">at</span>`}
      <div class="gh-status">${played ? (g.overtime ? 'Final / OT' : 'Final') : 'Scheduled'} · ${weekLabel(g.week)}${g.user_played ? ' · user game' : ''}</div></div>
    ${side(home, true)}</section>`;
  const body = played ? await boxScore(env, dyn.id, y, g, away, home, dyn.slug) : await preview(env, dyn.id, y, away, home, dyn.slug);
  return layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, path: ctx.url.pathname, title: `${away.name} at ${home.name}`, siteName: env.SITE_NAME, dyn, section: 'schedule', body: html`${header}${body}`, wide: true });
}

// ---- preview: season averages head to head + each team's stat leaders ----
async function preview(env: PageCtx['env'], d: number, y: number, away: TeamRow, home: TeamRow, slug: string): Promise<Raw> {
  const db = env.DB;
  const [tss, games, leadersA, leadersH] = await Promise.all([getTeamSeasonStats(db, d, y), getGames(db, d, y, { playedOnly: true }), teamLeaders(db, d, y, away.tgid), teamLeaders(db, d, y, home.tgid)]);
  const ts = new Map(tss.map((t) => [t.tgid, parse(t.stats_json)]));
  const scoring = (tgid: number) => {
    let pf = 0, pa = 0, gp = 0;
    for (const gm of games) { if (gm.home_tgid === tgid) { pf += gm.home_score; pa += gm.away_score; gp++; } else if (gm.away_tgid === tgid) { pf += gm.away_score; pa += gm.home_score; gp++; } }
    return { pf, pa, gp };
  };
  const A = ts.get(away.tgid) ?? {}, H = ts.get(home.tgid) ?? {};
  const sa = scoring(away.tgid), sh = scoring(home.tgid);
  const ga = n(A.tsga) || sa.gp || 1, gh = n(H.tsga) || sh.gp || 1;
  const rows = [
    cmpRow('Points per game', sa.gp ? sa.pf / sa.gp : 0, sh.gp ? sh.pf / sh.gp : 0, r1),
    cmpRow('Points allowed', sa.gp ? sa.pa / sa.gp : 0, sh.gp ? sh.pa / sh.gp : 0, r1, true),
    cmpRow('Total yards / game', n(A.tsoy) / ga, n(H.tsoy) / gh, r1),
    cmpRow('Passing yards / game', n(A.tsop) / ga, n(H.tsop) / gh, r1),
    cmpRow('Rushing yards / game', n(A.tsor) / ga, n(H.tsor) / gh, r1),
    cmpRow('Yards allowed / game', n(A.tsdy) / ga, n(H.tsdy) / gh, r1, true),
    cmpRow('First downs / game', n(A.ts1d) / ga, n(H.ts1d) / gh, r1),
    cmpRow('3rd down %', n(A.ts3d) ? (n(A.ts3c) / n(A.ts3d)) * 100 : 0, n(H.ts3d) ? (n(H.ts3c) / n(H.ts3d)) * 100 : 0, (v) => `${Math.round(v)}%`),
    cmpRow('Turnovers', n(A.tspi) + n(A.tsfl), n(H.tspi) + n(H.tsfl), (v) => v, true),
    cmpRow('Takeaways', n(A.tsDi) + n(A.tsdf), n(H.tsDi) + n(H.tsdf), (v) => v),
    cmpRow('Sacks', n(A.tssk), n(H.tssk), (v) => v),
    cmpRow('Penalty yards / game', n(A.tsPy) / ga, n(H.tsPy) / gh, r1, true),
  ];
  return html`<div class="cols">
    <div class="col-main">${box('Matchup · season averages', html`${cmpTable(away, home, rows)}<p class="muted">Season totals from the team-stat table divided by games played; the marked side leads the category.</p>`)}</div>
    <div class="col-side">${box(html`${teamLogo(away, 'xs')}${away.name} leaders`, leadersA ? leadersBlock(slug, leadersA) : html`<p class="muted">No stats yet.</p>`)}${box(html`${teamLogo(home, 'xs')}${home.name} leaders`, leadersH ? leadersBlock(slug, leadersH) : html`<p class="muted">No stats yet.</p>`)}</div>
  </div>`;
}

interface Leader { cat: string; p: StatRow; line: string }
async function teamLeaders(db: D1Database, d: number, y: number, tgid: number): Promise<Leader[] | null> {
  const [off, def, kick] = await Promise.all([getTeamPlayerSeasonStats(db, d, y, 'PSOF', tgid), getTeamPlayerSeasonStats(db, d, y, 'PSDE', tgid), getTeamPlayerSeasonStats(db, d, y, 'PSKI', tgid)]);
  const rows = (list: StatRow[]) => list.map((r) => ({ r, s: parse(r.stats_json) }));
  const best = (list: { r: StatRow; s: Stats }[], key: string) => list.filter((x) => n(x.s[key]) > 0).sort((a, b) => n(b.s[key]) - n(a.s[key]))[0];
  const o = rows(off), de = rows(def), k = rows(kick);
  const out: Leader[] = [];
  const pa = best(o, 'saya'); if (pa) out.push({ cat: 'Passing', p: pa.r, line: `${n(pa.s.sacm)}/${n(pa.s.saat)}, ${n(pa.s.saya)} yds, ${n(pa.s.satd)} TD, ${n(pa.s.sain)} INT` });
  const ru = best(o, 'suya'); if (ru) out.push({ cat: 'Rushing', p: ru.r, line: `${n(ru.s.suat)} att, ${n(ru.s.suya)} yds, ${n(ru.s.sutd)} TD` });
  const re = best(o, 'scya'); if (re) out.push({ cat: 'Receiving', p: re.r, line: `${n(re.s.scca)} rec, ${n(re.s.scya)} yds, ${n(re.s.sctd)} TD` });
  const tk = best(de, 'sdta'); if (tk) out.push({ cat: 'Tackles', p: tk.r, line: `${n(tk.s.sdta)} tkl, ${n(tk.s.sdtl)} TFL` });
  const sk = best(de, 'slsk'); if (sk) out.push({ cat: 'Sacks', p: sk.r, line: `${n(sk.s.slsk)} sacks` });
  const it = best(de, 'ssin'); if (it) out.push({ cat: 'Interceptions', p: it.r, line: `${n(it.s.ssin)} INT, ${n(it.s.ssiy)} yds` });
  const fg = best(k, 'skfm'); if (fg) out.push({ cat: 'Kicking', p: fg.r, line: `${n(fg.s.skfm)}/${n(fg.s.skfa)} FG, ${n(fg.s.skem)}/${n(fg.s.skea)} XP` });
  return out.length ? out : null;
}
const leadersBlock = (slug: string, leaders: Leader[]) => html`<div class="leaders">${leaders.map((l) => html`<div class="ld"><div class="ld-cat">${l.cat}</div><div>${headshot(l.p)} <span class="ld-name">${playerLink(slug, l.p as unknown as PlayerRow)}</span> <span class="muted">${pos(l.p.pos)}</span></div><div class="ld-line">${l.line}</div></div>`)}</div>`;

// ---- box score: team stats from BTES, player lines from BOFF/BDEF/BKIC/BKPR ----
async function boxScore(env: PageCtx['env'], d: number, y: number, g: GameRow, away: TeamRow, home: TeamRow, slug: string): Promise<Raw> {
  const db = env.DB;
  const logs = await getGameLogs(db, d, y, g.week, g.game_no);
  if (!logs.length) return box('Box score', html`<p class="muted">No box score was recorded for this game (the save keeps game logs only for the current season's played games).</p>`);
  const team = (kind: string, tgid: number) => parse(logs.find((l) => l.kind === kind && (l.tgid ?? l.pgid) === tgid)?.stats_json);
  const A = team('BTES', away.tgid), H = team('BTES', home.tgid);
  const rows = [
    cmpRow('First downs', n(A.ts1d), n(H.ts1d), (v) => v),
    cmpRow('Total yards', n(A.tsoy), n(H.tsoy), (v) => v),
    cmpRow('Passing yards', n(A.tsop), n(H.tsop), (v) => v),
    cmpRow('Comp / Att', n(A.tspc), n(H.tspc), (v) => `${v}/${v === n(A.tspc) ? n(A.tspa) : n(H.tspa)}`),
    cmpRow('Rushing yards', n(A.tsor), n(H.tsor), (v) => v),
    cmpRow('Rush attempts', n(A.tsra), n(H.tsra), (v) => v),
    cmpRow('3rd down', n(A.ts3c), n(H.ts3c), (v) => `${v}/${v === n(A.ts3c) ? n(A.ts3d) : n(H.ts3d)}`),
    cmpRow('Turnovers', n(A.tspi) + n(A.tsfl), n(H.tspi) + n(H.tsfl), (v) => v, true),
    cmpRow('Penalties', n(A.tspe), n(H.tspe), (v) => `${v}-${v === n(A.tspe) ? n(A.tsPy) : n(H.tsPy)}`, true),
    cmpRow('Return yards', n(A.tskr) + n(A.tspr), n(H.tskr) + n(H.tspr), (v) => v),
    cmpRow('Possession', n(A.tspt), n(H.tspt), (v) => mmss(v)),
  ];
  const pgids = [...new Set(logs.filter((l) => l.kind !== 'BTES').map((l) => l.pgid))];
  const players = new Map((await getPlayersByIds(db, d, pgids)).map((p) => [p.pgid, p]));
  const lines = (kind: string, tgid: number) => logs.filter((l) => l.kind === kind).map((l) => ({ p: players.get(l.pgid), s: parse(l.stats_json) })).filter((x) => x.p && x.p.tgid === tgid) as { p: PlayerRow; s: Stats }[];
  const table = (title: string, list: { p: PlayerRow; s: Stats }[], cols: [string, (s: Stats) => string | number][], sortKey: (s: Stats) => number) => {
    const rowsL = list.filter((x) => sortKey(x.s) > 0 || cols.some(([, f]) => Number(f(x.s)) > 0)).sort((a, b) => sortKey(b.s) - sortKey(a.s));
    return rowsL.length ? html`<h4>${title}</h4><table class="list lines"><tr><th></th>${cols.map(([c]) => html`<th class="num">${c}</th>`)}</tr>${rowsL.map((x) => html`<tr><td>${headshot(x.p)} ${playerLink(slug, x.p)} <span class="muted">${pos(x.p.pos)}</span></td>${cols.map(([, f]) => html`<td class="num">${f(x.s)}</td>`)}</tr>`)}</table>` : html``;
  };
  const teamLines = (t: TeamRow) => html`
    ${table('Passing', lines('BOFF', t.tgid).filter((x) => n(x.s.gaat) > 0), [['C/ATT', (s) => `${n(s.gacm)}/${n(s.gaat)}`], ['YDS', (s) => n(s.gaya)], ['TD', (s) => n(s.gatd)], ['INT', (s) => n(s.gain)], ['LNG', (s) => n(s.galN)]], (s) => n(s.gaya))}
    ${table('Rushing', lines('BOFF', t.tgid).filter((x) => n(x.s.guat) > 0), [['CAR', (s) => n(s.guat)], ['YDS', (s) => n(s.guya)], ['TD', (s) => n(s.gutd)], ['LNG', (s) => n(s.gulN)], ['FUM', (s) => n(s.gufu)]], (s) => n(s.guya))}
    ${table('Receiving', lines('BOFF', t.tgid).filter((x) => n(x.s.gcca) > 0), [['REC', (s) => n(s.gcca)], ['YDS', (s) => n(s.gcya)], ['TD', (s) => n(s.gctd)], ['LNG', (s) => n(s.gcrL)], ['DRP', (s) => n(s.gcdr)]], (s) => n(s.gcya))}
    ${table('Defense', lines('BDEF', t.tgid), [['TKL', (s) => n(s.gdta)], ['TFL', (s) => n(s.gdtl)], ['SCK', (s) => n(s.glsk)], ['INT', (s) => n(s.gsin)], ['PD', (s) => n(s.gdpd)], ['FF', (s) => n(s.glff)]], (s) => n(s.gdta) * 10 + n(s.glsk))}
    ${table('Kicking', lines('BKIC', t.tgid).filter((x) => n(x.s.gkfa) + n(x.s.gkea) > 0), [['FG', (s) => `${n(s.gkfm)}/${n(s.gkfa)}`], ['LNG', (s) => n(s.gkfL)], ['XP', (s) => `${n(s.gkem)}/${n(s.gkea)}`]], (s) => n(s.gkfm) + n(s.gkem))}
    ${table('Punting', lines('BKIC', t.tgid).filter((x) => n(x.s.gpat) > 0), [['NO', (s) => n(s.gpat)], ['YDS', (s) => n(s.gpya)], ['AVG', (s) => (n(s.gpat) ? r1(n(s.gpya) / n(s.gpat)) : '0.0')], ['LNG', (s) => n(s.gplN)]], (s) => n(s.gpya))}
    ${table('Returns', lines('BKPR', t.tgid), [['KR', (s) => `${n(s.grka)}-${n(s.grky)}`], ['PR', (s) => `${n(s.grpa)}-${n(s.grpy)}`], ['TD', (s) => n(s.grkt) + n(s.grpt)]], (s) => n(s.grky) + n(s.grpy))}`;
  return html`<div class="cols">
    <div class="col-main">${box('Team stats', cmpTable(away, home, rows))}
      <div class="grid2">${box(html`${teamLogo(away, 'xs')}${away.name}`, teamLines(away))}${box(html`${teamLogo(home, 'xs')}${home.name}`, teamLines(home))}</div></div>
    <div class="col-side">${box('Game', html`<p>${weekLabel(g.week)} · ${g.overtime ? 'Overtime' : 'Regulation'}${g.user_played ? ' · played by a league member' : ' · simulated'}</p>`)}</div>
  </div>`;
}
