import type { PageCtx } from '../index.js';
import { html, type Raw } from '../html.js';
import { layout, box } from '../layout.js';
import { getTeams, getTeam, getRecruits, getBoard, getUserTeams, teamMap, getWebBoard, upsertWebBoard, deleteWebBoard, type BoardRow, type RecruitRow, type TeamRow, type WebBoardRow } from '../db/queries.js';
import { redirect } from '../session.js';
import { teamLink, teamLogo, pos, heightFt, headshot, interestStack, weekLabel } from './common.js';

const MAX_PER_PROSPECT = 500; // the game's cap per prospect per week
const MAX_SCOUT = 1000;
const BOARD_SLOTS = 35;
const stars = (n: number) => '*'.repeat(n);
const num = (v: unknown, dflt = 0) => { const n = Number(v); return Number.isFinite(n) ? n : dflt; };

// Weekly budget and points left come from the team row (TRPA / TRCP) the console pushes.
function budgetOf(team: TeamRow | undefined): { budget: number; left: number } {
  try { const raw = JSON.parse(team?.raw_json ?? '{}'); return { budget: Number(raw.TRPA ?? 0) || 0, left: Number(raw.TRCP ?? 0) || 0 }; } catch { return { budget: 0, left: 0 }; }
}
const toRow = (b: BoardRow, tgid: number): WebBoardRow => ({ PRSI: b.prsi, PPSC: b.points_this_week, PPSL: b.points_last_week, PSCP: 0, PROR: b.board_order, PEPV: b.playing_time, USEL: 0, TGID: tgid });

// The board the member is working on: the pending web board if there is one, else the console's last push.
async function desiredBoard(db: D1Database, d: number, tgid: number, year: number, week: number): Promise<{ rows: WebBoardRow[]; pending: boolean; updatedAt: string | null }> {
  const web = await getWebBoard(db, d, tgid, year, week);
  if (web && !web.delivered_at) return { rows: JSON.parse(web.rows_json), pending: true, updatedAt: web.updated_at };
  const board = await getBoard(db, d, tgid);
  return { rows: board.map((b) => toRow(b, tgid)).sort((a, b) => a.PROR - b.PROR), pending: false, updatedAt: null };
}
const renumber = (rows: WebBoardRow[]) => rows.sort((a, b) => a.PROR - b.PROR).map((r, i) => ({ ...r, PROR: i }));

// Shared page context: the team being viewed and whether the member may edit it.
async function recruitingCtx(ctx: PageCtx) {
  const { env, dyn, url, member } = ctx;
  const db = env.DB, d = dyn.id;
  const teams = await getTeams(db, d);
  const tm = teamMap(teams);
  const userTeams = await getUserTeams(db, d);
  const myTeam = member?.tgid && member.tgid !== 1023 ? member.tgid : undefined;
  const tgid = url.searchParams.get('team') ? Number(url.searchParams.get('team')) : (myTeam ?? userTeams[0]?.tgid);
  const team = tgid !== undefined ? tm.get(tgid) : undefined;
  const canEdit = !!team && myTeam === team.tgid;
  return { teams, tm, userTeams, myTeam, tgid, team, canEdit };
}
const top300Badge = (slug: string) => html`<a class="top300" href="/d/${slug}/recruiting/top300" title="Top 300 prospects"><span class="t-top">TOP</span><span class="t-num">300</span></a>`;
const stepper = (name: string, value: number, max: number, step: number, title = '') => html`<span class="stepper"><button type="button" class="st-btn" data-step="${-step}" data-for="${name}" aria-label="minus">&minus;</button><input type="number" inputmode="numeric" id="${name}" name="${name}" value="${value}" min="0" max="${max}" step="${step}" title="${title}"><button type="button" class="st-btn" data-step="${step}" data-for="${name}" aria-label="plus">+</button></span>`;
const sortBtn = (key: string, label: string, title = '') => html`<button type="button" class="ph" data-sort="${key}" title="${title || `Sort by ${label}`}">${label}</button>`;

// Filter toolbar (client side): position and star rating; applies to the .prlist that follows it.
function tools(recs: RecruitRow[]): Raw {
  const positions = [...new Set(recs.map((r) => r.pos))].sort((a, b) => a - b);
  return html`<div class="prtools"><label>Pos <select data-filter="pos"><option value="">All</option>${positions.map((p) => html`<option value="${pos(p)}">${pos(p)}</option>`)}</select></label>
    <label>Stars <select data-filter="stars"><option value="">All</option>${[5, 4, 3, 2, 1].map((s) => html`<option value="${s}">${s}</option>`)}</select></label>
    <span class="muted ft-count"></span><span class="muted ft-hint">Click a column heading to sort.</span></div>`;
}
const dataAttrs = (rec: RecruitRow | undefined, i: number, pts = 0, last = 0) => rec
  ? html`data-order="${i}" data-name="${rec.last_name} ${rec.first_name}" data-pos="${pos(rec.pos)}" data-stars="${rec.stars}" data-rank="${rec.rank}" data-ht="${rec.height}" data-wt="${rec.weight}" data-ovr="${rec.pre_scout_overall}" data-pts="${pts}" data-last="${last}"`
  : html`data-order="${i}" data-pts="${pts}" data-last="${last}"`;

export async function recruitingPage(ctx: PageCtx) {
  const { env, dyn, url, member, members } = ctx;
  const db = env.DB, d = dyn.id, y = dyn.season_year, week = dyn.week ?? 0;
  const { teams, tm, userTeams, myTeam, tgid, team, canEdit } = await recruitingCtx(ctx);
  const [desired, boardRows] = await Promise.all([
    team ? desiredBoard(db, d, team.tgid, y, week) : Promise.resolve({ rows: [] as WebBoardRow[], pending: false, updatedAt: null }),
    team ? getBoard(db, d, team.tgid) : Promise.resolve([] as BoardRow[]),
  ]);
  const byPrsi = new Map(boardRows.map((b) => [b.prsi, b]));
  const missing = desired.rows.map((r) => r.PRSI).filter((p) => !byPrsi.has(p)); // added on the web, not in the imported board yet
  const extra = missing.length ? (await getRecruits(db, d, { limit: 5000 })).filter((r) => missing.includes(r.prsi)) : [];
  const recruitOf = (prsi: number): RecruitRow | undefined => byPrsi.get(prsi) ?? extra.find((r) => r.prsi === prsi);
  const used = desired.rows.reduce((s, r) => s + (r.PPSC || 0), 0);
  const { budget } = budgetOf(team);
  const flash = url.searchParams.get('saved') ? html`<p class="flash">Board saved. The console picks it up the next time the dynasty loads (refresh or resume), and it stays until the console confirms it.</p>` : url.searchParams.get('err') ? html`<p class="flash err">${url.searchParams.get('err')}</p>` : html``;
  const picker = html`<form class="inline" method="get"><select name="team" onchange="this.form.submit()">${teams.map((t) => html`<option value="${t.tgid}" ${t.tgid === tgid ? 'selected' : ''}>${t.name}${userTeams.some((u) => u.tgid === t.tgid) ? ' (user)' : ''}</option>`)}</select></form>`;
  const header = html`<div class="rec-head"><h2>Recruiting · ${weekLabel(week)}</h2>${top300Badge(dyn.slug)}${picker}</div>`;

  const budgetBar = team ? html`<div class="budget">
      <div><div class="b-num">${used.toLocaleString()}</div><div class="b-lbl">points this week</div></div>
      <div class="${budget && used > budget ? 'over' : ''}"><div class="b-num">${budget ? (budget - used).toLocaleString() : '?'}</div><div class="b-lbl">left of ${budget ? budget.toLocaleString() : '?'}</div></div>
      <div><div class="b-num">${desired.rows.length}</div><div class="b-lbl">of ${BOARD_SLOTS} slots</div></div>
      <div class="b-state">${desired.pending ? html`<span class="tag">PENDING</span>saved ${desired.updatedAt} UTC · applied when the dynasty next loads on the console` : html`in-game board as of the last sync`}</div>
    </div>` : html``;

  // One prospect. Desktop: one full row with every column, steppers and controls inline. Mobile (CSS): the same row
  // collapses to rank, photo, name and points; a tap expands the steppers and the detail panel.
  const controls = (r: WebBoardRow) => html`<button class="btn icon" name="move" value="${r.PRSI}:up" title="Move up">&#9650;</button><button class="btn icon" name="move" value="${r.PRSI}:down" title="Move down">&#9660;</button><button class="btn sm danger" name="remove" value="${r.PRSI}">Remove</button>`;
  const prospect = (r: WebBoardRow, i: number) => {
    const rec = recruitOf(r.PRSI);
    const name = rec ? `${rec.first_name} ${rec.last_name}` : `Prospect ${r.PRSI}`;
    const tag = rec?.committed ? html` <span class="tag">${rec.committed_tgid === tgid ? 'COMMITTED' : 'GONE'}</span>` : html``;
    return html`<div class="pr" ${dataAttrs(rec, i, r.PPSC, r.PPSL)}>
      <div class="pr-sum" role="button" tabindex="0" aria-expanded="false">
        <span class="pr-rk">${i + 1}</span>${rec ? headshot(rec) : html`<span class="headshot sm"></span>`}
        <span class="pr-name"><span class="pr-n">${name}${tag}</span><span class="pr-meta mob-only">${rec ? html`${pos(rec.pos)} · <span class="stars">${stars(rec.stars)}</span> · #${rec.rank}` : ''}</span></span>
        <span class="pr-col c-pos">${rec ? pos(rec.pos) : ''}</span>
        <span class="pr-col c-stars stars">${rec ? stars(rec.stars) : ''}</span>
        <span class="pr-col c-rank">${rec?.rank ?? ''}</span>
        <span class="pr-col c-ht">${rec ? heightFt(rec.height) : ''}</span>
        <span class="pr-col c-wt">${rec?.weight ?? ''}</span>
        <span class="pr-col c-ovr"><b>${rec?.pre_scout_overall ?? ''}</b></span>
        <span class="pr-col c-int">${interestStack(tm, rec?.teams_json ?? null)}</span>
        <span class="pr-col c-last">${r.PPSL}</span>
        <span class="pr-st">${canEdit ? html`<span class="st-f"><span class="st-l">Points</span>${stepper(`pts_${r.PRSI}`, r.PPSC, MAX_PER_PROSPECT, 10)}</span><span class="st-f"><span class="st-l">Scout</span>${stepper(`scout_${r.PRSI}`, r.PSCP, MAX_SCOUT, 50, 'scouting points')}</span>` : html`<span class="st-f"><span class="st-l">Points</span><b class="c-ptsv">${r.PPSC}</b></span><span class="st-f"><span class="st-l">Scout</span><b class="c-ptsv">${r.PSCP}</b></span>`}</span>
        <span class="pr-col c-pt">${r.PEPV}</span>
        <span class="pr-col c-ctl">${canEdit ? controls(r) : ''}</span>
        <span class="pr-pts mob-only"><b>${r.PPSC}</b><small>pts</small></span>
        <span class="pr-chev mob-only" aria-hidden="true"></span>
      </div>
      <div class="pr-more mob-only">
        <div class="pr-grid">
          <div><label>Scouted OVR</label><b>${rec?.pre_scout_overall ?? ''}</b></div>
          <div><label>Last week</label><b>${r.PPSL}</b></div>
          <div><label>Playing time</label><b>${r.PEPV}</b></div>
          <div><label>Size</label>${rec ? `${heightFt(rec.height)} · ${rec.weight} lb` : ''}</div>
          <div class="span2"><label>Interest</label>${interestStack(tm, rec?.teams_json ?? null)}</div>
        </div>
        ${canEdit ? html`<div class="pr-ctl">${controls(r)}</div>` : ''}
      </div>
    </div>`;
  };
  const head = html`<div class="pr-head desk-only"><span class="pr-rk">${sortBtn('order', '#', 'Board order')}</span><span></span><span class="pr-name">${sortBtn('name', 'Prospect')}</span><span class="pr-col c-pos">${sortBtn('pos', 'Pos')}</span><span class="pr-col c-stars">${sortBtn('stars', 'Stars')}</span><span class="pr-col c-rank">${sortBtn('rank', 'Rank', 'National rank')}</span><span class="pr-col c-ht">${sortBtn('ht', 'Ht')}</span><span class="pr-col c-wt">${sortBtn('wt', 'Wt')}</span><span class="pr-col c-ovr">${sortBtn('ovr', 'OVR', 'Scouted overall (rises as scouting completes)')}</span><span class="pr-col c-int">Interest</span><span class="pr-col c-last">${sortBtn('last', 'Last wk')}</span><span class="pr-st"><span class="st-f">${sortBtn('pts', 'Points')}</span><span class="st-f">Scout</span></span><span class="pr-col c-pt">PT</span><span class="pr-col c-ctl"></span></div>`;
  const recs = desired.rows.map((r) => recruitOf(r.PRSI)).filter((r): r is RecruitRow => !!r);
  const list = html`${tools(recs)}<div class="prlist board">${head}${desired.rows.map(prospect)}</div>`;
  const form = canEdit ? html`<form method="post" action="/d/${dyn.slug}/recruiting/board"><input type="hidden" name="tgid" value="${team!.tgid}"><input type="hidden" name="week" value="${week}">${list}
      <div class="board-actions"><button class="btn" name="action" value="save">Save board</button>${desired.pending ? html`<button class="btn light" name="action" value="reset">Discard web changes</button>` : ''}<span class="muted">0-${MAX_PER_PROSPECT} points per prospect, in tens. Changes apply the next time the dynasty loads on the console.</span></div></form>` : list;

  const q = (url.searchParams.get('q') ?? '').trim();
  const onBoard = new Set(desired.rows.map((r) => r.PRSI));
  const matches = canEdit && q ? (await getRecruits(db, d, { limit: 5000 })).filter((r) => !r.committed && !onBoard.has(r.prsi) && `${r.first_name} ${r.last_name}`.toLowerCase().includes(q.toLowerCase())).slice(0, 15) : [];
  const addBox = canEdit ? box('Add a prospect', html`<form class="addbox" method="get"><input type="hidden" name="team" value="${team!.tgid}"><input type="text" name="q" value="${q}" placeholder="Search by name" inputmode="search"> <button class="btn light">Search</button> <span class="muted">or browse the</span> ${top300Badge(dyn.slug)}${desired.rows.length >= BOARD_SLOTS ? html` <span class="muted">Board is full.</span>` : ''}</form>
      ${matches.length ? html`<div class="prlist t300">${t300Head()}${matches.map((r, i) => t300Row(dyn.slug, tm, r, i, canEdit && team ? { tgid: team.tgid, week, full: desired.rows.length >= BOARD_SLOTS, onBoard: false, back: `/d/${dyn.slug}/recruiting?team=${team.tgid}&q=${encodeURIComponent(q)}` } : null))}</div>` : q ? html`<p class="muted">No uncommitted prospect matches "${q}".</p>` : html``}`) : html``;

  const who = !member && members && members.length > 1 ? html`<p class="flash err">Pick who you are in the top bar to edit your board.</p>` : member && !canEdit && team ? html`<p class="muted">Viewing ${team.name}'s board. ${myTeam ? html`<a href="?team=${myTeam}">Go to your board</a>.` : 'You have no team yet.'}</p>` : html``;
  const body = html`${header}${flash}${who}${box(html`${teamLogo(team, 'sm')}${team ? `${team.name} recruiting board` : 'Recruiting board'}`, html`${budgetBar}${desired.rows.length ? form : html`<p class="muted">Nothing on the board.</p>`}`)}${addBox}`;
  return layout({ strip: ctx.strip, member, members, path: url.pathname + url.search, title: 'Recruiting', siteName: env.SITE_NAME, dyn, section: 'recruiting', body, wide: true });
}

const addButton = (slug: string, tgid: number, week: number, prsi: number, full: boolean, back: string) =>
  html`<form class="pr-add" method="post" action="/d/${slug}/recruiting/board"><input type="hidden" name="tgid" value="${tgid}"><input type="hidden" name="week" value="${week}"><input type="hidden" name="prsi" value="${prsi}"><input type="hidden" name="back" value="${back}"><button class="btn sm" name="action" value="add" ${full ? 'disabled' : ''}>Add</button></form>`;

// Top 300 / search rows: rank, prospect, pos, stars, ht, wt, scouted OVR, interest or commitment, add.
interface AddCtx { tgid: number; week: number; full: boolean; onBoard: boolean; back: string }
const t300Head = () => html`<div class="pr-head desk-only t300"><span class="pr-rk">${sortBtn('rank', 'Rk', 'National rank')}</span><span></span><span class="pr-name">${sortBtn('name', 'Prospect')}</span><span class="pr-col c-pos">${sortBtn('pos', 'Pos')}</span><span class="pr-col c-stars">${sortBtn('stars', 'Stars')}</span><span class="pr-col c-ht">${sortBtn('ht', 'Ht')}</span><span class="pr-col c-wt">${sortBtn('wt', 'Wt')}</span><span class="pr-col c-ovr">${sortBtn('ovr', 'OVR', 'Scouted overall (rises as scouting completes)')}</span><span class="pr-col c-int">Interest</span><span class="pr-col c-add"></span></div>`;
function t300Row(slug: string, tm: Map<number, TeamRow>, r: RecruitRow, i: number, add: AddCtx | null): Raw {
  const committed = r.committed ? html`${teamLogo(tm.get(r.committed_tgid ?? -1), 'xs')}${teamLink(slug, tm.get(r.committed_tgid ?? -1), 'Committed')}` : interestStack(tm, r.teams_json);
  return html`<div class="pr t300" ${dataAttrs(r, i)}>
    <div class="pr-sum static t300">
      <span class="pr-rk">${r.rank}</span>${headshot(r)}
      <span class="pr-name"><span class="pr-n">${r.first_name} ${r.last_name}${add?.onBoard ? html` <span class="tag">ON BOARD</span>` : ''}</span><span class="pr-meta mob-only">${pos(r.pos)} · <span class="stars">${stars(r.stars)}</span> · ${heightFt(r.height)} ${r.weight} lb · OVR ${r.pre_scout_overall}</span></span>
      <span class="pr-col c-pos">${pos(r.pos)}</span>
      <span class="pr-col c-stars stars">${stars(r.stars)}</span>
      <span class="pr-col c-ht">${heightFt(r.height)}</span>
      <span class="pr-col c-wt">${r.weight}</span>
      <span class="pr-col c-ovr"><b>${r.pre_scout_overall}</b></span>
      <span class="pr-col c-int">${committed}</span>
      <span class="c-add">${add && !r.committed && !add.onBoard ? addButton(slug, add.tgid, add.week, r.prsi, add.full, add.back) : ''}</span>
    </div></div>`;
}

// /d/<slug>/recruiting/top300: the national top 300 by rank, with Add buttons for the member's own board.
export async function top300Page(ctx: PageCtx) {
  const { env, dyn, url, member, members } = ctx;
  const db = env.DB, d = dyn.id, y = dyn.season_year, week = dyn.week ?? 0;
  const { tm, team, canEdit } = await recruitingCtx(ctx);
  const showAll = url.searchParams.get('all') === '1';
  const all = (await getRecruits(db, d, { limit: 300 })).slice(0, showAll ? 300 : 100);
  const desired = canEdit && team ? await desiredBoard(db, d, team.tgid, y, week) : null;
  const onBoard = new Set(desired?.rows.map((r) => r.PRSI) ?? []);
  const full = (desired?.rows.length ?? 0) >= BOARD_SLOTS;
  const flash = url.searchParams.get('saved') ? html`<p class="flash">Added to your board. The console picks it up the next time the dynasty loads.</p>` : url.searchParams.get('err') ? html`<p class="flash err">${url.searchParams.get('err')}</p>` : html``;
  const back = `/d/${dyn.slug}/recruiting/top300`;
  const rows = all.map((r, i) => t300Row(dyn.slug, tm, r, i, canEdit && team ? { tgid: team.tgid, week, full, onBoard: onBoard.has(r.prsi), back } : null));
  const body = html`<div class="rec-head"><h2>Top 300 prospects</h2>${top300Badge(dyn.slug)}<a class="btn light" href="/d/${dyn.slug}/recruiting">Back to the board</a></div>${flash}
    ${box(`${all.length} prospects by national rank`, html`${tools(all)}<div class="prlist t300">${t300Head()}${rows}</div>${showAll ? html`` : html`<div class="board-actions"><a class="btn light" href="?all=1">Show all 300</a><span class="muted">Showing the top 100; sorting and filters apply to the rows shown.</span></div>`}`)}`;
  return layout({ strip: ctx.strip, member, members, path: url.pathname + url.search, title: 'Top 300', siteName: env.SITE_NAME, dyn, section: 'recruiting', body, wide: true });
}

// POST /d/<slug>/recruiting/board: save | add | remove | move | reset, for the member's own team only.
export async function boardAction(ctx: PageCtx, form: FormData): Promise<Response> {
  const { env, dyn, member } = ctx;
  const db = env.DB, d = dyn.id, y = dyn.season_year, week = dyn.week ?? 0;
  const tgid = num(form.get('tgid'), -1);
  const backTo = String(form.get('back') ?? '');
  const base = backTo.startsWith('/') ? backTo : `/d/${dyn.slug}/recruiting?team=${tgid}`;
  const back = (extra: string) => redirect(base + (base.includes('?') ? '&' : '?') + extra.replace(/^&/, ''));
  if (!member || member.tgid !== tgid) return back(`err=${encodeURIComponent('You can only edit your own board.')}`);
  if (num(form.get('week'), -1) !== week) return back(`err=${encodeURIComponent('The dynasty advanced while you were editing; the board was reloaded.')}`);
  const team = await getTeam(db, d, tgid);
  const action = String(form.get('action') ?? 'save');
  if (action === 'reset') { await deleteWebBoard(db, d, tgid, y, week); return back('reset=1'); }
  const { rows } = await desiredBoard(db, d, tgid, y, week);
  let next = rows.map((r) => ({ ...r }));
  for (const r of next) {
    const p = form.get(`pts_${r.PRSI}`); if (p !== null) r.PPSC = Math.min(MAX_PER_PROSPECT, Math.max(0, Math.round(num(p) / 10) * 10));
    const s = form.get(`scout_${r.PRSI}`); if (s !== null) r.PSCP = Math.min(MAX_SCOUT, Math.max(0, Math.round(num(s) / 50) * 50));
  }
  const move = form.get('move'); const removeId = form.get('remove'); const prsi = num(form.get('prsi'), 0);
  let note = 'save';
  if (action === 'add' && prsi) {
    if (next.some((r) => r.PRSI === prsi)) return back(`err=${encodeURIComponent('Already on the board.')}`);
    if (next.length >= BOARD_SLOTS) return back(`err=${encodeURIComponent('The board is full (35).')}`);
    next.push({ PRSI: prsi, PPSC: 0, PPSL: 0, PSCP: 0, PROR: next.length, PEPV: 0, USEL: 1, TGID: tgid }); note = `add ${prsi}`;
  } else if (typeof removeId === 'string' && removeId) {
    next = next.filter((r) => r.PRSI !== num(removeId)); note = `remove ${removeId}`;
  } else if (typeof move === 'string' && move.includes(':')) {
    const [idStr, dir] = move.split(':'); const id = num(idStr); next = renumber(next);
    const i = next.findIndex((r) => r.PRSI === id); const j = dir === 'up' ? i - 1 : i + 1;
    if (i >= 0 && j >= 0 && j < next.length) { const a = next[i]!.PROR; next[i]!.PROR = next[j]!.PROR; next[j]!.PROR = a; }
    note = `move ${move}`;
  }
  next = renumber(next);
  const used = next.reduce((s, r) => s + r.PPSC, 0);
  const { budget } = budgetOf(team ?? undefined);
  if (budget && used > budget) return back(`err=${encodeURIComponent(`That is ${used - budget} points over the weekly budget of ${budget}.`)}`);
  await upsertWebBoard(db, d, tgid, y, week, next, member.blaze_id, note);
  return back('saved=1');
}
