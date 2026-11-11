import { html, type Raw } from '../html.js';
import { getTeams, getGames, getWeeks, teamMap, type TeamRow, type GameRow, type PlayerRow, type Dynasty } from '../db/queries.js';
import type { Env } from '../env.js';
import { positionName, classYear } from '@ncaa/ncaa14';

import { gameOdds, leagueOdds } from '../odds.js';
export const teamLink = (slug: string, t: TeamRow | undefined, fallback = '?') => t ? html`<a class="team-link" href="/d/${slug}/team/${t.tgid}">${t.name}</a>` : html`${fallback}`;
export const teamAbbr = (t: TeamRow | undefined) => t?.abbr ?? '?';
export const playerName = (p: { first_name: string; last_name: string }) => `${p.first_name} ${p.last_name}`;
export const playerLink = (slug: string, p: PlayerRow | undefined, fallback = 'Unknown') => p ? html`<a href="/d/${slug}/player/${p.pgid}">${playerName(p)}</a>` : html`${fallback}`;
export const pos = (code: number) => positionName(code);
export const cls = (p: { year: number; redshirt: number }) => classYear(p.year, p.redshirt);
export const heightFt = (inches: number) => `${Math.floor(inches / 12)}'${inches % 12}"`;
// Headshot: the league's real player photo when the roster name matches one, else the game's face art for the player's
// head id, else a silhouette (served by the Worker when the R2 object is missing).
export const headshotUrl = (p: { photo_key?: string | null; head_id?: number | null }) =>
  p.photo_key ? `/img/players/${encodeURIComponent(p.photo_key.replace(/^players[/]/, ''))}` : p.head_id ? `/img/faces/${p.head_id}.png` : '/img/faces/0.png';
export const headshot = (p: { photo_key?: string | null; head_id?: number | null }, size: 'sm' | 'lg' = 'sm') =>
  html`<img class="headshot ${size}" src="${headshotUrl(p)}" alt="" loading="lazy" decoding="async" width="${size === 'lg' ? 80 : 28}" height="${size === 'lg' ? 96 : 34}">`;
// Team / conference logos from R2 (logos/<key>); a monogram shield with the abbreviation stands in when none is stored.
// Logos are stored at 500px plus 64px and 160px variants (logos/teams64, logos/teams160); pages use the small ones.
export const teamLogoUrl = (t: { logo_key?: string | null; abbr?: string }, size: 'xs' | 'sm' | 'md' | 'lg' = 'sm') => t.logo_key ? `/img/logos/${t.logo_key.replace(/^teams[/]/, size === 'lg' ? 'teams160/' : 'teams64/')}` : `/img/logos/teams/none.png?t=${encodeURIComponent(t.abbr ?? '?')}`;
export const teamLogo = (t: { logo_key?: string | null; abbr?: string; name?: string } | undefined, size: 'xs' | 'sm' | 'md' | 'lg' = 'sm') =>
  t ? html`<img class="tlogo ${size}" src="${teamLogoUrl(t, size)}" alt="" loading="lazy" decoding="async" width="${size === 'lg' ? 72 : size === 'md' ? 32 : size === 'xs' ? 16 : 20}" height="${size === 'lg' ? 72 : size === 'md' ? 32 : size === 'xs' ? 16 : 20}">` : html``;
// Team colours from the TEAM row (TBCR/TBCG/TBCB primary, TB2R/TB2G/TB2B secondary), as CSS hex, with a text colour
// that reads on the primary. Falls back to the site's ink and white when the row has none.
export function teamColors(rawJson: string | null | undefined): { primary: string; secondary: string; onPrimary: string } {
  let r: Record<string, unknown> = {}; try { r = JSON.parse(rawJson || '{}') ?? {}; } catch { /* none */ }
  const chan = (k: string) => { const v = Number(r[k]); return Number.isInteger(v) && v >= 0 && v <= 255 ? v : null; };
  const hex = (keys: [string, string, string]) => { const c = keys.map(chan); return c.every((v) => v !== null) ? `#${c.map((v) => v!.toString(16).padStart(2, '0')).join('')}` : null; };
  const primary = hex(['TBCR', 'TBCG', 'TBCB']) ?? '#1d1d1d', secondary = hex(['TB2R', 'TB2G', 'TB2B']) ?? '#ffffff';
  const lum = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  return { primary, secondary, onPrimary: lum(primary) > 0.4 ? '#111111' : '#ffffff' };
}
export const confLogo = (c: { logo_key?: string | null; name: string } | undefined, size: 'sm' | 'md' = 'sm') =>
  c?.logo_key ? html`<img class="tlogo ${size} conf" src="/img/logos/${c.logo_key.replace(/^conf[/]/, 'conf64/')}" alt="" loading="lazy" decoding="async" width="22" height="22">` : html``;
export const confTitle = (c: { logo_key?: string | null; name: string }) => html`${confLogo(c)}${c.name}`;
export const rankOf = (t?: { rank_bcs: number; rank_coaches: number; rank_media: number } | null) => (t ? (t.rank_bcs > 0 && t.rank_bcs <= 25 ? t.rank_bcs : t.rank_coaches > 0 && t.rank_coaches <= 25 ? t.rank_coaches : 0) : 0);
export const pollName = (teams: { rank_bcs: number }[]) => (teams.some((t) => t.rank_bcs > 0) ? 'BCS' : 'Coaches Poll');
export const gameHref = (slug: string, g: { week: number; game_no: number }) => `/d/${slug}/game/${g.week}/${g.game_no}`;
export const interestStack = (tm: Map<number, TeamRow>, json: string | null, max = 3) => {
  const list = (JSON.parse(json || '[]') as { tgid: number; points: number }[]).slice(0, max);
  if (!list.length) return html`<span class="muted">-</span>`;
  return html`<span class="istack" tabindex="0" title="${list.map((x) => `${tm.get(x.tgid)?.name ?? x.tgid} ${x.points}`).join(', ')}">${list.map((x) => { const t = tm.get(x.tgid); return html`<span class="ic"><img src="${t ? teamLogoUrl(t) : '/img/logos/teams/none.png?t=%3F'}" alt="" loading="lazy"><span class="ab">${t?.abbr ?? x.tgid}<br>${x.points}</span></span>`; })}</span>`;
};
export const rankBadge = (r: number) => (r > 0 && r <= 25 ? html`<span class="rank">#${r}</span> ` : html``);

// line: the simulated spread for a game still to be played ("MONT -6.5"), shown next to Preview
export function scoreLine(slug: string, g: GameRow, teams: Map<number, TeamRow>, line?: string): Raw {
  const h = teams.get(g.home_tgid), a = teams.get(g.away_tgid);
  const played = g.status >= 2;
  const homeWon = g.status === 3;
  return html`<tr class="game ${played ? 'final' : 'upcoming'}" data-href="${gameHref(slug, g)}">
    <td class="away ${played && !homeWon ? 'winner' : ''}">${teamLogo(a, 'xs')}${rankBadge(rankOf(a))}${teamLink(slug, a)}</td>
    <td class="score">${played ? g.away_score : ''}</td>
    <td class="at">@</td>
    <td class="home ${played && homeWon ? 'winner' : ''}">${teamLogo(h, 'xs')}${rankBadge(rankOf(h))}${teamLink(slug, h)}</td>
    <td class="score">${played ? g.home_score : ''}</td>
    <td class="status">${!played && line ? html`<span class="line">${line}</span> · ` : ''}<a href="${gameHref(slug, g)}">${played ? (g.overtime ? 'Final/OT' : 'Final') : 'Preview'}</a>${g.user_played ? ' · user' : ''}</td>
  </tr>`;
}

// Compact scoreboard for the 320px sidebar: one two-line tile per game (logo, rank, abbreviation, score), two per row.
export const miniScores = (slug: string, games: GameRow[], teams: Map<number, TeamRow>, empty = 'No games.') => {
  const row = (t: TeamRow | undefined, score: number, won: boolean, played: boolean) => html`<div class="ms-row ${won ? 'won' : ''}">${teamLogo(t, 'xs')}<span class="ms-abbr">${t && rankOf(t) > 0 && rankOf(t) <= 25 ? html`<span class="ms-rk">${rankOf(t)}</span>` : ''}${t?.abbr ?? '?'}</span><span class="ms-score">${played ? score : ''}</span></div>`;
  return games.length ? html`<div class="mini-scores">${games.map((g) => { const played = g.status >= 2; const a = teams.get(g.away_tgid), h = teams.get(g.home_tgid); return html`<a class="ms-game" href="${gameHref(slug, g)}">${row(a, g.away_score, played && g.status === 2, played)}${row(h, g.home_score, played && g.status === 3, played)}<div class="ms-status">${played ? (g.overtime ? 'Final/OT' : 'Final') : 'Preview'}${g.user_played ? ' · user' : ''}</div></a>`; })}</div>` : html`<p class="muted">${empty}</p>`;
};

export const gamesTable = (slug: string, games: GameRow[], teams: Map<number, TeamRow>, empty = 'No games.', lines?: Map<string, string>) =>
  games.length ? html`<table class="games">${games.map((g) => scoreLine(slug, g, teams, lines?.get(`${g.week}:${g.game_no}`)))}</table>` : html`<p class="muted">${empty}</p>`;

// Scoreboard strip: one tile per game of a week. stripTiles is also served alone (/d/<slug>/strip?week=N) for the
// week dropdown; scoreStrip wraps the current week with the week select and the season label.
export async function stripTiles(env: Env, dyn: Dynasty, week: number): Promise<Raw> {
  const [teams, games] = await Promise.all([getTeams(env.DB, dyn.id), getGames(env.DB, dyn.id, dyn.season_year, { week })]);
  const tm = teamMap(teams);
  // games still to be played carry the simulated moneyline where the score will go (worker/src/odds.ts)
  const lo = games.some((g) => g.status < 2) ? await leagueOdds(env.DB, dyn) : null;
  // the favourite's (minus) price leans green, the underdog's (plus) price leans red; around +/-200 both stay neutral
  // and the colour deepens with the price, to full at 5000 (a log scale, so -600 already reads clearly)
  const mlColor = (n: number) => { const t = Math.min(1, Math.max(0, Math.log(Math.abs(n) / 200) / Math.log(25))); const to = n < 0 ? [10, 143, 60] : [204, 0, 0]; return `rgb(${[72, 73, 74].map((c, i) => Math.round(c + (to[i]! - c) * t)).join(' ')})`; };
  const ml = (n: number | undefined) => (n === undefined ? '' : html`<span class="st-ml" style="color:${mlColor(n)}">${n > 0 ? '+' : '−'}${Math.abs(n)}</span>`);
  const row = (t: TeamRow, score: number, won: boolean, played: boolean, money?: number) => html`<div class="st-row ${won ? 'won' : ''}">${teamLogo(t, 'xs')}<span class="st-abbr">${rankOf(t) ? html`<span class="st-rk">${rankOf(t)}</span>` : ''}${t.abbr}</span><span class="st-score">${played ? score : ml(money)}</span></div>`;
  const tiles = games.map((g) => {
    const h = tm.get(g.home_tgid), a = tm.get(g.away_tgid);
    if (!h || !a) return html``;
    const played = g.status >= 2; const o = played ? null : gameOdds(lo, g);
    return html`<a class="st-tile ${played ? 'final' : ''}" href="${gameHref(dyn.slug, g)}">${row(a, g.away_score, played && g.status === 2, played, o?.awayMoney)}${row(h, g.home_score, played && g.status === 3, played, o?.homeMoney)}<div class="st-status">${played ? (g.overtime ? 'Final/OT' : 'Final') : 'Preview'}</div></a>`;
  });
  return html`${tiles.length ? tiles : html`<span class="st-empty">No games this week</span>`}`;
}
export async function scoreStrip(env: Env, dyn: Dynasty): Promise<Raw> {
  const week = dyn.week ?? 0;
  const [tiles, weeks] = await Promise.all([stripTiles(env, dyn, week), getWeeks(env.DB, dyn.id, dyn.season_year)]);
  const opts = [...new Set([...weeks.map((w) => w.week).filter((w) => w <= week), week])].sort((a, b) => b - a);
  const label = (w: number) => (w === week && dyn.week_type === 151 ? 'Preseason' : weekLabel(w));
  return html`<div class="scorestrip"><div class="wrap st-inner"><div class="st-label"><span class="st-weekwrap"><select class="st-select" aria-label="Week" data-url="/d/${dyn.slug}/strip">${opts.map((w) => html`<option value="${w}" ${w === week ? 'selected' : ''}>${label(w)}</option>`)}</select></span><span class="st-sub">${seasonLabel(dyn)}</span></div><div class="st-scroll" data-week="${week}">${tiles}</div></div></div>`;
}
// Seasons are counted from the dynasty's first year (dynasties.start_year = SEAI.SSYE + 2013, the hub's "Year N";
// 2013 for saves imported before it was recorded): "1st season", "2nd season" ... A dynasty moved to 2026 by the
// Year Changer is in its 1st season, not its 14th.
export const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
export const seasonLabel = (d: { season_year: number | null; start_year?: number | null }) => `${ordinal(Math.max(1, (d.season_year ?? 2013) - (d.start_year ?? 2013) + 1))} season`;

export const weekLabel = (w: number) => (w === 0 ? 'Week 1' : w >= 15 ? `Postseason ${w - 14}` : `Week ${w + 1}`);
