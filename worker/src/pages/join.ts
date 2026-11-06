// Account creation from an invite code: GET /d/<slug>/join?code=... shows which persona the code is for and asks for a
// username + password, or, when the browser is already signed in to a site account, offers to take the invite with that
// account; POST creates (or links) the account for the invite's member, marks the invite used and signs the browser in.
import type { PageCtx } from '../index.js';
import { html } from '../html.js';
import { box } from '../layout.js';
import type { Dynasty, MemberRow, InviteRow } from '../db/queries.js';
import { getInvite, getAccountForMember, getAccountForPersona, getAccountByUsername, createAccountFromInvite, linkAccountFromInvite, getTeam, deleteSession } from '../db/queries.js';
import { hashPassword, createSession, redirect, sameOrigin, normalizeCode, sessionAccount, sessionHashFromRequest, USERNAME_RE, PASSWORD_MIN, type AccountInfo } from '../session.js';
import { authPage } from './login.js';
import { teamLogo } from './common.js';

const enc = encodeURIComponent;
type Check = { ok: true; invite: InviteRow; member: MemberRow; persona: number | null } | { ok: false; reason: string };
// The console persona a member stands for (null for a web player): the account made from the invite will own it.
const personaOf = (m: MemberRow) => (m.web_only === 1 || m.blaze_id <= 0 ? null : m.blaze_id);
// Whether a signed-in account may take this invite: any account for a web player; for a console persona only one that
// owns no persona yet (one persona per account).
const canLink = (acct: AccountInfo, persona: number | null) => persona === null || acct.blazeId === null;

// An invite is usable when it exists for this dynasty, is unused, its member is still in the league and has no account.
async function checkInvite(db: D1Database, dyn: Dynasty, members: MemberRow[], code: string): Promise<Check> {
  if (!code) return { ok: false, reason: 'This page needs an invite link (…/join?code=XXXX-XXXX-XXXX-XXXX).' };
  const invite = await getInvite(db, code);
  if (!invite || invite.dynasty_id !== dyn.id) return { ok: false, reason: 'That invite code is not valid for this dynasty.' };
  if (invite.used_at) return { ok: false, reason: 'That invite has already been used. Sign in instead, or ask the commissioner for a new one.' };
  const member = members.find((m) => m.blaze_id === invite.blaze_id);
  if (!member) return { ok: false, reason: 'The member this invite was for is no longer in the league.' };
  if (await getAccountForMember(db, dyn.id, member.blaze_id)) return { ok: false, reason: `${member.persona} already has an account here. Sign in instead.` };
  const persona = personaOf(member);
  if (persona !== null) {
    const owner = await getAccountForPersona(db, persona);
    if (owner) return { ok: false, reason: `${member.persona} is already the site account ${owner.username}. Sign in with it; this dynasty is linked to it by itself.` };
  }
  return { ok: true, invite, member, persona };
}

export async function joinPage(ctx: PageCtx): Promise<Response> {
  const { env, dyn, url, members, req } = ctx;
  const code = normalizeCode(url.searchParams.get('code'));
  const check = await checkInvite(env.DB, dyn, members ?? [], code);
  const err = url.searchParams.get('err');
  if (!check.ok) return authPage(ctx, 'Join', html`<div class="auth-wrap"><h2>Join ${dyn.name}</h2><p class="flash err">${check.reason}</p><p><a class="btn light" href="/d/${dyn.slug}/login">Sign in</a></p></div>`);
  const m = check.member;
  const team = m.tgid && m.tgid !== 1023 ? await getTeam(env.DB, dyn.id, m.tgid) : null;
  const acct = req ? await sessionAccount(req, env.DB) : null;
  const who = html`This invite is for <b>${m.persona}</b>${team ? html` · ${teamLogo(team, 'xs')}${team.name}` : ''}${m.commissioner === 1 ? html` <span class="tag">Commissioner</span>` : ''}${m.web_only === 1 ? html` <span class="tag web">Web player</span>. You coach your team's games in Supersim on this site and mark yourself ready each week; no console needed` : ''}.`;
  const linkBox = !acct ? html`` : canLink(acct, check.persona)
    ? box('Use the account you are signed in with', html`<p>${who} You are signed in as <b>${acct.username}</b>: take the invite with that account and keep one username and password for every dynasty you are in.</p>
      <form class="wform" method="post" action="/d/${dyn.slug}/join"><input type="hidden" name="code" value="${code}"><input type="hidden" name="link" value="1">
        <div class="actions"><button class="btn">Join as ${acct.username}</button></div>
      </form>`)
    : box('Signed in as another persona', html`<p class="muted">You are signed in as <b>${acct.username}</b>, which already stands for another console persona, so ${m.persona} needs an account of its own.</p>`);
  const body = html`<div class="auth-wrap"><h2>Join ${dyn.name}</h2>${err ? html`<p class="flash err">${err}</p>` : ''}${linkBox}
    ${box(acct ? 'Or create a separate account' : 'Create your account', html`<p>${who} Pick a username and password; they sign you in on this site${check.persona !== null ? html`, in this dynasty and in every other one your console persona is a member of` : ''}.</p>
    <form class="wform" method="post" action="/d/${dyn.slug}/join"><input type="hidden" name="code" value="${code}">
      <div class="fields">
        <div class="wide"><label for="jn-u">Username</label><input id="jn-u" type="text" name="username" autocomplete="username" pattern="[A-Za-z0-9_.-]{3,24}" maxlength="24" required ${acct ? '' : 'autofocus'} value="${url.searchParams.get('username') ?? ''}"></div>
        <div class="wide"><label for="jn-p">Password</label><input id="jn-p" type="password" name="password" autocomplete="new-password" minlength="${PASSWORD_MIN}" required></div>
        <div class="wide"><label for="jn-c">Confirm password</label><input id="jn-c" type="password" name="confirm" autocomplete="new-password" minlength="${PASSWORD_MIN}" required></div>
      </div>
      <div class="actions"><button class="btn">Create account and sign in</button><span class="muted">3-24 letters, digits, _ . - for the username; at least ${PASSWORD_MIN} characters for the password.</span></div>
    </form>`)}</div>`;
  return authPage(ctx, 'Join', body);
}

// POST /d/<slug>/join  (code + username/password/confirm, or code + link=1 for the signed-in account)
export async function joinAction(ctx: PageCtx, form: FormData): Promise<Response> {
  const { env, dyn, url, req, members } = ctx;
  const db = env.DB;
  const code = normalizeCode(form.get('code'));
  const username = String(form.get('username') ?? '').trim();
  const back = (msg: string) => redirect(`/d/${dyn.slug}/join?code=${enc(code)}&username=${enc(username)}&err=${enc(msg)}`);
  if (!req || !sameOrigin(req, url)) return back('The form came from another site; try again from this page.');
  const check = await checkInvite(db, dyn, members ?? [], code);
  if (!check.ok) return redirect(`/d/${dyn.slug}/join?code=${enc(code)}`);
  const errorText = (e: unknown) => String((e as any)?.message ?? e);
  if (form.get('link') === '1') { // take the invite with the account the browser is signed in with
    const acct = await sessionAccount(req, db);
    if (!acct) return back('You are not signed in; sign in first, or create an account below.');
    if (!canLink(acct, check.persona)) return back(`${acct.username} already stands for another console persona; create a separate account for ${check.member.persona}.`);
    let ok: boolean;
    try { ok = await linkAccountFromInvite(db, acct.id, dyn.id, check.member.blaze_id, check.persona, code); }
    catch (e) { return back(/UNIQUE/i.test(errorText(e)) ? `${check.member.persona} just got an account; sign in with it.` : `Could not link the account: ${errorText(e)}`); }
    if (!ok) return back('That invite was used a moment ago.');
    return redirect(`/d/${dyn.slug}/members?joined=1`);
  }
  const password = String(form.get('password') ?? '');
  if (!USERNAME_RE.test(username)) return back('Usernames are 3 to 24 characters: letters, digits, _ . and -.');
  if (password.length < PASSWORD_MIN) return back(`Passwords need at least ${PASSWORD_MIN} characters.`);
  if (password !== String(form.get('confirm') ?? '')) return back('The two passwords do not match.');
  if (await getAccountByUsername(db, username)) return back('That username is taken.');
  const { hash, salt } = await hashPassword(password);
  let id: number | null;
  try { id = await createAccountFromInvite(db, dyn.id, check.member.blaze_id, check.persona, username, hash, salt, code); }
  catch (e) { return back(/UNIQUE/i.test(errorText(e)) ? 'That username is taken, or this member just got an account.' : `Could not create the account: ${errorText(e)}`); }
  if (id === null) return back('That invite was used a moment ago.');
  const old = await sessionHashFromRequest(req); // one session per browser: the new account replaces whatever cookie it carried
  if (old) await deleteSession(db, old);
  return redirect(`/d/${dyn.slug}/members?joined=1`, { 'set-cookie': await createSession(db, id) });
}
