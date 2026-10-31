import type { PageCtx } from '../index.js';
import { html } from '../html.js';
import { layout, box, two } from '../layout.js';
import { getTeams, getGames, getStories, teamMap, getUserTeams, getMembers, listWebStories, type GameRow } from '../db/queries.js';
import { storyImageUrl, paragraphs } from './stories.js';
import { gamesTable, miniScores, weekLabel, teamLink, teamLogo, rankOf, pollName, seasonLabel } from './common.js';

export async function homePage(ctx: PageCtx) {
  const { env, dyn } = ctx;
  const db = env.DB, d = dyn.id, y = dyn.season_year;
  const [teams, stories, members, coachTeams, webStories] = await Promise.all([getTeams(db, d), getStories(db, d, y, { limit: 12 }), getMembers(db, d), getUserTeams(db, d), listWebStories(db, d, 1)]);
  const tm = teamMap(teams);
  const userSet = new Set([...members.map((m) => m.tgid), ...coachTeams.map((u) => u.tgid)].filter((t) => t > 0 && t !== 1023));
  const isUser = (g: GameRow) => userSet.has(g.home_tgid) || userSet.has(g.away_tgid);
  const week = dyn.week ?? 0;
  const [thisWeek, played] = await Promise.all([getGames(db, d, y, { week }), getGames(db, d, y, { playedOnly: true })]);
  const lastPlayedWeek = played.length ? Math.max(...played.map((g) => g.week)) : -1;
  const scoresWeek = thisWeek.some((g) => g.status >= 2) ? week : lastPlayedWeek;
  const scores = scoresWeek < 0 ? [] : scoresWeek === week ? thisWeek : await getGames(db, d, y, { week: scoresWeek });
  // The newest member-written story is the hero when there is one; the game's own lead headline then joins the Headlines box.
  const web = webStories[0];
  const main = web ? undefined : stories[0];
  const headlines = web ? stories : stories.slice(1);
  const top = teams.filter((t) => rankOf(t) > 0 && rankOf(t) <= 10).sort((a, b) => rankOf(a) - rankOf(b));
  const online = dyn.od_id !== null;
  const preseason = dyn.week_type === 151;
  const stage = preseason ? 'Preseason' : weekLabel(week);
  const status = online
    ? html`<p class="od-status"><span class="tag">ONLINE DYNASTY</span> ${seasonLabel(dyn)} · ${stage} · ${members.length} member${members.length === 1 ? '' : 's'} · dynasty file #${dyn.od_file_id ?? 0}${dyn.updated_at ? html` · synced from the console ${dyn.updated_at} UTC` : ''}</p>`
    : html`<p class="od-status">${seasonLabel(dyn)} · ${stage}${dyn.updated_at ? html` · imported ${dyn.updated_at} UTC` : ''}</p>`;
  const memberRows = members.map((m) => {
    const t = tm.get(m.tgid);
    return html`<tr><td>${m.persona}${m.commissioner ? html` <span class="tag">COMMISH</span>` : ''}</td><td>${t ? html`${teamLogo(t)} ${teamLink(dyn.slug, t)}` : html`<span class="muted">picking a team</span>`}</td><td>${t ? `${t.wins}-${t.losses}` : ''}</td><td class="muted">${t && rankOf(t) ? `#${rankOf(t)}` : ''}</td></tr>`;
  });
  const left = html`
    ${status}
    ${box(`${stage} · User games`, gamesTable(dyn.slug, thisWeek.filter(isUser), tm, 'No user games this week.'))}
    ${web ? html`<div class="box story"><a href="/d/${dyn.slug}/stories#story-${web.id}">${storyImageUrl(web) ? html`<img class="story-img" src="${storyImageUrl(web)}" alt="">` : ''}<h2>${web.title}</h2></a><p class="caption">${paragraphs(web.body)[0] ?? ''}</p><div class="timestamp">By ${web.author_persona} · ${weekLabel(web.week)}${web.tgid ? html` · ${teamLink(dyn.slug, tm.get(web.tgid))}` : ''} · <a href="/d/${dyn.slug}/stories#story-${web.id}">Read on the News Wire</a></div></div>`
      : main ? html`<div class="box story"><h2>${main.headline}</h2><p class="caption">${main.text}</p><div class="timestamp">${weekLabel(main.week)}${main.tgid ? html` · ${teamLink(dyn.slug, tm.get(main.tgid))}` : ''}</div></div>` : box('News Wire', html`<p class="muted">No stories yet.</p>`)}
    ${box('Headlines', html`<ul class="headlines">${headlines.map((s) => html`<li><strong>${s.headline}</strong> <span class="muted">${weekLabel(s.week)}</span><br>${s.text}</li>`)}</ul>`)}
  `;
  const right = html`
    ${box('Dynasty Members', members.length ? html`<table class="list members">${memberRows}</table>` : html`<p class="muted">${online ? 'No members yet.' : 'Imported from an offline save; user teams come from the coach table.'}</p>`)}
    ${scores.length ? box(`Scores · ${weekLabel(scoresWeek)}`, miniScores(dyn.slug, scores, tm)) : box('Scores', html`<p class="muted">No games played yet.</p>`)}
    ${box(`${pollName(teams)} Top 10`, html`<table class="list">${top.map((t) => html`<tr><td class="rk">${rankOf(t)}</td><td>${teamLogo(t, 'xs')} ${teamLink(dyn.slug, t)}</td><td>${t.wins}-${t.losses}</td></tr>`)}</table>`)}
  `;
  return layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, path: ctx.url.pathname, title: 'Home', siteName: env.SITE_NAME, dyn, section: 'home', body: two(left, right) });
}
