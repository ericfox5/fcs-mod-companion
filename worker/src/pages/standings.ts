import type { PageCtx } from '../index.js';
import { html } from '../html.js';
import { layout, box } from '../layout.js';
import { getTeams, getConferences, getDivisions } from '../db/queries.js';
import { teamLink, teamLogo, confTitle, rankOf } from './common.js';

export async function standingsPage(ctx: PageCtx) {
  const { env, dyn } = ctx;
  const db = env.DB, d = dyn.id;
  const [teams, confs, divs] = await Promise.all([getTeams(db, d), getConferences(db, d), getDivisions(db, d)]);
  const pct = (w: number, l: number) => (w + l ? (w / (w + l)).toFixed(3).replace(/^0/, '') : '.000');
  const sortTeams = (list: typeof teams) => [...list].sort((a, b) => (b.conf_wins - b.conf_losses) - (a.conf_wins - a.conf_losses) || b.conf_wins - a.conf_wins || b.wins - a.wins || a.name.localeCompare(b.name));
  const table = (list: typeof teams) => html`<table class="list standings"><tr><th>Team</th><th>Conf</th><th>Pct</th><th>Overall</th><th>Strk</th><th>RK</th></tr>
    ${sortTeams(list).map((t) => html`<tr><td>${teamLogo(t)} ${teamLink(dyn.slug, t)}</td><td>${t.conf_wins}-${t.conf_losses}</td><td>${pct(t.conf_wins, t.conf_losses)}</td><td>${t.wins}-${t.losses}</td><td>${t.streak > 0 ? `W${t.streak}` : t.streak < 0 ? `L${-t.streak}` : '—'}</td><td>${rankOf(t) || ''}</td></tr>`)}</table>`;
  const blocks = confs.map((c) => {
    const members = teams.filter((t) => t.cgid === c.cgid);
    if (!members.length) return html``;
    const cdivs = divs.filter((v) => v.cgid === c.cgid && members.some((t) => t.dgid === v.dgid));
    if (cdivs.length > 1) return box(confTitle(c), html`${cdivs.map((v) => html`<h4>${v.name}</h4>${table(members.filter((t) => t.dgid === v.dgid))}`)}`);
    return box(confTitle(c), table(members));
  });
  return layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, path: ctx.url.pathname, title: 'Standings', siteName: env.SITE_NAME, dyn, section: 'standings', body: html`<h2>Standings</h2><div class="grid2">${blocks}</div>`, wide: true });
}
