// Individual player edits (jersey, position, redshirt, name) for a member's own team. Each save is a pending row per
// player and week; the bridge folds pending rows into the console's PLYZ roster push for the next advance and acks them
// once the dynasty has left that week. Only the jersey number is confirmed to land in-game; the rest ride the same
// columns and are labelled experimental in the form.
import type { PageCtx } from '../index.js';
import { html, type Raw } from '../html.js';
import { box } from '../layout.js';
import { getPlayer, deletePlayerEdit, upsertPlayerEdit, type PlayerRow, type MemberRow, type WebPlayerEdit, type PlayerEditValues } from '../db/queries.js';
import { redirect } from '../session.js';
import { weekLabel, pos } from './common.js';
import { POSITIONS } from '@ncaa/ncaa14';

export const FIRST_MAX = 11, LAST_MAX = 13; // PFNA / PLNA string widths in the game's player table
const EDITABLE_POS = POSITIONS.slice(0, 21); // QB .. P; KR/PR/KO/LS are depth-chart slots, not roster positions
const REDSHIRT: [number, string][] = [[0, 'No redshirt'], [1, 'Redshirting this season'], [2, 'Redshirt used']];
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const enc = encodeURIComponent;

export const canEditPlayer = (member: MemberRow | null | undefined, p: { tgid: number }) => !!member && (member.commissioner === 1 || member.tgid === p.tgid);

// What the member wants the player to look like: the pending edit when there is one, else the console's values.
export const desiredPlayer = (p: PlayerRow, e: WebPlayerEdit | null | undefined): PlayerEditValues => ({
  jersey: e?.jersey ?? p.jersey, pos: e?.pos ?? p.pos, redshirt: e?.redshirt ?? p.redshirt, first_name: e?.first_name ?? p.first_name, last_name: e?.last_name ?? p.last_name,
});

// Short summary of what changes ("#66 -> #12, HB -> WR") for the pending note and the bridge log.
export function describeChanges(p: PlayerRow, v: PlayerEditValues): string[] {
  const out: string[] = [];
  if (v.jersey !== null && v.jersey !== p.jersey) out.push(`#${p.jersey} -> #${v.jersey}`);
  if (v.pos !== null && v.pos !== p.pos) out.push(`${pos(p.pos)} -> ${pos(v.pos)}`);
  if (v.redshirt !== null && v.redshirt !== p.redshirt) out.push(`redshirt ${REDSHIRT[p.redshirt]?.[1] ?? p.redshirt} -> ${REDSHIRT[v.redshirt]?.[1] ?? v.redshirt}`);
  const first = v.first_name ?? p.first_name, last = v.last_name ?? p.last_name;
  if (first !== p.first_name || last !== p.last_name) out.push(`${p.first_name} ${p.last_name} -> ${first} ${last}`);
  return out;
}

// The "Edit player" card on the player page (only rendered for a member who may edit this player).
export function playerEditCard(ctx: PageCtx, p: PlayerRow, pending: WebPlayerEdit | null | undefined): Raw {
  const { dyn, url } = ctx;
  const week = dyn.week ?? 0;
  const v = desiredPlayer(p, pending);
  const q = url.searchParams;
  const flash = q.get('saved') ? html`<p class="flash">Saved. The console applies it the next time the dynasty loads (refresh or resume).</p>`
    : q.get('reset') ? html`<p class="flash">Pending edit discarded.</p>`
    : q.get('nochange') ? html`<p class="flash">Nothing to change: those are the player's current values.</p>`
    : q.get('err') ? html`<p class="flash err">${q.get('err')}</p>` : html``;
  const exp = html``; // position, redshirt and name changes were confirmed in-game on 2026-10-29
  return box(html`Edit player${pending ? html` <span class="tag pending">PENDING</span>` : ''}`, html`${flash}
    ${pending ? html`<p class="pe-note"><span class="tag pending">PENDING</span> ${describeChanges(p, v).join(', ') || 'no visible change'} · applied when the dynasty next loads on the console</p>` : ''}
    <form class="wform" method="post" action="/d/${dyn.slug}/player/${p.pgid}/edit"><input type="hidden" name="week" value="${week}">
      <div class="fields">
        <div><label for="pe-jersey">Jersey</label><input id="pe-jersey" type="number" name="jersey" min="0" max="99" step="1" required value="${v.jersey}"></div>
        <div><label for="pe-pos">Position ${exp}</label><select id="pe-pos" name="pos">${EDITABLE_POS.map((name, i) => html`<option value="${i}" ${i === v.pos ? 'selected' : ''}>${name}</option>`)}</select></div>
        <div><label for="pe-rs">Redshirt ${exp}</label><select id="pe-rs" name="redshirt">${REDSHIRT.map(([code, label]) => html`<option value="${code}" ${code === v.redshirt ? 'selected' : ''}>${label}</option>`)}</select></div>
        <div><label for="pe-fn">First name ${exp}</label><input id="pe-fn" type="text" name="first_name" maxlength="${FIRST_MAX}" required value="${v.first_name}"></div>
        <div><label for="pe-ln">Last name ${exp}</label><input id="pe-ln" type="text" name="last_name" maxlength="${LAST_MAX}" required value="${v.last_name}"></div>
      </div>
      <div class="actions"><button class="btn" name="action" value="save">Save</button>${pending ? html`<button class="btn light" name="action" value="reset">Discard pending edit</button>` : ''}<span class="muted">Jersey changes are confirmed in-game; position, redshirt and names use the same channel but are unproven.</span></div>
    </form>`);
}

// POST /d/<slug>/player/<pgid>/edit: save | reset, for the member's own team (a commissioner may edit any team).
export async function playerEditAction(ctx: PageCtx, pgid: number, form: FormData): Promise<Response> {
  const { env, dyn, member } = ctx;
  const db = env.DB, d = dyn.id, y = dyn.season_year, week = dyn.week ?? 0;
  const back = (q: string) => redirect(`/d/${dyn.slug}/player/${pgid}?${q}`);
  const p = Number.isInteger(pgid) ? await getPlayer(db, d, pgid) : null;
  if (!p) return back(`err=${enc('No such player.')}`);
  if (!canEditPlayer(member, p)) return back(`err=${enc('You can only edit players on your own team.')}`);
  if (num(form.get('week')) !== week) return back(`err=${enc('The dynasty advanced while you were editing; the page was reloaded.')}`);
  if (String(form.get('action') ?? 'save') === 'reset') { await deletePlayerEdit(db, d, pgid, y, week); return back('reset=1'); }
  const jersey = num(form.get('jersey'));
  if (!Number.isInteger(jersey) || jersey < 0 || jersey > 99) return back(`err=${enc('Jersey must be a whole number from 0 to 99.')}`);
  const position = num(form.get('pos'));
  if (!Number.isInteger(position) || position < 0 || position >= EDITABLE_POS.length) return back(`err=${enc('Pick a position from the list.')}`);
  const redshirt = num(form.get('redshirt'));
  if (![0, 1, 2].includes(redshirt)) return back(`err=${enc('Pick a redshirt status from the list.')}`);
  const first = String(form.get('first_name') ?? '').trim().slice(0, FIRST_MAX);
  const last = String(form.get('last_name') ?? '').trim().slice(0, LAST_MAX);
  if (!first || !last) return back(`err=${enc('First and last name are required.')}`);
  if (!/^[\x20-\x7e]+$/.test(first + last)) return back(`err=${enc('Names must use plain letters, digits, spaces, apostrophes and hyphens (no accents).')}`);
  const v: PlayerEditValues = { jersey, pos: position, redshirt, first_name: first, last_name: last };
  const changes = describeChanges(p, v);
  if (!changes.length) { await deletePlayerEdit(db, d, pgid, y, week); return back('nochange=1'); }
  await upsertPlayerEdit(db, d, p.tgid, pgid, y, week, v, member?.blaze_id ?? null, changes.join(', '));
  return back('saved=1');
}
