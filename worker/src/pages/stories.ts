// News Wire: member-written stories (title, body, optional photo in R2, optional team and game) above the game's own
// generated headlines (MCOV, re-imported on every sync). Authors and commissioners may edit or delete a story.
import type { PageCtx } from '../index.js';
import { html, raw, esc, notFound, type Raw } from '../html.js';
import { layout, box } from '../layout.js';
import { getTeams, getStories, getGames, teamMap, listWebStories, getWebStory, insertWebStory, updateWebStory, setWebStoryImage, deleteWebStory, type WebStory, type WebStoryInput, type TeamRow, type GameRow, type MemberRow } from '../db/queries.js';
import { redirect } from '../session.js';
import { listCaptures, getCapture } from '../db/visits.js';
import { teamLink, teamLogo, weekLabel, gameHref } from './common.js';

const TITLE_MAX = 120, BODY_MAX = 12000, IMAGE_MAX = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const enc = encodeURIComponent;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };

export const canEditStory = (member: MemberRow | null | undefined, s: WebStory) => !!member && (member.commissioner === 1 || member.blaze_id === s.author_blaze_id);
export const storyImageUrl = (s: { image_key: string | null }) => (s.image_key ? `/img/${s.image_key.split('/').map(encodeURIComponent).join('/')}` : null);
// Blank-line separated paragraphs; single newlines inside a paragraph become line breaks. Everything is escaped.
export const paragraphs = (body: string): string[] => body.replace(/\r\n/g, '\n').split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean);
export const storyBody = (body: string): Raw => raw(paragraphs(body).map((p) => `<p>${p.split('\n').map(esc).join('<br>')}</p>`).join(''));

function storyCard(ctx: PageCtx, s: WebStory, tm: Map<number, TeamRow>): Raw {
  const { dyn, member } = ctx;
  const t = s.tgid ? tm.get(s.tgid) : undefined;
  const img = storyImageUrl(s);
  const game = s.game_week !== null && s.game_no !== null ? html` · <a href="${gameHref(dyn.slug, { week: s.game_week, game_no: s.game_no })}">Game ${weekLabel(s.game_week)}</a>` : '';
  const actions = canEditStory(member, s)
    ? html`<div class="story-actions"><a class="btn sm light" href="/d/${dyn.slug}/stories/${s.id}/edit">Edit</a><form method="post" action="/d/${dyn.slug}/stories/${s.id}/delete" onsubmit="return confirm('Delete this story?')"><button class="btn sm danger">Delete</button></form></div>`
    : '';
  return html`<article class="box wire-story" id="story-${s.id}">${img ? html`<img class="story-img" src="${img}" alt="">` : ''}
    <div class="wire-text"><h2>${s.title}</h2>
    <p class="byline">By <strong>${s.author_persona}</strong> · ${weekLabel(s.week)}${t ? html` · ${teamLogo(t, 'xs')} ${teamLink(dyn.slug, t)}` : ''}${game}${s.updated_at ? html` · <span class="muted">edited</span>` : ''}</p>
    <div class="story-body">${storyBody(s.body)}</div>${actions}</div></article>`;
}

// /d/<slug>/stories: member stories newest first, then the game's headlines by week.
export async function storiesPage(ctx: PageCtx) {
  const { env, dyn, url, member } = ctx;
  const db = env.DB, d = dyn.id, y = dyn.season_year;
  const tm = teamMap(await getTeams(db, d));
  const week = url.searchParams.get('week');
  const [web, stories] = await Promise.all([listWebStories(db, d), getStories(db, d, y, week !== null ? { week: Number(week) } : { limit: 200 })]);
  const byWeek = new Map<number, typeof stories>();
  for (const s of stories) { if (!byWeek.has(s.week)) byWeek.set(s.week, []); byWeek.get(s.week)!.push(s); }
  const q = url.searchParams;
  const flash = q.get('saved') ? html`<p class="flash">Story published.</p>` : q.get('deleted') ? html`<p class="flash">Story deleted.</p>` : q.get('err') ? html`<p class="flash err">${q.get('err')}</p>` : html``;
  const body = html`<div class="wire-head"><h2>News Wire</h2>${member ? html`<a class="btn" href="/d/${dyn.slug}/stories/new">Write a story</a>` : ''}</div>${flash}
  ${web.length ? web.map((s) => storyCard(ctx, s, tm)) : html`<p class="muted">No member stories yet.${member ? ' Be the first to write one.' : ''}</p>`}
  <h3 class="wire-sub">From the game</h3><p class="muted">Headlines the game generates at each advance.</p>
  ${[...byWeek.entries()].sort((a, b) => b[0] - a[0]).map(([w, list]) => box(weekLabel(w), html`<ul class="headlines">${list.map((s) => html`<li><strong>${s.headline}</strong>${s.tgid ? html` <span class="muted">· ${teamLink(dyn.slug, tm.get(s.tgid))}</span>` : ''}<br>${s.text}</li>`)}</ul>`))}`;
  return layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, path: ctx.url.pathname, title: 'News Wire', siteName: env.SITE_NAME, dyn, section: 'stories', body });
}

// GET /d/<slug>/stories/new and /d/<slug>/stories/<id>/edit: the story form (multipart, with an optional photo).
export async function storyFormPage(ctx: PageCtx, id?: number) {
  const { env, dyn, url, member, members } = ctx;
  const db = env.DB, d = dyn.id, y = dyn.season_year, week = dyn.week ?? 0;
  const page = (title: string, body: Raw) => layout({ strip: ctx.strip, member, members, path: url.pathname, title, siteName: env.SITE_NAME, dyn, section: 'stories', body });
  if (!member) return page('Write a story', html`<h2>Write a story</h2><p class="flash err">${ctx.locked ? 'Sign in from the top bar to write a story.' : 'Pick who you are in the top bar to write a story.'}</p>`);
  const s = id !== undefined ? await getWebStory(db, d, id) : null;
  if (id !== undefined && !s) return notFound('No such story');
  if (s && !canEditStory(member, s)) return redirect(`/d/${dyn.slug}/stories?err=${enc('You can only edit your own stories.')}`);
  const teams = await getTeams(db, d);
  const tm = teamMap(teams);
  const weeks = [...new Set([week, week - 1].filter((w) => w >= 0))];
  const games = (await Promise.all(weeks.map((w) => getGames(db, d, y, { week: w })))).flat();
  const selTeam = s ? s.tgid : member.tgid > 0 ? member.tgid : null;
  const selGame = s && s.game_week !== null && s.game_no !== null ? `${s.game_week}:${s.game_no}` : '';
  const gameLabel = (g: GameRow) => `${weekLabel(g.week)}: ${tm.get(g.away_tgid)?.name ?? '?'} at ${tm.get(g.home_tgid)?.name ?? '?'}${g.status >= 2 ? ` (${g.away_score}-${g.home_score}${g.overtime ? ' OT' : ''})` : ''}`;
  const err = url.searchParams.get('err');
  const action = s ? `/d/${dyn.slug}/stories/${s.id}/edit` : `/d/${dyn.slug}/stories/new`;
  const captures = await listCaptures(db, d, 24);
  const capLabel = (c: { home_tgid: number | null; away_tgid: number | null; home_score: number | null; away_score: number | null; play_text: string | null; week: number | null; taken_at: string | null }) => c.home_tgid && c.away_tgid ? `${tm.get(c.away_tgid)?.abbr ?? '?'} at ${tm.get(c.home_tgid)?.abbr ?? '?'} ${c.away_score ?? ''}-${c.home_score ?? ''}${c.play_text ? ` · ${c.play_text}` : ''}` : (c.taken_at ?? '').slice(0, 16);
  const body = html`<h2>${s ? 'Edit story' : 'Write a story'}</h2>${err ? html`<p class="flash err">${err}</p>` : ''}
  ${box(s ? s.title : 'New story', html`<form class="wform" method="post" action="${action}" enctype="multipart/form-data">
    <div class="fields">
      <div class="wide"><label for="sf-title">Headline</label><input id="sf-title" type="text" name="title" maxlength="${TITLE_MAX}" required value="${s?.title ?? ''}"></div>
      <div class="wide"><label for="sf-body">Story</label><textarea id="sf-body" name="body" maxlength="${BODY_MAX}" required placeholder="Separate paragraphs with a blank line.">${s?.body ?? ''}</textarea></div>
      <div><label for="sf-team">Team</label><select id="sf-team" name="tgid"><option value="">No team</option>${teams.map((t) => html`<option value="${t.tgid}" ${t.tgid === selTeam ? 'selected' : ''}>${t.name}</option>`)}</select></div>
      <div><label for="sf-game">About this game</label><select id="sf-game" name="game"><option value="">None</option>${games.map((g) => html`<option value="${g.week}:${g.game_no}" ${`${g.week}:${g.game_no}` === selGame ? 'selected' : ''}>${gameLabel(g)}</option>`)}</select></div>
      <div class="wide"><label for="sf-img">Photo <span class="exp">(JPEG, PNG or WebP, up to 5 MB)</span></label><input id="sf-img" type="file" name="image" accept="image/jpeg,image/png,image/webp">
        ${s?.image_key ? html`<p class="muted sf-cur"><img class="sf-thumb" src="${storyImageUrl(s)}" alt=""> Current photo. <label class="inline-check"><input type="checkbox" name="remove_image" value="1"> Remove it</label></p>` : ''}</div>
      ${captures.length ? html`<div class="wide"><label>Or use an in-game capture</label><div class="caps"><label class="cap"><input type="radio" name="capture" value="" checked><span class="cap-none">None</span></label>${captures.map((c) => html`<label class="cap" title="${capLabel(c)}"><input type="radio" name="capture" value="${c.id}"><img src="${storyImageUrl(c)}" alt="" loading="lazy" decoding="async"><span class="cap-cap">${capLabel(c)}</span></label>`)}</div></div>` : ''}
    </div>
    <div class="actions"><button class="btn">${s ? 'Save changes' : 'Publish'}</button><a class="btn light" href="/d/${dyn.slug}/stories">Cancel</a></div>
  </form>`)}`;
  return page(s ? 'Edit story' : 'Write a story', body);
}

// POST /d/<slug>/stories/new | /stories/<id>/edit | /stories/<id>/delete. The form is multipart; the photo is a File part.
export async function storyAction(ctx: PageCtx, a: string, b?: string): Promise<Response> {
  const { env, dyn, member, req } = ctx;
  const db = env.DB, d = dyn.id, y = dyn.season_year, week = dyn.week ?? 0;
  const list = `/d/${dyn.slug}/stories`;
  const fail = (to: string, msg: string) => redirect(`${to}?err=${enc(msg)}`);
  if (!member) return fail(list, ctx.locked ? 'Sign in from the top bar to write a story.' : 'Pick who you are in the top bar to write a story.');
  const isNew = a === 'new';
  const id = isNew ? NaN : num(a);
  const existing = !isNew && Number.isInteger(id) ? await getWebStory(db, d, id) : null;
  if (!isNew && !existing) return notFound('No such story');
  if (existing && !canEditStory(member, existing)) return fail(list, 'You can only edit your own stories.');
  if (existing && b === 'delete') {
    if (existing.image_key) await env.SAVES.delete(existing.image_key);
    await deleteWebStory(db, d, existing.id);
    return redirect(`${list}?deleted=1`);
  }
  if (!isNew && b !== 'edit') return notFound();
  const formTo = isNew ? `${list}/new` : `${list}/${existing!.id}/edit`;
  let form: FormData;
  try { form = await req!.formData(); } catch { return fail(formTo, 'Could not read the form (is the photo under 5 MB?).'); }
  const title = String(form.get('title') ?? '').trim().slice(0, TITLE_MAX);
  const text = String(form.get('body') ?? '').replace(/\r\n/g, '\n').trim().slice(0, BODY_MAX);
  if (!title || !text) return fail(formTo, 'A headline and a story are both required.');
  const tgidRaw = String(form.get('tgid') ?? '');
  const tgid = tgidRaw === '' ? null : num(tgidRaw);
  if (tgid !== null && !Number.isInteger(tgid)) return fail(formTo, 'Bad team.');
  let game_week: number | null = null, game_no: number | null = null;
  const game = String(form.get('game') ?? '');
  if (game) { const [w, n] = game.split(':').map(num); if (!Number.isInteger(w) || !Number.isInteger(n)) return fail(formTo, 'Bad game.'); game_week = w!; game_no = n!; }
  const part = form.get('image');
  const file = part !== null && typeof part !== 'string' && part.size > 0 ? part : null; // an empty File part means no photo was chosen
  if (file && !IMAGE_TYPES[file.type]) return fail(formTo, 'Photos must be JPEG, PNG or WebP.');
  if (file && file.size > IMAGE_MAX) return fail(formTo, 'Photos must be 5 MB or smaller.');
  const input: WebStoryInput = { title, body: text, tgid, game_week, game_no };
  const storyId = existing ? existing.id : await insertWebStory(db, d, y, week, member, input);
  if (existing) await updateWebStory(db, d, storyId, input);
  const capId = num(String(form.get('capture') ?? ''));
  const cap = !file && Number.isInteger(capId) && capId > 0 ? await getCapture(db, d, capId) : null;
  if (cap) { // the story gets its own copy of the capture so deleting either never breaks the other
    const obj = await env.SAVES.get(cap.image_key);
    if (obj) {
      const key = `stories/${d}/${storyId}-${Date.now()}.jpg`;
      await env.SAVES.put(key, await obj.arrayBuffer(), { httpMetadata: { contentType: 'image/jpeg' } });
      if (existing?.image_key) await env.SAVES.delete(existing.image_key);
      await setWebStoryImage(db, d, storyId, key);
    }
  } else if (file) {
    const key = `stories/${d}/${storyId}-${Date.now()}.${IMAGE_TYPES[file.type]}`;
    await env.SAVES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
    if (existing?.image_key) await env.SAVES.delete(existing.image_key);
    await setWebStoryImage(db, d, storyId, key);
  } else if (existing?.image_key && form.get('remove_image')) {
    await env.SAVES.delete(existing.image_key);
    await setWebStoryImage(db, d, storyId, null);
  }
  return redirect(`${list}?saved=1#story-${storyId}`);
}
