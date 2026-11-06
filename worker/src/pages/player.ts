// /d/<slug>/player/<pgid>: the player profile, laid out like a big sports site's player page. A header band (headshot
// over a faded team logo, name, team · number · position, a bio column, the season stat block), then a
// left rail (switch player, team links), the main column (next or last game, season stats by category, game log,
// ratings) and a right rail (the roster editor for players a member may edit, conference standings).
import type { PageCtx } from '../index.js';
import { html, notFound, type Raw } from '../html.js';
import { layout, box } from '../layout.js';
import { getTeams, getPlayers, getGames, getConferences, teamMap, getPendingPlayerEdit, type PlayerRow, type TeamRow, type GameRow } from '../db/queries.js';
import { getPortalPlayer, isTransferring } from '../db/transfers.js';
import { playerSeasonLines, playerGameLines, topAtPositions } from '../db/player.js';
import { playerEditCard, canEditPlayer } from './player-edit.js';
import { keyStats } from './awards.js';
import { keyRatings, ratingBars, posGroup, tier } from './player-keys.js';
import { teamLink, teamLogo, teamLogoUrl, headshotUrl, heightFt, pos, seasonLabel, weekLabel, rankOf } from './common.js';

const POS_NAME = ['Quarterback', 'Halfback', 'Fullback', 'Wide Receiver', 'Tight End', 'Left Tackle', 'Left Guard', 'Center', 'Right Guard', 'Right Tackle', 'Left End', 'Right End', 'Defensive Tackle', 'Left Outside Linebacker', 'Middle Linebacker', 'Right Outside Linebacker', 'Cornerback', 'Free Safety', 'Strong Safety', 'Kicker', 'Punter'];
const YEAR_NAME = ['Freshman', 'Sophomore', 'Junior', 'Senior'];
// "Switch player" position groups
const GROUPS: [string, string, number[]][] = [['QB', 'Quarterback', [0]], ['RB', 'Running Back', [1, 2]], ['WR', 'Wide Receiver', [3]], ['TE', 'Tight End', [4]], ['OL', 'Offensive Line', [5, 6, 7, 8, 9]], ['DL', 'Defensive Line', [10, 11, 12]], ['LB', 'Linebacker', [13, 14, 15]], ['DB', 'Defensive Back', [16, 17, 18]], ['K', 'Kicker', [19]], ['P', 'Punter', [20]]];
const groupOf = (p: number) => GROUPS.find((g) => g[2].includes(p)) ?? GROUPS[0]!;

// Stat categories. Columns name season codes (player_season_stats); game lines use the same codes with a leading g
// (saya -> gaya), so one table definition serves both. A column is a code or a function of the line.
type K = (code: string) => number;
type Col = [label: string, title: string, value: string | ((k: K) => string)];
interface Cat { id: string; title: string; kind: string; has: (k: K) => boolean; cols: Col[] }
const fmt = (v: number) => v.toLocaleString('en-US');
const f1 = (v: number) => v.toFixed(1);
const per = (a: number, b: number, scale = 1) => (b ? f1((scale * a) / b) : '0.0');
const CATS: Cat[] = [
  { id: 'pass', title: 'Passing', kind: 'PSOF', has: (k) => k('saat') > 0, cols: [['CMP', 'Completions', 'sacm'], ['ATT', 'Passing attempts', 'saat'], ['CMP%', 'Completion percentage', (k) => per(k('sacm'), k('saat'), 100)], ['YDS', 'Passing yards', 'saya'], ['AVG', 'Yards per pass attempt', (k) => per(k('saya'), k('saat'))], ['TD', 'Passing touchdowns', 'satd'], ['INT', 'Interceptions', 'sain'], ['LNG', 'Longest pass', 'salN'], ['RTG', 'Passer rating (college formula)', (k) => per(8.4 * k('saya') + 330 * k('satd') + 100 * k('sacm') - 200 * k('sain'), k('saat'))]] },
  { id: 'rush', title: 'Rushing', kind: 'PSOF', has: (k) => k('suat') > 0, cols: [['CAR', 'Rushing attempts', 'suat'], ['YDS', 'Rushing yards', 'suya'], ['AVG', 'Yards per carry', (k) => per(k('suya'), k('suat'))], ['TD', 'Rushing touchdowns', 'sutd'], ['LNG', 'Longest run', 'sulN'], ['BTK', 'Broken tackles', 'subt'], ['FUM', 'Fumbles', 'sufu']] },
  { id: 'rec', title: 'Receiving', kind: 'PSOF', has: (k) => k('scca') > 0, cols: [['REC', 'Receptions', 'scca'], ['YDS', 'Receiving yards', 'scya'], ['AVG', 'Yards per reception', (k) => per(k('scya'), k('scca'))], ['TD', 'Receiving touchdowns', 'sctd'], ['LNG', 'Longest reception', 'scrL'], ['YAC', 'Yards after catch', 'scyc'], ['DRP', 'Drops', 'scdr']] },
  { id: 'def', title: 'Defense', kind: 'PSDE', has: (k) => k('sdta') + k('sdht') + k('slsk') + k('ssin') + k('sdpd') > 0, cols: [['TKL', 'Tackles', (k) => fmt(k('sdta') + k('sdht'))], ['TFL', 'Tackles for loss', 'sdtl'], ['SACK', 'Sacks', 'slsk'], ['INT', 'Interceptions', 'ssin'], ['PD', 'Passes defended', 'sdpd'], ['FF', 'Forced fumbles', 'slff'], ['FR', 'Fumble recoveries', 'slfr']] },
  { id: 'kick', title: 'Kicking', kind: 'PSKI', has: (k) => k('skfa') + k('skea') > 0, cols: [['FGM', 'Field goals made', 'skfm'], ['FGA', 'Field goal attempts', 'skfa'], ['FG%', 'Field goal percentage', (k) => per(k('skfm'), k('skfa'), 100)], ['LNG', 'Longest field goal', 'skfL'], ['XPM', 'Extra points made', 'skem'], ['XPA', 'Extra point attempts', 'skea'], ['PTS', 'Points', (k) => fmt(3 * k('skfm') + k('skem'))]] },
  { id: 'punt', title: 'Punting', kind: 'PSKI', has: (k) => k('spat') > 0, cols: [['NO', 'Punts', 'spat'], ['YDS', 'Punt yards', 'spya'], ['AVG', 'Yards per punt', (k) => per(k('spya'), k('spat'))], ['LNG', 'Longest punt', 'splN'], ['IN 20', 'Punts inside the 20', 'sppt']] },
  { id: 'ret', title: 'Returns', kind: 'PSKP', has: (k) => k('srka') + k('srpa') > 0, cols: [['KR', 'Kick returns', 'srka'], ['YDS', 'Kick return yards', 'srky'], ['TD', 'Kick return touchdowns', 'srkt'], ['PR', 'Punt returns', 'srpa'], ['YDS', 'Punt return yards', 'srpy'], ['TD', 'Punt return touchdowns', 'srpt']] },
  { id: 'block', title: 'Blocking', kind: 'PSOL', has: (k) => k('sopa') + k('sosa') > 0, cols: [['PANCAKES', 'Pancake blocks', 'sopa'], ['SACKS ALW', 'Sacks allowed', 'sosa']] },
];
const PRIMARY: Record<string, string[]> = { QB: ['pass', 'rush'], HB: ['rush', 'rec'], FB: ['rush', 'rec'], WR: ['rec', 'rush'], TE: ['rec', 'rush'], OL: ['block'], DL: ['def'], LB: ['def'], CB: ['def'], S: ['def'], K: ['kick'], P: ['punt'] };
const cell = (c: Col, k: K) => (typeof c[2] === 'string' ? fmt(k(c[2])) : c[2](k));
type Lines = Record<string, Record<string, number>>; // kind -> stats
const GAME_KIND: Record<string, string> = { BOFF: 'PSOF', BDEF: 'PSDE', BKIC: 'PSKI', BKPR: 'PSKP', BOLN: 'PSOL' }; // game line table -> season kind
const reader = (lines: Lines, cat: Cat, game = false): K => (code) => Number(lines[cat.kind]?.[game ? `g${code.slice(1)}` : code] ?? 0);

// All ratings, grouped; the player's position group comes first.
const RATING_GROUPS: [string, [string, string][]][] = [
  ['Physical', [['PSPD', 'Speed'], ['PACC', 'Acceleration'], ['PAGI', 'Agility'], ['PSTR', 'Strength'], ['PJMP', 'Jumping'], ['PAWR', 'Awareness'], ['PSTA', 'Stamina'], ['PINJ', 'Injury']]],
  ['Passing', [['PTHP', 'Throw power'], ['PTHA', 'Throw accuracy']]],
  ['Ball carrier', [['PCAR', 'Carrying'], ['PBTK', 'Break tackle'], ['PTRK', 'Trucking'], ['PESV', 'Elusiveness'], ['PBCV', 'Ball carrier vision'], ['PSAR', 'Stiff arm'], ['PSMV', 'Spin move'], ['PJMV', 'Juke move']]],
  ['Receiving', [['PCTH', 'Catching'], ['TRAF', 'Catch in traffic'], ['SPCT', 'Spectacular catch'], ['PRTR', 'Route running'], ['RELS', 'Release']]],
  ['Blocking', [['PRBK', 'Run blocking'], ['PRBS', 'Run block strength'], ['PBFW', 'Run block footwork'], ['PPBK', 'Pass blocking'], ['PPBS', 'Pass block strength'], ['PPBF', 'Pass block footwork'], ['PIBL', 'Impact blocking']]],
  ['Defense', [['PTAK', 'Tackle'], ['PHIT', 'Hit power'], ['PPMV', 'Power moves'], ['PFMV', 'Finesse moves'], ['PBSH', 'Block shedding'], ['PPRS', 'Pursuit'], ['PPRC', 'Play recognition'], ['PMCV', 'Man coverage'], ['PZCV', 'Zone coverage'], ['PYRS', 'Press']]],
  ['Special teams', [['PKPR', 'Kick power'], ['PKAC', 'Kick accuracy'], ['PKRT', 'Kick return']]],
];
const FIRST_GROUP: Record<string, string> = { QB: 'Passing', HB: 'Ball carrier', FB: 'Blocking', WR: 'Receiving', TE: 'Receiving', OL: 'Blocking', DL: 'Defense', LB: 'Defense', CB: 'Defense', S: 'Defense', K: 'Special teams', P: 'Special teams' };

const result = (g: GameRow, tgid: number) => {
  const home = g.home_tgid === tgid, us = home ? g.home_score : g.away_score, them = home ? g.away_score : g.home_score;
  return { home, opp: home ? g.away_tgid : g.home_tgid, won: us > them, score: `${Math.max(us, them)}-${Math.min(us, them)}` };
};
const winPct = (w: number, l: number) => (w + l ? w / (w + l) : 0);

export async function playerPage(ctx: PageCtx, pgid: number): Promise<Response> {
  const { env, dyn, member } = ctx;
  const db = env.DB, d = dyn.id, y = dyn.season_year, slug = dyn.slug;
  const p = await getPortalPlayer(db, d, pgid);
  if (!p) return notFound('No such player');
  let ratings: Record<string, number> = {};
  try { ratings = JSON.parse(p.ratings_json || '{}'); } catch { /* none */ }
  const uid = `${ratings.POID ?? p.pgid}:${ratings.RCHD ?? 0}`; // identity across seasons (bridge playerUids)
  const [teams, confs, roster, seasonRows, gameRows, pending] = await Promise.all([getTeams(db, d), getConferences(db, d), getPlayers(db, d, p.tgid), playerSeasonLines(db, d, uid, pgid, y), playerGameLines(db, d, uid, pgid, y), getPendingPlayerEdit(db, d, pgid, y, dyn.week ?? 0)]);
  const tm = teamMap(teams), team = tm.get(p.tgid);
  const confTeams = team ? teams.filter((t) => t.cgid === team.cgid) : [];
  const group = groupOf(p.pos);
  const [teamGames, tops] = await Promise.all([team ? getGames(db, d, y, { tgid: team.tgid }) : Promise.resolve([] as GameRow[]), topAtPositions(db, d, confTeams.map((t) => t.tgid), group[2])]);
  const href = (id: number) => `/d/${slug}/player/${id}`;

  // seasons: kind -> line per season, newest last
  const seasons = new Map<number, Lines>();
  for (const r of seasonRows) { const s = seasons.get(r.season_year) ?? {}; try { s[r.kind] = JSON.parse(r.stats_json || '{}'); } catch { /* skip */ } seasons.set(r.season_year, s); }
  const years = [...seasons.keys()].sort((a, b) => a - b);
  const latest = years.length ? seasons.get(years[years.length - 1]!)! : undefined;
  const games = (l: Lines) => Math.max(0, ...Object.values(l).map((s) => Number(s.sgmp ?? 0)));
  const pg = posGroup(p.pos);
  const anySeason = (c: Cat) => years.some((yr) => c.has(reader(seasons.get(yr)!, c)));
  const cats = [...PRIMARY[pg]!.map((id) => CATS.find((c) => c.id === id)!).filter(anySeason), ...CATS.filter((c) => !PRIMARY[pg]!.includes(c.id) && anySeason(c))];

  // game lines by game, every season; the schedules they need come per (season, team) the player played for
  type GameEntry = { season: number; week: number; game_no: number; tgid: number | null; lines: Lines };
  const byGame = new Map<string, GameEntry>();
  for (const r of gameRows) { const key = `${r.season_year}:${r.week}:${r.game_no}`; const g = byGame.get(key) ?? { season: r.season_year, week: r.week, game_no: r.game_no, tgid: r.tgid, lines: {} }; const kind = GAME_KIND[r.kind]; if (kind) try { g.lines[kind] = JSON.parse(r.stats_json || '{}'); } catch { /* skip */ } byGame.set(key, g); }
  const gameList = [...byGame.values()].sort((a, b) => a.season - b.season || a.week - b.week || a.game_no - b.game_no);
  const schedKeys = [...new Set(gameList.map((g) => `${g.season}:${g.tgid ?? p.tgid}`))];
  const scheds = await Promise.all(schedKeys.map((k) => { const [s, t] = k.split(':').map(Number); return s === y && t === p.tgid ? Promise.resolve(teamGames) : getGames(db, d, s!, { tgid: t! }); }));
  const gameOf = new Map(scheds.flat().map((g) => [`${g.season_year}:${g.week}:${g.game_no}`, g]));
  const logSeasons = [...new Set(gameList.map((g) => g.season))].sort((a, b) => b - a); // newest first
  const catsFor = (list: GameEntry[]) => CATS.filter((c) => list.some((g) => c.has(reader(g.lines, c, true)))).sort((a, b) => (PRIMARY[pg]!.includes(b.id) ? 1 : 0) - (PRIMARY[pg]!.includes(a.id) ? 1 : 0));

  // ---- header ----
  const portalDest = isTransferring(p) && p.to_tgid !== null && p.trac === 1 ? tm.get(p.to_tgid) : undefined;
  const flag = p.leave_flag;
  const status = isTransferring(p) ? { cls: 'warn', text: html`Transferring${portalDest ? html` to ${teamLink(slug, portalDest)}` : ''}` }
    : flag === 26 ? { cls: 'muted', text: html`Graduating` }
    : flag !== null && ((flag >= 1 && flag <= 7) || (flag >= 19 && flag <= 25)) ? { cls: 'warn', text: html`Entering the draft` }
    : { cls: 'ok', text: html`Active` };
  const statBlock = latest && games(latest) > 0
    ? { title: `${seasonLabel({ season_year: years[years.length - 1]!, start_year: dyn.start_year })} stats`, items: keyStats(p.pos, new Map(Object.entries(latest))) }
    : { title: 'Key ratings', items: keyRatings(p.pos, p.ratings_json).slice(0, 3).map((r) => [r.short, String(r.value)] as [string, string]) };
  const header = html`<section class="pp-head">
    <div class="pp-id">
      <div class="pp-pic">${team ? html`<img class="pp-tl" src="${teamLogoUrl(team, 'lg')}" alt="" width="200" height="200">` : ''}<img class="pp-shot" src="${headshotUrl(p)}" alt="${p.first_name} ${p.last_name}" width="150" height="170"></div>
      <div class="pp-name">
        <h1><span class="pp-first">${p.first_name}</span><span class="pp-last">${p.last_name}</span></h1>
        <div class="pp-team">${team ? html`${teamLogo(team, 'sm')}${teamLink(slug, team)}` : html`<span class="muted">No team</span>`}<span>#${p.jersey}</span><span>${POS_NAME[p.pos] ?? pos(p.pos)}</span>${pending ? html`<span class="tag pending" title="Edited on the site; applied when the dynasty next loads on the console">Pending edit</span>` : ''}</div>
      </div>
    </div>
    <ul class="pp-bio">
      <li><span>Class</span><b>${YEAR_NAME[p.year] ?? `Year ${p.year + 1}`}${p.redshirt ? ' (RS)' : ''}</b></li>
      <li><span>HT/WT</span><b>${heightFt(p.height)}, ${p.weight} lbs</b></li>
      <li><span>Overall</span><b><span class="ovr-pill t-${tier(p.overall)}">${p.overall}</span></b></li>
      <li><span>Status</span><b class="pp-st ${status.cls}">${status.text}</b></li>
    </ul>
    <aside class="pp-sb"><h2>${statBlock.title}</h2><ul>${statBlock.items.map(([l, v]) => html`<li><span>${l}</span><b>${v}</b></li>`)}</ul></aside>
  </section>`;

  // ---- main column ----
  const upcoming = teamGames.filter((g) => g.status < 2).sort((a, b) => a.week - b.week)[0];
  const last = teamGames.filter((g) => g.status >= 2).sort((a, b) => b.week - a.week)[0];
  const featured = upcoming ?? last;
  const side = (t: TeamRow | undefined, right = false) => html`<div class="pp-gs-team ${right ? 'r' : ''}">${teamLogo(t, 'md')}<div><b>${t && rankOf(t) ? html`<small>${rankOf(t)}</small> ` : ''}${t ? teamLink(slug, t) : '?'}</b><span class="muted">${t ? `${t.wins}-${t.losses}` : ''}</span></div></div>`;
  const gameCard: Raw = featured && team ? box(html`${upcoming ? 'Next Game' : 'Last Game'}<a class="box-link" href="/d/${slug}/game/${featured.week}/${featured.game_no}">${upcoming ? 'Preview' : 'Box score'}</a>`, html`<div class="pp-gs">
      ${side(tm.get(featured.away_tgid))}
      <div class="pp-gs-mid">${featured.status >= 2 ? html`<b class="pp-gs-score">${featured.away_score} - ${featured.home_score}</b><span>Final${featured.overtime ? '/OT' : ''}</span>` : html`<b>${weekLabel(featured.week)}</b><span>${featured.away_tgid === team.tgid ? 'Away' : 'Home'}</span>`}</div>
      ${side(tm.get(featured.home_tgid), true)}
    </div>`) : html``;

  const seasonTable = cats.length ? html`<div class="pp-scroll"><table class="pp-table">
      <thead><tr><th class="fx" rowspan="2">Season</th><th rowspan="2" title="Games played">GP</th>${cats.map((c) => html`<th class="grp" colspan="${c.cols.length}">${c.title}</th>`)}</tr>
      <tr>${cats.flatMap((c) => c.cols.map((col, i) => html`<th class="${i === 0 ? 'gs' : ''}" title="${col[1]}">${col[0]}</th>`))}</tr></thead>
      <tbody>${years.map((yr) => { const l = seasons.get(yr)!; return html`<tr><td class="fx">${seasonLabel({ season_year: yr, start_year: dyn.start_year })}</td><td>${games(l)}</td>${cats.flatMap((c) => { const k = reader(l, c); return c.cols.map((col, i) => html`<td class="${i === 0 ? 'gs' : ''}">${cell(col, k)}</td>`); })}</tr>`; })}</tbody>
    </table></div>` : html`<p class="muted pp-empty">No stats recorded yet.</p>`;
  const statsCard = html`<div id="stats" class="pp-anchor">${box('Season Stats', seasonTable, 'pp-card')}</div>`;

  // the Total row sums the game lines (longest-play columns take the max), so it can be read against Season Stats
  const totals = (c: Cat, games: typeof gameList): K => (code) => {
    const vals = games.map((g) => reader(g.lines, c, true)(code));
    return /(L|lN)$/.test(code) ? Math.max(0, ...vals) : vals.reduce((a, b) => a + b, 0);
  };
  const logTable = (c: Cat, season: GameEntry[]) => { const games = season.filter((g) => c.has(reader(g.lines, c, true))); return html`<div class="pp-scroll"><table class="pp-table">
      <thead><tr><th class="fx">WK</th><th>OPP</th><th>RESULT</th>${c.cols.map((col) => html`<th title="${col[1]}">${col[0]}</th>`)}</tr></thead>
      <tfoot><tr><td class="fx">Total</td><td class="pp-opp muted">${games.length} game${games.length === 1 ? '' : 's'}</td><td></td>${c.cols.map((col) => html`<td>${cell(col, totals(c, games))}</td>`)}</tr></tfoot>
      <tbody>${games.map((g) => {
        const gm = gameOf.get(`${g.season}:${g.week}:${g.game_no}`), tg = g.tgid ?? p.tgid, r = gm ? result(gm, tg) : null, opp = r ? tm.get(r.opp) : undefined, k = reader(g.lines, c, true);
        const link = g.season === y ? `/d/${slug}/game/${g.week}/${g.game_no}` : null; // game pages show the current season
        const res = r && gm && gm.status >= 2 ? html`<b>${r.won ? 'W' : 'L'}</b> ${r.score}` : '';
        return html`<tr><td class="fx">${weekLabel(g.week)}</td><td class="pp-opp">${r ? html`<span class="muted">${r.home ? 'vs' : '@'}</span> ${teamLogo(opp, 'xs')}${teamLink(slug, opp, '?')}` : ''}</td><td>${res ? (link ? html`<a class="pp-res ${r!.won ? 'w' : 'l'}" href="${link}">${res}</a>` : html`<span class="pp-res ${r!.won ? 'w' : 'l'}">${res}</span>`) : ''}</td>${c.cols.map((col) => html`<td>${cell(col, k)}</td>`)}</tr>`;
      })}</tbody>
    </table></div>`; };
  // one season: a tab per stat category
  const seasonLog = (season: GameEntry[]) => { const cs = catsFor(season); return html`<div data-tabs><div class="pp-subtabs" role="tablist">${cs.map((c, i) => html`<button type="button" role="tab" data-tab="${c.id}" aria-selected="${i === 0 ? 'true' : 'false'}">${c.title}</button>`)}</div>${cs.map((c, i) => html`<div data-panel="${c.id}" ${i === 0 ? '' : 'hidden'}>${logTable(c, season)}</div>`)}</div>`; };
  // several seasons: a season row of tabs above (newest first), each season's category tabs below
  const logBody = !logSeasons.length
    ? html`<p class="muted pp-empty">No game lines yet${dyn.week_type !== null && (dyn.week ?? 0) >= 22 ? ' this season (the console clears them in the offseason)' : ''}.</p>`
    : logSeasons.length === 1 ? seasonLog(gameList)
    : html`<div data-tabs><div class="pp-subtabs pp-seasons" role="tablist">${logSeasons.map((s, i) => html`<button type="button" role="tab" data-tab="s${s}" aria-selected="${i === 0 ? 'true' : 'false'}">${seasonLabel({ season_year: s })}</button>`)}</div>${logSeasons.map((s, i) => html`<div data-panel="s${s}" ${i === 0 ? '' : 'hidden'}>${seasonLog(gameList.filter((g) => g.season === s))}</div>`)}</div>`;
  const logCard = html`<div id="gamelog" class="pp-anchor">${box(logSeasons.length === 1 ? `Game Log · ${seasonLabel({ season_year: logSeasons[0]! })}` : 'Game Log', logBody, 'pp-card')}</div>`;

  const first = FIRST_GROUP[pg] ?? 'Physical';
  const groups = [...RATING_GROUPS.filter(([g]) => g === first), ...RATING_GROUPS.filter(([g]) => g !== first)]
    .map(([g, list]) => [g, list.filter(([c]) => typeof ratings[c] === 'number').map(([c, name]) => ({ short: name, long: name, value: ratings[c]! }))] as const)
    .filter(([, list]) => list.length);
  const ratingsCard = html`<div id="ratings" class="pp-anchor">${box(html`Ratings<span class="box-link muted">${POS_NAME[p.pos] ?? pos(p.pos)} · ${p.overall} OVR</span>`, html`
      <div class="pp-keyr"><h4>Key ratings</h4>${ratingBars(keyRatings(p.pos, p.ratings_json))}</div>
      <div class="pp-allr">${groups.map(([g, list]) => html`<div><h4>${g}</h4>${ratingBars(list, 'wide')}</div>`)}</div>`, 'pp-card')}</div>`;

  // ---- left rail: switch player, team links ----
  const topOf = new Map(tops.map((t) => [t.tgid, t.pgid]));
  const mates = roster.filter((r) => group[2].includes(r.pos)).sort((a, b) => b.overall - a.overall);
  const shown = mates.slice(0, 7);
  if (!shown.some((m) => m.pgid === p.pgid)) shown.push(p);
  const bestAt = (positions: number[]) => roster.filter((r) => positions.includes(r.pos)).sort((a, b) => b.overall - a.overall)[0];
  const switchCard = box('Switch Player', html`<div class="pp-switch">
      ${confTeams.length ? html`<select data-nav aria-label="Team">${[...confTeams].sort((a, b) => a.name.localeCompare(b.name)).map((t) => html`<option value="${topOf.has(t.tgid) ? href(topOf.get(t.tgid)!) : `/d/${slug}/rosters/${t.tgid}`}" ${t.tgid === p.tgid ? 'selected' : ''}>${t.name}</option>`)}</select>` : ''}
      <select data-nav aria-label="Position">${GROUPS.map((g) => { const b = bestAt(g[2]); return b ? html`<option value="${href(b.pgid)}" ${g === group ? 'selected' : ''}>${g[1]}</option>` : ''; })}</select>
    </div>
    <ul class="pp-mates">${shown.map((m) => html`<li class="${m.pgid === p.pgid ? 'on' : ''}"><a href="${href(m.pgid)}"><img src="${headshotUrl(m)}" alt="" width="36" height="36" loading="lazy" decoding="async"><span><b>${m.first_name} ${m.last_name}</b><small>#${m.jersey} · ${pos(m.pos)} · ${m.overall} OVR</small></span></a></li>`)}</ul>
    ${team ? html`<a class="pp-foot" href="/d/${slug}/rosters/${team.tgid}">Full Roster</a>` : ''}`, 'pp-card');
  const linksCard = team ? box(html`${team.name} Quick Links`, html`<ul class="pp-links">
      <li><a href="/d/${slug}/team/${team.tgid}">Team page &amp; schedule</a></li>
      <li><a href="/d/${slug}/rosters/${team.tgid}">Roster</a></li>
      <li><a href="/d/${slug}/recruiting?team=${team.tgid}">Recruiting board</a></li>
      <li><a href="/d/${slug}/transfers">Transfer Portal</a></li>
    </ul>`, 'pp-card') : html``;

  // ---- right rail: roster editor, conference standings ----
  const editCard = canEditPlayer(member, p) ? playerEditCard(ctx, p, pending) : html``;
  const conf = team ? confs.find((c) => c.cgid === team.cgid) : undefined;
  const standings = [...confTeams].sort((a, b) => winPct(b.conf_wins, b.conf_losses) - winPct(a.conf_wins, a.conf_losses) || b.conf_wins - a.conf_wins || winPct(b.wins, b.losses) - winPct(a.wins, a.losses));
  const standCard = team && standings.length ? box(`${seasonLabel(dyn)} ${conf?.name ?? team.conf_label ?? ''} Standings`, html`<table class="list pp-stand"><thead><tr><th>Team</th><th class="num">CONF</th><th class="num">OVR</th></tr></thead><tbody>${standings.map((t) => html`<tr class="${t.tgid === team.tgid ? 'user-team' : ''}"><td>${teamLogo(t, 'xs')}${teamLink(slug, t)}</td><td class="num">${t.conf_wins}-${t.conf_losses}</td><td class="num">${t.wins}-${t.losses}</td></tr>`)}</tbody></table><a class="pp-foot" href="/d/${slug}/standings">Full Standings</a>`, 'pp-card') : html``;

  const body = html`<div class="pp">${header}
    <div class="pp-grid">
      <aside class="pp-left">${switchCard}${linksCard}</aside>
      <div class="pp-main">${gameCard}${statsCard}${logCard}${ratingsCard}</div>
      <aside class="pp-right">${editCard}${standCard}</aside>
    </div></div>`;
  return layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, path: ctx.url.pathname, title: `${p.first_name} ${p.last_name}`, siteName: env.SITE_NAME, dyn, section: 'rosters', body, wide: true });
}
