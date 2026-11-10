// The Playbook page's JSON side (pages/playbook.ts renders the page; its browser code and Supersim's play picker talk to
// these):
//   GET    /d/<slug>/playbook/<tgid>/<off|def>.json  the Book the team runs: its saved edits composed over the stock books
//                                                    (header x-playbook: custom), else its stock book (x-playbook: stock)
//   POST   /d/<slug>/playbook/<tgid>/<off|def>       { edits: BookEdits, note?: string } saves the edits -> { ok, updatedAt };
//                                                    { reset: true } discards them -> { ok }
//   DELETE /d/<slug>/playbook/<tgid>/<off|def>       discards them -> { ok }
// Saving is for the team's coach or a commissioner (canEditTeam), as a same-origin JSON request (Origin header and, for a
// POST, content-type application/json); once the dynasty is locked a signed-in account is required, like Supersim. The
// edits are rebuilt field by field from the body (parseEditsBody), their books must all be of the requested side, and
// validateEdits (@ncaa/ncaa14) checks them against the stock books before they are stored; problems come back as a 400
// { error, problems }. Supersim freezes a team's edits into a game at kickoff (supersim/routes.ts) and the bridge delivers
// pending rows to the console (api/bridge.ts web-edits).
import type { PageCtx } from '../index.js';
import { json } from '../html.js';
import { getTeam, getPlaybookEdit, upsertPlaybookEdit, deletePlaybookEdit, type PlaybookSide } from '../db/queries.js';
import { canEditTeam } from './depth.js';
import { sameOrigin } from '../supersim/access.js';
import { loadIndex, loadBook, loadTeamBook } from '../supersim/coach/books.js';
import type { Book } from '../supersim/coach/types.js';
import { booksNeeded, validateEdits, compileProblems, LIMITS, type BookEdits, type FormationEdit, type SetEdit, type DrawnPlay, type SlotDraw, type PlayRef } from '@ncaa/ncaa14';

export const MAX_EDITS_BODY = 512 * 1024;
const NO_STORE = { 'cache-control': 'private, no-store' };
export const parseSide = (s: string | null | undefined): PlaybookSide | null => (s === 'off' || s === 'def' ? s : null);
export const playbookJsonUrl = (slug: string, tgid: number, side: PlaybookSide) => `/d/${slug}/playbook/${tgid}/${side}.json`;
const sideWord = (s: PlaybookSide) => (s === 'off' ? 'an offense' : 'a defense');

const isInt = (v: unknown): v is number => Number.isInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPath = (v: unknown): v is number[][] => Array.isArray(v) && v.every((pt) => Array.isArray(pt) && pt.length >= 2 && pt.every((n) => typeof n === 'number' && Number.isFinite(n)));
const isCustomKey = (k: unknown): k is string => typeof k === 'string' && /^c\d+$/.test(k);
export type EditsBody = { reset: true } | { reset: false; edits: BookEdits; note: string | null };
// The request body as the edits it carries, rebuilt field by field so what is stored is exactly the BookEdits shape (unknown
// keys dropped); a string names the problem. Semantics (ids that exist, the envelope) are validateEdits' job.
export function parseEditsBody(body: unknown): EditsBody | string {
  if (!isObj(body)) return 'the body must be a JSON object';
  if (body['reset'] === true) return { reset: true };
  const e = body['edits']; if (!isObj(e)) return 'edits missing';
  if (e['v'] !== 1) return 'unknown edits version';
  if (!isInt(e['base'])) return 'edits.base must be a book id';
  if (typeof e['name'] !== 'string') return 'edits.name must be a string';
  if (!Array.isArray(e['formations']) || e['formations'].length > LIMITS.formations) return `edits.formations must be a list of at most ${LIMITS.formations}`;
  const formations: FormationEdit[] = [];
  for (const f of e['formations']) {
    if (!isObj(f) || !isInt(f['id']) || !Array.isArray(f['sets'])) return 'each formation needs an id and a list of sets';
    if (f['from'] !== undefined && !isInt(f['from'])) return `formation ${f['id']}: from must be a book id`;
    const sets: SetEdit[] = [];
    for (const s of f['sets']) {
      if (!isObj(s) || !isInt(s['id']) || !Array.isArray(s['plays'])) return `formation ${f['id']}: each set needs an id and a list of plays`;
      if (!s['plays'].every((p) => isInt(p) || isCustomKey(p))) return `set ${s['id']}: plays must be play ids or custom play keys (c<n>)`;
      sets.push({ id: s['id'], plays: [...(s['plays'] as PlayRef[])] });
    }
    formations.push(isInt(f['from']) ? { id: f['id'], from: f['from'], sets } : { id: f['id'], sets });
  }
  const custom: Record<string, DrawnPlay> = {};
  if (e['custom'] !== undefined) {
    if (!isObj(e['custom'])) return 'edits.custom must be an object';
    const entries = Object.entries(e['custom']); if (entries.length > LIMITS.plays) return `${entries.length} custom plays (limit ${LIMITS.plays})`;
    for (const [cid, d] of entries) {
      if (!isCustomKey(cid)) return `custom play key ${cid} is not c<n>`;
      if (!isObj(d) || typeof d['n'] !== 'string' || d['n'].length > LIMITS.nameChars || !isInt(d['t']) || !isInt(d['set']) || !Array.isArray(d['slots']) || d['slots'].length > 11) return `custom play ${cid} needs a name (up to ${LIMITS.nameChars} characters), a type, its set and up to 11 slots`;
      const slots: SlotDraw[] = [];
      for (const sl of d['slots']) {
        if (!isObj(sl) || typeof sl['k'] !== 'string') return `custom play ${cid}: each slot needs a kind`;
        const o: SlotDraw = { k: sl['k'] };
        if (sl['p'] !== undefined) { if (!isPath(sl['p'])) return `custom play ${cid}: a path is a list of [x, y] yards`; o.p = sl['p'].map((pt) => [...pt]); }
        if (sl['o'] !== undefined) { if (!isObj(sl['o']) || !Object.values(sl['o']).every((n) => typeof n === 'number' && Number.isFinite(n))) return `custom play ${cid}: options must be numbers`; o.o = { ...(sl['o'] as Record<string, number>) }; }
        slots.push(o);
      }
      const play: DrawnPlay = { n: d['n'], t: d['t'], set: d['set'], slots };
      for (const k of ['sit', 'f', 'v', 'h'] as const) if (d[k] !== undefined) { if (!isInt(d[k])) return `custom play ${cid}: ${k} must be an integer`; play[k] = d[k]; }
      if (d['prog'] !== undefined) { if (!isPath(d['prog'])) return `custom play ${cid}: prog is a list of [slot, %]`; play.prog = d['prog'].map((pt) => [...pt]); }
      custom[cid] = play;
    }
  }
  const note = typeof body['note'] === 'string' ? body['note'].trim().slice(0, 200) || null : null;
  return { reset: false, edits: { v: 1, base: e['base'], name: e['name'], formations, custom }, note };
}

// GET .json: the book the team runs, for the Playbook page and Supersim's play picker
export async function playbookBookJson(ctx: PageCtx, tgid: number, side: string): Promise<Response> {
  const s = parseSide(side); if (!s || !Number.isInteger(tgid) || tgid >= 300) return json({ error: 'Not found' }, 404, NO_STORE);
  if (ctx.req && ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405, NO_STORE);
  const team = await getTeam(ctx.env.DB, ctx.dyn.id, tgid); if (!team) return json({ error: 'No such team' }, 404, NO_STORE);
  const tb = await loadTeamBook(ctx.env, ctx.url.origin, ctx.dyn.id, team, s);
  return json(tb.book, 200, { ...NO_STORE, 'x-playbook': tb.custom ? 'custom' : 'stock' });
}

// POST { edits, note? } | { reset: true } and DELETE: save or discard a team's edits of one side
export async function playbookEditAction(ctx: PageCtx, tgid: number, side: string): Promise<Response> {
  const { env, dyn, url, req, member, account, locked } = ctx; const db = env.DB;
  const s = parseSide(side); if (!s || !Number.isInteger(tgid) || tgid >= 300 || !req) return json({ error: 'Not found' }, 404, NO_STORE);
  const isDelete = req.method === 'DELETE';
  if (!isDelete && req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, NO_STORE);
  if (isDelete ? req.headers.get('origin') !== url.origin : !sameOrigin(req)) return json({ error: 'Same-origin JSON request required.' }, 403, NO_STORE);
  if (locked && !account) return json({ error: 'Sign in as a dynasty member to edit a playbook.' }, 401, NO_STORE);
  if (!member) return json({ error: locked ? 'You are not a member of this dynasty.' : 'Pick who you are (top bar) to edit a playbook.' }, 403, NO_STORE);
  if (!canEditTeam(member, tgid)) return json({ error: "You can only change your own team's playbook." }, 403, NO_STORE);
  const team = await getTeam(db, dyn.id, tgid); if (!team) return json({ error: 'No such team' }, 404, NO_STORE);
  const discard = async () => { await deletePlaybookEdit(db, dyn.id, tgid, s); return json({ ok: true }, 200, NO_STORE); };
  if (isDelete) return discard();
  if (Number(req.headers.get('content-length')) > MAX_EDITS_BODY) return json({ error: 'Request too large (512 KB limit).' }, 413, NO_STORE);
  const text = await req.text(); if (text.length > MAX_EDITS_BODY) return json({ error: 'Request too large (512 KB limit).' }, 413, NO_STORE);
  let raw: unknown; try { raw = JSON.parse(text); } catch { return json({ error: 'Bad JSON.' }, 400, NO_STORE); }
  const parsed = parseEditsBody(raw); if (typeof parsed === 'string') return json({ error: parsed }, 400, NO_STORE);
  if (parsed.reset) return discard();
  const { edits, note } = parsed; const needed = booksNeeded(edits);
  const index = await loadIndex(env.ASSETS, url.origin); const ofSide = new Set(index.books.filter((b) => b.side === s).map((b) => b.id));
  const wrongSide = needed.filter((id) => !ofSide.has(id)).map((id) => `book ${id} is not ${sideWord(s)} book`);
  if (wrongSide.length) return json({ error: 'The playbook edits have problems.', problems: wrongSide }, 400, NO_STORE);
  const books = new Map<number, Book>(); await Promise.all(needed.map(async (id) => { try { books.set(id, await loadBook(env.ASSETS, url.origin, id)); } catch { /* validateEdits reports it as not loaded */ } }));
  const problems = validateEdits(edits, books); if (problems.length) return json({ error: 'The playbook edits have problems.', problems }, 400, NO_STORE);
  // drawn plays must compile (the creator checks as it goes; this is the authority): the set is looked up in the formation's source book
  const setOf = (setl: number) => { for (const f of edits.formations) { const src = books.get(f.from ?? edits.base); const set = src?.formations.find((x) => x.id === f.id)?.sets.find((x) => x.id === setl); if (set) return set; } for (const b of books.values()) for (const f of b.formations) for (const x of f.sets) if (x.id === setl) return x; return undefined; };
  const drawn = compileProblems(edits.custom, setOf); if (drawn.length) return json({ error: 'Some drawn plays have problems.', problems: drawn }, 400, NO_STORE);
  await upsertPlaybookEdit(db, dyn.id, tgid, s, edits, member.blaze_id, note);
  const row = await getPlaybookEdit(db, dyn.id, tgid, s);
  return json({ ok: true, updatedAt: row?.updated_at ?? null }, 200, NO_STORE);
}
