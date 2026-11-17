// Site-level account pages (no dynasty in the URL): open sign-up, sign in / out, the account page where a member picks
// an in-game name and gets a join code for the public league server, and the admin's member list.
//   GET  /signup                         the sign-up form                      POST /signup            creates the account
//   GET  /login                          sign in                               POST /login, /logout
//   GET  /account                        in-game name, status, next steps      POST /account/name      picks the name, issues the first join code
//   GET  /account/regenerate             "are you sure" + password             POST /account/regenerate  new join code (the old one stops working)
//   POST /account/password               change password
//   GET  /admin/members                  admins (ADMIN_ACCOUNT_IDS / ADMIN_USERNAMES, account-rules.ts): all league members + recent audit rows
//   POST /admin/members/<userId>/disable | enable
// Every POST needs the CSRF token (security.ts) and is rate limited. Pages are sent with a strict Content-Security-
// Policy and `no-store`. A join code is shown exactly once, in the response to the POST that made it: the site keeps
// only the SHA-256 of the credential inside it (league.ts).
import type { Env } from '../env.js';
import { html, type Raw } from '../html.js';
import { layout, box } from '../layout.js';
import { getAccountByUsername, getAccountById, insertAccount, setAccountPassword, deleteOtherSessions, deleteSession } from '../db/queries.js';
import { hashPassword, verifyPassword, createSession, clearSessionCookies, sessionAccountWithUpgrade, sessionHashFromRequest, redirect, safeBack, delay, USERNAME_RE, type AccountInfo } from '../session.js';
import { csrfToken, csrfOk, rateHit, rateBump, rateCount, ratePurge, LIMITS, SIGNUP_BUSY_PER_NET, SIGNUP_HARD_CAP_DEFAULT, clientIp, clientNet, clientAddress, ipHash, turnstileOn, verifyTurnstile, STRICT_CSP } from '../security.js';
import { SIGNUP_PASSWORD_MIN, PASSWORD_MAX, PASSWORD_MESSAGES, passwordProblem, usernameProblem, imitatesAdmin, isAdmin } from '../account-rules.js';
import { attemptLogin } from './login.js';
import { onlineIdProblem, onlineIdTaken, getLeaguePlayer, getLeaguePlayerByUserId, enrollPlayer, replaceCredential, setPlayerDisabled, listLeaguePlayers, listAudit, audit,
  newTicket, ticketSha256, buildProfile, joinCode, profileFileText, leagueHost, setupUrl, PROFILE_FILENAME, type LeaguePlayerRow, type MemberProfile } from '../league.js';

const enc = encodeURIComponent;
export { SIGNUP_PASSWORD_MIN, passwordProblem, isAdmin }; // the rules themselves live in account-rules.ts (the invite flow uses them too)

interface SiteCtx { env: Env; req: Request; url: URL; account: AccountInfo | null; csrf: { token: string; setCookie?: string } }

export const signupOpen = (env: Env) => (env.OPEN_SIGNUP ?? 'true').trim().toLowerCase() !== 'false';
const positive = (v: string | undefined): number | null => { const n = Number(v); return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null; };
// The day's sign-up marks: `busy` is where the site starts being careful (SIGNUP_DAILY_CAP), `hard` where it pauses
// sign-up for everyone (SIGNUP_HARD_CAP, never below the busy mark). See LIMITS in security.ts.
export function signupCaps(env: Env): { busy: number; hard: number } {
  const busy = positive(env.SIGNUP_DAILY_CAP) ?? LIMITS.signupAll.max;
  return { busy, hard: Math.max(busy, positive(env.SIGNUP_HARD_CAP) ?? SIGNUP_HARD_CAP_DEFAULT) };
}

// ---- page chrome ---------------------------------------------------------------------------------------------------
const csrfField = (c: SiteCtx) => html`<input type="hidden" name="csrf" value="${c.csrf.token}">`;
function sitePage(c: SiteCtx, title: string, body: Raw, status = 200): Response {
  const right = c.account
    ? html`<div class="who"><a class="who-me" href="/account" title="Your account">${c.account.username}</a><span class="sep">·</span><form class="who-out" method="post" action="/logout">${csrfField(c)}<button type="submit">Sign out</button></form></div>`
    : html`<div class="who"><a class="who-in" href="/login">Sign in</a><span class="sep">·</span><a class="who-in" href="/signup">Join</a></div>`;
  const page = layout({ title, siteName: c.env.SITE_NAME, body: html`${body}<script src="/js/account.js" defer></script>`, right });
  const h = new Headers(page.headers);
  h.set('cache-control', 'no-store'); h.set('content-security-policy', STRICT_CSP);
  if (c.csrf.setCookie) h.append('set-cookie', c.csrf.setCookie);
  return new Response(page.body, { status, headers: h });
}
const flash = (msg: string | null | undefined, err = true) => (msg ? html`<p class="flash ${err ? 'err' : ''}">${msg}</p>` : html``);

const MESSAGES: Record<string, string> = {
  csrf: 'That form had expired. Please try again.',
  closed: 'Sign-ups are closed right now. If you have an invite link from a commissioner, that still works.',
  slow: 'Too many tries from your connection. Please wait a while and try again.',
  busy: 'A lot of people are signing up today, so for now each internet connection can create one account a day. Please try again tomorrow.',
  full: 'A lot of people signed up today and we have paused new accounts until tomorrow. Please come back then.',
  username: 'Usernames are 3 to 24 characters: letters, numbers, _ . and - only.',
  reserved: 'That username is not available. Please pick another one.',
  taken: 'That username is taken. Please pick another one.',
  match: 'The two passwords do not match.',
  agree: 'Please tick the box to agree to the house rules.',
  human: 'We could not confirm you are a person. Please try the check again.',
  login: 'Wrong username or password.',
  limited: 'Too many tries. Wait about 15 minutes, then try again.',
  ...PASSWORD_MESSAGES,
  nameformat: 'In-game names are 3 to 16 characters: letters, numbers, _ and - only (no spaces).',
  namereserved: 'That name is reserved. Please pick another one.',
  nametaken: 'Someone already has that in-game name. Please pick another one.',
  credlimit: 'You have made several join codes today. Please wait until tomorrow to make another.',
  password: 'That password is not right.',
  disabled: 'League access for this account has been turned off, so a new join code cannot be made.',
  noplayer: 'Pick your in-game name first.',
  ids: 'The league cannot take new members right now. Please tell the league admin.',
};
// Error text is looked up by key, never taken from the URL, so a crafted link cannot put words on the page.
const messageFor = (url: URL) => { const k = url.searchParams.get('err'); return k && Object.hasOwn(MESSAGES, k) ? MESSAGES[k]! : null; };

// ---- sign-up -------------------------------------------------------------------------------------------------------
function signupPage(c: SiteCtx): Response {
  if (c.account) return redirect('/account');
  if (!signupOpen(c.env)) return sitePage(c, 'Join', html`<div class="auth-wrap"><h2>Join the league</h2>${flash(MESSAGES.closed)}<p><a class="btn light" href="/login">Sign in</a></p></div>`);
  const ts = turnstileOn(c.env);
  const body = html`<div class="auth-wrap"><h2>Join the league</h2>${flash(messageFor(c.url))}
    <p class="lede-sm">Three short steps: <b>1.</b> create your account here, <b>2.</b> pick the name other players will see in the game, <b>3.</b> copy your join code into the setup wizard. It is free.</p>
    ${box('Step 1 of 3: create your account', html`<form class="wform" method="post" action="/signup">${csrfField(c)}
      <div class="fields">
        <div class="wide"><label for="su-u">Username</label><input id="su-u" type="text" name="username" autocomplete="username" pattern="[A-Za-z0-9_.-]{3,24}" maxlength="24" required autofocus value="${c.url.searchParams.get('u') ?? ''}"><p class="hint">For signing in to this website. 3 to 24 letters, numbers, _ . or -</p></div>
        <div class="wide"><label for="su-p">Password</label><input id="su-p" type="password" name="password" autocomplete="new-password" minlength="${SIGNUP_PASSWORD_MIN}" maxlength="${PASSWORD_MAX}" required><p class="hint">At least ${SIGNUP_PASSWORD_MIN} characters. Write it down somewhere safe: we do not ask for an email, so we cannot send you a reset link.</p></div>
        <div class="wide"><label for="su-c">Password again</label><input id="su-c" type="password" name="confirm" autocomplete="new-password" minlength="${SIGNUP_PASSWORD_MIN}" maxlength="${PASSWORD_MAX}" required></div>
        <div class="wide hp" aria-hidden="true"><label for="su-w">Leave this empty</label><input id="su-w" type="text" name="website" tabindex="-1" autocomplete="off"></div>
        <div class="wide"><label class="check"><input type="checkbox" name="agree" value="1" required> I will play fair and be decent to other members. I understand this is a free fan project and my account can be removed if I spoil it for others.</label></div>
        ${ts ? html`<div class="wide"><div class="cf-turnstile" data-sitekey="${c.env.TURNSTILE_SITE_KEY}"></div></div>` : ''}
      </div>
      <div class="actions"><button class="btn">Create my account</button><span class="muted">Already have one? <a href="/login">Sign in</a></span></div>
    </form>${ts ? html`<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ''}`)}</div>`;
  return sitePage(c, 'Join', body);
}

async function signupAction(c: SiteCtx, form: FormData): Promise<Response> {
  const { env, req, url } = c, db = env.DB;
  const username = String(form.get('username') ?? '').trim();
  const back = (err: string) => redirect(`/signup?err=${enc(err)}${USERNAME_RE.test(username) ? `&u=${enc(username)}` : ''}`);
  if (!(await csrfOk(req, url, form))) return back('csrf');
  if (!signupOpen(env)) return back('closed');
  if (!(await rateHit(db, LIMITS.signupTryIp, clientIp(req)))) return back('slow');
  if (String(form.get('website') ?? '') !== '') { await delay(400); return back('human'); } // the hidden field only a bot fills in
  const badName = await usernameProblem(env, db, username); // format, reserved words, admin names and their look-alikes
  if (badName) return back(badName);
  const password = String(form.get('password') ?? '');
  const bad = passwordProblem(password, username);
  if (bad) return back(bad);
  if (password !== String(form.get('confirm') ?? '')) return back('match');
  if (form.get('agree') !== '1') return back('agree');
  if (!(await verifyTurnstile(env, String(form.get('cf-turnstile-response') ?? ''), clientAddress(req)))) return back('human');
  if (await getAccountByUsername(db, username)) return back('taken');
  // How many accounts the site made today decides how careful to be (LIMITS in security.ts). Past the busy mark sign-up
  // stays open: Turnstile, when configured, is the check; without it each network gets one new account a day. Only the
  // hard cap pauses sign-up for everyone, so a handful of addresses cannot close the door on everybody else.
  const caps = signupCaps(env), today = await rateCount(db, LIMITS.signupAll, 'site');
  if (today >= caps.hard) return back('full');
  const busy = today >= caps.busy;
  const perNet = busy && !turnstileOn(env) ? SIGNUP_BUSY_PER_NET : LIMITS.signupOkIp.max;
  if ((await rateBump(db, LIMITS.signupOkIp, clientNet(req))) > perNet) return back(perNet < LIMITS.signupOkIp.max ? 'busy' : 'slow');
  if ((await rateBump(db, LIMITS.signupAll, 'site')) > caps.hard) return back('full');
  const { hash, salt } = await hashPassword(password);
  let id: number;
  try { id = await insertAccount(db, username, hash, salt); }
  catch (e) { if (/UNIQUE/i.test(String((e as Error)?.message ?? e))) return back('taken'); throw e; }
  await audit(db, { action: 'signup', accountId: id, actorId: id, ipHash: await ipHash(req) });
  await ratePurge(db);
  const old = await sessionHashFromRequest(req);
  if (old) await deleteSession(db, old);
  return redirect('/account?welcome=1', { 'set-cookie': await createSession(db, id) });
}

// ---- sign in / out -------------------------------------------------------------------------------------------------
function loginPage(c: SiteCtx): Response {
  const back = safeBack(c.url.searchParams.get('back'), '/account', c.url.origin);
  if (c.account) return redirect(back);
  const body = html`<div class="auth-wrap"><h2>Sign in</h2>${flash(messageFor(c.url))}${box('Your account', html`
    <form class="wform" method="post" action="/login">${csrfField(c)}<input type="hidden" name="back" value="${back}">
      <div class="fields">
        <div class="wide"><label for="li-u">Username</label><input id="li-u" type="text" name="username" autocomplete="username" maxlength="24" required autofocus></div>
        <div class="wide"><label for="li-p">Password</label><input id="li-p" type="password" name="password" autocomplete="current-password" maxlength="${PASSWORD_MAX}" required></div>
      </div>
      <div class="actions"><button class="btn">Sign in</button>${signupOpen(c.env) ? html`<span class="muted">New here? <a href="/signup">Create an account</a></span>` : ''}</div>
    </form>`)}</div>`;
  return sitePage(c, 'Sign in', body);
}
async function loginAction(c: SiteCtx, form: FormData): Promise<Response> {
  const back = safeBack(form.get('back'), '/account', c.url.origin);
  const fail = async (err: string) => { await delay(400); return redirect(`/login?err=${err}&back=${enc(back)}`); };
  if (!(await csrfOk(c.req, c.url, form))) return fail('csrf');
  const r = await attemptLogin(c.env.DB, c.req, String(form.get('username') ?? '').trim(), String(form.get('password') ?? ''));
  if (r === 'limited') return fail('limited');
  if (r === 'fail') return fail('login');
  return redirect(back, { 'set-cookie': r.cookie });
}
async function logoutAction(c: SiteCtx, form: FormData): Promise<Response> {
  if (await csrfOk(c.req, c.url, form)) { const h = await sessionHashFromRequest(c.req); if (h) await deleteSession(c.env.DB, h); return redirect('/', { 'set-cookie': clearSessionCookies() }); }
  return redirect('/account');
}

// ---- the account page ----------------------------------------------------------------------------------------------
const steps = (c: SiteCtx, haveCode: boolean) => html`<ol class="steps">
  <li><b>Get the setup wizard.</b> <a class="btn sm" href="${setupUrl(c.env)}" rel="noopener">Download the setup wizard</a> It is one small program for your Windows PC. If Windows says "Windows protected your PC", click <b>More info</b>, then <b>Run anyway</b>.</li>
  <li><b>Run it and choose to join the online league.</b> When it asks for your join code, ${haveCode ? 'paste the code from this page' : 'paste your join code'} (or pick the <code>${PROFILE_FILENAME}</code> file you downloaded). The wizard sets everything else up for you.</li>
  <li><b>Start the game.</b> Open <b>Online Dynasty</b> from the main menu. You will show up as your in-game name, and you can create a dynasty or join one.</li>
</ol>`;

function nameForm(c: SiteCtx, err: string | null): Raw {
  const suggest = c.url.searchParams.get('n') ?? (onlineIdProblem(c.account!.username) ? '' : c.account!.username);
  return box('Step 2 of 3: pick your in-game name', html`<p>This is the name other players see in the game. Choose carefully: it cannot be changed later.</p>${flash(err)}
    <form class="wform" method="post" action="/account/name">${csrfField(c)}
      <div class="fields"><div class="wide"><label for="ig-n">In-game name</label><input id="ig-n" type="text" name="online_id" pattern="[A-Za-z0-9_-]{3,16}" minlength="3" maxlength="16" required autofocus autocomplete="off" spellcheck="false" value="${suggest}"><p class="hint">3 to 16 letters, numbers, _ or - (no spaces). Every name is one of a kind.</p></div></div>
      <div class="actions"><button class="btn">Save name and get my join code</button></div>
    </form>`);
}
const passwordBox = (c: SiteCtx) => box('Change password', html`<form class="wform" method="post" action="/account/password">${csrfField(c)}
  <div class="fields">
    <div class="wide"><label for="pw-o">Current password</label><input id="pw-o" type="password" name="current" autocomplete="current-password" maxlength="${PASSWORD_MAX}" required></div>
    <div><label for="pw-n">New password</label><input id="pw-n" type="password" name="password" autocomplete="new-password" minlength="${SIGNUP_PASSWORD_MIN}" maxlength="${PASSWORD_MAX}" required></div>
    <div><label for="pw-c">New password again</label><input id="pw-c" type="password" name="confirm" autocomplete="new-password" minlength="${SIGNUP_PASSWORD_MIN}" maxlength="${PASSWORD_MAX}" required></div>
  </div>
  <div class="actions"><button class="btn light">Change password</button><span class="muted">Other devices are signed out.</span></div>
</form>`);

async function accountPage(c: SiteCtx): Promise<Response> {
  if (!c.account) return redirect(`/login?back=${enc('/account')}`);
  const q = c.url.searchParams, player = await getLeaguePlayer(c.env.DB, c.account.id);
  const note = q.get('welcome') ? flash('Your account is ready and you are signed in. One more thing to choose:', false) : q.get('pw') ? flash('Password changed.', false) : html``;
  const admin = isAdmin(c.env, c.account) ? html`<p><a class="btn light sm" href="/admin/members">League members (admin)</a></p>` : html``;
  const number = html`<p class="muted">Signed in as ${c.account.username} · account number ${c.account.id}</p>`;
  if (!player) return sitePage(c, 'Your account', html`<div class="auth-wrap wide"><h2>Your account</h2>${note}${nameForm(c, messageFor(c.url))}${passwordBox(c)}${number}${admin}</div>`);
  const off = player.disabled === 1;
  const body = html`<div class="auth-wrap wide"><h2>Your account</h2>${note}${flash(messageFor(c.url))}
    ${off ? flash(`Your league access has been turned off by the league admin${player.disabled_reason ? `: ${player.disabled_reason}` : '.'} You can still use this website. If you think this is a mistake, contact the league admin.`) : ''}
    ${box('Your in-game name', html`<p class="ig-name"><b>${player.online_id}</b> ${off ? html`<span class="tag gone">Turned off</span>` : html`<span class="tag commit">Active</span>`}</p>
      <p class="muted">Member number ${player.user_id} · signed in to this site as ${c.account.username} · join code made ${new Date(player.issued_ms).toISOString().slice(0, 10)}</p>`)}
    ${box('How to get playing', steps(c, false))}
    ${off ? '' : box('Lost your join code, or think someone else has it?', html`<p>For your safety we never keep a copy of your join code, so we cannot show it again. You can make a new one at any time. The old code stops working, and you run the setup wizard once more with the new code.</p>
      <p><a class="btn light" href="/account/regenerate">Make a new join code</a></p>`)}
    ${passwordBox(c)}${number}${admin}</div>`;
  return sitePage(c, 'Your account', body);
}

// The one time a join code is on screen: the response to the POST that created it.
function revealPage(c: SiteCtx, player: LeaguePlayerRow, profile: MemberProfile, first: boolean): Response {
  const code = joinCode(profile), file = btoa(profileFileText(profile));
  const body = html`<div class="auth-wrap wide"><h2>${first ? html`Welcome, ${player.online_id}!` : 'Your new join code'}</h2>
    ${flash(first ? 'Step 3 of 3: your join code is below. Copy it or download it now.' : 'Done. Your old join code no longer works. Run the setup wizard again with this new one.', false)}
    ${box('Your join code', html`<p><b>This is shown only once.</b> It is your personal key to the league, a bit like a password: anyone who has it can play as <b>${player.online_id}</b>, so do not post it or share it.</p>
      <p><b>Never use a join code that someone else sent you, and never give yours to anyone:</b> whoever holds a join code plays as the member it belongs to.</p>
      <textarea id="join-code" class="join-code" readonly rows="6" spellcheck="false" aria-label="Your join code">${code}</textarea>
      <div class="jc-actions"><button type="button" class="btn" data-copy="join-code">Copy join code</button>
        <a class="btn light" download="${PROFILE_FILENAME}" href="data:application/json;base64,${file}">Download it as a file</a>
        <span class="muted" id="copy-done" hidden>Copied. Paste it into the setup wizard.</span></div>
      <p class="muted">Either one works in the setup wizard. If you lose it, come back to your account page and make a new one.</p>`)}
    ${box('What to do next', steps(c, true))}
    <p><a class="btn light" href="/account">I have saved my join code</a></p></div>`;
  return sitePage(c, first ? 'Welcome' : 'New join code', body);
}

// Join codes are limited per account and per address (new names and regenerations share the allowance).
const credentialAllowed = async (c: SiteCtx) => (await rateHit(c.env.DB, LIMITS.credAccount, String(c.account!.id))) && (await rateHit(c.env.DB, LIMITS.credIp, clientIp(c.req)));

async function nameAction(c: SiteCtx, form: FormData): Promise<Response> {
  const db = c.env.DB, acct = c.account;
  if (!acct) return redirect(`/login?back=${enc('/account')}`);
  const name = String(form.get('online_id') ?? '').trim();
  const back = (err: string) => redirect(`/account?err=${enc(err)}${/^[A-Za-z0-9_-]{1,16}$/.test(name) ? `&n=${enc(name)}` : ''}`);
  if (!(await csrfOk(c.req, c.url, form))) return back('csrf');
  if (await getLeaguePlayer(db, acct.id)) return redirect('/account');
  const bad = onlineIdProblem(name);
  if (bad) return back(`name${bad}`);
  if (!isAdmin(c.env, acct) && (await imitatesAdmin(c.env, db, name))) return back('namereserved'); // nobody plays under an admin's name but the admin
  if (await onlineIdTaken(db, name, acct.id, acct.blazeId)) return back('nametaken');
  if (!(await credentialAllowed(c))) return back('credlimit');
  const ticket = newTicket(), issued = Date.now();
  const draft = buildProfile(0, name, ticket, issued, leagueHost(c.env));
  const r = await enrollPlayer(db, acct.id, name, await ticketSha256(ticket), issued, draft.expiresMs);
  if (!r.ok) return r.reason === 'exists' ? redirect('/account') : back(r.reason === 'full' ? 'ids' : 'nametaken');
  await audit(db, { action: 'credential_issue', accountId: acct.id, userId: r.player.user_id, actorId: acct.id, ipHash: await ipHash(c.req), detail: `onlineId ${r.player.online_id}` });
  return revealPage(c, r.player, { ...draft, userId: r.player.user_id, onlineId: r.player.online_id }, true);
}

async function regeneratePage(c: SiteCtx): Promise<Response> {
  if (!c.account) return redirect(`/login?back=${enc('/account/regenerate')}`);
  const player = await getLeaguePlayer(c.env.DB, c.account.id);
  if (!player) return redirect('/account?err=noplayer');
  if (player.disabled === 1) return redirect('/account?err=disabled');
  const body = html`<div class="auth-wrap"><h2>Make a new join code?</h2>${flash(messageFor(c.url))}
    ${box(html`New join code for ${player.online_id}`, html`<p>Here is what happens:</p>
      <ul class="plain"><li>Your <b>old join code stops working</b>. If the game is connected with it, it gets disconnected.</li>
        <li>You get a new code, shown once. You then <b>run the setup wizard again</b> and paste the new code.</li>
        <li>Your in-game name, your teams and your dynasties stay exactly as they are.</li></ul>
      <p>Do this if you lost your code, moved to a new PC without the file, or think someone else got hold of it.</p>
      <form class="wform" method="post" action="/account/regenerate">${csrfField(c)}
        <div class="fields"><div class="wide"><label for="rg-p">Type your password to confirm</label><input id="rg-p" type="password" name="password" autocomplete="current-password" maxlength="${PASSWORD_MAX}" required autofocus></div></div>
        <div class="actions"><button class="btn danger">Yes, make a new join code</button><a class="btn light" href="/account">No, keep my current one</a></div>
      </form>`)}</div>`;
  return sitePage(c, 'New join code', body);
}

// The account's password, checked with its own limit (a stolen session should not be able to guess at it freely).
async function passwordConfirmed(c: SiteCtx, password: string): Promise<'ok' | 'bad' | 'limited'> {
  const db = c.env.DB, id = c.account!.id;
  if (!(await rateHit(db, LIMITS.passwordAccount, String(id)))) return 'limited';
  const acct = await getAccountById(db, id);
  return acct && password && password.length <= PASSWORD_MAX && (await verifyPassword(password, acct)) ? 'ok' : 'bad';
}

async function regenerateAction(c: SiteCtx, form: FormData): Promise<Response> {
  const db = c.env.DB, acct = c.account;
  if (!acct) return redirect(`/login?back=${enc('/account/regenerate')}`);
  const back = (err: string) => redirect(`/account/regenerate?err=${err}`);
  if (!(await csrfOk(c.req, c.url, form))) return back('csrf');
  const player = await getLeaguePlayer(db, acct.id);
  if (!player) return redirect('/account?err=noplayer');
  if (player.disabled === 1) return redirect('/account?err=disabled');
  const pw = await passwordConfirmed(c, String(form.get('password') ?? ''));
  if (pw !== 'ok') { await delay(400); return back(pw === 'limited' ? 'limited' : 'password'); }
  if (!(await credentialAllowed(c))) return back('credlimit');
  const ticket = newTicket(), issued = Date.now();
  const profile = buildProfile(player.user_id, player.online_id, ticket, issued, leagueHost(c.env));
  if (!(await replaceCredential(db, acct.id, await ticketSha256(ticket), issued, profile.expiresMs))) return redirect('/account?err=disabled');
  await audit(db, { action: 'credential_regenerate', accountId: acct.id, userId: player.user_id, actorId: acct.id, ipHash: await ipHash(c.req) });
  return revealPage(c, player, profile, false);
}

async function passwordAction(c: SiteCtx, form: FormData): Promise<Response> {
  const db = c.env.DB, acct = c.account;
  if (!acct) return redirect(`/login?back=${enc('/account')}`);
  const back = (err: string) => redirect(`/account?err=${enc(err)}`);
  if (!(await csrfOk(c.req, c.url, form))) return back('csrf');
  const pw = await passwordConfirmed(c, String(form.get('current') ?? ''));
  if (pw !== 'ok') { await delay(400); return back(pw === 'limited' ? 'limited' : 'password'); }
  const next = String(form.get('password') ?? '');
  const bad = passwordProblem(next, acct.username);
  if (bad) return back(bad);
  if (next !== String(form.get('confirm') ?? '')) return back('match');
  const { hash, salt } = await hashPassword(next);
  await setAccountPassword(db, acct.id, hash, salt);
  const keep = await sessionHashFromRequest(c.req);
  if (keep) await deleteOtherSessions(db, acct.id, keep);
  await audit(db, { action: 'password_change', accountId: acct.id, actorId: acct.id, ipHash: await ipHash(c.req) });
  return redirect('/account?pw=1');
}

// ---- admin ---------------------------------------------------------------------------------------------------------
async function adminPage(c: SiteCtx): Promise<Response> {
  const db = c.env.DB, q = c.url.searchParams;
  const [players, log] = await Promise.all([listLeaguePlayers(db), listAudit(db, 50)]);
  const note = q.get('done') === 'off' ? flash('Member turned off. The league server drops them the next time it checks the list.', false) : q.get('done') === 'on' ? flash('Member turned back on.', false) : flash(q.get('err') ? 'That did not work. Reload the page and try again.' : null);
  const rowsHtml = players.map((p) => html`<tr>
    <td><b>${p.online_id}</b> ${p.disabled === 1 ? html`<span class="tag gone">Off</span>` : ''}</td><td>${p.user_id}</td><td>${p.username}</td>
    <td class="muted">${new Date(p.issued_ms).toISOString().slice(0, 10)}${p.disabled === 1 ? html`<br>off ${p.disabled_at ?? ''}${p.disabled_reason ? html`: ${p.disabled_reason}` : ''}` : ''}</td>
    <td class="ctl">${p.disabled === 1
      ? html`<form class="inline" method="post" action="/admin/members/${p.user_id}/enable">${csrfField(c)}<button class="btn light sm">Turn back on</button></form>`
      : html`<form class="inline" method="post" action="/admin/members/${p.user_id}/disable">${csrfField(c)}<input class="reason" type="text" name="reason" maxlength="120" placeholder="Reason (the member sees it)"> <button class="btn danger sm">Turn off</button></form>`}</td>
  </tr>`);
  const body = html`<h2>League members</h2>${note}
    ${box(html`Everyone with a join code <span class="muted">(${players.length})</span>`, html`<table class="list members"><thead><tr><th>In-game name</th><th>Member no.</th><th>Site username</th><th>Join code made</th><th></th></tr></thead>
      <tbody>${rowsHtml.length ? rowsHtml : html`<tr><td colspan="5" class="muted">Nobody yet.</td></tr>`}</tbody></table>
      <p class="muted">Turning a member off blocks their join code on the league server and stops them making a new one. Their site account, and anything they did in a dynasty, stays. Removing someone from one dynasty is still done by that dynasty's commissioner in the game.</p>`)}
    ${box('Recent activity', html`<table class="list"><thead><tr><th>When (UTC)</th><th>What</th><th>Account</th><th>Member no.</th><th>By</th><th>Note</th></tr></thead>
      <tbody>${log.length ? log.map((a) => html`<tr><td>${a.at}</td><td>${a.action}</td><td>${a.account_id ?? ''}</td><td>${a.user_id ?? ''}</td><td>${a.actor_account_id ?? ''}</td><td class="muted">${a.detail ?? ''}</td></tr>`) : html`<tr><td colspan="6" class="muted">Nothing yet.</td></tr>`}</tbody></table>`)}`;
  return sitePage(c, 'League members', body);
}
async function adminAction(c: SiteCtx, rawId: string, verb: string, form: FormData): Promise<Response> {
  const db = c.env.DB, userId = Number(rawId);
  if (!(await csrfOk(c.req, c.url, form)) || !Number.isSafeInteger(userId)) return redirect('/admin/members?err=1');
  const player = await getLeaguePlayerByUserId(db, userId);
  if (!player) return redirect('/admin/members?err=1');
  const off = verb === 'disable';
  const reason = off ? String(form.get('reason') ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || null : null;
  await setPlayerDisabled(db, userId, off, reason);
  await audit(db, { action: off ? 'member_disable' : 'member_enable', accountId: player.account_id, userId, actorId: c.account!.id, ipHash: await ipHash(c.req), detail: reason });
  return redirect(`/admin/members?done=${off ? 'off' : 'on'}`);
}

// ---- router --------------------------------------------------------------------------------------------------------
// Returns null for a path this module does not own. index.ts calls it for /signup, /login, /logout, /account, /admin.
export async function handleSite(req: Request, env: Env, url: URL, parts: string[]): Promise<Response | null> {
  const [a, b, c3, d] = parts, get = req.method === 'GET' || req.method === 'HEAD', post = req.method === 'POST';
  const known = (a === 'signup' && !b) || (a === 'login' && !b) || (a === 'logout' && !b) || (a === 'account' && (!b || ((b === 'name' || b === 'regenerate' || b === 'password') && !c3)))
    || (a === 'admin' && b === 'members' && (!c3 || ((d === 'disable' || d === 'enable') && parts.length === 4)));
  if (!known || (!get && !post)) return null;
  const session = await sessionAccountWithUpgrade(req, env.DB);
  const c: SiteCtx = { env, req, url, account: session.account, csrf: await csrfToken(req) };
  // a browser still holding the session under the old cookie name gets the __Host- one with the page it asked for
  const page = async (r: Response | Promise<Response>) => { const res = await r; if (session.setCookie) res.headers.append('set-cookie', session.setCookie); return res; };
  if (a === 'admin') { // not an admin: the page does not exist
    if (!isAdmin(env, c.account)) return null;
    if (get && !c3) return page(adminPage(c));
    if (post && c3 && d) return adminAction(c, c3, d, await req.formData());
    return null;
  }
  if (get) {
    if (a === 'signup') return page(signupPage(c));
    if (a === 'login') return page(loginPage(c));
    if (a === 'account' && !b) return page(accountPage(c));
    if (a === 'account' && b === 'regenerate') return page(regeneratePage(c));
    return null;
  }
  const form = await req.formData();
  if (a === 'signup') return signupAction(c, form);
  if (a === 'login') return loginAction(c, form);
  if (a === 'logout') return logoutAction(c, form);
  if (a === 'account' && b === 'name') return nameAction(c, form);
  if (a === 'account' && b === 'regenerate') return regenerateAction(c, form);
  if (a === 'account' && b === 'password') return passwordAction(c, form);
  return null;
}
