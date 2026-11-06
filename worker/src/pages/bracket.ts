// The FCS playoff bracket: projected from the polls and conference standings during the season, live once the bridge
// has set the field from the console's week-18 file (worker/src/playoff-state.ts). The bracket is played on the site:
// members coach their own games in Supersim, the other games are simulated there too, anyone signed in can watch, and
// the finished bracket goes back to the console in one copy of its dynasty file.
import type { PageCtx } from '../index.js';
import { html, type Raw } from '../html.js';
import { layout, box } from '../layout.js';
import { getTeams, getConferences, getMembers, teamMap, type TeamRow } from '../db/queries.js';
import { teamLink, teamLogo, weekLabel } from './common.js';
import { loadPlayoff, playoffGameOpen, type StateGame, type PlayoffState } from '../playoff-state.js';
import { selectPlayoffField, resolveBracket, defaultAutoBidConfs, roundName, BRACKET_WEEKS, type Seed, type ResolvedGame, type PlayoffTeamInput } from '@ncaa/ncaa14';

const toInput = (t: TeamRow): PlayoffTeamInput => ({ tgid: t.tgid, name: t.name, cgid: t.cgid, teamType: t.team_type, wins: t.wins, losses: t.losses, confWins: t.conf_wins, confLosses: t.conf_losses, rankCoaches: t.rank_coaches, rankMedia: t.rank_media, overall: t.overall });
interface LiveRow { week: number; game_no: number; status: string; q: number; a: number; h: number }

export async function bracketPage(ctx: PageCtx) {
  const { env, dyn } = ctx; const db = env.DB, d = dyn.id;
  const [teams, confs, state, members, liveRows] = await Promise.all([
    getTeams(db, d), getConferences(db, d), loadPlayoff(db, dyn), getMembers(db, d),
    db.prepare("SELECT week, game_no, status, json_extract(state_json, '$.q') AS q, json_extract(state_json, '$.score[0]') AS a, json_extract(state_json, '$.score[1]') AS h FROM supersim_live WHERE dynasty_id=? AND season_year=? AND week>=16").bind(d, dyn.season_year).all<LiveRow>().then((r) => r.results),
  ]);
  const tm = teamMap(teams);
  const live = !!state && state.seeds.length > 0 && state.phase !== 'skipped';
  const inputs = teams.map(toInput);
  const autoBid = defaultAutoBidConfs(confs.map((c) => ({ cgid: c.cgid, name: c.name })), inputs);
  const seeds: Seed[] = live ? state!.seeds : selectPlayoffField(inputs, { autoBidConfs: autoBid }).seeds;
  const games = new Map<string, StateGame>(); if (live) for (const g of state!.games) games.set(`${g.round}:${g.idx}`, g);
  const winnerOf = (r: number, i: number) => { const g = games.get(`${r}:${i}`); if (!g || g.status < 2) return null; return g.status === 3 ? g.home : g.away; };
  const resolved = resolveBracket(seeds, winnerOf);
  const confName = (cgid: number | null) => (cgid === null ? '' : confs.find((c) => c.cgid === cgid)?.name ?? '');
  const seedOf = new Map(seeds.map((s) => [s.tgid, s.seed]));
  const myTeam = ctx.member?.tgid ?? null; const signedIn = !!ctx.account;
  const liveOf = (g: StateGame) => liveRows.find((l) => l.week === g.week && l.game_no === g.sgnm) ?? null;
  const simOn = (env as { SUPERSIM_ENABLED?: string }).SUPERSIM_ENABLED === 'true';
  const slot = (tgid: number | null, ref: ResolvedGame['a'], g: ResolvedGame, side: 'home' | 'away'): Raw => {
    if (tgid === null) return html`<div class="bk-team tbd"><span class="seed"></span><span class="name">${'seed' in ref ? `Seed ${ref.seed}` : `Winner of ${roundName(ref.game[0])} ${ref.game[1] + 1}`}</span></div>`;
    const t = tm.get(tgid); const sg = games.get(`${g.round}:${g.idx}`);
    const score = sg && sg.status >= 2 ? (side === 'home' ? sg.homeScore : sg.awayScore) : null;
    const won = g.winner === tgid;
    return html`<div class="bk-team ${won ? 'w' : ''} ${g.winner !== null && !won ? 'l' : ''} ${tgid === myTeam ? 'mine' : ''}"><span class="seed">${seedOf.get(tgid) ?? ''}</span>${t ? teamLogo(t, 'xs') : ''}<span class="name">${t ? teamLink(dyn.slug, t) : `#${tgid}`}</span>${score !== null ? html`<span class="score">${score}</span>` : ''}</div>`;
  };
  // what a signed-in member can do with a bracket game: coach it (their team), watch it (in progress), or sim it
  const action = (g: ResolvedGame, sg: StateGame | undefined): Raw => {
    if (!live || !sg || !simOn || !signedIn) return html``;
    const l = liveOf(sg); const base = `/d/${dyn.slug}/supersim`;
    if (sg.status >= 2) return sg.runId ? html`<a class="bk-act" href="${base}/watch/${sg.week}/${sg.sgnm}">Replay</a>` : html``;
    if (l && l.status === 'live') {
      const mine = myTeam !== null && (sg.home === myTeam || sg.away === myTeam);
      return html`<a class="bk-act live" href="${base}/${mine ? '' : 'watch/'}${sg.week}/${sg.sgnm}"><i></i>LIVE ${l.a}-${l.h} Q${l.q} · ${mine ? 'Resume' : 'Watch'}</a>`;
    }
    if (!playoffGameOpen(state, sg)) return html``;
    const mine = myTeam !== null && (sg.home === myTeam || sg.away === myTeam);
    const humans = [sg.home, sg.away].filter((t) => members.some((m) => m.tgid === t));
    if (mine) return html`<a class="bk-act" href="${base}/${sg.week}/${sg.sgnm}">Coach this game</a>`;
    if (humans.length) return html`<span class="bk-act muted">Waiting for ${humans.map((t) => members.find((m) => m.tgid === t)?.persona).filter(Boolean).join(' and ')}</span>`;
    return html`<button type="button" class="bk-act bk-sim" data-game="${sg.week}:${sg.sgnm}">Sim this game</button>`;
  };
  const card = (g: ResolvedGame): Raw => {
    const sg = games.get(`${g.round}:${g.idx}`); const final = !!sg && sg.status >= 2;
    const host = g.round < 5 && g.home !== null ? tm.get(g.home) : null;
    const [top, bottom] = g.home !== null && g.away !== null ? [[g.home, 'home'], [g.away, 'away']] as const : [[null, 'home'], [null, 'away']] as const;
    const refTop = g.home !== null ? (g.homeSeed !== null && 'seed' in g.a && g.a.seed === g.homeSeed ? g.a : g.b) : g.a, refBottom = refTop === g.a ? g.b : g.a;
    return html`<div class="bk-game ${final ? 'final' : ''}">${slot(top[0], refTop, g, top[1])}${slot(bottom[0], refBottom, g, bottom[1])}
      <div class="bk-meta">${final ? `Final${sg?.ot ? ' (OT)' : ''}` : weekLabel(sg?.week ?? BRACKET_WEEKS[g.round] ?? 0)}${g.round < 5 && host ? ` · at ${host.abbr || host.name}` : g.round === 5 ? ' · neutral site' : ''}</div>${action(g, sg)}</div>`;
  };
  const columns = [1, 2, 3, 4, 5].map((round) => html`<div class="bk-col"><h4>${roundName(round)}</h4>${resolved.filter((g) => g.round === round).map(card)}</div>`);
  const champion = live && state!.champion ? tm.get(state!.champion) : null;
  const openGames = live ? state!.games.filter((g) => playoffGameOpen(state, g)) : [];
  const cpuGames = openGames.filter((g) => ![g.home, g.away].some((t) => members.some((m) => m.tgid === t)));
  const phaseNote = (s: PlayoffState): Raw => {
    if (s.phase === 'delivered') return html`<p class="muted">The console took the finished bracket${s.delivered ? ` (${s.delivered.matched} of ${s.delivered.total} results kept as played here${s.delivered.matched < s.delivered.total ? '; the rest were simulated again on the console, the results here stand' : ''})` : ''}.</p>`;
    if (s.phase === 'final') return html`<p class="muted">The bracket is complete. The console takes it at its next load from the Dynasty hub; the league server holds the week advance until then.</p>`;
    return html`<p class="muted">The bracket is played here while the console sits at Bowl Season: coaches call their own games in Supersim, the other games are simulated here, and anyone signed in can watch live. The week advance on the console is held until the champion is crowned.${openGames.length ? html` <b>${openGames.length}</b> game${openGames.length === 1 ? '' : 's'} open now${cpuGames.length && signedIn && simOn ? html`, ${cpuGames.length} between CPU teams: <button type="button" class="bk-act bk-sim-all">Sim all CPU games</button>` : ''}.` : ''}</p>`;
  };
  const banner = champion
    ? html`<div class="bk-champ">${teamLogo(champion, 'md')} <div><div class="bk-champ-l">FCS National Champion</div><div class="bk-champ-n">${teamLink(dyn.slug, champion)}</div></div></div>${phaseNote(state!)}`
    : state?.phase === 'skipped' ? html`<p class="muted"><b>No playoff was played this season.</b> ${state.note ?? ''} The console played the game's own bowl season instead; the field below is what the polls projected.</p>`
      : live ? phaseNote(state!)
        : html`<p class="muted">Projected: ${autoBid.length} conference champions get automatic bids (${autoBid.map(confName).filter(Boolean).join(', ')}), the rest of the 24 by the polls and records. The field is set once the console reaches Bowl Season (after the conference championship games), and the bracket is then played here on the site.</p>`;
  const field = html`<table class="list bk-seeds"><tr><th>Seed</th><th>Team</th><th>Record</th><th>Bid</th></tr>${seeds.map((s) => { const t = tm.get(s.tgid); return html`<tr><td class="rk">${s.seed}</td><td>${t ? html`${teamLogo(t, 'xs')} ${teamLink(dyn.slug, t)}` : `#${s.tgid}`}</td><td>${t ? `${t.wins}-${t.losses}` : ''}</td><td>${s.autoBid !== null ? html`<span class="tag">${confName(s.autoBid)} champion</span>` : html`<span class="muted">at-large</span>`}${s.seed <= 8 ? html` <span class="muted">· bye</span>` : ''}</td></tr>`; })}</table>`;
  const body = html`<h2>FCS Playoffs ${live ? '' : html`<span class="muted">(projected)</span>`}</h2>${banner}<div class="bracket" data-slug="${dyn.slug}">${columns}</div>${box(live ? 'The field' : 'Projected field', field)}${live && simOn ? html`<p class="bk-simlog muted" hidden></p><script src="/js/bracket.js" defer></script>` : ''}`;
  return layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, path: ctx.url.pathname, title: 'Bracket', siteName: env.SITE_NAME, dyn, section: 'bracket', body, wide: true });
}
