// The rules every new site account has to pass, whichever way it is created: open sign-up (pages/account.ts) or a
// commissioner's invite link (pages/join.ts). Also who counts as an admin.
import type { Env } from './env.js';
import { USERNAME_RE, type AccountInfo } from './session.js';
import { isReservedName, lookalikeKey } from './league.js';

export const SIGNUP_PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;
// The passwords everyone tries first. Not a substitute for a long password, just the obvious ones.
const COMMON_PASSWORDS = new Set(['password', 'password1', 'password12', 'password123', 'password1234', '1234567890', '12345678910', '0123456789', '1111111111', '0000000000',
  'qwertyuiop', 'qwerty12345', '1q2w3e4r5t', 'iloveyou12', 'letmein123', 'football14', 'football123', 'ncaafootball', 'ncaafootball14', 'abcdefghij', 'abc1234567', 'changeme123', 'welcome123', 'adminadmin']);

// What is wrong with a new password ('pwshort' | 'pwlong' | 'pweasy'), or null.
export function passwordProblem(password: string, username: string): 'pwshort' | 'pwlong' | 'pweasy' | null {
  if (password.length < SIGNUP_PASSWORD_MIN) return 'pwshort';
  if (password.length > PASSWORD_MAX) return 'pwlong';
  const p = password.toLowerCase();
  // a listed password, one repeated character, or the username itself with digits or symbols tacked on
  const stem = (s: string) => s.replace(/[\d\W_]+$/, '');
  if (COMMON_PASSWORDS.has(p) || /^(.)\1+$/.test(p) || (!!username && stem(p) === stem(username.toLowerCase()))) return 'pweasy';
  return null;
}
export const PASSWORD_MESSAGES = {
  pwshort: `Passwords need at least ${SIGNUP_PASSWORD_MIN} characters. A short sentence works well.`,
  pwlong: `Passwords can be at most ${PASSWORD_MAX} characters.`,
  pweasy: 'That password is too easy to guess. Please pick another one.',
} as const;

// ---- Admins --------------------------------------------------------------------------------------------------------
// An admin is recognised by ACCOUNT NUMBER: ADMIN_ACCOUNT_IDS, a comma-separated list of account ids (each account's
// number is shown on its /account page). An account number is handed out once and never reused, so listing a number
// can only ever mean the account that already has it.
//
// ADMIN_USERNAMES (the older way) still works, for accounts that exist: an account whose username is on the list is an
// admin. What keeps that safe when a listed name is NOT registered yet is that a listed name can never be registered:
// usernameProblem() below is the gate both account-creating routes go through, and it refuses a listed name and
// anything that reads like one or like an admin's username ("B0SS", "b.o.s.s", "Boss_"), so listing a name before it
// exists gives the name to nobody. The owner of a listed name therefore has to create the account first (or already
// have it) and list it afterwards; better, list the account number and leave ADMIN_USERNAMES empty.
// Names are compared without regard to case, in ASCII only: a list entry or a username with any other character
// (usernames cannot have one: USERNAME_RE) never matches, so a look-alike letter from another alphabet gets nowhere.
const listOf = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
export const adminIds = (env: Env): number[] => listOf(env.ADMIN_ACCOUNT_IDS).filter((s) => /^[1-9]\d{0,14}$/.test(s)).map(Number);
export const adminNames = (env: Env): string[] => listOf(env.ADMIN_USERNAMES).filter((s) => USERNAME_RE.test(s)).map((s) => s.toLowerCase());
export function isAdmin(env: Env, account: AccountInfo | null | undefined): boolean {
  if (!account) return false;
  if (Number.isSafeInteger(account.id) && adminIds(env).includes(account.id)) return true;
  return USERNAME_RE.test(account.username) && adminNames(env).includes(account.username.toLowerCase());
}
// True when `name` is, or reads like, an admin's username: a name on ADMIN_USERNAMES (registered or not; entries with
// odd characters count here too, to be safe) or the username of an account on ADMIN_ACCOUNT_IDS.
export async function imitatesAdmin(env: Env, db: D1Database, name: string): Promise<boolean> {
  const key = lookalikeKey(name);
  if (!key) return false;
  if (listOf(env.ADMIN_USERNAMES).some((n) => lookalikeKey(n) === key)) return true;
  const ids = adminIds(env).slice(0, 50);
  if (!ids.length) return false;
  const found = await db.prepare(`SELECT username FROM accounts WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<{ username: string }>();
  return found.results.some((a) => lookalikeKey(a.username) === key);
}

// What is wrong with a username someone wants to register ('username' = badly formed, 'reserved'), or null. Whether it
// is already taken is for the database to say.
export async function usernameProblem(env: Env, db: D1Database, username: string): Promise<'username' | 'reserved' | null> {
  if (!USERNAME_RE.test(username)) return 'username';
  if (isReservedName(username) || (await imitatesAdmin(env, db, username))) return 'reserved';
  return null;
}
