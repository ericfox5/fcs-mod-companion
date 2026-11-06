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
import { pos, cls, teamLogo } from './common.js';
import { DEPTH_SLOTS } from '@ncaa/ncaa14';
import { loadBook, loadIndex, teamBooks } from '../supersim/coach/books.js';
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

async function teamBookPair(ctx: PageCtx, raw: string): Promise<{ off: Book | null; def: Book | null }> {
  try {
    const index = await loadIndex(ctx.env.ASSETS, ctx.url.origin); let rawObj: Record<string, unknown> | null = null; try { rawObj = JSON.parse(raw || 'null'); } catch { /* none */ }
    const b = teamBooks(index, rawObj);
    const [off, def] = await Promise.all([loadBook(ctx.env.ASSETS, ctx.url.origin, b.offBook).catch(() => null), loadBook(ctx.env.ASSETS, ctx.url.origin, b.defBook).catch(() => null)]);
    return { off, def };
  } catch { return { off: null, def: null }; }
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
  const slotSelect = (name: string, posCode: number, id: number, orig: number, extra = '') => {
    const p = byId.get(id);
    return edit
      ? html`<select name="${name}" data-dc data-pos="${posCode}" data-orig="${orig}" aria-label="${name}" ${extra}>${option(p, id, true)}</select>`
      : html`<span class="dc-name">${p ? label(p) : id ? `#${id}` : '—'}</span>`;
  };
  const posCard = (posCode: number) => {
    const n = DEPTH_SLOTS[posCode]!; const ids = chart[String(posCode)] ?? []; const was = consoleChart[String(posCode)] ?? [];
    return html`<div class="dc-pos"><h4>${pos(posCode)}<small>${groups.get(posCode)?.length ?? 0} on the roster</small></h4>
      <ol>${Array.from({ length: n }, (_, i) => { const id = ids[i] ?? 0; const p = byId.get(id); const changed = pendingChart && id !== (was[i] ?? 0); return html`<li class="${changed ? 'changed' : ''}${p && p.redshirt === 1 ? ' rs' : ''}">${slotSelect(`s${posCode}_${i}`, posCode, id, was[i] ?? 0)}${p && p.redshirt === 1 ? html` <span class="tag" title="Redshirting this season: the game keeps him off the field">RS</span>` : ''}${p ? html` <span class="dc-cls">${cls(p)}</span>` : ''}</li>`; })}</ol></div>`;
  };
  const books = await teamBookPair(ctx, team.raw_json);
  const formationRows = (side: 'off' | 'def', book: Book | null): Raw => {
    if (!book) return html`<p class="muted">Playbook unavailable.</p>`;
    const forms = book.formations.filter((f) => f.sets.length);
    return html`${forms.map((f) => { const subbed = f.sets.reduce((a, s) => a + s.slots.filter((sl) => subs.has(subKey({ side, set: s.id, slot: sl.i }))).length, 0); return html`<details class="dc-form" ${subbed ? 'open' : ''}><summary>${f.n}<small>${f.sets.length} set${f.sets.length === 1 ? '' : 's'}${subbed ? ` · ${subbed} sub${subbed === 1 ? '' : 's'}` : ''}</small></summary>
      <table class="list dc-sets">${f.sets.map((s) => html`<tr><th>${s.n}</th>${s.slots.map((sl) => { const k = subKey({ side, set: s.id, slot: sl.i }); const id = subs.get(k) ?? 0; const dflt = byId.get(chart[String(sl.pos)]?.[sl.depth] ?? 0); const name = `fs_${side}_${s.id}_${sl.i}`; const dLabel = `${pos(sl.pos)}${sl.depth + 1}`;
        return html`<td class="${id ? 'changed' : ''}"><label><small>${dLabel}</small>${edit ? html`<select name="${name}" data-dc data-pos="${sl.pos}" data-orig="${id}" data-default="${dflt ? `${dflt.last_name} (depth chart)` : 'depth chart'}" aria-label="${f.n} ${s.n} ${dLabel}">${id && byId.get(id) ? html`<option value="0">${dflt ? `${dflt.last_name} (depth chart)` : 'depth chart'}</option>${option(byId.get(id), id, true)}` : html`<option value="0" selected>${dflt ? `${dflt.last_name} (depth chart)` : 'depth chart'}</option>`}</select>` : html`<span class="dc-name">${id && byId.get(id) ? label(byId.get(id)!) : dflt ? `${dflt.last_name} (depth chart)` : '—'}</span>`}</label></td>`; })}</tr>`)}</table></details>`; })}`;
  };
  const body = html`<h2>Depth Chart</h2>${picker}${flash}
    <form class="dc" method="post" action="${base}"><input type="hidden" name="tgid" value="${team.tgid}"><input type="hidden" name="week" value="${week}">
    ${box(html`${teamLogo(team, 'sm')} ${team.name} depth chart${pending ? html` <span class="tag pending">PENDING</span>` : ''}`, html`
      <p class="dc-note">${edit ? html`Pick who starts at every slot. ${pending ? html`<b>A pending chart is shown:</b> it reaches the console the next time the dynasty loads there and Supersim already uses it. ` : ''}The game keeps redshirts (RS) and injured players off the field; a player the game sat down as a transfer can still be placed here, which is what makes him play.` : html`Sign in as this team's coach (or the commissioner) to change it.`}</p>
      ${edit ? html`<div class="dc-actions"><button class="btn" name="action" value="save">Save depth chart</button><button class="btn light" name="action" value="auto" formnovalidate>Fill by ratings</button>${pending ? html`<button class="btn light" name="action" value="reset" formnovalidate>Discard pending chart</button>` : ''}<span class="muted">Blank slots keep what the console has. Tap a slot to pick from the roster.</span></div>` : ''}
      ${UNITS.map(([title, codes]) => html`<h4 class="dc-unit">${title}</h4><div class="dc-grid">${codes.map(posCard)}</div>`)}`)}
    ${box(html`Formation subs <span class="tag" title="The game's formation-sub table has never carried a row in this league's files, so how the console reads these is unverified. Supersim honours them regardless.">EXPERIMENTAL</span>`, html`
      <p class="dc-note">A player who comes in for one slot of one set, over the depth chart (the in-game Formation Subs screen). Supersim lines up with these at once; whether the console takes them is unverified: set one in the game, advance, and the site will show it here if the encoding matches.</p>
      <div class="dc-books"><div><h4 class="dc-unit">Offense · ${books.off?.name ?? '—'}</h4>${formationRows('off', books.off)}</div><div><h4 class="dc-unit">Defense · ${books.def?.name ?? '—'}</h4>${formationRows('def', books.def)}</div></div>
      ${edit ? html`<div class="dc-actions"><button class="btn" name="action" value="save">Save depth chart and subs</button></div>` : ''}`)}
    </form>
    ${edit ? html`<template id="dc-players">${[...groups.entries()].map(([p, list]) => html`<optgroup label="${pos(p)}" data-pos="${p}">${list.map((x) => html`<option value="${x.pgid}">${label(x)}</option>`)}</optgroup>`)}</template>` : ''}`;
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
