import type { PageCtx } from '../index.js';
import { html, type Raw } from '../html.js';
import { layout, box, two } from '../layout.js';
import { getTeams, getGames, getStories, teamMap, getUserTeams, getMembers, listWebStories, listReady, listLiveSims, type GameRow, type MemberRow, type TeamRow, type LiveSimRow } from '../db/queries.js';
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
  const roster = await memberStatus(ctx, members, tm, thisWeek, preseason);
  const left = html`
    ${status}
    ${box(`${stage} · User games`, gamesTable(dyn.slug, thisWeek.filter(isUser), tm, 'No user games this week.'))}
    ${web ? html`<div class="box story"><a href="/d/${dyn.slug}/stories#story-${web.id}">${storyImageUrl(web) ? html`<img class="story-img" src="${storyImageUrl(web)}" alt="">` : ''}<h2>${web.title}</h2></a><p class="caption">${paragraphs(web.body)[0] ?? ''}</p><div class="timestamp">By ${web.author_persona} · ${weekLabel(web.week)}${web.tgid ? html` · ${teamLink(dyn.slug, tm.get(web.tgid))}` : ''} · <a href="/d/${dyn.slug}/stories#story-${web.id}">Read on the News Wire</a></div></div>`
      : main ? html`<div class="box story"><h2>${main.headline}</h2><p class="caption">${main.text}</p><div class="timestamp">${weekLabel(main.week)}${main.tgid ? html` · ${teamLink(dyn.slug, tm.get(main.tgid))}` : ''}</div></div>` : box('News Wire', html`<p class="muted">No stories yet.</p>`)}
    ${box('Headlines', html`<ul class="headlines">${headlines.map((s) => html`<li><strong>${s.headline}</strong> <span class="muted">${weekLabel(s.week)}</span><br>${s.text}</li>`)}</ul>`)}
  `;
  const right = html`
    <div id="members">${box(roster.title, members.length ? roster.body : html`<p class="muted">${online ? 'No members yet.' : 'Imported from an offline save; user teams come from the coach table.'}</p>`)}</div>
    ${scores.length ? box(`Scores · ${weekLabel(scoresWeek)}`, miniScores(dyn.slug, scores, tm)) : box('Scores', html`<p class="muted">No games played yet.</p>`)}
    ${box(`${pollName(teams)} Top 10`, html`<table class="list">${top.map((t) => html`<tr><td class="rk">${rankOf(t)}</td><td>${teamLogo(t, 'xs')} ${teamLink(dyn.slug, t)}</td><td>${t.wins}-${t.losses}</td></tr>`)}</table>`)}
  `;
  return layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, path: ctx.url.pathname, title: 'Home', siteName: env.SITE_NAME, dyn, section: 'home', body: two(left, right) });
}

// Dynasty Members (migration 0014): each member's game this week (played on the console, coached in Supersim, being
// coached right now, not played yet, bye) and whether they marked Ready, so the commissioner can see when to advance on
// the console. The member viewing the page gets the Ready toggle and, while their game is open, a link to coach it.
async function memberStatus(ctx: PageCtx, members: MemberRow[], tm: Map<number, TeamRow>, games: GameRow[], preseason: boolean): Promise<{ title: Raw | string; body: Raw }> {
  const { env, dyn, member: me, url } = ctx;
  const slug = dyn.slug, online = dyn.od_id !== null;
  const [ready, live] = online ? await Promise.all([listReady(env.DB, dyn.id, dyn.od_file_id ?? 0), listLiveSims(env.DB, dyn.id, dyn.season_year, dyn.week)]) : [[], [] as LiveSimRow[]];
  const readyAt = new Map(ready.map((r) => [r.blaze_id, r.ready_at]));
  const gameOf = (tgid: number) => games.find((g) => g.home_tgid === tgid || g.away_tgid === tgid);
  const liveOf = (g: GameRow | undefined) => (g ? live.find((l) => l.game_no === g.game_no) : undefined);
  const qtr = (q: number) => (q > 4 ? 'OT' : `Q${q}`);
  const weekCell = (m: MemberRow, t: TeamRow | undefined): Raw => {
    if (!t) return html`<span class="mg muted">No team yet</span>`;
    const g = gameOf(m.tgid);
    if (!g) return html`<span class="mg muted">${preseason ? 'Preseason' : games.length ? 'Bye week' : 'No games this week'}</span>`;
    const home = g.home_tgid === m.tgid, opp = tm.get(home ? g.away_tgid : g.home_tgid);
    const vs = `${home ? 'vs' : 'at'} ${opp?.abbr || opp?.name || '?'}`;
    if (g.status >= 2) {
      const us = home ? g.home_score : g.away_score, them = home ? g.away_score : g.home_score;
      return html`<a class="mg done ${us > them ? 'w' : 'l'}" href="/d/${slug}/game/${g.week}/${g.game_no}"><b>${us > them ? 'W' : 'L'} ${us}-${them}</b> ${vs}</a> <span class="mg-src">${g.source === 'supersim' ? 'Supersim' : 'Console'}</span>`;
    }
    const l = liveOf(g);
    if (l) { // being coached right now: other members' games link to the watch page (the viewer's own has the Resume button below)
      const us = home ? l.home_score : l.away_score, them = home ? l.away_score : l.home_score; const line = html`<i></i>In Supersim · ${us}-${them} ${vs} · ${qtr(l.q)}`;
      return me?.blaze_id === m.blaze_id ? html`<span class="mg live">${line}</span>` : html`<a class="mg live" href="/d/${slug}/supersim/watch/${g.week}/${g.game_no}" title="Watch this game live">${line} · Watch</a>`;
    }
    return html`<span class="mg todo">${preseason ? 'Up next' : 'Not played'} · ${vs}</span>`;
  };
  const rows = members.map((m) => {
    const t = tm.get(m.tgid), on = readyAt.has(m.blaze_id);
    return html`<tr class="${me?.blaze_id === m.blaze_id ? 'me' : ''}">
      <td class="m-logo">${t ? teamLogo(t, 'md') : html`<span class="m-nologo"></span>`}</td>
      <td class="m-main"><div class="m-name">${m.persona}${m.commissioner ? html` <span class="tag">Commish</span>` : ''}${m.web_only === 1 ? html` <span class="tag web" title="Plays on the site only (Supersim)">Web</span>` : ''}</div>
        <div class="m-team">${t ? html`${teamLink(slug, t)} · ${t.wins}-${t.losses}${rankOf(t) ? ` · #${rankOf(t)}` : ''}` : 'Picking a team'}</div>
        ${online ? html`<div class="m-wk">${weekCell(m, t)}</div>` : ''}</td>
      ${online ? html`<td class="m-rdy"><span class="rdy ${on ? 'on' : ''}" title="${on ? `Ready since ${readyAt.get(m.blaze_id)} UTC` : 'Not marked ready yet'}">${on ? 'Ready' : 'Not ready'}</span></td>` : ''}
    </tr>`;
  });
  const n = members.filter((m) => readyAt.has(m.blaze_id)).length, all = members.length > 0 && n === members.length;
  const title = online ? html`Dynasty Members <span class="rdy-count ${all ? 'all' : ''}">${n}/${members.length} ready</span>` : 'Dynasty Members';
  const err = url.searchParams.get('err');
  const bar = online ? html`<div class="rdy-bar" aria-hidden="true">${members.map((_, i) => html`<i class="${i < n ? 'on' : ''}"></i>`)}</div>` : html``;
  const done = all ? html`<p class="rdy-all">Everyone is ready. Commissioner: advance the week on the console.</p>` : html``;
  let mine: Raw = html``;
  if (online && me) {
    const g = me.tgid ? gameOf(me.tgid) : undefined, open = !!g && g.status < 2 && !preseason, on = readyAt.has(me.blaze_id);
    const sim = open && ctx.account && (env as { SUPERSIM_ENABLED?: string }).SUPERSIM_ENABLED === 'true' ? html`<a class="btn light sm" href="/d/${slug}/supersim">${liveOf(g) ? 'Resume your game' : 'Coach your game'}</a>` : html``;
    mine = html`<form class="me-ready" method="post" action="/d/${slug}/ready"><input type="hidden" name="back" value="${url.pathname}">
      ${on ? html`<span class="me-on">You're ready</span><button class="btn light sm" name="ready" value="0">Undo</button>` : html`<button class="btn sm" name="ready" value="1">I'm ready</button>`}${sim}
      ${open && !on ? html`<span class="muted me-hint">${me.web_only === 1 ? 'A game you leave unplayed is simulated by the console at the advance.' : 'Play your game on the console or in Supersim, then mark ready.'}</span>` : ''}
    </form>`;
  }
  return { title, body: html`${err ? html`<p class="flash err rdy-err">${err}</p>` : ''}${bar}<table class="mem">${rows}</table>${done}${mine}` };
}
