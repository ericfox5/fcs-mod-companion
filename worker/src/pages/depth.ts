// Depth chart and formation subs for a member's own team (a commissioner may edit any team). The chart is the game's
// DCHT table: 88 slots per team, a fixed number per position. A save is one pending row per team and week
// (web_depth_edits); the bridge writes it into the copy of the dynasty file the league server hands the console at its
// next load (bridge/src/dynasty-patch.ts), which is how it gets past the in-game screen when that refuses a player (a
// portal player the game sat down for the season). Supersim lines up from the pending chart straight away. Formation
// subs (PLSU) ride the same row; the table's encoding is the site's reading and unverified (decode/depth.ts).
import type { PageCtx } from '../index.js';
import { html, type Raw } from '../html.js';
import { layout, box } from '../layout.js';
import { getTeams, getPlayers, getDepthChart, getFormationSubs, getPendingDepthEdit, upsertDepthEdit, deleteDepthEdit, type PlayerRow, type MemberRow, type FormationSub } from '../db/queries.js';
import { redirect } from '../session.js';
import { pos, cls, teamLogo, teamLogoUrl, headshotUrl, teamColors } from './common.js';
import { tier } from './player-keys.js';
import { DEPTH_SLOTS } from '@ncaa/ncaa14';
import { loadTeamBook } from '../supersim/coach/books.js';
import type { Book } from '../supersim/coach/types.js';

const enc = encodeURIComponent;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const UNITS: [string, number[]][] = [['Offense', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]], ['Defense', [10, 11, 12, 13, 14, 15, 16, 17, 18]], ['Special teams', [19, 20, 21, 22, 23, 24]]];
// where a position's slots are filled from when its own players run out (the game's own fallbacks, as Supersim uses them)
const FALLBACK: Record<number, number[]> = { 0: [0], 1: [1, 2, 21, 22], 2: [2, 1, 4], 3: [3, 21, 22, 1], 4: [4, 2, 5, 9], 5: [5, 9, 6, 8, 7], 6: [6, 8, 7, 5, 9], 7: [7, 6, 8], 8: [8, 6, 7, 9, 5], 9: [9, 5, 8, 6, 7], 10: [10, 11, 12, 15, 13], 11: [11, 10, 12, 13, 15], 12: [12, 10, 11], 13: [13, 15, 14, 18], 14: [14, 13, 15, 18], 15: [15, 13, 14, 18], 16: [16, 17, 18, 3], 17: [17, 18, 16], 18: [18, 17, 16, 14], 19: [19, 20, 23], 20: [20, 19], 21: [21, 22, 3, 1, 16], 22: [22, 21, 3, 16, 1], 23: [23, 19, 20], 24: [24, 7, 4, 6] };
export type Chart = Record<string, number[]>;

export const canEditTeam = (member: MemberRow | null | undefined, tgid: number) => !!member && (member.commissioner === 1 || member.tgid === tgid);
const label = (p: PlayerRow) => `#${p.jersey} ${p.last_name}, ${p.first_name} · ${pos(p.pos)} ${p.overall}${p.redshirt === 1 ? ' · RS' : ''}`;

// The console's rows as {pos: [pgid by depth]}, every position padded to its slot count.
export function chartFromRows(rows: { pos: number; depth: number; pgid: number }[]): Chart {
  const out: Chart = {};
  for (const [p, n] of Object.entries(DEPTH_SLOTS)) out[p] = Array<number>(n).fill(0);
  for (const r of rows) if (out[String(r.pos)] && r.depth < DEPTH_SLOTS[r.pos]!) out[String(r.pos)]![r.depth] = r.pgid;
  return out;
}
// A chart by the ratings: each position's own players by overall (redshirts sit), then the fallback positions; the
// return slots go to the fastest skill players, kickoffs to the kicker, long snaps to the center.
export function autoChart(players: PlayerRow[]): Chart {
  const R = new Map(players.map((p) => { let r: Record<string, number> = {}; try { r = JSON.parse(p.ratings_json || '{}'); } catch { /* none */ } return [p.pgid, r]; }));
  const active = players.filter((p) => p.redshirt !== 1);
  const byOvr = (list: PlayerRow[]) => [...list].sort((a, b) => b.overall - a.overall || a.pgid - b.pgid);
  const out: Chart = {};
  for (const [ps, n] of Object.entries(DEPTH_SLOTS)) {
    const p = Number(ps); const picked: number[] = [];
    const take = (list: PlayerRow[]) => { for (const x of list) { if (picked.length >= n) break; if (!picked.includes(x.pgid)) picked.push(x.pgid); } };
    if (p === 21 || p === 22) take([...active.filter((x) => [3, 1, 16, 17, 2].includes(x.pos))].sort((a, b) => (R.get(b.pgid)?.['PSPD'] ?? 0) - (R.get(a.pgid)?.['PSPD'] ?? 0) || b.overall - a.overall));
    else if (p === 23) take(byOvr(active.filter((x) => x.pos === 19 || x.pos === 20)));
    else if (p === 24) take(byOvr(active.filter((x) => x.pos === 7)));
    for (const fp of FALLBACK[p] ?? [p]) take(byOvr(active.filter((x) => x.pos === fp)));
    take(byOvr(active));
    while (picked.length < n) picked.push(0);
    out[ps] = picked;
  }
  return out;
}
// the form's s<pos>_<depth> fields over the chart shown; a slot left blank keeps what it had
function chartFromForm(form: FormData, shown: Chart, roster: Set<number>): Chart {
  const out: Chart = {};
  for (const [ps, n] of Object.entries(DEPTH_SLOTS)) {
    const row = Array<number>(n).fill(0);
    for (let d = 0; d < n; d++) { const v = form.get(`s${ps}_${d}`); const id = v === null ? (shown[ps]?.[d] ?? 0) : num(v); row[d] = roster.has(id) ? id : 0; }
    for (let d = 0; d < n; d++) if (row[d] && row.indexOf(row[d]!) !== d) row[d] = 0; // the same player twice at one position
    out[ps] = row;
  }
  return out;
}
function subsFromForm(form: FormData, roster: Set<number>): FormationSub[] {
  const out: FormationSub[] = [];
  for (const [k, v] of form.entries()) {
    const m = /^fs_(off|def)_(\d+)_(\d+)$/.exec(k); if (!m) continue;
    const id = num(v); if (!roster.has(id)) continue;
    out.push({ side: m[1] as 'off' | 'def', set: Number(m[2]), slot: Number(m[3]), pgid: id });
  }
  return out;
}
export const subKey = (s: { side: string; set: number; slot: number }) => `${s.side}:${s.set}:${s.slot}`;

// the books the team runs (its playbook edits saved on the site composed over the stock books, else the stock books); null
// when a book cannot be loaded
async function teamBookPair(ctx: PageCtx, team: { tgid: number; raw_json: string }): Promise<{ off: Book | null; def: Book | null }> {
  const one = (side: 'off' | 'def') => loadTeamBook(ctx.env, ctx.url.origin, ctx.dyn.id, team, side).then((t) => t.book).catch(() => null);
  const [off, def] = await Promise.all([one('off'), one('def')]);
  return { off, def };
}

export async function depthPage(ctx: PageCtx, tgid?: number): Promise<Response> {
  const { env, dyn, url, member } = ctx; const db = env.DB, d = dyn.id, y = dyn.season_year, week = dyn.week ?? 0;
  const teams = await getTeams(db, d);
  const want = tgid ?? num(url.searchParams.get('t'));
  const sel = Number.isInteger(want) && teams.some((t) => t.tgid === want) ? want : (member?.tgid && teams.some((t) => t.tgid === member.tgid) ? member.tgid : teams[0]?.tgid);
  const team = teams.find((t) => t.tgid === sel);
  const base = `/d/${dyn.slug}/depth`;
  const picker = html`<form class="inline" method="get" action="${base}"><select name="t" data-nav-param="t" onchange="location.href='${base}?t='+this.value">${teams.map((t) => html`<option value="${t.tgid}" ${t.tgid === sel ? 'selected' : ''}>${t.name}</option>`)}</select></form>`;
  if (!team) return layout({ strip: ctx.strip, member, members: ctx.members, path: url.pathname, title: 'Depth Chart', siteName: env.SITE_NAME, dyn, section: 'depth', body: html`<h2>Depth Chart</h2>${picker}<p class="muted">No teams imported yet.</p>` });
  const [players, rows, consoleSubs, pending] = await Promise.all([getPlayers(db, d, team.tgid), getDepthChart(db, d, team.tgid, dyn.current_snapshot_id), getFormationSubs(db, d, team.tgid, dyn.current_snapshot_id), getPendingDepthEdit(db, d, team.tgid, y, week)]);
  const byId = new Map(players.map((p) => [p.pgid, p]));
  let pendingChart: Chart | null = null, pendingSubs: FormationSub[] | null = null;
  if (pending) { try { pendingChart = JSON.parse(pending.chart_json); pendingSubs = JSON.parse(pending.subs_json); } catch { /* malformed */ } }
  const consoleChart = chartFromRows(rows); const chart = pendingChart ?? consoleChart;
  const subs = new Map((pendingSubs ?? consoleSubs.map((s) => ({ side: s.side === 1 ? 'off' : 'def', set: s.set_id, slot: s.slot, pgid: s.pgid } as FormationSub))).map((s) => [subKey(s), s.pgid]));
  const edit = canEditTeam(member, team.tgid);
  const q = url.searchParams;
  const flash = q.get('saved') ? html`<p class="flash">Saved. Supersim uses this chart now; the console gets it the next time the dynasty loads there (the league server hands it a copy of the dynasty file with your chart in it).</p>`
    : q.get('reset') ? html`<p class="flash">Pending depth chart discarded; the console's own chart is shown.</p>`
    : q.get('auto') ? html`<p class="flash">Filled by the ratings. Look it over and save.</p>`
    : q.get('err') ? html`<p class="flash err">${q.get('err')}</p>` : html``;
  const sorted = [...players].sort((a, b) => a.pos - b.pos || b.overall - a.overall);
  const groups = new Map<number, PlayerRow[]>(); for (const p of sorted) groups.set(p.pos, [...(groups.get(p.pos) ?? []), p]);
  const option = (p: PlayerRow | undefined, id: number, selected: boolean) => (p ? html`<option value="${p.pgid}" ${selected ? 'selected' : ''}>${label(p)}</option>` : id ? html`<option value="${id}" ${selected ? 'selected' : ''}>#${id} (not on the roster)</option>` : html`<option value="0" ${selected ? 'selected' : ''}>—</option>`);
  // Lineup cards: one per position, the starter as a card (team-coloured strip, headshot, name) with the backups listed
  // under it. Every slot is a button for the coach (depth.js swaps them and keeps the hidden s<pos>_<depth> inputs that
  // the form posts); viewers get the same cards as plain blocks. depth.js re-renders a slot from the roster card data.
  const colors = teamColors(team.raw_json);
  const short = (p: PlayerRow) => `${p.first_name.charAt(0)}. ${p.last_name}`;
  const rsTag = html`<span class="tag rs" title="Redshirting this season: the game keeps him off the field">RS</span>`;
  const starterBody = (p: PlayerRow | undefined, id: number) => p
    ? html`<span class="lc-strip"><span class="lc-num">#${p.jersey}</span>${p.redshirt === 1 ? rsTag : ''}<span class="ovr-pill t-${tier(p.overall)}">${p.overall}</span></span><span class="lc-pic"><img class="lc-shot" src="${headshotUrl(p)}" alt="" loading="lazy" decoding="async" width="86" height="104"></span><span class="lc-name">${short(p)}</span><span class="lc-cls">${cls(p)} · ${pos(p.pos)}</span>`
    : html`<span class="lc-strip"><span class="lc-num">${id ? `#${id}` : ''}</span></span><span class="lc-pic"><img class="lc-shot" src="/img/faces/0.png" alt="" width="86" height="104"></span><span class="lc-name muted">${id ? 'Not on the roster' : 'Empty'}</span><span class="lc-cls">&nbsp;</span>`;
  const backupBody = (p: PlayerRow | undefined, id: number, d: number) => p
    ? html`<span class="lc-d">${d + 1}</span><span class="lc-bname">${short(p)}${p.redshirt === 1 ? html` ${rsTag}` : ''}</span><span class="lc-bovr t-${tier(p.overall)}">${p.overall}</span>`
    : html`<span class="lc-d">${d + 1}</span><span class="lc-bname muted">${id ? `#${id}` : '—'}</span><span class="lc-bovr"></span>`;
  const slot = (posCode: number, d: number, id: number, was: number, body: Raw, kind: string) => {
    const p = byId.get(id);
    const c = `lc-slot ${kind}${pendingChart && id !== was ? ' changed' : ''}${p && p.redshirt === 1 ? ' rs' : ''}`;
    return edit ? html`<button type="button" class="${c}" data-slot="${posCode}_${d}" data-pgid="${id}" data-orig="${was}" aria-label="${pos(posCode)} ${d + 1}">${body}</button>` : html`<span class="${c}">${body}</span>`;
  };
  const posCard = (posCode: number) => {
    const n = DEPTH_SLOTS[posCode]!; const ids = chart[String(posCode)] ?? []; const was = consoleChart[String(posCode)] ?? [];
    const sId = ids[0] ?? 0;
    return html`<div class="lc" data-pos="${posCode}">
      ${slot(posCode, 0, sId, was[0] ?? 0, starterBody(byId.get(sId), sId), 'lc-starter')}
      <ol class="lc-backups">${Array.from({ length: n - 1 }, (_, i) => { const d = i + 1, id = ids[d] ?? 0; return html`<li>${slot(posCode, d, id, was[d] ?? 0, backupBody(byId.get(id), id, d), 'lc-backup')}</li>`; })}</ol>
      <div class="lc-label">${pos(posCode)}<small>${groups.get(posCode)?.length ?? 0} on roster</small></div>
      ${edit ? Array.from({ length: n }, (_, d) => html`<input type="hidden" name="s${posCode}_${d}" value="${ids[d] ?? 0}">`) : ''}
    </div>`;
  };
  // the roster drawer: every player as a small card; depth.js reads a player's details from these data attributes
  const bench = edit ? html`<details class="lc-bench"><summary>Roster<small>${players.length} players · tap one, then the slot he takes (or a slot first)</small></summary>
    <div class="lc-bench-tools"><input type="search" class="lc-find" placeholder="Find by name, number or position" aria-label="Find a player" data-bench-filter></div>
    <div class="lc-bench-grid">${sorted.map((p) => html`<button type="button" class="lc-mini${p.redshirt === 1 ? ' rs' : ''}" data-bench="${p.pgid}" data-name="${short(p)}" data-num="${p.jersey}" data-ovr="${p.overall}" data-tier="${tier(p.overall)}" data-pos="${pos(p.pos)}" data-cls="${cls(p)}" data-shot="${headshotUrl(p)}" data-rs="${p.redshirt === 1 ? 1 : 0}" data-search="${`${p.first_name} ${p.last_name} #${p.jersey} ${pos(p.pos)}`.toLowerCase()}"><img class="lc-mshot" src="${headshotUrl(p)}" alt="" loading="lazy" decoding="async" width="28" height="34"><span class="lc-mname">${short(p)}</span><span class="lc-mmeta">#${p.jersey} · ${pos(p.pos)} · ${cls(p)}</span><span class="ovr-pill t-${tier(p.overall)}">${p.overall}</span></button>`)}</div></details>` : html``;
  const ovr = Math.max(0, Math.min(100, Number(team.overall) || 0));
  const head = html`<div class="lc-head"><img class="lc-hlogo" src="${teamLogoUrl(team, 'lg')}" alt="" width="56" height="56"><div class="lc-htext"><span class="lc-hk">Depth chart${pending ? html` <span class="tag pending">PENDING</span>` : ''}</span><span class="lc-hname">${team.name}</span></div><span class="lc-ovr" title="Team overall"><svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15.9"></circle><circle class="v" cx="18" cy="18" r="15.9" stroke-dasharray="${ovr} 100"></circle></svg><b>${ovr}</b><small>OVR</small></span></div>`;
  const tabs = html`<div class="lc-tabs" role="tablist">${UNITS.map(([title], i) => html`<button type="button" role="tab" data-tab="u${i}" aria-selected="${i === 0 ? 'true' : 'false'}">${title}</button>`)}</div>`;
  const books = await teamBookPair(ctx, team);
  const formationRows = (side: 'off' | 'def', book: Book | null): Raw => {
    if (!book) return html`<p class="muted">Playbook unavailable.</p>`;
    const forms = book.formations.filter((f) => f.sets.length);
    return html`${forms.map((f) => { const subbed = f.sets.reduce((a, s) => a + s.slots.filter((sl) => subs.has(subKey({ side, set: s.id, slot: sl.i }))).length, 0); return html`<details class="dc-form" ${subbed ? 'open' : ''}><summary>${f.n}<small>${f.sets.length} set${f.sets.length === 1 ? '' : 's'}${subbed ? ` · ${subbed} sub${subbed === 1 ? '' : 's'}` : ''}</small></summary>
      <table class="list dc-sets">${f.sets.map((s) => html`<tr><th>${s.n}</th>${s.slots.map((sl) => { const k = subKey({ side, set: s.id, slot: sl.i }); const id = subs.get(k) ?? 0; const dflt = byId.get(chart[String(sl.pos)]?.[sl.depth] ?? 0); const name = `fs_${side}_${s.id}_${sl.i}`; const dLabel = `${pos(sl.pos)}${sl.depth + 1}`;
        return html`<td class="${id ? 'changed' : ''}"><label><small>${dLabel}</small>${edit ? html`<select name="${name}" data-dc data-pos="${sl.pos}" data-orig="${id}" data-default="${dflt ? `${dflt.last_name} (depth chart)` : 'depth chart'}" aria-label="${f.n} ${s.n} ${dLabel}">${id && byId.get(id) ? html`<option value="0">${dflt ? `${dflt.last_name} (depth chart)` : 'depth chart'}</option>${option(byId.get(id), id, true)}` : html`<option value="0" selected>${dflt ? `${dflt.last_name} (depth chart)` : 'depth chart'}</option>`}</select>` : html`<span class="dc-name">${id && byId.get(id) ? label(byId.get(id)!) : dflt ? `${dflt.last_name} (depth chart)` : '—'}</span>`}</label></td>`; })}</tr>`)}</table></details>`; })}`;
  };
  const body = html`<h2>Depth Chart</h2>${picker}${flash}
    <form class="dc" method="post" action="${base}"><input type="hidden" name="tgid" value="${team.tgid}"><input type="hidden" name="week" value="${week}">
    <section class="box lc-box" style="--team:${colors.primary};--team-2:${colors.secondary};--on-team:${colors.onPrimary}">${head}
      <p class="dc-note">${edit ? html`Tap a player, then tap where he goes: two chart slots swap, a roster player takes the slot. ${pending ? html`<b>A pending chart is shown:</b> it reaches the console the next time the dynasty loads there and Supersim already uses it. ` : ''}The game keeps redshirts (RS) and injured players off the field; a player the game sat down as a transfer can still be placed here, which is what makes him play.` : html`Sign in as this team's coach (or the commissioner) to change it.`}</p>
      ${edit ? html`<div class="dc-actions"><button class="btn" name="action" value="save" data-save>Save depth chart</button><button class="btn light" name="action" value="auto" formnovalidate>Fill by ratings</button>${pending ? html`<button class="btn light" name="action" value="reset" formnovalidate>Discard pending chart</button>` : ''}<span class="muted" data-hint>Blue: changed here. Amber: pending from an earlier save.</span></div><noscript><p class="dc-note">Changing the chart needs JavaScript; the chart is shown as it stands.</p></noscript>` : ''}
      <div class="lc-units" data-tabs>${tabs}${UNITS.map(([, codes], i) => html`<div class="lc-grid" data-panel="u${i}" ${i ? 'hidden' : ''}>${codes.map(posCard)}</div>`)}</div>
      ${bench}
    </section>
    ${box(html`Formation subs <span class="tag" title="The game's formation-sub table has never carried a row in this league's files, so how the console reads these is unverified. Supersim honours them regardless.">EXPERIMENTAL</span>`, html`
      <p class="dc-note">A player who comes in for one slot of one set, over the depth chart (the in-game Formation Subs screen). Supersim lines up with these at once; whether the console takes them is unverified: set one in the game, advance, and the site will show it here if the encoding matches.</p>
      <div class="dc-books"><div><h4 class="dc-unit">Offense · ${books.off?.name ?? '—'}</h4>${formationRows('off', books.off)}</div><div><h4 class="dc-unit">Defense · ${books.def?.name ?? '—'}</h4>${formationRows('def', books.def)}</div></div>
      ${edit ? html`<div class="dc-actions"><button class="btn" name="action" value="save">Save depth chart and subs</button></div>` : ''}`)}
    </form>
    ${edit ? html`<template id="dc-players">${[...groups.entries()].map(([p, list]) => html`<optgroup label="${pos(p)}" data-pos="${p}">${list.map((x) => html`<option value="${x.pgid}">${label(x)}</option>`)}</optgroup>`)}</template><script src="/js/depth.js" defer></script>` : ''}`;
  return layout({ strip: ctx.strip, member, members: ctx.members, path: url.pathname, title: 'Depth Chart', siteName: env.SITE_NAME, dyn, section: 'depth', body, wide: true });
}

// POST /d/<slug>/depth: save | auto | reset for the member's own team (a commissioner may edit any team).
export async function depthAction(ctx: PageCtx, form: FormData): Promise<Response> {
  const { env, dyn, member } = ctx; const db = env.DB, d = dyn.id, y = dyn.season_year, week = dyn.week ?? 0;
  const tgid = num(form.get('tgid'));
  const back = (q: string) => redirect(`/d/${dyn.slug}/depth?t=${tgid}&${q}`);
  if (!Number.isInteger(tgid)) return redirect(`/d/${dyn.slug}/depth`);
  if (!canEditTeam(member, tgid)) return back(`err=${enc('You can only change your own team\'s depth chart.')}`);
  if (num(form.get('week')) !== week) return back(`err=${enc('The dynasty advanced while you were editing; the page was reloaded.')}`);
  const action = String(form.get('action') ?? 'save');
  if (action === 'reset') { await deleteDepthEdit(db, d, tgid, y, week); return back('reset=1'); }
  const [players, rows, pending] = await Promise.all([getPlayers(db, d, tgid), getDepthChart(db, d, tgid, dyn.current_snapshot_id), getPendingDepthEdit(db, d, tgid, y, week)]);
  if (!players.length) return back(`err=${enc('No roster for this team.')}`);
  const roster = new Set(players.map((p) => p.pgid));
  let shown: Chart = chartFromRows(rows); let subs: FormationSub[] = [];
  if (pending) { try { shown = JSON.parse(pending.chart_json); subs = JSON.parse(pending.subs_json); } catch { /* malformed */ } }
  if (action === 'auto') { await upsertDepthEdit(db, d, tgid, y, week, autoChart(players), subs, member?.blaze_id ?? null, 'filled by ratings'); return back('auto=1'); }
  const chart = chartFromForm(form, shown, roster); const newSubs = subsFromForm(form, roster);
  const changed = Object.keys(DEPTH_SLOTS).filter((p) => JSON.stringify(chart[p]) !== JSON.stringify(chartFromRows(rows)[p])).map((p) => pos(Number(p)));
  const note = [changed.length ? `${changed.join(', ')} changed` : 'chart as the console has it', newSubs.length ? `${newSubs.length} formation sub(s)` : ''].filter(Boolean).join('; ');
  await upsertDepthEdit(db, d, tgid, y, week, chart, newSubs, member?.blaze_id ?? null, note);
  return back('saved=1');
}
