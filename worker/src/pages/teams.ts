import type { PageCtx } from '../index.js';
import { html, notFound } from '../html.js';
import { layout, box, two } from '../layout.js';
import { getTeams, getTeam, getConferences, getGames, getPlayers, getCoaches, getStories, teamMap, type GameRow, type TeamRow } from '../db/queries.js';
import { gamesTable, teamLink, playerLink, pos, cls, heightFt, weekLabel, teamLogo, rankOf, seasonLabel } from './common.js';

// Teams = an automated power ranking (Standings keeps the conference tables). Each team gets a 0-100 rating from weighted
// parts: win % (32), capped scoring margin (18), strength of schedule (15), last-three form (10), points scored and allowed
// per game as percentiles (8 + 8), plus +3 per quality win (opponent >= .600), -3 per bad loss (opponent < .400), up to
// +/-2 for the current streak and a small bonus for a top-25 poll rank. Before any game is played the order is team
// overall rating.
interface Power { t: TeamRow; g: number; pf: number; pa: number; margin: number; sos: number; qw: number; bl: number; form: string[]; best?: { opp: TeamRow; us: number; them: number }; worst?: { opp: TeamRow; us: number; them: number }; rating: number }
const pctOf = (t: TeamRow) => (t.wins + t.losses ? t.wins / (t.wins + t.losses) : 0.5);
function powerRanking(teams: TeamRow[], games: GameRow[]): Power[] {
  const tm = teamMap(teams);
  const rows = new Map<number, Power>(teams.map((t) => [t.tgid, { t, g: 0, pf: 0, pa: 0, margin: 0, sos: 0, qw: 0, bl: 0, form: [], rating: 0 }]));
  for (const g of [...games].sort((a, b) => a.week - b.week || a.game_no - b.game_no)) {
    for (const [us, them, usScore, themScore] of [[g.home_tgid, g.away_tgid, g.home_score, g.away_score], [g.away_tgid, g.home_tgid, g.away_score, g.home_score]] as const) {
      const r = rows.get(us), opp = tm.get(them); if (!r || !opp) continue;
      const won = usScore > themScore, op = pctOf(opp);
      r.g += 1; r.pf += usScore; r.pa += themScore; r.margin += Math.max(-28, Math.min(28, usScore - themScore)); r.sos += op; r.form.push(won ? 'W' : 'L');
      if (won && op >= 0.6) r.qw += 1; if (!won && op < 0.4) r.bl += 1;
      if (won && (!r.best || op > pctOf(r.best.opp))) r.best = { opp, us: usScore, them: themScore };
      if (!won && (!r.worst || op < pctOf(r.worst.opp))) r.worst = { opp, us: usScore, them: themScore };
    }
  }
  const list = [...rows.values()];
  const played = list.filter((r) => r.g > 0);
  const rankPct = (vals: number[], v: number, higherBetter: boolean) => (vals.length > 1 ? vals.filter((x) => (higherBetter ? x < v : x > v)).length / (vals.length - 1) : 0.5);
  const pfs = played.map((r) => r.pf / r.g), pas = played.map((r) => r.pa / r.g);
  for (const r of list) {
    if (!r.g) { r.rating = r.t.overall / 2; continue; }
    const form = r.form.slice(-3); const formPct = form.filter((x) => x === 'W').length / form.length;
    const streak = Math.max(-5, Math.min(5, r.t.streak)) / 5; const poll = rankOf(r.t);
    r.rating = 100 * (0.32 * pctOf(r.t) + 0.18 * ((r.margin / r.g + 28) / 56) + 0.15 * (r.sos / r.g) + 0.1 * formPct + 0.08 * rankPct(pfs, r.pf / r.g, true) + 0.08 * rankPct(pas, r.pa / r.g, false))
      + 3 * r.qw - 3 * r.bl + 2 * streak + (poll ? (26 - poll) * 0.15 : 0);
  }
  return list.sort((a, b) => b.rating - a.rating || b.t.overall - a.t.overall || a.t.name.localeCompare(b.t.name));
}

export async function teamsPage(ctx: PageCtx) {
  const { env, dyn } = ctx;
  const db = env.DB, d = dyn.id, y = dyn.season_year;
  const [teams, confs, coaches, games] = await Promise.all([getTeams(db, d), getConferences(db, d), getCoaches(db, d), getGames(db, d, y, { playedOnly: true })]);
  const userTeams = new Set(coaches.filter((c) => c.user_controlled).map((c) => c.tgid));
  const confOf = new Map(confs.map((c) => [c.cgid, c]));
  const ranked = powerRanking(teams, games);
  const sosOrder = ranked.filter((r) => r.g).map((r) => r.sos / r.g).sort((a, b) => b - a);
  const sosRank = (r: Power) => (r.g ? sosOrder.indexOf(r.sos / r.g) + 1 : 0);
  const result = (x: Power['best'], won: boolean) => x ? html`<span class="${won ? 'res-w' : 'res-l'}">${won ? 'W' : 'L'} ${x.us}-${x.them}</span> ${teamLogo(x.opp, 'xs')}${x.opp.abbr} <span class="muted">(${x.opp.wins}-${x.opp.losses})</span>` : html`<span class="muted">-</span>`;
  const body = html`<h2>Power Rankings</h2>
  <p class="muted pw-note">Computed from this season's results: record, scoring margin, strength of schedule, recent form, offense and defense, quality wins and bad losses, streak and poll position. The conference tables are on <a href="/d/${dyn.slug}/standings">Standings</a>.</p>
  ${box(`${seasonLabel(dyn)} · ${games.length ? `through ${weekLabel(Math.max(...games.map((g) => g.week)))}` : 'preseason (by team rating)'}`, html`<table class="list power"><tr><th class="rk">#</th><th>Team</th><th>Record</th><th class="pw-x">Conf</th><th>Streak</th><th class="pw-x">Last 3</th><th class="num pw-x">PF/G</th><th class="num pw-x">PA/G</th><th class="num pw-x">SOS</th><th class="pw-x">Best win</th><th class="pw-x">Worst loss</th><th class="num">Rating</th></tr>
  ${ranked.map((r, i) => html`<tr class="${userTeams.has(r.t.tgid) ? 'user-team' : ''}"><td class="rk">${i + 1}</td><td>${teamLogo(r.t)} ${teamLink(dyn.slug, r.t)}${rankOf(r.t) ? html` <span class="muted">#${rankOf(r.t)}</span>` : ''}${userTeams.has(r.t.tgid) ? html` <span class="tag">USER</span>` : ''}<div class="pw-conf muted">${confOf.get(r.t.cgid)?.name ?? r.t.conf_label}</div></td>
    <td>${r.t.wins}-${r.t.losses}</td><td class="pw-x muted">${r.t.conf_wins}-${r.t.conf_losses}</td><td>${r.t.streak > 0 ? html`<span class="res-w">W${r.t.streak}</span>` : r.t.streak < 0 ? html`<span class="res-l">L${-r.t.streak}</span>` : '-'}</td>
    <td class="pw-x">${r.form.slice(-3).map((x) => html`<span class="form ${x === 'W' ? 'w' : 'l'}">${x}</span>`)}</td>
    <td class="num pw-x">${r.g ? (r.pf / r.g).toFixed(1) : '-'}</td><td class="num pw-x">${r.g ? (r.pa / r.g).toFixed(1) : '-'}</td><td class="num pw-x">${r.g ? `#${sosRank(r)}` : '-'}</td>
    <td class="pw-x">${result(r.best, true)}</td><td class="pw-x">${result(r.worst, false)}</td><td class="num"><b>${r.rating.toFixed(1)}</b></td></tr>`)}
  </table>`)}`;
  return layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, path: ctx.url.pathname, title: 'Power Rankings', siteName: env.SITE_NAME, dyn, section: 'teams', body, wide: true });
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
