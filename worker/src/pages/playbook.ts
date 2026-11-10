// Playbook page (/d/<slug>/playbook[/<tgid>][?side=off|def]): the book a team runs in game (TEAM.TOPB / TDPB -> the stock
// playbook JSON), or the team's own edited book once its coach has saved edits (web_playbook_edits). The page renders
// the frame — team picker, side tabs, team-coloured header — and hands the editor (public/js/playbook/playbook.js) the
// team, side, stock book id, saved edits and URLs through #pb's data attributes; the editor fetches the books itself.
// Saving goes through POST /d/<slug>/playbook/<tgid>/<side> (index.ts); Supersim composes the saved edits at once.
import type { PageCtx } from '../index.js';
import { html } from '../html.js';
import { layout } from '../layout.js';
import { getTeams, getPlaybookEdit } from '../db/queries.js';
import { teamLogoUrl, teamColors } from './common.js';
import { canEditTeam } from './depth.js';
import { loadIndex, teamBooks } from '../supersim/coach/books.js';

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };

export async function playbookPage(ctx: PageCtx, tgid?: number, sideParam?: string): Promise<Response> {
  const { env, dyn, url, member } = ctx; const db = env.DB, d = dyn.id;
  const side: 'off' | 'def' = sideParam === 'def' ? 'def' : 'off';
  const teams = await getTeams(db, d);
  const want = tgid ?? num(url.searchParams.get('t'));
  const sel = Number.isInteger(want) && teams.some((t) => t.tgid === want) ? want : (member?.tgid && teams.some((t) => t.tgid === member.tgid) ? member.tgid : teams[0]?.tgid);
  const team = teams.find((t) => t.tgid === sel);
  const base = `/d/${dyn.slug}/playbook`;
  const page = (body: ReturnType<typeof html>) => layout({ strip: ctx.strip, member, members: ctx.members, path: url.pathname, title: 'Playbook', siteName: env.SITE_NAME, dyn, section: 'playbook', body, wide: true, css: ['/css/playbook.css'] });
  const picker = html`<form class="inline" method="get" action="${base}"><input type="hidden" name="side" value="${side}"><select name="t" data-nav-param="t" onchange="location.href='${base}?side=${side}&t='+this.value">${teams.map((t) => html`<option value="${t.tgid}" ${t.tgid === sel ? 'selected' : ''}>${t.name}</option>`)}</select></form>`;
  if (!team) return page(html`<h2>Playbook</h2>${picker}<p class="muted">No teams imported yet.</p>`);
  let rawObj: Record<string, unknown> | null = null; try { rawObj = JSON.parse(team.raw_json || 'null'); } catch { /* none */ }
  let stock = { offBook: 0, defBook: 0, offName: '—', defName: '—' }, indexOk = true;
  try { stock = teamBooks(await loadIndex(env.ASSETS, url.origin), rawObj); } catch { indexOk = false; }
  const edit = await getPlaybookEdit(db, d, team.tgid, side);
  const editable = canEditTeam(member, team.tgid);
  const colors = teamColors(team.raw_json);
  const stockId = side === 'off' ? stock.offBook : stock.defBook, stockName = side === 'off' ? stock.offName : stock.defName;
  const tabs = html`<nav class="pb-side" aria-label="Side"><a href="${base}?t=${team.tgid}&side=off" class="${side === 'off' ? 'on' : ''}">Offense · ${stock.offName}</a><a href="${base}?t=${team.tgid}&side=def" class="${side === 'def' ? 'on' : ''}">Defense · ${stock.defName}</a></nav>`;
  const head = html`<div class="pb-head" style="--team:${colors.primary};--team-2:${colors.secondary};--on-team:${colors.onPrimary}"><img class="lc-hlogo" src="${teamLogoUrl(team, 'lg')}" alt="" width="48" height="48"><div class="lc-htext"><span class="lc-hk">Playbook${edit ? html` <span class="tag pending">CUSTOM</span>` : ''}</span><span class="lc-hname">${team.name}</span></div>${tabs}</div>`;
  const delivery = edit ? (edit.delivered_at ? html` <span class="muted">This book is on the league host's console (written ${edit.delivered_at.slice(0, 10)}); members get it with the next FCS-online release.</span>` : html` <span class="muted">Saved ${edit.updated_at.slice(0, 10)}; not on the console yet.</span>`) : '';
  const note = editable
    ? html`<p class="pb-note">Shape the book the way you want it: add formations from any stock book, pick the sets and plays and their order${side === 'off' ? html`, and <b>draw your own plays</b> (routes, run tracks, blocks, play action, screens, RPO, read option) from any set` : ''}. <b>Save</b> puts it to work in Supersim at once; the console gets it with the next FCS-online release, which every member installs before a game that uses it.${side === 'def' ? html` Defensive books reach Supersim now; drawing defensive plays and the console side for defense come later.` : ''}${delivery}</p>`
    : html`<p class="pb-note">The playbook ${team.name} runs in game. Sign in as this team's coach (or the commissioner) to edit it.${delivery}</p>`;
  const body = html`<h2>Playbook</h2>${picker}
    <section class="box pb-box">${head}${note}
      ${indexOk ? html`<div id="pb" data-slug="${dyn.slug}" data-team="${team.tgid}" data-team-name="${team.name}" data-side="${side}" data-stock="${stockId}" data-stock-name="${stockName}" data-index="/data/playbooks/index.json" data-books="/data/playbooks/" data-book-url="${base}/${team.tgid}/${side}.json" data-save-url="${base}/${team.tgid}/${side}" data-editable="${editable ? '1' : '0'}" data-edits="${edit ? edit.edits_json : ''}" data-updated="${edit ? edit.updated_at : ''}"><noscript><p class="pb-note">The playbook editor needs JavaScript.</p></noscript></div><script type="module" src="/js/playbook/playbook.js"></script>` : html`<p class="pb-note">The playbook data is not available on this site yet (worker/public/data/playbooks).</p>`}
    </section>`;
  return page(body);
}
