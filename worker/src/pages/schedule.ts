import type { PageCtx } from '../index.js';
import { html } from '../html.js';
import { layout, box } from '../layout.js';
import { getTeams, getGames, teamMap } from '../db/queries.js';
import { gamesTable, weekLabel } from './common.js';
import { spreadLabel } from '@ncaa/ncaa14';
import { gameOdds, leagueOdds } from '../odds.js';

export async function schedulePage(ctx: PageCtx) {
  const { env, dyn, url } = ctx;
  const db = env.DB, d = dyn.id, y = dyn.season_year;
  const teams = await getTeams(db, d);
  const tm = teamMap(teams);
  const all = await getGames(db, d, y);
  const weeks = [...new Set(all.map((g) => g.week))].sort((a, b) => a - b);
  const played = all.filter((g) => g.status >= 2);
  const defaultWeek = played.length ? Math.max(...played.map((g) => g.week)) : (weeks[0] ?? 0);
  const week = url.searchParams.has('week') ? Number(url.searchParams.get('week')) : defaultWeek;
  const tgid = url.searchParams.get('team') ? Number(url.searchParams.get('team')) : undefined;
  const games = all.filter((g) => (tgid !== undefined ? g.home_tgid === tgid || g.away_tgid === tgid : g.week === week));
  const nav = html`<div class="weeknav">${weeks.map((w) => html`<a class="${w === week && tgid === undefined ? 'selected' : ''}" href="?week=${w}">${w + 1}</a>`)}
    <form class="inline" method="get"><select name="team" onchange="this.form.submit()"><option value="">Team schedule…</option>${teams.map((t) => html`<option value="${t.tgid}" ${t.tgid === tgid ? 'selected' : ''}>${t.name}</option>`)}</select></form></div>`;
  const title = tgid !== undefined ? `${tm.get(tgid)?.name ?? 'Team'} schedule` : weekLabel(week);
  // simulated spreads next to the games still to be played
  const lines = new Map<string, string>();
  if (games.some((g) => g.status < 2)) { const lo = await leagueOdds(db, dyn); for (const g of games) { if (g.status >= 2) continue; const o = gameOdds(lo, g); const h = tm.get(g.home_tgid), a = tm.get(g.away_tgid); if (o && h && a) lines.set(`${g.week}:${g.game_no}`, spreadLabel(o.spread, h.abbr, a.abbr)); } }
  const body = html`<h2>Schedule</h2>${nav}${box(title, gamesTable(dyn.slug, games, tm, 'No games.', lines))}`;
  return layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, path: ctx.url.pathname, title: 'Schedule', siteName: env.SITE_NAME, dyn, section: 'schedule', body });
}
