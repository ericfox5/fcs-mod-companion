// /d/<slug>/members: every online member (persona, team, commissioner) with its account, if any. A signed-in commissioner
// issues invite codes here for members without an account and can revoke open ones; the first invite of a dynasty comes
// from the bridge (`ncaa-bridge od invite`) because nobody is signed in yet.
import type { PageCtx } from '../index.js';
import { html, type Raw } from '../html.js';
import { box } from '../layout.js';
import { getTeams, teamMap, listAccounts, listOpenInvites, insertInvite, deleteOpenInvite, getAccountForMember } from '../db/queries.js';
import { redirect, sameOrigin, normalizeCode, joinUrl, newInviteCode } from '../session.js';
import { authPage } from './login.js';
import { teamLogo, teamLink } from './common.js';

const enc = encodeURIComponent;
const isCommissioner = (ctx: PageCtx) => !!ctx.account && ctx.member?.commissioner === 1;

export async function membersPage(ctx: PageCtx): Promise<Response> {
  const { env, dyn, url, member, members = [], account, locked } = ctx;
  const db = env.DB, q = url.searchParams, base = `/d/${dyn.slug}`;
  const commish = isCommissioner(ctx);
  const [accounts, teams, invites] = await Promise.all([listAccounts(db, dyn.id), getTeams(db, dyn.id), commish ? listOpenInvites(db, dyn.id) : Promise.resolve([])]);
  const tm = teamMap(teams);
  const acctOf = new Map(accounts.map((a) => [a.blaze_id, a]));
  const personaOf = new Map(members.map((m) => [m.blaze_id, m.persona]));
  const flash = q.get('joined') ? html`<p class="flash">Welcome! Your account is set up and you are signed in.</p>`
    : q.get('invited') ? html`<p class="flash">Invite created. Send the join link below privately; whoever opens it creates the account for that persona.</p>`
    : q.get('revoked') ? html`<p class="flash">Invite revoked.</p>`
    : q.get('err') ? html`<p class="flash err">${q.get('err')}</p>` : html``;
  const whoami = account
    ? html`<div class="muted whoami">Signed in as <b>${account.username}</b>${member ? html` (${member.persona})` : ''}. <form class="inline" method="post" action="${base}/logout"><input type="hidden" name="back" value="${base}/members"><button class="btn light sm">Sign out</button></form></div>`
    : html`<p class="muted">${locked ? html`Members with an account can <a href="${base}/login?back=${enc(`${base}/members`)}">sign in</a>; an invite link from the commissioner creates one.` : html`No accounts yet. The site can be edited by picking a persona in the top bar until the first account exists; the commissioner creates it from an invite issued on the league server (<code>ncaa-bridge od invite --did ${dyn.od_id ?? 'N'} --persona NAME</code>).`}</p>`;

  const rows = members.map((m) => {
    const t = tm.get(m.tgid), a = acctOf.get(m.blaze_id), open = invites.filter((i) => i.blaze_id === m.blaze_id).length;
    return html`<tr class="${member?.blaze_id === m.blaze_id ? 'user-team' : ''}">
      <td><b>${m.persona}</b>${m.commissioner === 1 ? html` <span class="tag">Commissioner</span>` : ''}</td>
      <td>${teamLogo(t, 'xs')}${teamLink(dyn.slug, t, m.tgid === 1023 || !m.tgid ? 'no team' : String(m.tgid))}</td>
      <td class="acct">${a ? html`account: <b>${a.username}</b>` : html`<span class="muted">no account yet</span>`}</td>
      ${commish ? html`<td class="ctl">${a ? '' : open ? html`<span class="muted">${open} open invite${open > 1 ? 's' : ''}</span>` : html`<form class="inline" method="post" action="${base}/members/invite"><input type="hidden" name="blaze_id" value="${m.blaze_id}"><button class="btn sm">Create invite</button></form>`}</td>` : ''}
    </tr>`;
  });
  const table = html`<table class="list members"><thead><tr><th>Member</th><th>Team</th><th>Account</th>${commish ? html`<th></th>` : ''}</tr></thead><tbody>${rows.length ? rows : html`<tr><td colspan="4" class="muted">No online members registered yet.</td></tr>`}</tbody></table>`;

  const inviteRows = invites.map((i) => html`<tr>
    <td><b>${personaOf.get(i.blaze_id) ?? i.blaze_id}</b></td>
    <td><code>${i.code}</code></td>
    <td class="acct"><input class="join-link" type="text" readonly value="${joinUrl(url.origin, dyn.slug, i.code)}" onfocus="this.select()"></td>
    <td class="muted">${i.note ?? ''}<br>${i.created_at} UTC</td>
    <td class="ctl"><form class="inline" method="post" action="${base}/members/invite/${enc(i.code)}/revoke"><button class="btn danger sm">Revoke</button></form></td>
  </tr>`);
  const invitesBox: Raw = commish
    ? box(html`Open invites <span class="muted">(${invites.length})</span>`, html`${invites.length ? html`<table class="list"><thead><tr><th>For</th><th>Code</th><th>Join link</th><th>Issued</th><th></th></tr></thead><tbody>${inviteRows}</tbody></table>` : html`<p class="muted">None open. Use "Create invite" next to a member without an account.</p>`}
      <p class="muted">A join link creates the account for that persona and signs the browser in. Anyone holding the link can use it once, so send it privately. The console still decides who is in the league; the site only mirrors its member list.</p>`)
    : html``;

  const body = html`<h2>Members</h2>${flash}${whoami}${box('League members', table)}${invitesBox}`;
  return authPage(ctx, 'Members', body);
}

const deny = (ctx: PageCtx, msg = 'Only a signed-in commissioner can manage invites.') => redirect(`/d/${ctx.dyn.slug}/members?err=${enc(msg)}`);

// POST /d/<slug>/members/invite  (blaze_id): a new invite for a member without an account.
export async function inviteAction(ctx: PageCtx, form: FormData): Promise<Response> {
  const { env, dyn, url, req, members = [], account } = ctx;
  if (!isCommissioner(ctx) || !account) return deny(ctx);
  if (!req || !sameOrigin(req, url)) return deny(ctx, 'The form came from another site; try again from this page.');
  const blazeId = Number(form.get('blaze_id'));
  const m = members.find((x) => x.blaze_id === blazeId);
  if (!m) return deny(ctx, 'No such member.');
  if (await getAccountForMember(env.DB, dyn.id, blazeId)) return deny(ctx, `${m.persona} already has an account.`);
  const note = String(form.get('note') ?? '').trim().slice(0, 120) || `invited by ${account.username}`;
  await insertInvite(env.DB, newInviteCode(), dyn.id, blazeId, account.id, note);
  return redirect(`/d/${dyn.slug}/members?invited=1`);
}

// POST /d/<slug>/members/invite/<code>/revoke
export async function revokeInviteAction(ctx: PageCtx, rawCode: string): Promise<Response> {
  const { env, dyn, url, req } = ctx;
  if (!isCommissioner(ctx)) return deny(ctx);
  if (!req || !sameOrigin(req, url)) return deny(ctx, 'The form came from another site; try again from this page.');
  const ok = await deleteOpenInvite(env.DB, dyn.id, normalizeCode(decodeURIComponent(rawCode)));
  return redirect(`/d/${dyn.slug}/members?${ok ? 'revoked=1' : `err=${enc('That invite is gone already.')}`}`);
}
