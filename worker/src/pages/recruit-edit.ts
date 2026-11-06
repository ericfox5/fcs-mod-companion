// /d/<slug>/recruit/<prsi>: a prospect's card with the recruit editor (name, position, height, weight, stars) for the
// commissioner (any prospect) or the coach of the team he has committed to. A save is one pending row per prospect and
// season (migration 0019); the bridge writes it into the copy of the dynasty file the console downloads at its next load
// and acks it once a console file carries the values. Also the commissioner's "re-generate the class" request: the
// bridge runs Fang's Recruit Overhaul on the console's current file (preseason only) and reports back.
import type { PageCtx } from '../index.js';
import { html, notFound, type Raw } from '../html.js';
import { layout, box } from '../layout.js';
import { getRecruit, getTeams, teamMap, getPendingRecruitEdit, upsertRecruitEdit, deleteRecruitEdit, insertOverhaulRequest, getLatestOverhaulRequest, type RecruitRow, type MemberRow, type WebRecruitEdit, type RecruitEditValues, type OverhaulRequest } from '../db/queries.js';
import { redirect } from '../session.js';
import { headshot, heightFt, pos, teamLink, teamLogo, interestStack, weekLabel } from './common.js';
import { POSITIONS } from '@ncaa/ncaa14';
import { FIRST_MAX, LAST_MAX } from './player-edit.js';
import { FACE_LABELS, FACE_GROUPS, faceGroup } from './faces.js';

const EDITABLE_POS = POSITIONS.slice(0, 21); // QB .. P
const MIN_HT = 60, MAX_HT = 84; // inches (the game's field is 7 bits)
const MIN_WT = 160, MAX_WT = 400; // pounds: the game stores PWGT = lb - 160 in 8 bits
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const enc = encodeURIComponent;
const stars = (n: number) => '*'.repeat(Math.max(0, Math.min(5, n)));

export const isCommissioner = (member: MemberRow | null | undefined) => !!member && member.commissioner === 1;
// the commissioner edits any prospect; a coach edits the ones committed to his team; web-only members have no console
export const canEditRecruit = (member: MemberRow | null | undefined, r: RecruitRow) => !!member && member.web_only !== 1 && (isCommissioner(member) || (!!r.committed && r.committed_tgid === member.tgid));

// What the member wants the prospect to look like: the pending edit when there is one, else the console's values.
export const desiredRecruit = (r: RecruitRow, e: WebRecruitEdit | null | undefined): RecruitEditValues => ({
  first_name: e?.first_name ?? r.first_name, last_name: e?.last_name ?? r.last_name, pos: e?.pos ?? r.pos, height: e?.height ?? r.height, weight: e?.weight ?? r.weight, stars: e?.stars ?? r.stars, head_id: e?.head_id ?? r.head_id ?? 0,
});
const faceName = (id: number) => `${id}${FACE_LABELS.has(id) ? ` (${FACE_LABELS.get(id)})` : ''}`;
export function describeRecruitChanges(r: RecruitRow, v: RecruitEditValues): string[] {
  const out: string[] = [];
  if (v.first_name !== r.first_name || v.last_name !== r.last_name) out.push(`${r.first_name} ${r.last_name} -> ${v.first_name} ${v.last_name}`);
  if (v.pos !== r.pos) out.push(`${pos(r.pos)} -> ${pos(v.pos)}`);
  if (v.height !== r.height) out.push(`${heightFt(r.height)} -> ${heightFt(v.height)}`);
  if (v.weight !== r.weight) out.push(`${r.weight} -> ${v.weight} lb`);
  if (v.stars !== r.stars) out.push(`${r.stars} -> ${v.stars} stars`);
  if (v.head_id !== (r.head_id ?? 0)) out.push(`face ${faceName(r.head_id ?? 0)} -> ${faceName(v.head_id)}`);
  return out;
}
// the face picker: every head id the game has, grouped by the config's skin-tone labels, with the art shown beside it
function facePicker(current: number): Raw {
  const groups = new Map<string, number[]>(); for (const g of [...FACE_GROUPS, 'Other']) groups.set(g, []);
  for (const [id, label] of FACE_LABELS) groups.get(faceGroup(label))!.push(id);
  return html`<select id="re-face" name="head_id" data-face-for="re-face-img">${[...groups].filter(([, ids]) => ids.length).map(([g, ids]) => html`<optgroup label="${g}">${ids.map((id) => html`<option value="${id}" ${id === current ? 'selected' : ''}>${faceName(id)}</option>`)}</optgroup>`)}</select>`;
}

function editCard(ctx: PageCtx, r: RecruitRow, pending: WebRecruitEdit | null | undefined): Raw {
  const { dyn, url } = ctx; const q = url.searchParams; const v = desiredRecruit(r, pending);
  const flash = q.get('saved') ? html`<p class="flash">Saved. The console applies it the next time the dynasty loads (leave the dynasty and re-enter it).</p>`
    : q.get('reset') ? html`<p class="flash">Pending edit discarded.</p>`
    : q.get('nochange') ? html`<p class="flash">Nothing to change: those are the prospect's current values.</p>`
    : q.get('err') ? html`<p class="flash err">${q.get('err')}</p>` : html``;
  const heights: number[] = []; for (let h = MIN_HT; h <= MAX_HT; h++) heights.push(h);
  return box(html`Edit prospect${pending ? html` <span class="tag pending">PENDING</span>` : ''}`, html`${flash}
    ${pending ? html`<p class="pe-note"><span class="tag pending">PENDING</span> ${describeRecruitChanges(r, v).join(', ') || 'no visible change'} · applied when the dynasty next loads on the console</p>` : ''}
    <form class="wform" method="post" action="/d/${dyn.slug}/recruit/${r.prsi}/edit"><input type="hidden" name="year" value="${dyn.season_year}">
      <div class="fields">
        <div><label for="re-fn">First name</label><input id="re-fn" type="text" name="first_name" maxlength="${FIRST_MAX}" required value="${v.first_name}"></div>
        <div><label for="re-ln">Last name</label><input id="re-ln" type="text" name="last_name" maxlength="${LAST_MAX}" required value="${v.last_name}"></div>
        <div><label for="re-pos">Position</label><select id="re-pos" name="pos">${EDITABLE_POS.map((name, i) => html`<option value="${i}" ${i === v.pos ? 'selected' : ''}>${name}</option>`)}</select></div>
        <div><label for="re-ht">Height</label><select id="re-ht" name="height">${heights.map((h) => html`<option value="${h}" ${h === v.height ? 'selected' : ''}>${heightFt(h)}</option>`)}</select></div>
        <div><label for="re-wt">Weight (lb)</label><input id="re-wt" type="number" name="weight" min="${MIN_WT}" max="${MAX_WT}" step="1" required value="${v.weight}"></div>
        <div><label for="re-st">Stars</label><select id="re-st" name="stars">${[5, 4, 3, 2, 1].map((s) => html`<option value="${s}" ${s === v.stars ? 'selected' : ''}>${s} ${stars(s)}</option>`)}</select></div>
        <div class="wide re-facerow"><div><label for="re-face">Face (head art)</label>${facePicker(v.head_id)}</div><img id="re-face-img" class="headshot lg re-face" src="/img/faces/${v.head_id}.png" alt="" width="80" height="96"></div>
      </div>
      <div class="actions"><button class="btn" name="action" value="save">Save</button>${pending ? html`<button class="btn light" name="action" value="reset">Discard pending edit</button>` : ''}<span class="muted">Names up to ${FIRST_MAX} and ${LAST_MAX} letters; faces are the game's 246 heads (skin-tone groups from the EA DB Editor config). Ratings and rank stay the game's; the console applies the edit at its next dynasty load.</span></div>
    </form>`);
}

// GET /d/<slug>/recruit/<prsi>
export async function recruitPage(ctx: PageCtx, prsi: number): Promise<Response> {
  const { env, dyn, url, member, members } = ctx; const db = env.DB, d = dyn.id;
  const r = Number.isInteger(prsi) ? await getRecruit(db, d, prsi) : null;
  if (!r) return notFound('No such prospect');
  const tm = teamMap(await getTeams(db, d));
  const pending = await getPendingRecruitEdit(db, d, r.prsi, dyn.season_year);
  const v = desiredRecruit(r, pending);
  const committed = r.committed ? tm.get(r.committed_tgid ?? -1) : undefined;
  const head = html`<div class="rec-head"><h2>Prospect</h2><a class="btn light" href="/d/${dyn.slug}/recruiting">Back to recruiting</a></div>`;
  const card = box(html`${v.first_name} ${v.last_name}${pending ? html` <span class="tag pending">PENDING</span>` : ''}`, html`<div class="pr-card">
      ${headshot({ ...r, head_id: v.head_id }, 'lg')}
      <div class="pr-bio">
        <div class="pr-line"><b>${pos(v.pos)}</b> · <span class="stars">${stars(v.stars)}</span> · #${r.rank} nationally</div>
        <div class="pr-line">${heightFt(v.height)} · ${v.weight} lb · scouted OVR <b>${r.pre_scout_overall}</b></div>
        <div class="pr-line">${committed ? html`${teamLogo(committed, 'xs')} Committed to ${teamLink(dyn.slug, committed)}` : html`Interest: ${interestStack(tm, r.teams_json, 5)}`}</div>
        ${pending ? html`<div class="pr-line muted">Shown with the pending edit; the console still has ${r.first_name} ${r.last_name}, ${pos(r.pos)}, ${heightFt(r.height)}, ${r.weight} lb, ${r.stars} stars.</div>` : ''}
      </div></div>`);
  const edit = canEditRecruit(member, r) ? editCard(ctx, r, pending) : member ? html`<p class="muted">${isCommissioner(member) ? '' : 'The commissioner, or the coach of the team a prospect has committed to, can edit him.'}</p>` : html``;
  const body = html`${head}${card}${edit}`;
  return layout({ strip: ctx.strip, member, members, path: url.pathname + url.search, title: `${v.first_name} ${v.last_name}`, siteName: env.SITE_NAME, dyn, section: 'recruiting', body });
}

// POST /d/<slug>/recruit/<prsi>/edit: save | reset
export async function recruitEditAction(ctx: PageCtx, prsi: number, form: FormData): Promise<Response> {
  const { env, dyn, member } = ctx; const db = env.DB, d = dyn.id, y = dyn.season_year, week = dyn.week ?? 0;
  const back = (q: string) => redirect(`/d/${dyn.slug}/recruit/${prsi}?${q}`);
  const r = Number.isInteger(prsi) ? await getRecruit(db, d, prsi) : null;
  if (!r) return back(`err=${enc('No such prospect.')}`);
  if (!canEditRecruit(member, r)) return back(`err=${enc('Only the commissioner, or the coach of the team he committed to, can edit a prospect.')}`);
  if (num(form.get('year')) !== y) return back(`err=${enc('The dynasty moved to a new season while you were editing; the page was reloaded.')}`);
  if (String(form.get('action') ?? 'save') === 'reset') { await deleteRecruitEdit(db, d, prsi, y); return back('reset=1'); }
  const first = String(form.get('first_name') ?? '').trim().slice(0, FIRST_MAX), last = String(form.get('last_name') ?? '').trim().slice(0, LAST_MAX);
  if (!first || !last) return back(`err=${enc('First and last name are required.')}`);
  if (!/^[\x20-\x7e]+$/.test(first + last)) return back(`err=${enc('Names must use plain letters, digits, spaces, apostrophes and hyphens (no accents).')}`);
  const position = num(form.get('pos')); if (!Number.isInteger(position) || position < 0 || position >= EDITABLE_POS.length) return back(`err=${enc('Pick a position from the list.')}`);
  const height = num(form.get('height')); if (!Number.isInteger(height) || height < MIN_HT || height > MAX_HT) return back(`err=${enc(`Height must be between ${heightFt(MIN_HT)} and ${heightFt(MAX_HT)}.`)}`);
  const weight = num(form.get('weight')); if (!Number.isInteger(weight) || weight < MIN_WT || weight > MAX_WT) return back(`err=${enc(`Weight must be a whole number from ${MIN_WT} to ${MAX_WT} lb.`)}`);
  const st = num(form.get('stars')); if (!Number.isInteger(st) || st < 1 || st > 5) return back(`err=${enc('Stars must be 1 to 5.')}`);
  const face = num(form.get('head_id')); if (!Number.isInteger(face) || !FACE_LABELS.has(face)) return back(`err=${enc('Pick a face from the list.')}`);
  const v: RecruitEditValues = { first_name: first, last_name: last, pos: position, height, weight, stars: st, head_id: face };
  const changes = describeRecruitChanges(r, v);
  if (!changes.length) { await deleteRecruitEdit(db, d, prsi, y); return back('nochange=1'); }
  await upsertRecruitEdit(db, d, prsi, y, week, v, member?.blaze_id ?? null, changes.join(', '));
  return back('saved=1');
}

// The commissioner's "re-generate the class" box on the recruiting page (preseason only).
export function classBox(ctx: PageCtx, latest: OverhaulRequest | null | undefined): Raw {
  const { dyn, url } = ctx; const week = dyn.week ?? 0; const preseason = week === 0;
  const q = url.searchParams;
  const flash = q.get('regen') ? html`<p class="flash">Queued. The league server runs Fang's Recruit Overhaul within a minute (about 45 seconds of work); the console takes the new class the next time the dynasty loads.</p>` : q.get('regenerr') ? html`<p class="flash err">${q.get('regenerr')}</p>` : html``;
  const status = !latest ? html`` : latest.status === 'pending' ? html`<p class="pe-note"><span class="tag pending">RUNNING</span> requested ${latest.created_at} UTC · the league server is on it; <a href="${url.pathname}">refresh</a> in a minute.</p>`
    : latest.status === 'done' ? html`<p class="pe-note"><span class="tag commit">DONE</span> ${latest.message ?? ''} (${latest.done_at ?? ''} UTC)</p>` : html`<p class="pe-note"><span class="tag gone">FAILED</span> ${latest.message ?? ''} (${latest.done_at ?? ''} UTC)</p>`;
  const busy = latest?.status === 'pending';
  return box('Recruiting class', html`${flash}${status}
    <form class="wform" method="post" action="/d/${dyn.slug}/recruiting/overhaul"><input type="hidden" name="week" value="${week}">
      <div class="actions"><button class="btn" name="action" value="regen" ${preseason && !busy ? '' : 'disabled'}>Re-generate with Fang's Recruit Overhaul</button>
      <span class="muted">${preseason ? 'Gives every prospect a new realistic name, face and build, re-spreads stars and pitches, and re-rolls interest. Preseason only, before anyone recruits; every console takes the new class at its next dynasty load.' : `Available during the preseason only (the dynasty is at ${weekLabel(week)}).`}</span></div>
    </form>`);
}

// POST /d/<slug>/recruiting/overhaul
export async function overhaulAction(ctx: PageCtx, form: FormData): Promise<Response> {
  const { env, dyn, member } = ctx; const db = env.DB, d = dyn.id, y = dyn.season_year, week = dyn.week ?? 0;
  const back = (q: string) => redirect(`/d/${dyn.slug}/recruiting?${q}`);
  if (!isCommissioner(member)) return back(`regenerr=${enc('Only the commissioner can re-generate the class.')}`);
  if (week !== 0 || num(form.get('week')) !== 0) return back(`regenerr=${enc('The class can only be re-generated during the preseason.')}`);
  const latest = await getLatestOverhaulRequest(db, d, y);
  if (latest?.status === 'pending') return back(`regenerr=${enc('A re-generate request is already running.')}`);
  await insertOverhaulRequest(db, d, y, member?.blaze_id ?? null);
  return back('regen=1');
}
