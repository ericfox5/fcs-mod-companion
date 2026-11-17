// Who is using the site. Two layers:
//  - Accounts + sessions (migrations 0008, 0023): the `__Host-od_session` cookie carries a random token whose SHA-256 is a
//    sessions row. Accounts are site-wide (one username + password, owning at most one league-server persona) and are
//    linked to the member they act as in each dynasty (account_members): a console persona automatically, by the
//    bridge's member sync and lazily here, so whoever created or joined the dynasty on the console is recognised with the
//    session they already have; a web player through their invite. Once a dynasty has at least one linked account it is
//    "locked": only signed-in members act, the persona cookie below is ignored and nobody is auto-selected. Accounts are
//    created from invite codes (the first one from the bridge, later ones by a signed-in commissioner on /members); an
//    invite can also be taken by an account that already exists.
//  - Before any account is linked (locked = false): the plain persona cookie `od_member=<blaze_id>` chosen from the
//    dynasty's members, and a single-member dynasty auto-selects that member. Unchanged from the one-commissioner days.
import type { MemberRow, AccountRow } from './db/queries.js';
import { getMembersWithTeams, countAccounts, getSession, touchSession, insertSession, linkedMemberId, linkMember } from './db/queries.js';

export const MEMBER_COOKIE = 'od_member';
// The session cookie has the `__Host-` prefix: a browser only accepts such a cookie from this exact host, over HTTPS,
// with Path=/ and no Domain, so a sibling subdomain (the league server's, say) cannot plant one. Until 2026-11 the
// cookie was called `od_session`; that name is still read for a while so nobody is signed out by the rename, under two
// conditions that keep the old name from being a way round the prefix: the session must have been created before
// LEGACY_SESSION_CUTOFF_MS (every later session was only ever handed out under the new name), and the old name stops
// being read altogether one session lifetime after the cutoff. A browser seen with the old cookie is given the new one.
export const SESSION_COOKIE = '__Host-od_session';
export const LEGACY_SESSION_COOKIE = 'od_session';
export const LEGACY_SESSION_CUTOFF_MS = Date.UTC(2026, 10, 29); // set to (or shortly after) the day the rename is deployed
const DAY_MS = 86400_000;
const SESSION_DAYS = 30, RENEW_DAYS = 7;
const PBKDF2_ITERATIONS = 100_000; // Workers cap PBKDF2 at 100k iterations
const HASH_PREFIX = `pbkdf2-sha256$${PBKDF2_ITERATIONS}$`;
export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,24}$/; // the password rules are in account-rules.ts

export interface AccountInfo { id: number; username: string; blazeId: number | null } // blazeId: the console persona the account owns
export interface Auth {
  member: MemberRow | null; members: MemberRow[];
  account: AccountInfo | null; // signed-in account, when the od_session cookie is valid and the account is a member here (or the dynasty is locked)
  locked: boolean; // the dynasty has at least one linked account: persona cookie ignored, no auto-select
  setCookie?: string; // a renewed session cookie the response should carry (sliding expiry)
}

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return decodeURIComponent(v.join('=')); }
  return null;
}

const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => new Uint8Array((h.match(/.{2}/g) ?? []).map((x) => parseInt(x, 16)));
const randomHex = (n: number) => toHex(crypto.getRandomValues(new Uint8Array(n)));
export async function sha256Hex(s: string): Promise<string> { return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))); }
// Constant-time string compare (same length required).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// SQLite datetime('now') format (UTC) so expiry compares in SQL.
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const parseStamp = (s: string) => Date.parse(s.replace(' ', 'T') + 'Z');
const expiryStamp = () => stamp(Date.now() + SESSION_DAYS * DAY_MS);

// Passwords: PBKDF2-SHA256, 100k iterations, 16-byte salt; stored as `pbkdf2-sha256$<iterations>$<hex>` + salt hex.
async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return toHex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)));
}
export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: HASH_PREFIX + (await pbkdf2(password, salt, PBKDF2_ITERATIONS)), salt: toHex(salt) };
}
export async function verifyPassword(password: string, acct: Pick<AccountRow, 'pass_hash' | 'salt'>): Promise<boolean> {
  const [algo, iter, hex] = acct.pass_hash.split('$');
  if (algo !== 'pbkdf2-sha256' || !iter || !hex) return false;
  return timingSafeEqual(await pbkdf2(password, fromHex(acct.salt), Number(iter)), hex);
}
// Equalises the time taken by a failed login whether or not the username exists.
export const burnHash = (password: string) => pbkdf2(password, new Uint8Array(16), PBKDF2_ITERATIONS);
export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Sessions: 32 random bytes in the cookie, SHA-256 hex in the table, 30 days, renewed when under 7 days remain. One
// session is good for every dynasty the account is linked to.
export const sessionCookie = (token: string) => `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
// Signing out clears both names, or a leftover old-name cookie would sign the browser straight back in.
export const clearSessionCookies = () => [SESSION_COOKIE, LEGACY_SESSION_COOKIE].map((n) => `${n}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
const TOKEN_RE = /^[0-9a-f]{64}$/;
// The session token the request carries: the `__Host-` cookie, else (during the transition) the old-name one.
export function sessionToken(req: Request, now = Date.now()): { token: string; legacy: boolean } | null {
  const t = readCookie(req, SESSION_COOKIE);
  if (t && TOKEN_RE.test(t)) return { token: t, legacy: false };
  if (now >= LEGACY_SESSION_CUTOFF_MS + SESSION_DAYS * DAY_MS) return null;
  const old = readCookie(req, LEGACY_SESSION_COOKIE);
  return old && TOKEN_RE.test(old) ? { token: old, legacy: true } : null;
}
export async function createSession(db: D1Database, accountId: number): Promise<string> {
  const token = randomHex(32);
  await insertSession(db, await sha256Hex(token), accountId, expiryStamp());
  return sessionCookie(token);
}
export const sessionHashFromRequest = async (req: Request): Promise<string | null> => { const t = sessionToken(req); return t ? sha256Hex(t.token) : null; };

// Invite codes: 16 symbols from an unambiguous alphabet (80 bits), grouped for reading aloud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const s = [...bytes].map((b) => CODE_ALPHABET[b & 31]).join('');
  return s.match(/.{4}/g)!.join('-');
}
export const normalizeCode = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 19);
export const joinUrl = (origin: string, slug: string, code: string) => `${origin}/d/${slug}/join?code=${encodeURIComponent(code)}`;

// Form helpers: a same-site POST (the session cookie is SameSite=Lax, this is belt and braces) and a safe redirect.
export const sameOrigin = (req: Request, url: URL) => { const o = req.headers.get('origin'); return !o || o === url.origin; };
// `safeBack` returns where to send the browser after a form: the value when it is a path on this site, else the
// default. A path starts with one "/", has no backslash (browsers read "/\host" as "//host") and no control character
// (browsers drop tabs and newlines, so "/<tab>/host" is "//host" too); it is then resolved against this site's origin
// and must still be on it. What comes back is the resolved path + query + fragment, never the raw text.
export function safeBack(v: unknown, dflt: string, origin = 'https://site.invalid'): string {
  const s = typeof v === 'string' ? v : '';
  if (!s.startsWith('/') || s.startsWith('//') || s.length > 2000 || /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s)) return dflt;
  try {
    const base = new URL(origin), u = new URL(s, base);
    if (u.origin !== base.origin || u.username || u.password || u.pathname.startsWith('//')) return dflt;
    return u.pathname + u.search + u.hash;
  } catch { return dflt; }
}

// The valid session behind the request's cookie, with its account, or null.
// `legacy`: it came in the old-name cookie, so the response should hand the browser the new one.
async function readSession(req: Request, db: D1Database): Promise<{ hash: string; token: string; account: AccountInfo; expiresAt: string; legacy: boolean } | null> {
  const t = sessionToken(req);
  if (!t) return null;
  const hash = await sha256Hex(t.token);
  const s = await getSession(db, hash);
  if (!s) return null;
  if (t.legacy && !(parseStamp(s.created_at) < LEGACY_SESSION_CUTOFF_MS)) return null; // a newer session is only good in the __Host- cookie
  return { hash, token: t.token, account: { id: s.account_id, username: s.username, blazeId: s.persona_blaze_id }, expiresAt: s.expires_at, legacy: t.legacy };
}
// The signed-in account regardless of dynasty (the join page uses it to offer taking an invite with an existing account).
export const sessionAccount = async (req: Request, db: D1Database): Promise<AccountInfo | null> => (await readSession(req, db))?.account ?? null;
// The same, plus the cookie to set when the browser still holds the session under the old cookie name.
export async function sessionAccountWithUpgrade(req: Request, db: D1Database): Promise<{ account: AccountInfo | null; setCookie?: string }> {
  const s = await readSession(req, db);
  return { account: s?.account ?? null, setCookie: s?.legacy ? sessionCookie(s.token) : undefined };
}

// The acting member for this request. See the header comment for the two modes. The viewer's { locked, account } is also
// stamped on every member row (MemberRow.auth) so layout() can draw the top bar from the `members` pages already pass.
export async function currentMember(req: Request, db: D1Database, dynastyId: number): Promise<Auth> {
  const [members, links] = await Promise.all([getMembersWithTeams(db, dynastyId), countAccounts(db, dynastyId)]);
  let locked = links > 0;
  const done = (member: MemberRow | null, account: AccountInfo | null, setCookie?: string): Auth => {
    for (const m of members) m.auth = { locked, account };
    return { member, members, account, locked, setCookie };
  };
  const s = await readSession(req, db);
  if (s) {
    let setCookie: string | undefined = s.legacy ? sessionCookie(s.token) : undefined; // move an old-name cookie to the __Host- name
    if (parseStamp(s.expiresAt) - Date.now() < RENEW_DAYS * DAY_MS) { await touchSession(db, s.hash, expiryStamp()); setCookie = sessionCookie(s.token); }
    const linked = await linkedMemberId(db, s.account.id, dynastyId);
    let member = linked === null ? null : members.find((m) => m.blaze_id === linked) ?? null;
    if (!member && s.account.blazeId !== null) { // the account's console persona is a member here but was synced before the account existed: link it now
      const mine = members.find((m) => m.blaze_id === s.account.blazeId && m.web_only !== 1);
      if (mine) { await linkMember(db, s.account.id, dynastyId, mine.blaze_id); member = mine; locked = true; }
    }
    if (member || locked) return done(member, s.account, setCookie);
    // signed in but not a member of this unlocked dynasty: the persona picker below applies, as for any visitor
  }
  if (locked) return done(null, null);
  const want = Number(readCookie(req, MEMBER_COOKIE));
  return done(members.find((m) => m.blaze_id === want) ?? (members.length === 1 ? members[0]! : null), null);
}

export const memberCookie = (blazeId: number) => `${MEMBER_COOKIE}=${blazeId}; Path=/; Max-Age=31536000; SameSite=Lax`;
// A header value may be a list (several Set-Cookie lines).
export function redirect(to: string, headers: Record<string, string | string[]> = {}): Response {
  const h = new Headers({ location: to });
  for (const [k, v] of Object.entries(headers)) for (const x of Array.isArray(v) ? v : [v]) h.append(k, x);
  return new Response(null, { status: 303, headers: h });
}
