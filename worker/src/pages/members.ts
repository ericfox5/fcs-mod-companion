// /d/<slug>/members: every online member (persona, team, commissioner) with its account, if any. A signed-in commissioner
// issues invite codes here for members without an account and can revoke open ones; the first invite of a dynasty comes
// from the bridge (`ncaa-bridge od invite`) because nobody is signed in yet. Accounts are site-wide (migration 0023): a
// console persona that already has one is linked to the dynasty by the bridge's member sync, or here when "Create
// invite" finds it, instead of getting an invite. The commissioner also adds web players (migration 0014): members
// without a console who coach their team's games in Supersim here; each gets an invite at once. Any member marks Ready
// for the advance (POST /d/<slug>/ready); the home page shows who is ready.
import type { PageCtx } from '../index.js';
import { html, type Raw } from '../html.js';
import { box } from '../layout.js';
import type { MemberRow, TeamRow } from '../db/queries.js';
import { getTeams, teamMap, listAccounts, listOpenInvites, insertInvite, deleteOpenInvite, getAccountForMember, getAccountForPersona, linkMember, addWebMember, setWebMemberTeam, removeWebMember, setReady } from '../db/queries.js';
import { redirect, sameOrigin, normalizeCode, joinUrl, newInviteCode, safeBack } from '../session.js';
import { authPage } from './login.js';
import { teamLogo, teamLink } from './common.js';

const enc = encodeURIComponent;
const isCommissioner = (ctx: PageCtx) => !!ctx.account && ctx.member?.commissioner === 1;
const hasTeam = (tgid: number) => tgid > 0 && tgid !== 1023;
// Team choices for a web player: every team nobody else controls, grouped by conference.
function teamSelect(name: string, teams: TeamRow[], members: MemberRow[], current: number | null, id?: string): Raw {
  const taken = new Set(members.filter((m) => m.tgid !== current).map((m) => m.tgid));
  const free = teams.filter((t) => !taken.has(t.tgid)).sort((a, b) => (a.conf_label || '~').localeCompare(b.conf_label || '~') || a.name.localeCompare(b.name));
  const groups = new Map<string, TeamRow[]>();
  for (const t of free) { const k = t.conf_label || 'Other'; groups.set(k, [...(groups.get(k) ?? []), t]); }
  return html`<select name="${name}" ${id ? html`id="${id}"` : ''} required>${current === null ? html`<option value="">Pick a team</option>` : ''}${[...groups].map(([conf, list]) => html`<optgroup label="${conf}">${list.map((t) => html`<option value="${t.tgid}" ${t.tgid === current ? 'selected' : ''}>${t.name}</option>`)}</optgroup>`)}</select>`;
}

export async function membersPage(ctx: PageCtx): Promise<Response> {
  const { env, dyn, url, member, members = [], account, locked } = ctx;
  const db = env.DB, q = url.searchParams, base = `/d/${dyn.slug}`;
  const commish = isCommissioner(ctx);
  const [accounts, teams, invites] = await Promise.all([listAccounts(db, dyn.id), getTeams(db, dyn.id), commish ? listOpenInvites(db, dyn.id) : Promise.resolve([])]);
  const tm = teamMap(teams);
  const acctOf = new Map(accounts.map((a) => [a.blaze_id, a]));
  const personaOf = new Map(members.map((m) => [m.blaze_id, m.persona]));
  const flash = q.get('joined') ? html`<p class="flash">Welcome! Your account is set up and you are signed in.</p>`
    : q.get('webadded') ? html`<p class="flash">Web player added. Send them the join link below privately; it creates their account, and they can coach their games in Supersim right away.</p>`
    : q.get('invited') ? html`<p class="flash">Invite created. Send the join link below privately; whoever opens it creates the account for that persona.</p>`
    : q.get('linked') ? html`<p class="flash">${q.get('linked')} already has a site account from another dynasty; it is linked here now, no invite needed.</p>`
    : q.get('revoked') ? html`<p class="flash">Invite revoked.</p>`
    : q.get('moved') ? html`<p class="flash">Team changed.</p>`
    : q.get('removed') ? html`<p class="flash">Web player removed.</p>`
    : q.get('err') ? html`<p class="flash err">${q.get('err')}</p>` : html``;
  const whoami = account
    ? html`<div class="muted whoami">Signed in as <b>${account.username}</b>${member ? html` (${member.persona})` : ''}. <form class="inline" method="post" action="${base}/logout"><input type="hidden" name="back" value="${base}/members"><button class="btn light sm">Sign out</button></form></div>`
    : html`<p class="muted">${locked ? html`Members with an account can <a href="${base}/login?back=${enc(`${base}/members`)}">sign in</a>; an invite link from the commissioner creates one. One account covers every dynasty you are in.` : html`No account linked yet. The site can be edited by picking a persona in the top bar until the first account is linked; a console persona with a site account is linked when the league server syncs the members (or <a href="${base}/login?back=${enc(`${base}/members`)}">sign in</a> here), and a brand-new league's first account comes from an invite issued on the league server (<code>ncaa-bridge od invite --did ${dyn.od_id ?? 'N'} --persona NAME</code>).`}</p>`;

  const rows = members.map((m) => {
    const t = tm.get(m.tgid), a = acctOf.get(m.blaze_id), open = invites.filter((i) => i.blaze_id === m.blaze_id).length;
    const web = m.web_only === 1;
    const clash = web && members.some((o) => o.web_only !== 1 && o.tgid === m.tgid);
    const invite = a ? html`` : open ? html`<span class="muted">${open} open invite${open > 1 ? 's' : ''}</span>` : html`<form class="inline" method="post" action="${base}/members/invite"><input type="hidden" name="blaze_id" value="${m.blaze_id}"><button class="btn sm">Create invite</button></form>`;
    const webCtl = web ? html`<form class="inline wm-team" method="post" action="${base}/members/web/${m.blaze_id}"><input type="hidden" name="action" value="team">${teamSelect('tgid', teams, members, m.tgid)}<button class="btn light sm">Move</button></form>
      <form class="inline" method="post" action="${base}/members/web/${m.blaze_id}"><input type="hidden" name="action" value="remove"><button class="btn danger sm" title="Removes ${m.persona} and their account; past Supersim results stay">Remove</button></form>` : html``;
    return html`<tr class="${member?.blaze_id === m.blaze_id ? 'user-team' : ''}">
      <td><b>${m.persona}</b>${m.commissioner === 1 ? html` <span class="tag">Commissioner</span>` : ''}${web ? html` <span class="tag web" title="Plays on the site only: coaches Supersim games, no console">Web player</span>` : ''}</td>
      <td>${teamLogo(t, 'xs')}${teamLink(dyn.slug, t, !hasTeam(m.tgid) ? 'no team' : String(m.tgid))}${clash ? html`<div class="flash err wm-clash">A console member now controls this team; move ${m.persona} to another one.</div>` : ''}</td>
      <td class="acct">${a ? html`account: <b>${a.username}</b>` : html`<span class="muted">no account yet</span>`}</td>
      ${commish ? html`<td class="ctl">${invite}${webCtl}</td>` : ''}
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
      <p class="muted">A join link creates the account for that persona and signs the browser in, or, if the browser is already signed in to a site account, links that account. Anyone holding the link can use it once, so send it privately. The console still decides who is in the league; the site only mirrors its member list, plus any web players added on this page. A console member whose persona already has a site account needs no invite: the league server's sync links it here by itself.</p>`)
    : html``;
  const webBox: Raw = commish && dyn.od_id !== null
    ? box('Add a web player', html`<form class="wform" method="post" action="${base}/members/web">
        <div class="fields">
          <div><label for="wp-name">Name</label><input id="wp-name" type="text" name="persona" maxlength="24" minlength="2" required placeholder="How the league knows them"></div>
          <div><label for="wp-team">Team</label>${teamSelect('tgid', teams, members, null, 'wp-team')}</div>
        </div>
        <div class="actions"><button class="btn">Add and create invite</button></div>
      </form>
      <p class="muted">For players without RPCS3. They sign in here, coach their team's games in Supersim and mark themselves ready; the Dynasty Members box on the home page shows you who has played and who is ready before you advance on the console. To the console their team stays CPU-controlled: at the advance it takes the Supersim final instead of simulating the game. A game against a console member's team is played on the console, and recruiting for a web player's team stays with the CPU.</p>`)
    : html``;

  const body = html`<h2>Members</h2>${flash}${whoami}${box('League members', table)}${webBox}${invitesBox}`;
  return authPage(ctx, 'Members', body);
}

const deny = (ctx: PageCtx, msg = 'Only a signed-in commissioner can manage invites.') => redirect(`/d/${ctx.dyn.slug}/members?err=${enc(msg)}`);
const crossSite = (ctx: PageCtx) => !ctx.req || !sameOrigin(ctx.req, ctx.url);

// POST /d/<slug>/members/invite  (blaze_id): a new invite for a member without an account.
export async function inviteAction(ctx: PageCtx, form: FormData): Promise<Response> {
  const { env, dyn, members = [], account } = ctx;
  if (!isCommissioner(ctx) || !account) return deny(ctx);
  if (crossSite(ctx)) return deny(ctx, 'The form came from another site; try again from this page.');
  const blazeId = Number(form.get('blaze_id'));
  const m = members.find((x) => x.blaze_id === blazeId);
  if (!m) return deny(ctx, 'No such member.');
  if (await getAccountForMember(env.DB, dyn.id, blazeId)) return deny(ctx, `${m.persona} already has an account.`);
  if (m.web_only !== 1) { // a console persona with a site account from another dynasty: link it instead of inviting
    const owner = await getAccountForPersona(env.DB, blazeId);
    if (owner) { await linkMember(env.DB, owner.id, dyn.id, blazeId); return redirect(`/d/${dyn.slug}/members?linked=${enc(m.persona)}`); }
  }
  const note = String(form.get('note') ?? '').trim().slice(0, 120) || `invited by ${account.username}`;
  await insertInvite(env.DB, newInviteCode(), dyn.id, blazeId, account.id, note);
  return redirect(`/d/${dyn.slug}/members?invited=1`);
}

// POST /d/<slug>/members/invite/<code>/revoke
export async function revokeInviteAction(ctx: PageCtx, rawCode: string): Promise<Response> {
  const { env, dyn } = ctx;
  if (!isCommissioner(ctx)) return deny(ctx);
  if (crossSite(ctx)) return deny(ctx, 'The form came from another site; try again from this page.');
  const ok = await deleteOpenInvite(env.DB, dyn.id, normalizeCode(decodeURIComponent(rawCode)));
  return redirect(`/d/${dyn.slug}/members?${ok ? 'revoked=1' : `err=${enc('That invite is gone already.')}`}`);
}

// A team a web player may take: a real team of this dynasty that no other member controls.
async function freeTeam(ctx: PageCtx, raw: unknown, self: number | null): Promise<TeamRow | string> {
  const tgid = Number(raw);
  const team = (await getTeams(ctx.env.DB, ctx.dyn.id)).find((t) => t.tgid === tgid);
  if (!team) return 'Pick a team.';
  const owner = (ctx.members ?? []).find((m) => m.tgid === tgid && m.blaze_id !== self);
  return owner ? `${team.name} already belongs to ${owner.persona}.` : team;
}

// POST /d/<slug>/members/web  (persona, tgid): adds a web player and creates their invite.
export async function addWebMemberAction(ctx: PageCtx, form: FormData): Promise<Response> {
  const { env, dyn, members = [], account } = ctx;
  if (!isCommissioner(ctx) || !account) return deny(ctx, 'Only a signed-in commissioner can add web players.');
  if (crossSite(ctx)) return deny(ctx, 'The form came from another site; try again from this page.');
  if (dyn.od_id === null) return deny(ctx, 'Web players need an online dynasty.');
  const persona = String(form.get('persona') ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (persona.length < 2) return deny(ctx, 'Give the web player a name (2-24 characters).');
  if (members.some((m) => m.persona.toLowerCase() === persona.toLowerCase())) return deny(ctx, `There is already a member called ${persona}.`);
  const team = await freeTeam(ctx, form.get('tgid'), null);
  if (typeof team === 'string') return deny(ctx, team);
  const id = await addWebMember(env.DB, dyn.id, persona, team.tgid);
  await insertInvite(env.DB, newInviteCode(), dyn.id, id, account.id, `web player (${team.name}), invited by ${account.username}`);
  return redirect(`/d/${dyn.slug}/members?webadded=1`);
}

// POST /d/<slug>/members/web/<blaze_id>  (action = team + tgid | remove)
export async function webMemberAction(ctx: PageCtx, rawId: string, form: FormData): Promise<Response> {
  const { env, dyn, members = [] } = ctx;
  if (!isCommissioner(ctx)) return deny(ctx, 'Only a signed-in commissioner can manage web players.');
  if (crossSite(ctx)) return deny(ctx, 'The form came from another site; try again from this page.');
  const m = members.find((x) => x.blaze_id === Number(rawId) && x.web_only === 1);
  if (!m) return deny(ctx, 'No such web player.');
  if (form.get('action') === 'remove') { await removeWebMember(env.DB, dyn.id, m.blaze_id); return redirect(`/d/${dyn.slug}/members?removed=1`); }
  const team = await freeTeam(ctx, form.get('tgid'), m.blaze_id);
  if (typeof team === 'string') return deny(ctx, team);
  await setWebMemberTeam(env.DB, dyn.id, m.blaze_id, team.tgid);
  return redirect(`/d/${dyn.slug}/members?moved=1`);
}

// POST /d/<slug>/ready  (ready = 1 | 0, back): the acting member marks themselves ready for the next advance, or not.
// The flag belongs to the dynasty file the league is on, so the advance (a new file) clears everyone's.
export async function readyAction(ctx: PageCtx, form: FormData): Promise<Response> {
  const { env, dyn, member } = ctx;
  const back = safeBack(form.get('back'), `/d/${dyn.slug}`);
  const to = (err?: string) => redirect(err ? `${back}${back.includes('?') ? '&' : '?'}err=${enc(err)}#members` : `${back}#members`);
  if (crossSite(ctx)) return to('The form came from another site; try again from this page.');
  if (!member) return to(ctx.locked ? 'Sign in to mark yourself ready.' : 'Pick who you are in the top bar first.');
  if (dyn.od_id === null) return to('Ready is for online dynasties.');
  await setReady(env.DB, dyn.id, member.blaze_id, dyn.od_file_id ?? 0, dyn.season_year, dyn.week, form.get('ready') === '1');
  return to();
}
