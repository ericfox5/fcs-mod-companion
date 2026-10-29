import type { PageCtx } from '../index.js';
import { html } from '../html.js';
import { layout, box, two } from '../layout.js';
import { getTeams, getHeisman, getAllAmericans, getPlayersByIds, teamMap } from '../db/queries.js';
import { playerLink, pos, cls, teamLink, headshot, teamLogo } from './common.js';

export async function awardsPage(ctx: PageCtx) {
  const { env, dyn } = ctx;
  const db = env.DB, d = dyn.id, y = dyn.season_year;
  const [teams, heis, aa] = await Promise.all([getTeams(db, d), getHeisman(db, d, y), getAllAmericans(db, d, y)]);
  const tm = teamMap(teams);
  const players = new Map((await getPlayersByIds(db, d, [...new Set([...heis.map((h) => h.pgid), ...aa.map((a) => a.pgid)])])).map((p) => [p.pgid, p]));
  const watch = heis.map((h) => ({ ...h, pts: Number((JSON.parse(h.raw_json || '{}') as Record<string, number>).PCAP ?? 0) })).sort((a, b) => b.pts - a.pts);
  const left = box('Heisman Watch', heis.length ? html`<table class="list"><tr><th>RK</th><th>Player</th><th>Pos</th><th>Team</th><th class="num">Pts</th><th class="num">LW</th></tr>${watch.map((h, i) => { const p = players.get(h.pgid); return html`<tr><td class="rk">${i + 1}</td><td>${p ? headshot(p) : ''} ${playerLink(dyn.slug, p)}</td><td>${p ? pos(p.pos) : ''}</td><td>${p ? html`${teamLogo(tm.get(p.tgid), 'xs')}${teamLink(dyn.slug, tm.get(p.tgid))}` : ''}</td><td class="num">${h.pts}</td><td class="num muted">${h.rank >= 15 ? 'NR' : h.rank + 1}</td></tr>`; })}</table><p class="muted">Order by Heisman points; LW = last week's slot.</p>` : html`<p class="muted">No Heisman race yet.</p>`);
  const teamsAA = [...new Set(aa.map((a) => a.team_type))].sort();
  const right = html`${teamsAA.map((tt) => box(`All-Americans · team ${tt + 1}`, html`<table class="list">${aa.filter((a) => a.team_type === tt).map((a) => { const p = players.get(a.pgid); return html`<tr><td>${pos(a.pos)}</td><td>${playerLink(dyn.slug, p)}</td><td>${p ? cls(p) : ''}</td><td>${p ? teamLink(dyn.slug, tm.get(p.tgid)) : ''}</td></tr>`; })}</table>`))}`;
  return layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, path: ctx.url.pathname, title: 'Awards', siteName: env.SITE_NAME, dyn, section: 'awards', body: two(left, right) });
}
