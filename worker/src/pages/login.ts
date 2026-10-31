// Sign in / sign out for member accounts (see session.ts). GET /d/<slug>/login shows the form; POST login checks the
// username + password and sets the od_session cookie; POST logout drops the session row and clears the cookie.
import type { PageCtx } from '../index.js';
import { html, type Raw } from '../html.js';
import { layout, box } from '../layout.js';
import { getAccountByUsername, deleteSession, purgeExpiredSessions } from '../db/queries.js';
import { verifyPassword, burnHash, delay, createSession, clearSessionCookie, sessionHashFromRequest, redirect, sameOrigin, safeBack, USERNAME_RE } from '../session.js';

const enc = encodeURIComponent;
export const authPage = (ctx: PageCtx, title: string, body: Raw) =>
  layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, account: ctx.account, locked: ctx.locked, path: ctx.url.pathname + ctx.url.search, title, siteName: ctx.env.SITE_NAME, dyn: ctx.dyn, body });

export async function loginPage(ctx: PageCtx): Promise<Response> {
  const { dyn, url } = ctx;
  const back = safeBack(url.searchParams.get('back'), `/d/${dyn.slug}`);
  const flash = url.searchParams.get('err') ? html`<p class="flash err">Wrong username or password.</p>` : html``;
  const note = !ctx.locked
    ? html`<p class="muted">No accounts exist for this dynasty yet. The first one is created from an invite issued on the league server: <code>ncaa-bridge od invite --did ${dyn.od_id ?? 'N'} --persona NAME</code>, then open the link it prints.</p>`
    : ctx.account ? html`<p class="muted">You are already signed in as <b>${ctx.account.username}</b>${ctx.member ? html` (${ctx.member.persona})` : ''}. <a href="/d/${dyn.slug}/members">Members</a></p>` : html``;
  const body = html`<div class="auth-wrap"><h2>Sign in</h2>${flash}${box('Member account', html`${note}
    <form class="wform" method="post" action="/d/${dyn.slug}/login"><input type="hidden" name="back" value="${back}">
      <div class="fields">
        <div class="wide"><label for="li-u">Username</label><input id="li-u" type="text" name="username" autocomplete="username" maxlength="24" required autofocus></div>
        <div class="wide"><label for="li-p">Password</label><input id="li-p" type="password" name="password" autocomplete="current-password" required></div>
      </div>
      <div class="actions"><button class="btn">Sign in</button><span class="muted">Got an invite link? Open it to create your account.</span></div>
    </form>`)}</div>`;
  return authPage(ctx, 'Sign in', body);
}

// POST /d/<slug>/login: generic failure message and a 400 ms pause on any failure (no hint whether the user exists).
export async function loginAction(ctx: PageCtx, form: FormData): Promise<Response> {
  const { env, dyn, url, req } = ctx;
  const db = env.DB;
  const back = safeBack(form.get('back'), `/d/${dyn.slug}`);
  const fail = async () => { await delay(400); return redirect(`/d/${dyn.slug}/login?err=1&back=${enc(back)}`); };
  if (!req || !sameOrigin(req, url)) return fail();
  const username = String(form.get('username') ?? '').trim();
  const password = String(form.get('password') ?? '');
  if (!USERNAME_RE.test(username) || !password) return fail();
  const acct = await getAccountByUsername(db, dyn.id, username);
  if (!acct) { await burnHash(password); return fail(); }
  if (!(await verifyPassword(password, acct))) return fail();
  const old = await sessionHashFromRequest(req); // one session per browser: replace whatever cookie it carried
  if (old) await deleteSession(db, old);
  await purgeExpiredSessions(db);
  return redirect(back, { 'set-cookie': await createSession(db, acct.id, dyn.id) });
}

// POST /d/<slug>/logout
export async function logoutAction(ctx: PageCtx, form: FormData): Promise<Response> {
  const { env, dyn, url, req } = ctx;
  const back = safeBack(form.get('back'), `/d/${dyn.slug}`);
  if (req && sameOrigin(req, url)) { const h = await sessionHashFromRequest(req); if (h) await deleteSession(env.DB, h); }
  return redirect(back, { 'set-cookie': clearSessionCookie() });
}
