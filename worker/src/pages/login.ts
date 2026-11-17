// Sign in / sign out for member accounts (see session.ts). GET /d/<slug>/login shows the form; POST login checks the
// username + password and sets the session cookie (accounts and sessions are site-wide: one sign-in covers every
// dynasty the account is linked to); POST logout drops the session row and clears the cookie.
import type { PageCtx } from '../index.js';
import { html, type Raw } from '../html.js';
import { layout, box } from '../layout.js';
import { getAccountByUsername, deleteSession, purgeExpiredSessions } from '../db/queries.js';
import { verifyPassword, burnHash, delay, createSession, clearSessionCookies, sessionHashFromRequest, redirect, sameOrigin, safeBack, USERNAME_RE } from '../session.js';
import { LIMITS, LOGIN_GUESSED_PER_IP, LOGIN_GUESSED_DELAY_MS, rateHit, rateBump, rateBlocked, rateClear, clientIp } from '../security.js';

const enc = encodeURIComponent;
export const authPage = (ctx: PageCtx, title: string, body: Raw) =>
  layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, account: ctx.account, locked: ctx.locked, path: ctx.url.pathname + ctx.url.search, title, siteName: ctx.env.SITE_NAME, dyn: ctx.dyn, body });

export async function loginPage(ctx: PageCtx): Promise<Response> {
  const { dyn, url } = ctx;
  const back = safeBack(url.searchParams.get('back'), `/d/${dyn.slug}`, url.origin);
  const flash = url.searchParams.get('err') === '2' ? html`<p class="flash err">Too many tries. Wait about 15 minutes, then try again.</p>` : url.searchParams.get('err') ? html`<p class="flash err">Wrong username or password.</p>` : html``;
  const note = ctx.account
    ? html`<p class="muted">You are already signed in as <b>${ctx.account.username}</b>${ctx.member ? html` (${ctx.member.persona})` : ''}. <a href="/d/${dyn.slug}/members">Members</a></p>`
    : !ctx.locked
      ? html`<p class="muted">No account is linked to this dynasty yet. Accounts work across the whole site: sign in with the one you already have, and if your console persona is a member here you act as it at once. A league's first account comes from an invite issued on the league server: <code>ncaa-bridge od invite --did ${dyn.od_id ?? 'N'} --persona NAME</code>, then open the link it prints.</p>`
      : html`<p class="muted">One username and password for every dynasty you are in: the console persona you created or joined this dynasty with is recognised by itself.</p>`;
  const body = html`<div class="auth-wrap"><h2>Sign in</h2>${flash}${box('Member account', html`${note}
    <form class="wform" method="post" action="/d/${dyn.slug}/login"><input type="hidden" name="back" value="${back}">
      <div class="fields">
        <div class="wide"><label for="li-u">Username</label><input id="li-u" type="text" name="username" autocomplete="username" maxlength="24" required autofocus></div>
        <div class="wide"><label for="li-p">Password</label><input id="li-p" type="password" name="password" autocomplete="current-password" required></div>
      </div>
      <div class="actions"><button class="btn">Sign in</button><span class="muted">Got an invite link? Open it to create your account. New here? <a href="/signup">Create an account</a>.</span></div>
    </form>`)}</div>`;
  return authPage(ctx, 'Sign in', body);
}

// The sign-in check shared by /d/<slug>/login and the site-level /login (pages/account.ts). Returns the session cookie,
// 'fail' (wrong username or password: the same answer and the same time spent whether or not the username exists) or
// 'limited' (too many tries from this address). The limits are in security.ts, with the reasoning: only the counter
// for this username AND this address can refuse a sign-in, so other people's wrong guesses never lock the owner out;
// a username that is being guessed at from many addresses is slowed down (fewer tries per address, a longer wait)
// rather than blocked, and the right password still signs in. Each try takes its slot in one SQL statement before the
// password is looked at, so parallel requests cannot get more checks than the limit allows; a success hands the slots
// back. The counters grow the same way for names that do not exist, so the limit gives nothing away either.
export async function attemptLogin(db: D1Database, req: Request, username: string, password: string): Promise<{ cookie: string } | 'fail' | 'limited'> {
  const ip = clientIp(req), user = username.toLowerCase();
  if (!(await rateHit(db, LIMITS.loginIp, ip))) return 'limited';
  if (!USERNAME_RE.test(username) || !password || password.length > 256) return 'fail';
  const guessed = await rateBlocked(db, LIMITS.loginUser, user); // many wrong passwords for this name lately, from anywhere
  const slot = `${user}|${ip}`;
  if ((await rateBump(db, LIMITS.loginUserIp, slot)) > (guessed ? LOGIN_GUESSED_PER_IP : LIMITS.loginUserIp.max)) return 'limited';
  if (guessed) await delay(LOGIN_GUESSED_DELAY_MS);
  const acct = await getAccountByUsername(db, username); // site-wide: the session is good for every dynasty the account is linked to
  const ok = acct ? await verifyPassword(password, acct) : (await burnHash(password), false);
  if (!acct || !ok) { await rateBump(db, LIMITS.loginUser, user); return 'fail'; }
  await rateClear(db, LIMITS.loginUserIp, slot);
  const old = await sessionHashFromRequest(req); // one session per browser: replace whatever cookie it carried
  if (old) await deleteSession(db, old);
  await purgeExpiredSessions(db);
  return { cookie: await createSession(db, acct.id) };
}

// POST /d/<slug>/login: generic failure message and a 400 ms pause on any failure (no hint whether the user exists).
export async function loginAction(ctx: PageCtx, form: FormData): Promise<Response> {
  const { env, dyn, url, req } = ctx;
  const back = safeBack(form.get('back'), `/d/${dyn.slug}`, url.origin);
  const fail = async (code = 1) => { await delay(400); return redirect(`/d/${dyn.slug}/login?err=${code}&back=${enc(back)}`); };
  if (!req || !sameOrigin(req, url)) return fail();
  const r = await attemptLogin(env.DB, req, String(form.get('username') ?? '').trim(), String(form.get('password') ?? ''));
  if (r === 'limited') return fail(2);
  if (r === 'fail') return fail();
  return redirect(back, { 'set-cookie': r.cookie });
}

// POST /d/<slug>/logout
export async function logoutAction(ctx: PageCtx, form: FormData): Promise<Response> {
  const { env, dyn, url, req } = ctx;
  const back = safeBack(form.get('back'), `/d/${dyn.slug}`, url.origin);
  if (req && sameOrigin(req, url)) { const h = await sessionHashFromRequest(req); if (h) await deleteSession(env.DB, h); }
  return redirect(back, { 'set-cookie': clearSessionCookies() });
}
