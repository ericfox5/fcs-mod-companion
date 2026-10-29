import type { PageCtx } from '../index.js';
import { html } from '../html.js';
import { layout, box } from '../layout.js';
import { getTeams } from '../db/queries.js';
import { teamLink, teamLogo } from './common.js';

export async function rankingsPage(ctx: PageCtx) {
  const { env, dyn } = ctx;
  const teams = await getTeams(env.DB, dyn.id);
  const poll = (title: string, key: 'rank_bcs' | 'rank_coaches' | 'rank_media') => {
    const ranked = teams.filter((t) => t[key] > 0).sort((a, b) => a[key] - b[key]).slice(0, 25);
    return box(title, ranked.length ? html`<table class="list rankings"><tr><th>RK</th><th>Team</th><th>Rec</th></tr>${ranked.map((t) => html`<tr><td class="rk">${t[key]}</td><td>${teamLogo(t)} ${teamLink(dyn.slug, t)}</td><td>${t.wins}-${t.losses}</td></tr>`)}</table>` : html`<p class="muted">No poll yet.</p>`);
  };
  const body = html`<h2>Rankings</h2><div class="grid3">${poll('Coaches Poll', 'rank_coaches')}${poll('Media Poll', 'rank_media')}${teams.some((t) => t.rank_bcs > 0) ? poll('BCS Standings', 'rank_bcs') : ''}</div>`;
  return layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, path: ctx.url.pathname, title: 'Rankings', siteName: env.SITE_NAME, dyn, section: 'rankings', body, wide: true });
}
