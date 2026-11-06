// Transfer Portal (offseason "Players Leaving" week): every player transferring out this offseason, where he goes and
// why, with the commissioner's changes on top. A change is a pending row per player and week (web_transfer_edits); the
// bridge turns pending rows into the change tables the console pulls when the dynasty loads (PLYZ leaving flags, TRAZ
// destination, PLSZ) and acks them once the console reflects them or the dynasty has left that week.
import type { PageCtx } from '../index.js';
import { html, type Raw } from '../html.js';
import { layout, box, stageLabel } from '../layout.js';
import { getTeams, teamMap, type TeamRow } from '../db/queries.js';
import {
  TRANSFER_REASONS, TRANSFER_FLAGS, reasonLabel, isTransferring, listTransfers, getPortalPlayer, getPortalPlayers, hasLeaveData, leaveCounts,
  teamRosterForPortal, searchPortalPlayers, listTransferEdits, upsertTransferEdit, deleteTransferEdit, latestSeasonStats, type PortalPlayer, type WebTransferEdit,
} from '../db/transfers.js';
import { redirect, sameOrigin } from '../session.js';
import { teamLogo, teamLogoUrl, teamLink, playerName, pos, cls, headshot, headshotUrl, heightFt, seasonLabel } from './common.js';
import { keyStats, keyRatings, ratingBars, statTiles } from './player-keys.js';

const enc = encodeURIComponent;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
// Commissioner = the member flagged as commissioner; once the league has accounts that member must be signed in.
export const isPortalCommissioner = (ctx: Pick<PageCtx, 'member' | 'account' | 'locked'>) => !!ctx.member && ctx.member.commissioner === 1 && (!ctx.locked || !!ctx.account);
// Leaving for good this offseason (graduation, the draft): not offered for a transfer.
const DEPARTING = (flag: number | null) => flag !== null && ((flag >= 1 && flag <= 7) || (flag >= 19 && flag <= 26));
const memberTeams = (ctx: PageCtx) => new Set((ctx.members ?? []).map((m) => m.tgid).filter((t) => t > 0 && t !== 1023));
const CONSOLE_NOTE = 'The console applies it the next time the dynasty loads (refresh or resume).';

// One row of the portal: the imported state plus the pending change.
interface PortalRow { p: PortalPlayer; edit: WebTransferEdit | undefined; inFile: boolean; staying: boolean; dest: number | null; was: number | null; reason: number | null }
function portalRows(base: PortalPlayer[], added: PortalPlayer[], edits: WebTransferEdit[]): PortalRow[] {
  const editOf = new Map(edits.map((e) => [e.pgid, e]));
  const row = (p: PortalPlayer, inFile: boolean): PortalRow => {
    const edit = editOf.get(p.pgid);
    const fileDest = p.to_tgid !== null && p.trac === 1 ? p.to_tgid : null;
    const staying = edit?.action === 'stay';
    const dest = edit?.action === 'transfer' ? edit.to_tgid : fileDest;
    return { p, edit, inFile, staying, dest, was: edit?.action === 'transfer' && inFile && fileDest !== dest ? fileDest : null, reason: edit?.action === 'transfer' ? (edit.reason ?? p.leave_flag) : p.leave_flag };
  };
  const seen = new Set(base.map((p) => p.pgid));
  return [...base.map((p) => row(p, true)), ...added.filter((p) => !seen.has(p.pgid)).map((p) => row(p, false))];
}

const teamCell = (slug: string, t: TeamRow | undefined, fallback = '—') => t ? html`<span class="tp-team">${teamLogo(t, 'xs')}${teamLink(slug, t)}</span>` : html`<span class="muted">${fallback}</span>`;
const teamOption = (t: TeamRow, selected: number | null) => html`<option value="${t.tgid}" ${t.tgid === selected ? 'selected' : ''}>${t.name}${t.conf_label ? ` (${t.conf_label})` : ''}</option>`;
const teamOptions = (teams: TeamRow[], exclude: number | null, selected: number | null) => teams.filter((t) => t.tgid !== exclude).map((t) => teamOption(t, selected));
// one option per label (10 and 11 are both "Playing Time": keep whichever the player already has)
const reasonOptions = (selected: number | null) => {
  const seen = new Set<string>();
  return TRANSFER_REASONS.filter(([, long]) => !seen.has(long) && !!seen.add(long)).map(([c, long]) => {
    const v = c === 10 && (selected === 10 || selected === 11) ? selected : c;
    return html`<option value="${v}" ${v === selected ? 'selected' : ''}>${long}</option>`;
  });
};
// Route-strip logo: the 64px variant, the 160px one on dense screens; teamLogoUrl falls back to the monogram shield.
const routeLogo = (t: TeamRow | undefined, cls = '') => t
  ? html`<img class="tp-logo ${cls}" src="${teamLogoUrl(t, 'sm')}" srcset="${teamLogoUrl(t, 'sm')} 64w, ${teamLogoUrl(t, 'lg')} 160w" sizes="(max-width: 720px) 32px, 40px" alt="" width="40" height="40" loading="lazy" decoding="async">`
  : html`<span class="tp-logo tp-open" aria-hidden="true"></span>`;
const reasonTag = (code: number | null) => code !== null && TRANSFER_FLAGS.includes(code) ? html`<span class="tp-why r${code === 11 ? 10 : code}">${reasonLabel(code)}</span>` : '';

export async function transfersPage(ctx: PageCtx): Promise<Response> {
  const { env, dyn, url } = ctx;
  const db = env.DB, d = dyn.id, y = dyn.season_year, week = dyn.week ?? 0, slug = dyn.slug, base = `/d/${slug}/transfers`, q = url.searchParams;
  const commish = isPortalCommissioner(ctx);
  const [teams, inFile, edits, hasData, counts] = await Promise.all([getTeams(db, d), listTransfers(db, d), listTransferEdits(db, d, y, week), hasLeaveData(db, d), leaveCounts(db, d)]);
  const tm = teamMap(teams);
  const addedIds = edits.filter((e) => e.action === 'transfer' && !inFile.some((p) => p.pgid === e.pgid)).map((e) => e.pgid);
  const rows = portalRows(inFile, addedIds.length ? await getPortalPlayers(db, d, addedIds) : [], edits).sort((a, b) => b.p.overall - a.p.overall);
  const seasons = rows.length ? await latestSeasonStats(db, d, rows.map((r) => r.p.pgid)) : new Map();
  const mine = memberTeams(ctx);
  const live = rows.filter((r) => !r.staying);
  const countOf = (pred: (f: number) => boolean) => counts.filter((c) => pred(c.leave_flag)).reduce((s, c) => s + c.n, 0);

  // Messages after a change land on the player's row when it is still listed (?at= / ?edit=), else at the top.
  const editPgid = commish ? num(q.get('edit')) : NaN;
  const at = num(q.get('at'));
  const msg = q.get('saved') ? { ok: true, text: `${q.get('saved')} ${CONSOLE_NOTE}`, row: at }
    : q.get('undone') ? { ok: true, text: 'Pending change discarded.', row: at }
    : q.get('nochange') ? { ok: true, text: 'Nothing to change: that is already how the transfer stands.', row: at }
    : q.get('err') ? { ok: false, text: q.get('err')!, row: editPgid } : null;
  const msgRow = msg && rows.some((r) => r.p.pgid === msg.row) ? msg.row : NaN;
  const flash = msg && Number.isNaN(msgRow) ? html`<p class="flash ${msg.ok ? '' : 'err'}">${msg.text}</p>` : html``;

  // from -> to strip: three green chevrons = in the save file, amber = a pending change, grey = staying, faded = undecided
  const route = (r: PortalRow) => {
    const f = tm.get(r.p.tgid), t = r.dest !== null ? tm.get(r.dest) : undefined, w = r.was !== null ? tm.get(r.was) : undefined;
    const kind = r.staying ? 'staying' : r.edit ? 'pending' : t ? 'file' : 'undecided';
    const label = r.staying ? 'Staying' : !r.inFile ? 'Added' : r.edit ? 'Pending' : '';
    const to = r.staying
      ? html`<span class="tp-dlogo">${t ? routeLogo(t, 'gone') : routeLogo(undefined)}</span><span class="tp-end to">${t ? html`<s class="tp-was">${t.name}</s>` : ''}<span class="tp-stays">Stays at ${f?.name ?? 'his school'}</span></span>`
      : t
        ? html`<span class="tp-dlogo">${routeLogo(t, r.edit ? 'new' : '')}</span><span class="tp-end to">${teamLink(slug, t)}${w ? html`<s class="tp-was" title="Destination in the save file">${teamLogo(w, 'xs')}${w.name}</s>` : ''}</span>`
        : html`<span class="tp-dlogo">${routeLogo(undefined)}</span><span class="tp-end to"><span class="muted">Undecided</span></span>`;
    return html`<div class="tp-route ${kind}">
      <span class="tp-end from">${teamLink(slug, f)}</span><span class="tp-flogo">${routeLogo(f)}</span>
      <span class="tp-track">${label ? html`<span class="tp-tl">${label}</span>` : ''}<span class="tp-chev" aria-hidden="true"><i></i><i></i><i></i></span><span class="tp-sr">${r.staying ? ', not transferring, was headed to' : ' to '}</span></span>
      ${to}
    </div>`;
  };

  // the commissioner's inline panel; team options come from one <template> (site.js) unless the row was opened by URL
  const panel = (r: PortalRow) => {
    const open = r.p.pgid === editPgid, f = tm.get(r.p.tgid), id = `tp-pn-${r.p.pgid}`;
    const destSel = r.staying ? null : r.dest;
    return html`<div class="tp-panel" id="${id}" ${open ? '' : 'hidden'}>
      ${msg && !msg.ok && msgRow === r.p.pgid ? html`<p class="tp-note err">${msg.text}</p>` : ''}
      <form method="post" action="${base}"><input type="hidden" name="week" value="${week}"><input type="hidden" name="pgid" value="${r.p.pgid}">
        <label>Destination <select name="to_tgid" required data-tp-dest data-from="${r.p.tgid}" ${open ? 'data-filled="1"' : ''}>${destSel === null ? html`<option value="">Pick a school</option>` : ''}${open ? teamOptions(teams, r.p.tgid, destSel) : destSel !== null && tm.get(destSel) ? teamOption(tm.get(destSel)!, destSel) : ''}</select></label>
        <label>Reason <select name="reason">${reasonOptions(r.reason !== null && TRANSFER_FLAGS.includes(r.reason) ? r.reason : 9)}</select></label>
        <button class="btn sm" name="action" value="dest">${r.staying ? 'Put back in the portal' : 'Save destination'}</button>
        <span class="tp-alt">
          ${r.staying ? '' : html`<button class="btn sm light" name="action" value="stay" formnovalidate>Keep at ${f?.name ?? 'his school'}</button>`}
          ${r.staying ? '' : html`<a class="btn sm light" href="${base}?team=${r.p.tgid}&swap=${r.p.pgid}${r.dest !== null ? `&dest=${r.dest}` : ''}&reason=${r.reason ?? 9}#tp-add">Swap for another player</a>`}
          ${r.edit ? html`<button class="btn sm danger" name="action" value="undo" formnovalidate>Undo pending change</button>` : ''}
        </span>
      </form>
    </div>`;
  };

  // tap a row (or its caret) for last season's line and the position's key ratings; one row open at a time (site.js)
  const more = (r: PortalRow) => {
    const p = r.p, season = seasons.get(p.pgid), ks = season ? keyStats(p.pos, season.stats) : null, kr = keyRatings(p.pos, p.ratings_json);
    return html`<div class="tp-more" id="tp-mo-${p.pgid}" hidden>
      <section class="tp-ms"><h4>${seasonLabel(season ? { season_year: season.year, start_year: dyn.start_year } : dyn)}<span>${ks ? `${ks.games} game${ks.games === 1 ? '' : 's'}` : ''}</span></h4>${ks && ks.games ? statTiles(ks.cells) : html`<p class="muted">Did not play.</p>`}</section>
      <section class="tp-mr"><h4>Key ratings<span>${pos(p.pos)}</span></h4>${kr.length ? ratingBars(kr) : html`<p class="muted">No ratings imported.</p>`}</section>
      <p class="tp-mf">#${p.jersey} · ${heightFt(p.height)} · ${p.weight} lb · <a href="/d/${slug}/player/${p.pgid}">Full profile</a></p>
    </div>`;
  };

  const list = rows.length ? html`<ul class="tp-list ${commish ? 'ed' : ''}">${rows.map((r) => {
    const f = tm.get(r.p.tgid), t = r.dest !== null ? tm.get(r.dest) : undefined;
    const member = mine.has(r.p.tgid) || (!r.staying && r.dest !== null && mine.has(r.dest));
    const search = `${playerName(r.p)} ${f?.name ?? ''} ${t?.name ?? ''}`.toLowerCase();
    const open = r.p.pgid === editPgid;
    return html`<li class="tp-row ${member ? 'member' : ''} ${r.staying ? 'staying' : ''} ${r.edit ? 'pending' : ''} ${open ? 'open' : ''}" id="p${r.p.pgid}" data-name="${r.p.last_name}, ${r.p.first_name}" data-pos="${r.p.pos}" data-class="${r.p.year * 2 + (r.p.redshirt ? 1 : 0)}" data-ovr="${r.p.overall}" data-from="${f?.name ?? ''}" data-to="${r.staying ? '' : (t?.name ?? '')}" data-team="${r.p.tgid}" data-member="${member ? 1 : 0}" data-search="${search}">
      <img class="tp-photo" src="${headshotUrl(r.p)}" alt="" width="48" height="58" loading="lazy" decoding="async">
      <div class="tp-who">
        <a class="tp-name" href="/d/${slug}/player/${r.p.pgid}">${playerName(r.p)}</a>
        <div class="tp-chips"><span class="tp-chip">${pos(r.p.pos)}</span><span class="tp-chip">${cls(r.p)}</span><span class="tp-chip ovr" title="Overall rating"><b>${r.p.overall}</b> OVR</span>${reasonTag(r.reason)}</div>
      </div>
      ${route(r)}
      <div class="tp-act">${commish ? html`<a class="btn sm light tp-edbtn" href="${base}?edit=${r.p.pgid}#p${r.p.pgid}" role="button" data-tp-toggle="tp-pn-${r.p.pgid}" aria-controls="tp-pn-${r.p.pgid}" aria-expanded="${open ? 'true' : 'false'}">Edit</a>` : ''}<button type="button" class="tp-caret" data-tp-more="tp-mo-${r.p.pgid}" aria-controls="tp-mo-${r.p.pgid}" aria-expanded="false" aria-label="Stats and ratings for ${playerName(r.p)}"></button></div>
      ${msg?.ok && msgRow === r.p.pgid ? html`<p class="tp-note ok">${msg.text}</p>` : ''}
      ${more(r)}
      ${commish ? panel(r) : ''}
    </li>`;
  })}</ul>` : html`<div class="tp-empty"><p>${hasData
    ? 'No players are transferring right now. Transfers are decided in the offseason "Players Leaving" week and show here once that week is imported.'
    : 'Transfers show here in the offseason "Players Leaving" week, after the next import of the dynasty. Older imports carry no leaving data.'}</p>${commish ? html`<p><a href="#tp-add">Make a player transfer</a> to send someone into the portal yourself.</p>` : ''}</div>`;

  const fromTeams = [...new Set(rows.map((r) => r.p.tgid))].map((g) => tm.get(g)).filter((t): t is TeamRow => !!t).sort((a, b) => a.name.localeCompare(b.name));
  const tools = rows.length ? html`<div class="prtools tp-tools">
    <label class="tp-q"><input type="search" data-tp-search placeholder="Search player or school" aria-label="Search player or school"></label>
    <label>From <select data-tp-team><option value="">All schools</option>${fromTeams.map((t) => html`<option value="${t.tgid}">${t.name}</option>`)}</select></label>
    <label>Sort <select data-tp-sort><option value="ovr">Overall</option><option value="name">Name</option><option value="pos">Position</option><option value="class">Class</option><option value="from">From school</option><option value="to">Destination</option></select></label>
    ${mine.size ? html`<label class="inline-check"><input type="checkbox" data-tp-members> League members' teams only</label>` : ''}
    <span class="ft-count ft-hint" aria-live="polite"></span>
  </div>` : html``;

  // "Make a player transfer" (commissioner): pick a school's roster or search by name, then reason + destination
  let addCard: Raw = html``;
  if (commish) {
    const team = num(q.get('team')), find = (q.get('find') ?? '').trim().slice(0, 40), pick = num(q.get('pick')), swap = num(q.get('swap'));
    const dest = num(q.get('dest')), reason = num(q.get('reason'));
    const swapRow = Number.isInteger(swap) ? rows.find((r) => r.p.pgid === swap && !r.staying) : undefined;
    const editOf = new Map(edits.map((e) => [e.pgid, e]));
    const eligible = (p: PortalPlayer) => !DEPARTING(p.leave_flag) && p.leave_type !== 3 && (!isTransferring(p) || editOf.get(p.pgid)?.action === 'stay') && editOf.get(p.pgid)?.action !== 'transfer';
    const roster = Number.isInteger(team) && tm.has(team) ? (await teamRosterForPortal(db, d, team)).filter(eligible) : [];
    const found = find.length >= 2 ? (await searchPortalPlayers(db, d, find, 40)).filter(eligible).slice(0, 25) : [];
    const picked = Number.isInteger(pick) ? (roster.find((p) => p.pgid === pick) ?? found.find((p) => p.pgid === pick) ?? null) : null;
    const pickTeam = picked ? picked.tgid : (Number.isInteger(team) ? team : null);
    const keep = (extra: Record<string, string | number>) => { const u = new URLSearchParams(); if (swapRow) u.set('swap', String(swapRow.p.pgid)); if (Number.isInteger(dest)) u.set('dest', String(dest)); if (Number.isInteger(reason)) u.set('reason', String(reason)); for (const [k, v] of Object.entries(extra)) u.set(k, String(v)); return `${base}?${u}#tp-add`; };
    const carry = html`${swapRow ? html`<input type="hidden" name="swap" value="${swapRow.p.pgid}">` : ''}${Number.isInteger(dest) ? html`<input type="hidden" name="dest" value="${dest}">` : ''}${Number.isInteger(reason) ? html`<input type="hidden" name="reason" value="${reason}">` : ''}`;
    addCard = box(html`<span id="tp-add"></span>${swapRow ? 'Swap transfer' : 'Make a player transfer'}`, html`
      ${swapRow ? html`<p class="tp-swap"><span class="tag stay">Stays</span> ${playerName(swapRow.p)} (${tm.get(swapRow.p.tgid)?.name ?? '?'}) stays at his school, and the player you pick below transfers instead. <a href="${base}#tp-add">Cancel swap</a></p>` : ''}
      <div class="tp-find">
        <form class="inline" method="get" action="${base}">${carry}
          <label for="tp-team">School</label> <select id="tp-team" name="team" onchange="this.form.submit()"><option value="">Pick a school</option>${teams.map((t) => html`<option value="${t.tgid}" ${t.tgid === pickTeam ? 'selected' : ''}>${t.name}</option>`)}</select>
          <noscript><button class="btn sm light">Show roster</button></noscript>
        </form>
        <span class="muted">or</span>
        <form class="inline" method="get" action="${base}">${carry}
          <input type="search" name="find" value="${find}" placeholder="Player name" aria-label="Find a player by name"> <button class="btn sm light">Find</button>
        </form>
      </div>
      ${found.length ? html`<table class="list tp-found">${found.map((p) => html`<tr><td>${headshot(p)} ${playerName(p)}</td><td class="hide-sm">${pos(p.pos)} · ${cls(p)}</td><td class="ovr">${p.overall}</td><td>${teamCell(slug, tm.get(p.tgid))}</td><td><a class="btn sm light" href="${keep({ team: p.tgid, pick: p.pgid })}">Pick</a></td></tr>`)}</table>`
        : find.length >= 2 ? html`<p class="muted">No eligible player matches “${find}” (players already transferring, graduating or entering the draft are left out).</p>` : ''}
      ${roster.length || picked ? html`<form class="wform" method="post" action="${base}"><input type="hidden" name="week" value="${week}">${swapRow ? html`<input type="hidden" name="swap" value="${swapRow.p.pgid}">` : ''}
        <div class="fields">
          <div class="wide"><label for="tp-player">Player</label><select id="tp-player" name="pgid" required>${picked && !roster.some((p) => p.pgid === picked.pgid) ? html`<option value="${picked.pgid}" selected>${playerName(picked)} — ${pos(picked.pos)} · ${cls(picked)} · ${picked.overall} OVR</option>` : html`<option value="">Pick a player</option>`}${roster.map((p) => html`<option value="${p.pgid}" ${p.pgid === pick ? 'selected' : ''}>#${p.jersey} ${playerName(p)} — ${pos(p.pos)} · ${cls(p)} · ${p.overall} OVR</option>`)}</select></div>
          <div><label for="tp-areason">Reason</label><select id="tp-areason" name="reason">${reasonOptions(TRANSFER_FLAGS.includes(reason) ? reason : 9)}</select></div>
          <div><label for="tp-adest">Destination</label><select id="tp-adest" name="to_tgid" required><option value="">Pick a school</option>${teamOptions(teams, pickTeam, Number.isInteger(dest) ? dest : null)}</select></div>
        </div>
        <div class="actions"><button class="btn" name="action" value="add">${swapRow ? 'Swap transfer' : 'Make transfer'}</button><span class="muted">Applied when the dynasty next loads on the console, like every portal change.</span></div>
      </form>` : html`<p class="muted">Pick a school to list its roster, or find a player by name.</p>`}`, 'tp-add');
  }

  const cell = (n: number, label: string, cls = '') => html`<div class="tp-cell ${cls}"><b>${n}</b><span>${label}</span></div>`;
  const pendingNote = commish && edits.length ? html`<p class="od-status"><span class="tag pending">Pending</span> ${edits.length} change${edits.length === 1 ? '' : 's'} waiting for the console. They apply the next time the dynasty loads (refresh or resume), before the advance moves players.</p>` : '';
  const body = html`<div class="rec-head tp-head"><h2>Transfer Portal</h2><span class="muted">${stageLabel(dyn)}</span>${commish ? html`<a class="btn sm light" href="#tp-add">Make a player transfer</a>` : ''}</div>
    ${flash}${pendingNote}
    <div class="tp-board">
      ${cell(live.length, 'Transferring', 'hot')}
      ${mine.size ? cell(live.filter((r) => mine.has(r.p.tgid)).length, 'Leaving member teams') : ''}
      ${mine.size ? cell(live.filter((r) => r.dest !== null && mine.has(r.dest)).length, 'Joining member teams') : ''}
      ${hasData ? cell(countOf((f) => f === 26), 'Graduating') : ''}
      ${hasData ? cell(countOf((f) => (f >= 1 && f <= 7) || (f >= 19 && f <= 25)), 'Entering the draft') : ''}
      ${commish && edits.length ? cell(edits.length, 'Pending changes', 'pending') : ''}
    </div>
    ${box(html`Transfers <span class="muted">(${live.length})</span>`, html`${tools}${list}`, 'tp-box')}
    ${commish && rows.length ? html`<template id="tp-teams">${teams.map((t) => teamOption(t, null))}</template>` : ''}
    ${addCard}
    ${commish ? '' : html`<p class="muted">Only the league commissioner can change transfers.</p>`}`;
  return layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, path: url.pathname, title: 'Transfer Portal', siteName: env.SITE_NAME, dyn, section: 'transfers', body, wide: true });
}

// POST /d/<slug>/transfers: action dest | stay | add | undo (commissioner only). Results go back to the player's row.
export async function transferAction(ctx: PageCtx, form: FormData): Promise<Response> {
  const { env, dyn, url, req, member } = ctx;
  const db = env.DB, d = dyn.id, y = dyn.season_year, week = dyn.week ?? 0, base = `/d/${dyn.slug}/transfers`;
  const back = (qs: string, anchor = '') => redirect(`${base}?${qs}${anchor}`);
  const err = (msg: string, extra = '') => back(`err=${enc(msg)}${extra}`);
  if (!isPortalCommissioner(ctx)) return err('Only the league commissioner can change transfers.');
  if (!req || !sameOrigin(req, url)) return err('The form came from another site; try again from this page.');
  if (num(form.get('week')) !== week) return err('The dynasty advanced while you were editing; the portal was reloaded.');
  const action = String(form.get('action') ?? '');
  const pgid = num(form.get('pgid'));
  const p = Number.isInteger(pgid) ? await getPortalPlayer(db, d, pgid) : null;
  if (!p) return err('No such player.');
  const name = playerName(p);
  const atRow = `&at=${pgid}`, rowAnchor = `#p${pgid}`, inPanel = `&edit=${pgid}#p${pgid}`;
  const saved = (text: string) => back(`saved=${enc(text)}${atRow}`, rowAnchor);
  const pending = (await listTransferEdits(db, d, y, week)).find((e) => e.pgid === pgid);
  const teams = await getTeams(db, d);
  const by = member?.blaze_id ?? null;
  const validDest = (v: unknown, from: number) => { const t = num(v); return Number.isInteger(t) && t !== from && teams.some((x) => x.tgid === t) ? t : null; };
  const validReason = (v: unknown) => { const r = num(v); return TRANSFER_FLAGS.includes(r) ? r : 9; };
  const fileDest = p.to_tgid !== null && p.trac === 1 ? p.to_tgid : null;
  const teamName = (g: number | null) => teams.find((t) => t.tgid === g)?.name ?? 'his school';

  // "stay" for one player, shared by the stay action and a swap: a pending added transfer just goes away
  const keepAtSchool = async (pl: PortalPlayer, pend: WebTransferEdit | undefined): Promise<string | null> => {
    if (pend?.action === 'transfer' && !isTransferring(pl)) { await deleteTransferEdit(db, d, pl.pgid, y, week); return null; }
    if (!isTransferring(pl)) return `${playerName(pl)} is not transferring.`;
    await upsertTransferEdit(db, d, { pgid: pl.pgid, from_tgid: pl.tgid, action: 'stay', to_tgid: null, reason: null }, y, week, by);
    return null;
  };

  if (action === 'undo') {
    await deleteTransferEdit(db, d, pgid, y, week);
    return back(`undone=1${atRow}`, rowAnchor);
  }
  if (action === 'stay') {
    const e = await keepAtSchool(p, pending);
    return e ? err(e, inPanel) : saved(`${name} stays at ${teamName(p.tgid)}.`);
  }
  if (action === 'dest') {
    if (!isTransferring(p) && pending?.action !== 'transfer') return err(`${name} is not transferring; use “Make a player transfer”.`, inPanel);
    const to = validDest(form.get('to_tgid'), p.tgid);
    if (to === null) return err('Pick a destination school other than his own.', inPanel);
    const reason = form.get('reason') !== null ? validReason(form.get('reason')) : (pending?.reason ?? (TRANSFER_FLAGS.includes(p.leave_flag ?? -1) ? p.leave_flag! : 9));
    if (isTransferring(p) && to === fileDest && reason === p.leave_flag) { // the imported state: drop the pending change
      await deleteTransferEdit(db, d, pgid, y, week);
      return pending ? saved(`${name} is back in the portal, headed to ${teamName(to)}.`) : back(`nochange=1${atRow}`, rowAnchor);
    }
    await upsertTransferEdit(db, d, { pgid, from_tgid: p.tgid, action: 'transfer', to_tgid: to, reason }, y, week, by);
    return saved(`${name} now transfers to ${teamName(to)}.`);
  }
  if (action === 'add') {
    if (DEPARTING(p.leave_flag) || p.leave_type === 3) return err(`${name} is already leaving (graduating or entering the draft).`, '#tp-add');
    if (isTransferring(p) && pending?.action !== 'stay') return err(`${name} is already transferring; use Edit on his row to change the destination.`, inPanel);
    const to = validDest(form.get('to_tgid'), p.tgid);
    if (to === null) return err('Pick a destination school other than his own.', `&team=${p.tgid}&pick=${pgid}#tp-add`);
    const reason = validReason(form.get('reason'));
    // swap: the replaced player stays at his school
    const swap = num(form.get('swap'));
    let swapped = '';
    if (Number.isInteger(swap) && swap !== pgid) {
      const s = await getPortalPlayer(db, d, swap);
      const sp = (await listTransferEdits(db, d, y, week)).find((e) => e.pgid === swap);
      if (s) { const e = await keepAtSchool(s, sp); if (e) return err(e); swapped = ` ${playerName(s)} stays at ${teamName(s.tgid)}.`; }
    }
    if (isTransferring(p) && to === fileDest && reason === p.leave_flag) await deleteTransferEdit(db, d, pgid, y, week); // undoing an earlier "stay"
    else await upsertTransferEdit(db, d, { pgid, from_tgid: p.tgid, action: 'transfer', to_tgid: to, reason }, y, week, by);
    return saved(`${name} transfers from ${teamName(p.tgid)} to ${teamName(to)}.${swapped}`);
  }
  return err('Unknown action.');
}
