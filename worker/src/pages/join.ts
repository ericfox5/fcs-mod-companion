// Account creation from an invite code: GET /d/<slug>/join?code=... shows which persona the code is for and asks for a
// username + password; POST creates the account for the invite's member, marks the invite used and signs the browser in.
import type { PageCtx } from '../index.js';
import { html } from '../html.js';
import { box } from '../layout.js';
import type { Dynasty, MemberRow, InviteRow } from '../db/queries.js';
import { getInvite, getAccountForMember, getAccountByUsername, createAccountFromInvite, getTeam } from '../db/queries.js';
import { hashPassword, createSession, redirect, sameOrigin, normalizeCode, USERNAME_RE, PASSWORD_MIN } from '../session.js';
import { authPage } from './login.js';
import { teamLogo } from './common.js';

const enc = encodeURIComponent;
type Check = { ok: true; invite: InviteRow; member: MemberRow } | { ok: false; reason: string };

// An invite is usable when it exists for this dynasty, is unused, its member is still in the league and has no account.
async function checkInvite(db: D1Database, dyn: Dynasty, members: MemberRow[], code: string): Promise<Check> {
  if (!code) return { ok: false, reason: 'This page needs an invite link (…/join?code=XXXX-XXXX-XXXX-XXXX).' };
  const invite = await getInvite(db, code);
  if (!invite || invite.dynasty_id !== dyn.id) return { ok: false, reason: 'That invite code is not valid for this dynasty.' };
  if (invite.used_at) return { ok: false, reason: 'That invite has already been used. Sign in instead, or ask the commissioner for a new one.' };
  const member = members.find((m) => m.blaze_id === invite.blaze_id);
  if (!member) return { ok: false, reason: 'The member this invite was for is no longer in the league.' };
  if (await getAccountForMember(db, dyn.id, member.blaze_id)) return { ok: false, reason: `${member.persona} already has an account. Sign in instead.` };
  return { ok: true, invite, member };
}

export async function joinPage(ctx: PageCtx): Promise<Response> {
  const { env, dyn, url, members } = ctx;
  const code = normalizeCode(url.searchParams.get('code'));
  const check = await checkInvite(env.DB, dyn, members ?? [], code);
  const err = url.searchParams.get('err');
  if (!check.ok) return authPage(ctx, 'Join', html`<div class="auth-wrap"><h2>Join ${dyn.name}</h2><p class="flash err">${check.reason}</p><p><a class="btn light" href="/d/${dyn.slug}/login">Sign in</a></p></div>`);
  const m = check.member;
  const team = m.tgid && m.tgid !== 1023 ? await getTeam(env.DB, dyn.id, m.tgid) : null;
  const body = html`<div class="auth-wrap"><h2>Join ${dyn.name}</h2>${err ? html`<p class="flash err">${err}</p>` : ''}
    ${box('Create your account', html`<p>This invite is for <b>${m.persona}</b>${team ? html` · ${teamLogo(team, 'xs')}${team.name}` : ''}${m.commissioner === 1 ? html` <span class="tag">Commissioner</span>` : ''}. Pick a username and password; you will use them to sign in on this site.</p>
    <form class="wform" method="post" action="/d/${dyn.slug}/join"><input type="hidden" name="code" value="${code}">
      <div class="fields">
        <div class="wide"><label for="jn-u">Username</label><input id="jn-u" type="text" name="username" autocomplete="username" pattern="[A-Za-z0-9_.-]{3,24}" maxlength="24" required autofocus value="${url.searchParams.get('username') ?? ''}"></div>
        <div class="wide"><label for="jn-p">Password</label><input id="jn-p" type="password" name="password" autocomplete="new-password" minlength="${PASSWORD_MIN}" required></div>
        <div class="wide"><label for="jn-c">Confirm password</label><input id="jn-c" type="password" name="confirm" autocomplete="new-password" minlength="${PASSWORD_MIN}" required></div>
      </div>
      <div class="actions"><button class="btn">Create account and sign in</button><span class="muted">3-24 letters, digits, _ . - for the username; at least ${PASSWORD_MIN} characters for the password.</span></div>
    </form>`)}</div>`;
  return authPage(ctx, 'Join', body);
}

// POST /d/<slug>/join
export async function joinAction(ctx: PageCtx, form: FormData): Promise<Response> {
  const { env, dyn, url, req, members } = ctx;
  const db = env.DB;
  const code = normalizeCode(form.get('code'));
  const username = String(form.get('username') ?? '').trim();
  const back = (msg: string) => redirect(`/d/${dyn.slug}/join?code=${enc(code)}&username=${enc(username)}&err=${enc(msg)}`);
  if (!req || !sameOrigin(req, url)) return back('The form came from another site; try again from this page.');
  const check = await checkInvite(db, dyn, members ?? [], code);
  if (!check.ok) return redirect(`/d/${dyn.slug}/join?code=${enc(code)}`);
  const password = String(form.get('password') ?? '');
  if (!USERNAME_RE.test(username)) return back('Usernames are 3 to 24 characters: letters, digits, _ . and -.');
  if (password.length < PASSWORD_MIN) return back(`Passwords need at least ${PASSWORD_MIN} characters.`);
  if (password !== String(form.get('confirm') ?? '')) return back('The two passwords do not match.');
  if (await getAccountByUsername(db, dyn.id, username)) return back('That username is taken in this dynasty.');
  const { hash, salt } = await hashPassword(password);
  let id: number | null;
  try { id = await createAccountFromInvite(db, dyn.id, check.member.blaze_id, username, hash, salt, code); }
  catch (e: any) { return back(/UNIQUE/i.test(String(e?.message ?? e)) ? 'That username is taken, or this member just got an account.' : `Could not create the account: ${e?.message ?? e}`); }
  if (id === null) return back('That invite was used a moment ago.');
  return redirect(`/d/${dyn.slug}/members?joined=1`, { 'set-cookie': await createSession(db, id, dyn.id) });
}
