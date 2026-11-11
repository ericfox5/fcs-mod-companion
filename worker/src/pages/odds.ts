// Odds: simulated lines for the current week and every week still to be played (spread, total, moneylines and win
// probability from the rosters, depth charts and results so far; see worker/src/odds.ts). Entertainment only.
import type { PageCtx } from '../index.js';
import { html, raw, type Raw } from '../html.js';
import { layout, box } from '../layout.js';
import { getGames, getTeams, teamMap, type GameRow, type TeamRow } from '../db/queries.js';
import { moneyLabel, spreadLabel, type Odds } from '@ncaa/ncaa14';
import { gameHref, rankBadge, rankOf, teamColors, teamLink, teamLogo, weekLabel } from './common.js';
import { gameOdds, leagueOdds, storedLines, type LineRow } from '../odds.js';
import { UNIFORMS } from './uniforms.generated.js';

const pct = (p: number) => `${Math.round(p * 100)}%`;
// the win-probability bar: away share on the left, home on the right
export const probBar = (o: Odds) => html`<div class="prob" title="${pct(o.awayWin)} / ${pct(o.homeWin)}"><span class="a" style="width:${(o.awayWin * 100).toFixed(1)}%"></span><span class="h" style="width:${(o.homeWin * 100).toFixed(1)}%"></span></div>`;

// A played game against the line it closed at (game_lines): who was favoured and by how much, the total, whether the
// favourite covered and whether the game went over. The spread is on the home team.
export function closingResult(away: TeamRow, home: TeamRow, g: Pick<GameRow, 'home_score' | 'away_score'>, l: LineRow): { line: string; cover: string; total: string } {
  const fav = l.spread < 0 ? home : l.spread > 0 ? away : null; const dog = fav === home ? away : home;
  const margin = g.home_score - g.away_score; const ats = margin + l.spread; // above zero: the home side beat the number
  const favBy = fav === home ? margin : -margin; const points = g.home_score + g.away_score;
  const line = fav ? `${fav.abbr} −${Math.abs(l.spread).toFixed(1)}` : 'Pick’em';
  const cover = !fav ? (margin === 0 ? 'Tie' : `${(margin > 0 ? home : away).name} won`) : ats === 0 ? 'Push' : (fav === home ? ats > 0 : ats < 0) ? `${fav.name} covered` : favBy > 0 ? `${fav.name} won but did not cover` : `${dog.name} won outright`;
  const total = points === l.total ? 'Push on the total' : points > l.total ? 'Over' : 'Under';
  return { line, cover, total };
}
export const closingLine = (away: TeamRow, home: TeamRow, g: Pick<GameRow, 'home_score' | 'away_score'>, l: LineRow): Raw => {
  const r = closingResult(away, home, g, l);
  return html`<section class="box closing"><span class="cl-tag">Closing line</span><span class="cl-line"><b>${r.line}</b> · O/U <b>${l.total.toFixed(1)}</b></span><span class="cl-res">${r.cover} · ${r.total} (${g.away_score + g.home_score} points)</span><span class="cl-note muted">simulated line, for fun</span></section>`;
};

function oddsRow(slug: string, g: GameRow, tm: Map<number, TeamRow>, o: Odds | null, closed?: LineRow): Raw {
  const a = tm.get(g.away_tgid), h = tm.get(g.home_tgid); const played = g.status >= 2;
  const teams = html`<td class="team">${teamLogo(a, 'xs')}${rankBadge(rankOf(a))}${teamLink(slug, a)}</td><td class="at">@</td><td class="team">${teamLogo(h, 'xs')}${rankBadge(rankOf(h))}${teamLink(slug, h)}</td>`;
  // a played game shows the line it closed at (when one was recorded) and how it came out, not today's number
  if (played && a && h) {
    if (!closed) return html`<tr class="final" data-href="${gameHref(slug, g)}">${teams}<td colspan="4" class="muted">No closing line recorded</td><td class="status"><a href="${gameHref(slug, g)}">Final ${g.away_score}-${g.home_score}</a></td></tr>`;
    const r = closingResult(a, h, g, closed);
    return html`<tr class="final" data-href="${gameHref(slug, g)}">${teams}<td class="num line"><b>${r.line}</b></td><td class="num">${closed.total.toFixed(1)}</td><td class="num ml">${a.abbr} ${moneyLabel(closed.away_money)}<br>${h.abbr} ${moneyLabel(closed.home_money)}</td><td class="wp"><span class="wp-n">${r.cover} · ${r.total}</span></td><td class="status"><a href="${gameHref(slug, g)}">Final ${g.away_score}-${g.home_score}</a></td></tr>`;
  }
  if (!o || !a || !h) return html`<tr data-href="${gameHref(slug, g)}">${teams}<td colspan="5" class="muted">${played ? `Final ${g.away_score}-${g.home_score}` : 'No line yet'}</td></tr>`;
  const fav = o.spread < 0 ? h : o.spread > 0 ? a : null;
  return html`<tr class="${played ? 'final' : ''}" data-href="${gameHref(slug, g)}">${teams}
    <td class="num line">${fav ? html`${fav.abbr} <b>${(-Math.abs(o.spread)).toFixed(1)}</b>` : 'Pick’em'}</td>
    <td class="num">${o.total.toFixed(1)}</td>
    <td class="num ml">${a.abbr} ${moneyLabel(o.awayMoney)}<br>${h.abbr} ${moneyLabel(o.homeMoney)}</td>
    <td class="wp">${probBar(o)}<span class="wp-n">${pct(o.awayWin)} · ${pct(o.homeWin)}</span></td>
    <td class="status">${played ? html`<a href="${gameHref(slug, g)}">Final ${g.away_score}-${g.home_score}</a>` : html`<a href="${gameHref(slug, g)}">Preview</a>`}</td></tr>`;
}

export async function oddsPage(ctx: PageCtx) {
  const { env, dyn, url } = ctx; const db = env.DB;
  const [teams, all, lo] = await Promise.all([getTeams(db, dyn.id), getGames(db, dyn.id, dyn.season_year), leagueOdds(db, dyn)]);
  const tm = teamMap(teams);
  const weeks = [...new Set(all.map((g) => g.week))].sort((a, b) => a - b);
  // this week = the first week with a game still to play; the nav runs from there to the end of the schedule
  const open = weeks.filter((w) => all.some((g) => g.week === w && g.status < 2));
  const current = open[0] ?? weeks[weeks.length - 1] ?? 0;
  const week = url.searchParams.has('week') ? Number(url.searchParams.get('week')) : current;
  const shown = weeks.filter((w) => w >= current || weeks.indexOf(w) >= weeks.indexOf(current) - 2 || w === week); // the last two played weeks stay in reach, for the closing lines
  const games = all.filter((g) => g.week === week); const closed = games.some((g) => g.status >= 2) ? await storedLines(db, dyn, week) : new Map<number, LineRow>();
  const nav = html`<div class="weeknav">${shown.map((w) => (w === week ? html`<span>${weekLabel(w)}</span>` : html`<a href="?week=${w}">${weekLabel(w)}</a>`))}</div>`;
  const table = games.length
    ? html`<table class="list odds"><tr><th>Away</th><th></th><th>Home</th><th class="num">Spread</th><th class="num">Total</th><th class="num">Moneyline</th><th>Win probability (away · home)</th><th></th></tr>${games.map((g) => oddsRow(dyn.slug, g, tm, gameOdds(lo, g), closed.get(g.game_no)))}</table>`
    : html`<p class="muted">No games this week.</p>`;
  const note = html`<p class="muted">Simulated lines for fun: no real wagering. They are worked out from each team's depth chart and player ratings by unit (quarterback, run game, receivers, both lines, pass rush, coverage, kicking), set offense against defense, with a home edge and this season's results mixed in, and scaled to how Supersim games actually come out. They move when rosters, depth charts or results change.</p>`;
  const body = html`<h2>Odds</h2>${nav}${box(`${weekLabel(week)}${week === current ? ' · this week' : ''}`, lo ? table : html`<p class="muted">Lines are not available right now.</p>`)}${note}`;
  return layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, path: ctx.url.pathname, title: 'Odds', siteName: env.SITE_NAME, dyn, section: 'odds', body, wide: true });
}

// ---- the odds module on a game's preview page ----------------------------------------------------------------------
// Scoreboard numerals: the site's own seven-segment digits, drawn as SVG (no font to load). Unlit segments stay faintly
// visible, like a real board. Takes digits, '+', '-', '.' and spaces.
const SEG: Record<string, string> = {
  a: '2.2,1 7.8,1 8.8,2 7.8,3 2.2,3 1.2,2', g: '2.2,8 7.8,8 8.8,9 7.8,10 2.2,10 1.2,9', d: '2.2,15 7.8,15 8.8,16 7.8,17 2.2,17 1.2,16',
  f: '1,2.4 2,3.4 2,7.6 1,8.6 0,7.6 0,3.4', b: '9,2.4 10,3.4 10,7.6 9,8.6 8,7.6 8,3.4',
  e: '1,9.4 2,10.4 2,14.6 1,15.6 0,14.6 0,10.4', c: '9,9.4 10,10.4 10,14.6 9,15.6 8,14.6 8,10.4',
};
const DIGIT: Record<string, string> = { _: '', '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abfgcd', '-': 'g', '+': 'g' };
export function segNumber(text: string, height = 40, cls = ''): Raw {
  let x = 2; let out = '';
  for (const ch of text) {
    if (ch === ' ') { x += 5; continue; }
    if (ch === '.') { out += `<rect class="n" x="${x}" y="15" width="2.2" height="2.2" rx=".4"/>`; x += 4.4; continue; }
    const lit = DIGIT[ch]; if (lit === undefined) continue;
    const signs = ch === '+' || ch === '-';
    for (const [k, pts] of Object.entries(SEG)) { if (signs && k !== 'g') continue; out += `<polygon class="${lit.includes(k) ? 'n' : 'o'}" transform="translate(${x} 0)" points="${pts}"/>`; }
    if (ch === '+') out += `<rect class="n" x="${x + 4}" y="5.2" width="2" height="7.6" rx=".6"/>`;
    x += 12.4;
  }
  const w = Math.max(6, x + 1.5);
  return raw(`<svg class="seg${cls ? ` ${cls}` : ''}" role="img" aria-label="${text.replace(/_/g, '').trim()}" viewBox="0 0 ${w.toFixed(1)} 18" height="${height}" width="${((w / 18) * height).toFixed(1)}"><g transform="skewX(-7) translate(2.2 0)">${out}</g></svg>`);
}
// a team colour that reads on the dark board (a black or navy primary gives way to the secondary) and one for white cards
const lum = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i]!, 0);
// on the board a dark primary (maroon, navy) is lifted toward white until it reads, keeping its hue; pure black goes grey
const lift = (h: string) => { let c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); if (Math.max(...c) < 40) return '#b9bcc0'; let out = h; for (let k = 0; k < 12 && lum(out) < 0.13; k++) { c = c.map((v) => Math.round(v + (255 - v) * 0.14)); out = `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`; } return out; };
const onDark = (t: TeamRow) => lift(teamColors(t.raw_json).primary);
const onLight = (t: TeamRow) => { const c = teamColors(t.raw_json); return lum(c.primary) <= 0.6 ? c.primary : lum(c.secondary) <= 0.6 ? c.secondary : '#1d1d1d'; };
const ICON: Record<string, string> = {
  'pass game against the pass defense': '<path d="M3 16c4-9 10-12 18-12M21 4l-5 .6M21 4l-1.2 4.8"/>',
  'run game against the run defense': '<path d="M4 6l6 6-6 6M12 6l6 6-6 6"/>',
  'pass rush against the pass protection': '<path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z"/><path d="M9 12h6M12 9v6"/>',
  quarterback: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  'kicking game': '<path d="M6 3v10h12V3M12 13v8"/>',
};
const icon = (label: string) => raw(`<svg class="ob-ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[label] ?? '<circle cx="12" cy="12" r="7"/>'}</svg>`);
const money = (n: number) => `${n > 0 ? '+' : '-'}${Math.abs(n)}`;

// the odds module: a scoreboard with the projected score and a win-probability bar in the two teams' colours, the three
// lines as tiles (each number in its own treatment), and the mismatches as bars. Everything animates in once (odds.css).
// stars: each side's best player (highest overall), shown as an animated figure in his team's uniform (js/hero3d.js):
// the helmet, jersey, pants and number colours come from the game's own uniform art (uniforms.generated.ts; the home
// side wears its Home set, the visitors their Away set), falling back to the team's two colours.
// stat: his headline number (this season's best stat line, or his best rating before any games); skin: the skin colour
// of his in-game head (PGHE, face-skin.generated.ts) for the figure. link: false leaves his name unlinked (Quickplay).
export interface Star { pgid: number; name: string; pos: string; number: number; stat: string; skin?: string }
export function oddsBox(away: TeamRow, home: TeamRow, o: Odds, slug = '', stars: { away?: Star; home?: Star } = {}): Raw {
  const hero = (t: TeamRow, st: Star | undefined, set: 'home' | 'away') => {
    if (!st) return ''; const c = teamColors(t.raw_json); const k = UNIFORMS[t.tgid]?.[set] ?? {};
    const label = html`<b>${st.name}</b><span>${st.pos} · ${st.stat}</span>`;
    return html`<div class="ob-hero" data-primary="${c.primary}" data-secondary="${c.secondary}" data-set="${set}" data-helmet="${k.helmet ?? ''}" data-jersey="${k.jersey ?? ''}" data-pants="${k.pants ?? ''}" data-trim="${k.trim ?? ''}" data-number-color="${k.number ?? ''}" data-number="${st.number}" data-skin="${st.skin ?? ''}"></div>${slug ? html`<a class="ob-star" href="/d/${slug}/player/${st.pgid}">${label}</a>` : html`<span class="ob-star">${label}</span>`}`;
  };
  const team = (side: 'home' | 'away') => (side === 'home' ? home : away);
  const fav = o.spread < 0 ? home : o.spread > 0 ? away : null; const favWin = Math.max(o.homeWin, o.awayWin);
  // two teams in near-identical colours: the visitors wear white on the board, so the two sides still read apart
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); const far = (x: string, y: string) => Math.hypot(...rgb(x).map((v, i) => v - rgb(y)[i]!)) > 95;
  const ch = onDark(home); const ca = far(onDark(away), ch) ? onDark(away) : '#e6e7e9';
  // win probability as one bar: the visitors' colour from the left, the home colour from the right, blended where they
  // meet at the split (it eases out from the middle on load)
  const tug = html`<div class="ob-wp" role="img" aria-label="Win probability: ${away.abbr} ${pct(o.awayWin)}, ${home.abbr} ${pct(o.homeWin)}" style="--s:${(o.awayWin * 100).toFixed(1)}%;--ca:${ca};--ch:${ch}">
    <span class="ob-tug-end a">${pct(o.awayWin)}</span><div class="ob-wpbar"></div><span class="ob-tug-end h">${pct(o.homeWin)}</span></div>`;
  const moneyRow = (t: TeamRow, n: number, p: number, isFav: boolean) => html`<div class="ob-ml ${isFav ? 'fav' : ''}" style="--tc:${onLight(t)}">${teamLogo(t, 'xs')}<span class="ob-ab">${t.abbr}</span><span class="ob-num ob-price ${n > 0 ? 'dog' : 'fav'}">${money(n)}</span></div>`;
  // the total runs hot: yellow for a low-scoring game, through orange, to red for a shootout (30 to 70 points)
  const heat = Math.min(1, Math.max(0, (o.total - 30) / 40)); const mix = (a: number[], b: number[], f: number) => a.map((v, i) => Math.round(v + (b[i]! - v) * f));
  const heatRgb = heat < 0.5 ? mix([255, 214, 10], [255, 138, 0], heat * 2) : mix([255, 138, 0], [255, 45, 32], (heat - 0.5) * 2); const heatCol = `rgb(${heatRgb.join(' ')})`;
  // the number itself, on white: the same run in deeper tones (gold, burnt orange, red)
  const inkRgb = heat < 0.5 ? mix([201, 148, 0], [224, 100, 0], heat * 2) : mix([224, 100, 0], [208, 2, 27], (heat - 0.5) * 2); const heatInk = `rgb(${inkRgb.join(' ')})`;
  // the spread on a ruler: pick'em in the middle, a touchdown per tick, the marker on the favourite's side
  const lean = Math.max(-1, Math.min(1, -o.spread / 28)); const mark = (50 + lean * 50).toFixed(1); const favCol = fav ? onLight(fav) : '#1d1d1d';
  const maxEdge = Math.max(8, ...o.edges.map((e) => e.by));
  return html`<section class="oddsbox">
    <header class="ob-head"><span class="ob-tag">Odds</span><span class="ob-title">Simulated line</span></header>
    <div class="ob-board">
      <div class="ob-side" style="--tc:${ca}">${hero(away, stars.away, 'away')}${teamLogo(away, stars.away ? 'sm' : 'md')}<span class="ob-ab">${away.abbr}</span><span class="ob-pct">${pct(o.awayWin)}</span></div>
      <div class="ob-mid">
        <div class="ob-score"><span class="ob-proj" style="--tc:${ca}">${segNumber(String(Math.round(o.awayPoints)).padStart(2, '_'), 54)}</span><span class="ob-lbl">Projected<br>score</span><span class="ob-proj" style="--tc:${ch}">${segNumber(String(Math.round(o.homePoints)).padStart(2, '_'), 54)}</span></div>
        <div class="ob-tugwrap">${tug}<div class="ob-tugtxt"><b>${fav ? fav.abbr : 'Even'} ${pct(favWin)}</b><span>win probability</span></div></div>
      </div>
      <div class="ob-side right" style="--tc:${ch}">${hero(home, stars.home, 'home')}${teamLogo(home, stars.home ? 'sm' : 'md')}<span class="ob-ab">${home.abbr}</span><span class="ob-pct">${pct(o.homeWin)}</span></div>
    </div>
    <div class="ob-tiles">
      <div class="ob-tile"><span class="ob-k">Spread</span>
        <div class="ob-spread" style="--tc:${favCol};--m:${mark}%">
          <div class="ob-v">${fav ? html`${teamLogo(fav, 'sm')}<span class="ob-ab">${fav.abbr}</span><span class="ob-num">${`−${Math.abs(o.spread).toFixed(1)}`}</span>` : html`<span class="ob-num">PICK</span>`}</div>
          <div class="ob-ruler"><span>${away.abbr}</span><div class="ob-rule"><i></i><b></b></div><span>${home.abbr}</span></div>
        </div></div>
      <div class="ob-tile"><span class="ob-k">Total</span>
        <div class="ob-total" style="--heat:${heatCol};--heat-ink:${heatInk};--m:${(heat * 100).toFixed(1)}%">
          <div class="ob-v"><span class="ob-ou"><i>O</i><i>U</i></span><span class="ob-num">${o.total.toFixed(1)}</span></div>
          <div class="ob-heat"><b></b></div>
        </div></div>
      <div class="ob-tile"><span class="ob-k">Moneyline</span><div class="ob-mls">${moneyRow(away, o.awayMoney, o.awayWin, o.awayWin > o.homeWin)}${moneyRow(home, o.homeMoney, o.homeWin, o.homeWin >= o.awayWin)}</div></div>
    </div>
    ${o.edges.length ? html`<div class="ob-edges"><span class="ob-k">Where the game tilts</span>${o.edges.map((e, i) => html`<div class="ob-edge" style="--tc:${onLight(team(e.side))};--w:${Math.round(Math.min(1, e.by / maxEdge) * 100)}%;--d:${i * 90}ms">${icon(e.label)}<span class="ob-el"><b>${team(e.side).abbr}</b> ${e.label}</span><span class="ob-bar"><i></i></span><span class="ob-eb">+${e.by.toFixed(1)}</span></div>`)}</div>` : ''}
    <footer class="ob-foot">From depth charts and player ratings · for fun, no wagering</footer>
  </section>${stars.away || stars.home ? html`<script type="module" src="/js/hero3d.js"></script>` : ''}`;
}
