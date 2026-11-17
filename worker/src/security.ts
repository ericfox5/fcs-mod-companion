// Guardrails for a site that takes sign-ups from the open internet: constant-time comparison, CSRF tokens, rate
// limits kept in D1 (so they work on Cloudflare's free plan, with no paid rate-limiting product), the optional
// Turnstile check on sign-up, and the security headers every response carries.
import type { Env } from './env.js';
import { readCookie, sha256Hex, sessionToken } from './session.js';

const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const TOKEN_RE = /^[0-9a-f]{64}$/;

// Constant-time string compare. Different lengths still run the loop, so the time does not give the length away.
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i % (b.length || 1));
  return diff === 0;
}

// The visitor's address as Cloudflare reports it, and the short hash that is all the site ever stores of it.
// `clientAddress` is the address as sent (only for Turnstile's remoteip). `clientIp` is the key the per-address limits
// use: an IPv6 address is cut to its /64 (what a home or a server is handed), so one subscriber cannot dodge a limit by
// hopping around their own block. `clientNet` is coarser, for the number of accounts one network may create: IPv6 is cut
// to the /48, the block a provider typically gives one customer (a /64 key would let a single /48 pass for 65,536
// different addresses). IPv4, and IPv4 written as IPv6 (::ffff:a.b.c.d), are used whole in both.
export const clientAddress = (req: Request): string => (req.headers.get('cf-connecting-ip') ?? '').trim().toLowerCase() || 'unknown';
// The eight groups of an IPv6 address ("::" filled in, leading zeros dropped), or null when the text is not one.
export function ipv6Groups(ip: string): string[] | null {
  let s = ip.split('%')[0]!;
  const v4 = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) s = `${v4[1]}${((Number(v4[2]) << 8) | Number(v4[3])).toString(16)}:${((Number(v4[4]) << 8) | Number(v4[5])).toString(16)}`;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [], tail = halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (halves.length === 2 && fill < 1) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16).toString(16));
}
function addressKey(req: Request, v6Groups: number): string {
  const ip = clientAddress(req);
  if (!ip.includes(':')) return ip;
  const g = ipv6Groups(ip);
  if (!g) return ip;
  if (g.slice(0, 5).every((x) => x === '0') && g[5] === 'ffff') { const a = parseInt(g[6]!, 16), b = parseInt(g[7]!, 16); return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`; }
  return `${g.slice(0, v6Groups).join(':')}::/${v6Groups * 16}`;
}
export const clientIp = (req: Request): string => addressKey(req, 4);
export const clientNet = (req: Request): string => addressKey(req, 3);
export const ipHash = async (req: Request) => (await sha256Hex(`ip:${clientIp(req)}`)).slice(0, 32);

// ---- CSRF ----------------------------------------------------------------------------------------------------------
// Every state-changing form on the site-level pages (sign-up, sign-in, account, admin) carries a hidden `csrf` field.
// The token is the SHA-256 of a secret cookie the browser already holds: the session cookie when signed in, otherwise a
// short-lived `__Host-od_csrf` cookie set when the form is drawn. Another site can neither read those cookies (both
// HttpOnly) nor set them (`__Host-` and Secure stop a sibling subdomain from planting one), so it cannot produce the
// token. The Origin / Sec-Fetch-Site check below is a second, independent line.
export const CSRF_COOKIE = '__Host-od_csrf';
const csrfCookie = (v: string) => `${CSRF_COOKIE}=${v}; Path=/; Max-Age=7200; HttpOnly; Secure; SameSite=Lax`;
const csrfSecret = (req: Request): string | null => {
  const s = sessionToken(req)?.token; if (s) return s; // the __Host- session cookie (or, during the rename, the old-name one: session.ts)
  const c = readCookie(req, CSRF_COOKIE); return c && TOKEN_RE.test(c) ? c : null;
};
// The token to put in a form, plus the cookie to set when the browser has none yet.
export async function csrfToken(req: Request): Promise<{ token: string; setCookie?: string }> {
  const have = csrfSecret(req);
  if (have) return { token: await sha256Hex(`csrf:${have}`) };
  const fresh = toHex(crypto.getRandomValues(new Uint8Array(32)));
  return { token: await sha256Hex(`csrf:${fresh}`), setCookie: csrfCookie(fresh) };
}
// False when the request came from another site: an Origin that is not ours, or a browser saying so in Sec-Fetch-Site.
export function sameSiteRequest(req: Request, url: URL): boolean {
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin) return false;
  const site = req.headers.get('sec-fetch-site');
  return !site || site === 'same-origin' || site === 'none';
}
export async function csrfOk(req: Request, url: URL, form: FormData): Promise<boolean> {
  if (!sameSiteRequest(req, url)) return false;
  const secret = csrfSecret(req), sent = String(form.get('csrf') ?? '');
  if (!secret || !TOKEN_RE.test(sent)) return false;
  return timingSafeEqual(sent, await sha256Hex(`csrf:${secret}`));
}

// ---- Rate limits ---------------------------------------------------------------------------------------------------
// Fixed windows in the rate_limits table (migration 0030). `rateBump` counts one event in a single SQL statement and
// returns the new count, so the check and the increment cannot be split by parallel requests; `rateHit` is the same and
// says whether the caller is still within the limit. `rateCount` / `rateBlocked` only look.
//
// Sign-in (pages/login.ts) is built so that nobody can lock an owner out of their own account:
//  - `loginUserIp` is the only counter that refuses a sign-in, and it is per username AND address: each try takes a
//    slot before the password is checked, a correct password hands the slots back. Other people's wrong guesses, from
//    other addresses, never use up the owner's slots.
//  - `loginUser` counts wrong passwords for a username from anywhere. Reaching it refuses nobody; it only means the
//    name is being guessed at, and while that lasts every address gets LOGIN_GUESSED_PER_IP tries per window for that
//    name instead of loginUserIp.max, and each answer takes a little longer. A correct password still signs in.
//
// Sign-up: `signupAll` is not a ceiling but the "busy" mark (SIGNUP_DAILY_CAP). Past it, sign-up stays open: with
// Turnstile configured that check is what holds bots back; without it each network gets SIGNUP_BUSY_PER_NET new
// account a day instead of signupOkIp.max. Only SIGNUP_HARD_CAP (default 2000 a day) pauses sign-up for everyone.
export interface Limit { scope: string; max: number; windowSec: number }
export const LIMITS = {
  signupTryIp: { scope: 'signup-try-ip', max: 12, windowSec: 3600 },        // sign-up form posts per address
  signupOkIp: { scope: 'signup-ok-net', max: 3, windowSec: 86400 },         // accounts created per network (IPv4 address, IPv6 /48) per day
  signupAll: { scope: 'signup-all', max: 200, windowSec: 86400 },           // accounts created site-wide per day before the site counts as busy (SIGNUP_DAILY_CAP overrides)
  inviteTryIp: { scope: 'invite-try-ip', max: 20, windowSec: 3600 },        // invite sign-up form posts per address
  inviteOkIp: { scope: 'invite-ok-net', max: 5, windowSec: 86400 },         // accounts created from invites per network per day
  inviteIssue: { scope: 'invite-issue', max: 40, windowSec: 86400 },        // invites one commissioner account may create per day
  webPlayerAdd: { scope: 'web-add', max: 30, windowSec: 86400 },            // web players one commissioner account may add per day
  loginIp: { scope: 'login-ip', max: 30, windowSec: 900 },                  // sign-in posts per address
  loginUserIp: { scope: 'login-user-ip', max: 8, windowSec: 900 },          // sign-in tries for one username from one address (a success hands them back)
  loginUser: { scope: 'login-user', max: 20, windowSec: 3600 },             // wrong passwords for one username from anywhere: past this the name counts as "being guessed at"
  credAccount: { scope: 'cred-acct', max: 5, windowSec: 86400 },            // join codes issued per account per day
  credIp: { scope: 'cred-ip', max: 10, windowSec: 86400 },                  // join codes issued per address per day
  passwordAccount: { scope: 'pw-acct', max: 10, windowSec: 3600 },          // password checks on the account page
} satisfies Record<string, Limit>;
export const LOGIN_GUESSED_PER_IP = 3;      // tries per address and window for a username that is being guessed at
export const LOGIN_GUESSED_DELAY_MS = 1200; // extra wait on each such try
export const SIGNUP_BUSY_PER_NET = 1;       // accounts per network per day once the site is busy and Turnstile is off
export const SIGNUP_HARD_CAP_DEFAULT = 2000; // accounts site-wide per day at which sign-up pauses (SIGNUP_HARD_CAP overrides)
export const WEB_PLAYERS_MAX = 24;          // web players in one dynasty
export const OPEN_INVITES_MAX = 40;         // unused invites in one dynasty
const rateKey = async (l: Limit, subject: string) => `${l.scope}:${(await sha256Hex(`${l.scope}:${subject}`)).slice(0, 32)}`;

export async function rateBump(db: D1Database, l: Limit, subject: string, now = Date.now()): Promise<number> {
  const stale = now - l.windowSec * 1000;
  const row = await db.prepare(`INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start <= ? THEN 1 ELSE rate_limits.count + 1 END,
      window_start = CASE WHEN rate_limits.window_start <= ? THEN ? ELSE rate_limits.window_start END
    RETURNING count`).bind(await rateKey(l, subject), now, stale, stale, now).first<{ count: number }>();
  return Number(row?.count ?? 1);
}
export const rateHit = async (db: D1Database, l: Limit, subject: string, now = Date.now()): Promise<boolean> => (await rateBump(db, l, subject, now)) <= l.max;
export async function rateCount(db: D1Database, l: Limit, subject: string, now = Date.now()): Promise<number> {
  const row = await db.prepare('SELECT count FROM rate_limits WHERE key = ? AND window_start > ?').bind(await rateKey(l, subject), now - l.windowSec * 1000).first<{ count: number }>();
  return Number(row?.count ?? 0);
}
export const rateBlocked = async (db: D1Database, l: Limit, subject: string, now = Date.now()): Promise<boolean> => (await rateCount(db, l, subject, now)) >= l.max;export const rateClear = async (db: D1Database, l: Limit, subject: string) => { await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(await rateKey(l, subject)).run(); };
// Counters older than two days are of no use to any window above.
export const ratePurge = (db: D1Database, now = Date.now()) => db.prepare('DELETE FROM rate_limits WHERE window_start <= ?').bind(now - 2 * 86400_000).run();

// ---- Turnstile (optional) ------------------------------------------------------------------------------------------
// Cloudflare's free "are you a person" check on the sign-up form. It is on only when both TURNSTILE_SITE_KEY (a var)
// and TURNSTILE_SECRET_KEY (a secret) are set; with either missing the form has no widget and this returns true.
// When it is on, a missing token or an unreachable verifier refuses the sign-up.
export const turnstileOn = (env: Env) => !!env.TURNSTILE_SITE_KEY && !!env.TURNSTILE_SECRET_KEY;
export async function verifyTurnstile(env: Env, token: string, ip: string): Promise<boolean> {
  if (!turnstileOn(env)) return true;
  if (!token || token.length > 2048) return false;
  try {
    const body = new FormData();
    body.set('secret', env.TURNSTILE_SECRET_KEY!); body.set('response', token);
    if (ip !== 'unknown') body.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    return ((await res.json()) as { success?: boolean }).success === true;
  } catch { return false; }
}

// ---- Security headers ----------------------------------------------------------------------------------------------
// The site-wide Content-Security-Policy is the part that cannot break the existing pages (several use inline event
// handlers): no framing by other sites, no <base> hijack, forms post only here, no plugins. The account pages send
// STRICT_CSP instead: scripts only from this site (and Turnstile's when it is on), nothing inline.
export const BASE_CSP = "frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'";
export const STRICT_CSP = "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; "
  + "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; " + BASE_CSP;
export function withSecurityHeaders(res: Response): Response {
  if (res.status === 101) return res;
  let out = res;
  try { out.headers.set('x-content-type-options', 'nosniff'); } // asset and R2 responses have read-only headers: copy
  catch { out = new Response(res.body, res); out.headers.set('x-content-type-options', 'nosniff'); }
  const h = out.headers;
  h.set('referrer-policy', 'strict-origin-when-cross-origin');
  h.set('x-frame-options', 'SAMEORIGIN');
  h.set('strict-transport-security', 'max-age=31536000');
  h.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (!h.has('content-security-policy')) h.set('content-security-policy', BASE_CSP);
  return out;
}
