import type { PageCtx } from '../index.js';
import { html, type Raw } from '../html.js';
import { layout, box } from '../layout.js';
import { getTeams, getHeisman, getAllAmericans, getPlayersByIds, getConferences, getSeasonStatsFor, teamMap, type PlayerRow, type TeamRow } from '../db/queries.js';
import { playerLink, pos, cls, teamLink, headshot, teamLogo, confLogo } from './common.js';

const HEISMAN_LOGO = 'https://upload.wikimedia.org/wikipedia/en/8/8e/Heisman_Trophy_Logo.png';
type Stats = Map<string, Record<string, number>>; // kind (PSOF, PSDE, PSKI, PSKP, PSOL) -> season line

// Three headline numbers per position, from the season stat lines (codes as on the Stats page).
const fmt = (n: number) => n.toLocaleString('en-US');
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
const avg = (a: number, b: number) => (b ? (a / b).toFixed(1) : '-');
export function keyStats(position: number, stats: Stats): [string, string][] {
  const o = stats.get('PSOF') ?? {}, d = stats.get('PSDE') ?? {}, k = stats.get('PSKI') ?? {}, l = stats.get('PSOL') ?? {};
  const v = (s: Record<string, number>, key: string) => Number(s[key] ?? 0);
  const tackles = v(d, 'sdta') + v(d, 'sdht');
  if (position === 0) return [['YDS', fmt(v(o, 'saya'))], ['TD', fmt(v(o, 'satd'))], ['CMP', pct(v(o, 'sacm'), v(o, 'saat'))]];
  if (position === 1 || position === 2) return [['YDS', fmt(v(o, 'suya'))], ['TD', fmt(v(o, 'sutd'))], ['YPC', avg(v(o, 'suya'), v(o, 'suat'))]];
  if (position === 3 || position === 4) return [['REC', fmt(v(o, 'scca'))], ['YDS', fmt(v(o, 'scya'))], ['TD', fmt(v(o, 'sctd'))]];
  if (position >= 5 && position <= 9) return [['PANCAKES', fmt(v(l, 'sopa'))], ['SACKS ALW', fmt(v(l, 'sosa'))], ['GP', fmt(v(l, 'sgmp'))]];
  if (position >= 10 && position <= 15) return [['TKL', fmt(tackles)], ['TFL', fmt(v(d, 'sdtl'))], ['SACKS', fmt(v(d, 'slsk'))]];
  if (position >= 16 && position <= 18) return [['TKL', fmt(tackles)], ['INT', fmt(v(d, 'ssin'))], ['PD', fmt(v(d, 'sdpd'))]];
  if (position === 19) return [['FG', `${v(k, 'skfm')}/${v(k, 'skfa')}`], ['FG%', pct(v(k, 'skfm'), v(k, 'skfa'))], ['LNG', fmt(v(k, 'skfL'))]];
  if (position === 20) return [['PUNTS', fmt(v(k, 'spat'))], ['AVG', avg(v(k, 'spya'), v(k, 'spat'))], ['IN 20', fmt(v(k, 'sppt'))]];
  return [];
}
const keyCell = (position: number, stats: Stats | undefined): Raw => html`<td class="keystats">${keyStats(position, stats ?? new Map()).map(([label, value]) => html`<span class="ks"><b>${value}</b> ${label}</span>`)}</td>`;

export async function awardsPage(ctx: PageCtx) {
  const { env, dyn, url, member } = ctx;
  const db = env.DB, d = dyn.id, y = dyn.season_year;
  const [teams, heis, aa, confs] = await Promise.all([getTeams(db, d), getHeisman(db, d, y), getAllAmericans(db, d, y), getConferences(db, d)]);
  const tm = teamMap(teams);
  // All-conference teams (the game's AAPL rows: one first and one second team per conference). Default to the member's
  // conference, else the first one with a team.
  const aaConfs = confs.filter((c) => aa.some((a) => a.cgid === c.cgid));
  const myConf = member ? tm.get(member.tgid)?.cgid : undefined;
  const wanted = Number(url.searchParams.get('conf'));
  const conf = aaConfs.find((c) => c.cgid === wanted) ?? aaConfs.find((c) => c.cgid === myConf) ?? aaConfs[0];
  const confRows = conf ? aa.filter((a) => a.cgid === conf.cgid) : [];
  const ids = [...new Set([...heis.map((h) => h.pgid), ...confRows.map((a) => a.pgid)])];
  const [plist, srows] = await Promise.all([getPlayersByIds(db, d, ids), getSeasonStatsFor(db, d, y, ids)]);
  const players = new Map(plist.map((p) => [p.pgid, p]));
  const stats = new Map<number, Stats>();
  for (const r of srows) { if (!stats.has(r.pgid)) stats.set(r.pgid, new Map()); stats.get(r.pgid)!.set(r.kind, JSON.parse(r.stats_json) as Record<string, number>); }
  const teamCell = (p: PlayerRow | undefined, t: TeamRow | undefined) => html`<td class="team-cell">${p ? html`${teamLogo(t, 'xs')}${teamLink(dyn.slug, t)}` : ''}</td>`;

  const watch = heis.map((h) => ({ ...h, pts: Number((JSON.parse(h.raw_json || '{}') as Record<string, number>).PCAP ?? 0) })).sort((a, b) => b.pts - a.pts);
  const heisTitle = html`<span class="heisman-title"><img class="heisman-logo" src="${HEISMAN_LOGO}" alt="Heisman" height="26"> Watch</span>`;
  const heisBox = box(heisTitle, heis.length ? html`<table class="list awards"><tr><th class="rk">RK</th><th>Player</th><th>Pos</th><th>Team</th><th>Season</th><th class="num">Pts</th><th class="num">LW</th></tr>${watch.map((h, i) => {
    const p = players.get(h.pgid);
    return html`<tr><td class="rk">${i + 1}</td><td>${p ? headshot(p) : ''} ${playerLink(dyn.slug, p)}</td><td>${p ? pos(p.pos) : ''}</td>${teamCell(p, p ? tm.get(p.tgid) : undefined)}${p ? keyCell(p.pos, stats.get(p.pgid)) : html`<td></td>`}<td class="num">${h.pts}</td><td class="num muted">${h.rank >= 15 ? 'NR' : h.rank + 1}</td></tr>`;
  })}</table><p class="muted">Ordered by Heisman points; LW = last week's slot.</p>` : html`<p class="muted">No Heisman race yet.</p>`);

  const teamTable = (type: number, label: string) => {
    const rows = confRows.filter((a) => a.team_type === type).sort((a, b) => a.pos - b.pos);
    return html`<div class="aa-team"><h4>${label}</h4>${rows.length ? html`<table class="list awards"><tr><th>Pos</th><th>Player</th><th>Team</th><th>Season</th></tr>${rows.map((a) => {
      const p = players.get(a.pgid);
      return html`<tr><td>${pos(a.pos)}</td><td>${p ? headshot(p) : ''} ${playerLink(dyn.slug, p)} <span class="muted">${p ? cls(p) : ''}</span></td>${teamCell(p, p ? tm.get(p.tgid) : undefined)}${keyCell(a.pos, stats.get(a.pgid))}</tr>`;
    })}</table>` : html`<p class="muted">None.</p>`}</div>`;
  };
  const nav = html`<nav class="conf-nav">${aaConfs.map((c) => html`<a class="chip ${c.cgid === conf?.cgid ? 'on' : ''}" href="?conf=${c.cgid}#all-conference">${c.name}</a>`)}</nav>`;
  const aaBox = html`<div id="all-conference">${box(conf ? html`${confLogo(conf)}All-${conf.name} Teams` : 'All-Conference Teams', conf ? html`${nav}<div class="grid2 aa-grid">${teamTable(0, 'First Team')}${teamTable(1, 'Second Team')}</div>` : html`<p class="muted">No all-conference teams yet.</p>`)}</div>`;
  return layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, path: url.pathname, title: 'Awards', siteName: env.SITE_NAME, dyn, section: 'awards', body: html`${heisBox}${aaBox}` });
}
