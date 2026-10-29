import type { PageCtx } from '../index.js';
import { html, notFound } from '../html.js';
import { layout, box, two } from '../layout.js';
import { getTeams, getTeam, getPlayers, getPlayer, getPlayerSeasonStats, teamMap, getPendingPlayerEdit, listPendingPlayerEditPgids } from '../db/queries.js';
import { playerEditCard, canEditPlayer } from './player-edit.js';
import { teamLink, playerLink, pos, cls, heightFt, headshot } from './common.js';
import { fieldName, POSITIONS } from '@ncaa/ncaa14';

export async function rostersPage(ctx: PageCtx, tgid?: number) {
  const { env, dyn } = ctx;
  const db = env.DB, d = dyn.id;
  const teams = await getTeams(db, d);
  const sel = tgid ?? teams[0]?.tgid;
  const team = sel !== undefined ? teams.find((t) => t.tgid === sel) : undefined;
  const players = team ? await getPlayers(db, d, team.tgid) : [];
  const pending = new Set(team ? (await listPendingPlayerEditPgids(db, d, team.tgid, dyn.season_year, dyn.week ?? 0)).map((r) => r.pgid) : []); // edited on the site, not yet in the game
  const picker = html`<form class="inline" method="get" action="/d/${dyn.slug}/rosters/"><select name="t" onchange="location.href='/d/${dyn.slug}/rosters/'+this.value">${teams.map((t) => html`<option value="${t.tgid}" ${t.tgid === sel ? 'selected' : ''}>${t.name}</option>`)}</select></form>`;
  const body = html`<h2>Rosters</h2>${picker}
  ${team ? box(`${team.name} ${team.mascot} (${players.length})`, html`<table class="list roster"><tr><th>#</th><th></th><th>Name</th><th>Pos</th><th>Class</th><th>Ht</th><th>Wt</th><th>OVR</th><th>GP</th></tr>
    ${[...players].sort((a, b) => a.pos - b.pos || b.overall - a.overall).map((p) => html`<tr><td>${p.jersey}</td><td class="pic">${headshot(p)}</td><td>${playerLink(dyn.slug, p)}${pending.has(p.pgid) ? html` <span class="tag pending" title="Edited on the site; applied when the dynasty next loads on the console">PENDING</span>` : ''}</td><td>${pos(p.pos)}</td><td>${cls(p)}</td><td>${heightFt(p.height)}</td><td>${p.weight}</td><td class="ovr">${p.overall}</td><td>${p.games_played}</td></tr>`)}</table>`) : html``}`;
  return layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, path: ctx.url.pathname, title: 'Rosters', siteName: env.SITE_NAME, dyn, section: 'rosters', body });
}

export async function playerPage(ctx: PageCtx, pgid: number) {
  const { env, dyn } = ctx;
  const db = env.DB, d = dyn.id, y = dyn.season_year;
  const p = await getPlayer(db, d, pgid);
  if (!p) return notFound('No such player');
  const team = await getTeam(db, d, p.tgid);
  const pending = await getPendingPlayerEdit(db, d, pgid, y, dyn.week ?? 0);
  const editCard = canEditPlayer(ctx.member, p) ? playerEditCard(ctx, p, pending) : html``;
  const ratings: Record<string, number> = JSON.parse(p.ratings_json || '{}');
  const KEY = ['PSPD', 'PSTR', 'PAGI', 'PACC', 'PAWR', 'PBTK', 'PTRK', 'PELU', 'PBCV', 'PSMV', 'PJMV', 'PCAR', 'PCTH', 'PSPC', 'PCIT', 'PRTE', 'PJMP', 'PTHP', 'PTHA', 'PTAK', 'PHIT', 'PPMV', 'PFMV', 'PBSH', 'PPUR', 'PPRC', 'PMCV', 'PZCV', 'PPRS', 'PRLS', 'PPBK', 'PPBF', 'PPBS', 'PRBK', 'PRBF', 'PRBS', 'PIBL', 'PKPR', 'PKAC', 'PRET', 'PSTM', 'PINJ', 'PTGH'];
  const shown = KEY.filter((k) => k in ratings);
  const stats = await Promise.all(['PSOF', 'PSDE', 'PSKI', 'PSKP', 'PSOL'].map(async (k) => [k, (await getPlayerSeasonStats(db, d, y, k)).find((s) => s.pgid === pgid)] as const));
  const left = html`<div class="box player-card">${headshot(p, 'lg')}<h2>${p.first_name} ${p.last_name}${pending ? html` <span class="tag pending" title="Edited on the site; applied when the dynasty next loads on the console">PENDING</span>` : ''}</h2><p>${pos(p.pos)} · ${cls(p)} · #${p.jersey} · ${heightFt(p.height)} ${p.weight} lb · ${teamLink(dyn.slug, team ?? undefined)} · OVR <strong>${p.overall}</strong></p></div>
    ${box('Ratings', html`<table class="list ratings">${shown.map((k) => html`<tr><td>${fieldName(k)}</td><td class="bar"><span style="width:${ratings[k]}%"></span></td><td class="ovr">${ratings[k]}</td></tr>`)}</table>`)}`;
  const right = html`${editCard}${stats.filter(([, s]) => s).map(([k, s]) => box(`Season stats (${k})`, html`<table class="list">${Object.entries(JSON.parse(s!.stats_json)).filter(([f]) => !['PGID', 'SEYR', 'STKF', 'kind'].includes(f)).map(([f, v]) => html`<tr><td>${fieldName(f)}</td><td>${v as number}</td></tr>`)}</table>`))}
    ${box('Position', html`<p>${POSITIONS[p.pos] ?? p.pos}</p>`)}`;
  return layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, path: ctx.url.pathname, title: `${p.first_name} ${p.last_name}`, siteName: env.SITE_NAME, dyn, section: 'rosters', body: two(left, right) });
}
