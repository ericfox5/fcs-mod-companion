import type { PageCtx } from '../index.js';
import { html, notFound } from '../html.js';
import { layout, box, two } from '../layout.js';
import { getTeams, getTeam, getConferences, getDivisions, getGames, getPlayers, getCoaches, getStories, teamMap } from '../db/queries.js';
import { gamesTable, teamLink, playerLink, pos, cls, heightFt, weekLabel, teamLogo, confTitle } from './common.js';

export async function teamsPage(ctx: PageCtx) {
  const { env, dyn } = ctx;
  const db = env.DB, d = dyn.id;
  const [teams, confs, divs, coaches] = await Promise.all([getTeams(db, d), getConferences(db, d), getDivisions(db, d), getCoaches(db, d)]);
  const userTeams = new Set(coaches.filter((c) => c.user_controlled).map((c) => c.tgid));
  const byConf = new Map<number, typeof teams>();
  for (const t of teams) { if (!byConf.has(t.cgid)) byConf.set(t.cgid, []); byConf.get(t.cgid)!.push(t); }
  const divName = new Map(divs.map((v) => [v.dgid, v.short_name]));
  const body = html`<h2>Teams</h2>
  <div class="grid3">${confs.filter((c) => byConf.has(c.cgid)).map((c) => box(confTitle(c), html`<table class="list">
    ${byConf.get(c.cgid)!.sort((a, b) => a.dgid - b.dgid || b.wins - a.wins || a.name.localeCompare(b.name)).map((t) => html`<tr class="${userTeams.has(t.tgid) ? 'user-team' : ''}"><td>${teamLogo(t)} ${teamLink(dyn.slug, t)}${userTeams.has(t.tgid) ? html` <span class="tag">USER</span>` : ''}</td><td class="muted">${divName.get(t.dgid) ?? ''}</td><td>${t.wins}-${t.losses}</td><td class="muted">${t.conf_wins}-${t.conf_losses}</td></tr>`)}
  </table>`))}</div>`;
  return layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, path: ctx.url.pathname, title: 'Teams', siteName: env.SITE_NAME, dyn, section: 'teams', body, wide: true });
}

export async function teamPage(ctx: PageCtx, tgid: number) {
  const { env, dyn } = ctx;
  const db = env.DB, d = dyn.id, y = dyn.season_year;
  const team = await getTeam(db, d, tgid);
  if (!team) return notFound('No such team');
  const [teams, games, players, coaches, stories, confs] = await Promise.all([getTeams(db, d), getGames(db, d, y, { tgid }), getPlayers(db, d, tgid), getCoaches(db, d, tgid), getStories(db, d, y, { tgid, limit: 8 }), getConferences(db, d)]);
  const tm = teamMap(teams);
  const conf = confs.find((c) => c.cgid === team.cgid)?.name ?? team.conf_label;
  const hc = coaches.find((c) => c.position_code === 0);
  const top = [...players].sort((a, b) => b.overall - a.overall).slice(0, 10);
  const left = html`
    <div class="box team-head">${teamLogo(team, 'lg')}<h2>${team.name} ${team.mascot}</h2>
      <p>${conf} · ${team.wins}-${team.losses} (${team.conf_wins}-${team.conf_losses} conf) · BCS #${team.rank_bcs || '—'} · Coaches #${team.rank_coaches || '—'} · Media #${team.rank_media || '—'}</p>
      <p class="muted">Head coach: ${hc ? `${hc.first_name} ${hc.last_name}${hc.user_controlled ? ' (user)' : ''} · career ${hc.career_wins}-${hc.career_losses}` : 'n/a'} · Asset slot ${team.asset_slot}</p></div>
    ${box('Schedule', gamesTable(dyn.slug, games, tm))}
    ${box('News Wire', stories.length ? html`<ul class="headlines">${stories.map((s) => html`<li><strong>${s.headline}</strong> <span class="muted">${weekLabel(s.week)}</span><br>${s.text}</li>`)}</ul>` : html`<p class="muted">No stories about this team yet.</p>`)}`;
  const right = html`
    ${box('Top players', html`<table class="list">${top.map((p) => html`<tr><td>${pos(p.pos)}</td><td>${playerLink(dyn.slug, p)}</td><td>${cls(p)}</td><td class="ovr">${p.overall}</td></tr>`)}</table><p><a href="/d/${dyn.slug}/rosters/${tgid}">Full roster (${players.length}) →</a></p>`)}
    ${box('Coaching staff', html`<table class="list">${coaches.map((c) => html`<tr><td>${['HC', 'OC', 'DC'][c.position_code] ?? c.position_code}</td><td>${c.first_name} ${c.last_name}</td><td class="muted">${c.user_controlled ? 'user' : 'CPU'}</td></tr>`)}</table>`)}
    ${box('Team facts', html`<table class="list"><tr><td>Abbreviation</td><td>${team.abbr}</td></tr><tr><td>Long name</td><td>${team.long_name}</td></tr><tr><td>Streak</td><td>${team.streak > 0 ? `W${team.streak}` : team.streak < 0 ? `L${-team.streak}` : '—'}</td></tr><tr><td>Tallest player</td><td>${players.length ? heightFt(Math.max(...players.map((p) => p.height))) : ''}</td></tr></table>`)}`;
  return layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, path: ctx.url.pathname, title: team.name, siteName: env.SITE_NAME, dyn, section: 'teams', body: two(left, right) });
}
