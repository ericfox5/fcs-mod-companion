// Who is using the site. Two layers:
//  - Accounts + sessions (migration 0008): the `od_session` cookie carries a random token whose SHA-256 is a sessions
//    row; that row's account belongs to one od_members persona, which becomes the acting member. Once a dynasty has at
//    least one account it is "locked": only signed-in members act, the persona cookie below is ignored and nobody is
//    auto-selected. Accounts are created from invite codes (the first one from the bridge, later ones by a signed-in
//    commissioner on /members).
//  - Before any account exists (locked = false): the plain persona cookie `od_member=<blaze_id>` chosen from the
//    dynasty's members, and a single-member dynasty auto-selects that member. Unchanged from the one-commissioner days.
import type { MemberRow, AccountRow } from './db/queries.js';
import { getMembersWithTeams, countAccounts, getSession, touchSession, insertSession } from './db/queries.js';

export const MEMBER_COOKIE = 'od_member';
export const SESSION_COOKIE = 'od_session';
const DAY_MS = 86400_000;
const SESSION_DAYS = 30, RENEW_DAYS = 7;
const PBKDF2_ITERATIONS = 100_000; // Workers cap PBKDF2 at 100k iterations
const HASH_PREFIX = `pbkdf2-sha256$${PBKDF2_ITERATIONS}$`;
export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,24}$/;
export const PASSWORD_MIN = 8;

export interface AccountInfo { id: number; username: string }
export interface Auth {
  member: MemberRow | null; members: MemberRow[];
  account: AccountInfo | null; // signed-in account, when the od_session cookie is valid for this dynasty
  locked: boolean; // the dynasty has at least one account: persona cookie ignored, no auto-select
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

// Sessions: 32 random bytes in the cookie, SHA-256 hex in the table, 30 days, renewed when under 7 days remain.
export const sessionCookie = (token: string) => `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
export const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
export async function createSession(db: D1Database, accountId: number, dynastyId: number): Promise<string> {
  const token = randomHex(32);
  await insertSession(db, await sha256Hex(token), accountId, dynastyId, expiryStamp());
  return sessionCookie(token);
}
export const sessionHashFromRequest = async (req: Request): Promise<string | null> => { const t = readCookie(req, SESSION_COOKIE); return t && /^[0-9a-f]{64}$/.test(t) ? sha256Hex(t) : null; };

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
export const safeBack = (v: unknown, dflt: string) => { const s = String(v ?? ''); return s.startsWith('/') && !s.startsWith('//') ? s : dflt; };

// The acting member for this request. See the header comment for the two modes. The viewer's { locked, account } is also
// stamped on every member row (MemberRow.auth) so layout() can draw the top bar from the `members` pages already pass.
export async function currentMember(req: Request, db: D1Database, dynastyId: number): Promise<Auth> {
  const [members, accounts] = await Promise.all([getMembersWithTeams(db, dynastyId), countAccounts(db, dynastyId)]);
  const locked = accounts > 0;
  const done = (member: MemberRow | null, account: AccountInfo | null, setCookie?: string): Auth => {
    for (const m of members) m.auth = { locked, account };
    return { member, members, account, locked, setCookie };
  };
  const token = readCookie(req, SESSION_COOKIE);
  if (token && /^[0-9a-f]{64}$/.test(token)) {
    const hash = await sha256Hex(token);
    const s = await getSession(db, hash);
    if (s && s.dynasty_id === dynastyId) {
      let setCookie: string | undefined;
      if (parseStamp(s.expires_at) - Date.now() < RENEW_DAYS * DAY_MS) { await touchSession(db, hash, expiryStamp()); setCookie = sessionCookie(token); }
      return done(members.find((m) => m.blaze_id === s.blaze_id) ?? null, { id: s.account_id, username: s.username }, setCookie);
    }
  }
  if (locked) return done(null, null);
  const want = Number(readCookie(req, MEMBER_COOKIE));
  return done(members.find((m) => m.blaze_id === want) ?? (members.length === 1 ? members[0]! : null), null);
}

export const memberCookie = (blazeId: number) => `${MEMBER_COOKIE}=${blazeId}; Path=/; Max-Age=31536000; SameSite=Lax`;
export const redirect = (to: string, headers: Record<string, string> = {}) => new Response(null, { status: 303, headers: { location: to, ...headers } });
