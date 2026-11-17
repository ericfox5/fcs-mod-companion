// League identities for the public league server (migration 0030). A site account that wants to play picks an in-game
// name and is issued a league credential ("ticket"): 72 bytes = ASCII "FCSNP001" + 64 random bytes. The site stores
// only the credential's SHA-256; the plaintext leaves once, inside the member profile (a file or a "join code") that
// the setup wizard takes. The formats match spike/blaze/server/league-auth.mjs and spike/blaze/tools/league-enroll.mjs.
import type { Env } from './env.js';

export const TICKET_MAGIC = 'FCSNP001';
export const TICKET_BYTES = 72;
export const USER_ID_BASE = 800000;
export const USER_ID_MAX = 0x7fffffff;
export const ONLINE_ID_RE = /^[A-Za-z0-9_-]{3,16}$/;
export const JOIN_CODE_PREFIX = 'FCS1-';
export const PROFILE_FILENAME = 'fcs-online-profile.json';
export const DEFAULT_LEAGUE_HOST = 'play.fcs-mod.online';
export const DEFAULT_SETUP_URL = 'https://github.com/ericfox5/fcs-mod-companion/releases/latest';
const CREDENTIAL_DAYS = 3650; // as league-enroll.mjs

export const leagueHost = (env: Env) => (env.LEAGUE_SERVER_HOST ?? '').trim() || DEFAULT_LEAGUE_HOST;
export const setupUrl = (env: Env) => (env.SETUP_DOWNLOAD_URL ?? '').trim() || DEFAULT_SETUP_URL;

// ---- In-game names -------------------------------------------------------------------------------------------------
// Names nobody may take: staff-sounding names, the project's and the game's own names, placeholder names, and the test
// identities used while the league server was built. The same check covers site usernames, in-game names and the
// display names of web players. A name is read several ways before it is compared, so dressing it up does not help:
//   - lower case, with everything but letters and digits removed            "Ad-min", "E_A", "League.Admin"
//   - digits read as the letters they stand in for (1 as both i and l)       "Adm1n", "M0derat0r", "0ffic1al"
//   - digits dropped                                                          "Commish1", "Staff_2026"
// Three lists, from strict to loose, so ordinary names stay free:
//   RESERVED         the whole name is the word                               "League", "Player", "Host"
//   RESERVED_INSIDE  the word appears anywhere in the name                    "League_Admin", "xXModeratorXx", "FCS_Staff"
//   RESERVED_PART    short words that are also parts of ordinary names, so they only count as a separate part of the
//                    name (between _ - . or spaces, or at a capital letter)   "League_Mod", "ModMike", "EA_Mike"
//                    but not "Modesto", "Seahawk" or "Browner".
const RESERVED = new Set(['admin', 'admins', 'administrator', 'root', 'system', 'sysop', 'server', 'host', 'owner', 'staff', 'support', 'help', 'official',
  'moderator', 'mod', 'mods', 'commissioner', 'commish', 'league', 'leagueserver', 'ea', 'easports', 'eagames', 'electronicarts', 'tiburon', 'eatiburon',
  'ncaa', 'espn', 'sony', 'psn', 'playstation', 'rpcn', 'rpcs3', 'fcs', 'fcsmod', 'fcsmodonline', 'fcsonline', 'fcsprobe', 'fcsprobea', 'fcsprobeb', 'fcsprobec',
  'player', 'user', 'username', 'guest', 'anonymous', 'anon', 'cpu', 'computer', 'bot', 'test', 'tester', 'null', 'undefined', 'none', 'nobody', 'everyone', 'all',
  'developer', 'security', 'webmaster', 'gamemaster', 'superuser', 'operator', 'service', 'info', 'contact', 'abuse', 'billing']);
const RESERVED_INSIDE = ['admin', 'moderator', 'official', 'commissioner', 'commish', 'staff', 'sysop', 'helpdesk', 'webmaster', 'gamemaster', 'superuser',
  'leaguemod', 'sitemod', 'servermod', 'leagueowner', 'siteowner', 'serverowner', 'leaguehost', 'leaguedev', 'leaguesupport', 'techsupport', 'leagueoffice', 'leagueserver',
  'easports', 'eagames', 'electronicarts', 'eatiburon', 'fcsmod', 'fcsonline', 'fcsleague', 'fcsserver', 'fcsprobe', 'fcscompanion', 'ncaaonline', 'onlinedynasty', 'ncaabridge', 'modcompanion'];
const RESERVED_PART = new Set(['mod', 'mods', 'staff', 'owner', 'support', 'sysop', 'ea']);
// Ordinary words that happen to contain a reserved one; they are taken out before the "inside" check.
const ORDINARY = ['stafford', 'flagstaff', 'falstaff', 'distaff', 'badminton'];
const LEET: Record<string, string> = { '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g' };
// Lower case, letters and digits only.
export const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
// The ways a (lower-case, letters-and-digits) name can be read.
function readings(key: string): string[] {
  const swap = (one: string) => key.replace(/[0-9]/g, (d) => (d === '1' ? one : LEET[d] ?? d));
  return [...new Set([key, swap('i'), swap('l'), key.replace(/[0-9]/g, '')])].filter(Boolean);
}
export function isReservedName(name: string): boolean {
  const whole = readings(nameKey(name));
  if (whole.some((r) => RESERVED.has(r))) return true;
  if (whole.some((r) => { const rest = ORDINARY.reduce((t, w) => t.split(w).join(' '), r); return RESERVED_INSIDE.some((w) => rest.includes(w)); })) return true;
  const parts = name.split(/[^A-Za-z0-9]+/).flatMap((p) => p.split(/(?<=[a-z0-9])(?=[A-Z])/)).filter(Boolean);
  // a part with fewer than two letters ("34", "E4") is a number, not a word in disguise: digits are not read as letters there
  return parts.some((p) => { const k = nameKey(p); return ((k.match(/[a-z]/g) ?? []).length >= 2 ? readings(k) : [k, k.replace(/[0-9]/g, '')]).some((r) => RESERVED_PART.has(r)); });
}
// What is wrong with the name ('format' or 'reserved'), or null when it is fine. Uniqueness is checked against the database.
export function onlineIdProblem(name: string): 'format' | 'reserved' | null {
  if (!ONLINE_ID_RE.test(name)) return 'format';
  return isReservedName(name) ? 'reserved' : null;
}
// A web player's display name (pages/members.ts): 2 to 24 plain letters, digits, spaces and _ . ' -, starting with a
// letter or digit. Plain ASCII only, so a look-alike letter from another alphabet cannot be used to copy a name.
export const DISPLAY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.'-]{1,23}$/;
export function displayNameProblem(name: string): 'format' | 'reserved' | null {
  if (!DISPLAY_NAME_RE.test(name)) return 'format';
  return isReservedName(name) ? 'reserved' : null;
}
// One key for every name that looks the same at a glance: lower case, letters and digits only, with the characters
// people swap for each other folded together (0/o, 1/i/l, 5/s, rn/m, vv/w ...). Used to keep anyone from registering a
// look-alike of an admin's username (account-rules.ts).
export const lookalikeKey = (s: string) => nameKey(s).replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[0-9il]/g, (c) => (c === '1' || c === 'i' || c === 'l' ? 'l' : LEET[c] ?? c));

// ---- Credentials and profiles ---------------------------------------------------------------------------------------
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
export function newTicket(): Uint8Array {
  const t = new Uint8Array(TICKET_BYTES);
  t.set(new TextEncoder().encode(TICKET_MAGIC), 0);
  crypto.getRandomValues(t.subarray(TICKET_MAGIC.length));
  return t;
}
export const ticketSha256 = async (ticket: Uint8Array) => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', ticket)));

// What the member is handed: the shape league-enroll.mjs writes, plus the server to connect to.
export interface MemberProfile { version: 1; userId: number; onlineId: string; ticketHex: string; issuedMs: number; expiresMs: number; server: string }
export const buildProfile = (userId: number, onlineId: string, ticket: Uint8Array, issuedMs: number, server: string): MemberProfile =>
  ({ version: 1, userId, onlineId, ticketHex: toHex(ticket), issuedMs, expiresMs: issuedMs + CREDENTIAL_DAYS * 86400_000, server });
const b64url = (bytes: Uint8Array) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
// "FCS1-" + base64url (no padding) of the profile's compact UTF-8 JSON.
export const joinCode = (p: MemberProfile) => JOIN_CODE_PREFIX + b64url(new TextEncoder().encode(JSON.stringify(p)));
export const profileFileText = (p: MemberProfile) => JSON.stringify(p, null, 2) + '\n';
export function parseJoinCode(code: string): MemberProfile | null {
  if (!code.startsWith(JOIN_CODE_PREFIX)) return null;
  try {
    const b64 = code.slice(JOIN_CODE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))) as MemberProfile;
  } catch { return null; }
}

// ---- Database -------------------------------------------------------------------------------------------------------
export interface LeaguePlayerRow { account_id: number; user_id: number; online_id: string; ticket_sha256: string; issued_ms: number; expires_ms: number; disabled: number; disabled_at: string | null; disabled_reason: string | null; created_at: string; updated_at: string }
export interface LeaguePlayerListRow extends LeaguePlayerRow { username: string }
const rows = async <T>(stmt: D1PreparedStatement) => (await stmt.all<T>()).results;

export const getLeaguePlayer = (db: D1Database, accountId: number) => db.prepare('SELECT * FROM league_players WHERE account_id = ?').bind(accountId).first<LeaguePlayerRow>();
export const getLeaguePlayerByUserId = (db: D1Database, userId: number) => db.prepare('SELECT * FROM league_players WHERE user_id = ?').bind(userId).first<LeaguePlayerRow>();
export const listLeaguePlayers = (db: D1Database) => rows<LeaguePlayerListRow>(db.prepare('SELECT p.*, a.username FROM league_players p JOIN accounts a ON a.id = p.account_id ORDER BY p.user_id'));

// nameKey() in SQL, for the characters a stored name can have between its letters and digits.
const sqlNameKey = (col: string) => `lower(replace(replace(replace(replace(replace(${col}, '_', ''), '-', ''), ' ', ''), '.', ''), '''', ''))`;
// An in-game name is taken when another league member has it, when it is the name of a console member already playing
// in a dynasty the site mirrors (unless that console member is this very account), or when it is the display name of a
// web player (unless that web player is this account). Names are compared by nameKey: case, _ - . and spaces do not
// make a different name, so "Coach_K" and "coachk" cannot both exist, and neither kind of name can copy the other.
export async function onlineIdTaken(db: D1Database, name: string, accountId: number, ownBlazeId: number | null): Promise<boolean> {
  const key = nameKey(name);
  if (await db.prepare(`SELECT 1 AS x FROM league_players WHERE ${sqlNameKey('online_id')} = ? AND account_id <> ?`).bind(key, accountId).first()) return true;
  if (await db.prepare(`SELECT 1 AS x FROM od_members WHERE web_only = 0 AND ${sqlNameKey('persona')} = ? AND blaze_id <> ?`).bind(key, ownBlazeId ?? 0).first()) return true;
  return !!(await db.prepare(`SELECT 1 AS x FROM od_members m WHERE m.web_only = 1 AND ${sqlNameKey('m.persona')} = ?
    AND NOT EXISTS (SELECT 1 FROM account_members l WHERE l.dynasty_id = m.dynasty_id AND l.blaze_id = m.blaze_id AND l.account_id = ?)`).bind(key, accountId).first());
}
// A web player's display name is taken when it is (by nameKey) a league member's in-game name or the name of a console
// member in any dynasty: on the members page and in Supersim the two would be indistinguishable.
export async function displayNameTaken(db: D1Database, name: string): Promise<boolean> {
  const key = nameKey(name);
  if (await db.prepare(`SELECT 1 AS x FROM league_players WHERE ${sqlNameKey('online_id')} = ?`).bind(key).first()) return true;
  return !!(await db.prepare(`SELECT 1 AS x FROM od_members WHERE web_only = 0 AND ${sqlNameKey('persona')} = ?`).bind(key).first());
}

export type EnrollResult = { ok: true; player: LeaguePlayerRow } | { ok: false; reason: 'taken' | 'exists' | 'full' };
// Gives the account its league identity: allocates the user id (800000 and up, never reused), stores the name and the
// credential hash, and, when the account stands for no console persona yet, makes the new user id its persona so the
// site recognises the member in every dynasty they create or join on the league server (see session.ts).
export async function enrollPlayer(db: D1Database, accountId: number, onlineId: string, sha: string, issuedMs: number, expiresMs: number): Promise<EnrollResult> {
  if (await getLeaguePlayer(db, accountId)) return { ok: false, reason: 'exists' };
  await db.prepare('INSERT OR IGNORE INTO league_user_ids (account_id) VALUES (?)').bind(accountId).run();
  const alloc = await db.prepare('SELECT id FROM league_user_ids WHERE account_id = ?').bind(accountId).first<{ id: number }>();
  const userId = Number(alloc?.id ?? 0) + USER_ID_BASE - 1;
  if (!alloc || !Number.isSafeInteger(userId) || userId < USER_ID_BASE || userId > USER_ID_MAX) return { ok: false, reason: 'full' };
  try {
    await db.batch([
      db.prepare('INSERT INTO league_players (account_id, user_id, online_id, ticket_sha256, issued_ms, expires_ms) VALUES (?,?,?,?,?,?)').bind(accountId, userId, onlineId, sha, issuedMs, expiresMs),
      db.prepare('UPDATE OR IGNORE accounts SET blaze_id = ? WHERE id = ? AND blaze_id IS NULL').bind(userId, accountId),
    ]);
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String((e as Error)?.message ?? e))) return { ok: false, reason: (await getLeaguePlayer(db, accountId)) ? 'exists' : 'taken' };
    throw e;
  }
  const player = await getLeaguePlayer(db, accountId);
  return player ? { ok: true, player } : { ok: false, reason: 'taken' };
}
// Replaces the credential hash: the old credential stops working the next time the league server pulls the registry.
// A disabled member cannot get a new one. Returns false when nothing changed.
export async function replaceCredential(db: D1Database, accountId: number, sha: string, issuedMs: number, expiresMs: number): Promise<boolean> {
  const r = await db.prepare("UPDATE league_players SET ticket_sha256 = ?, issued_ms = ?, expires_ms = ?, updated_at = datetime('now') WHERE account_id = ? AND disabled = 0").bind(sha, issuedMs, expiresMs, accountId).run();
  return !!r.meta.changes;
}
export async function setPlayerDisabled(db: D1Database, userId: number, disabled: boolean, reason: string | null): Promise<boolean> {
  const r = disabled
    ? await db.prepare("UPDATE league_players SET disabled = 1, disabled_at = datetime('now'), disabled_reason = ?, updated_at = datetime('now') WHERE user_id = ?").bind(reason, userId).run()
    : await db.prepare("UPDATE league_players SET disabled = 0, disabled_at = NULL, disabled_reason = NULL, updated_at = datetime('now') WHERE user_id = ?").bind(userId).run();
  return !!r.meta.changes;
}

export type AuditAction = 'signup' | 'invite_signup' | 'credential_issue' | 'credential_regenerate' | 'member_disable' | 'member_enable' | 'password_change';
export interface AuditRow { id: number; at: string; action: string; account_id: number | null; user_id: number | null; actor_account_id: number | null; ip_hash: string | null; detail: string | null }
export const audit = (db: D1Database, a: { action: AuditAction; accountId: number | null; userId?: number | null; actorId: number | null; ipHash?: string | null; detail?: string | null }) =>
  db.prepare('INSERT INTO league_audit (action, account_id, user_id, actor_account_id, ip_hash, detail) VALUES (?,?,?,?,?,?)').bind(a.action, a.accountId, a.userId ?? null, a.actorId, a.ipHash ?? null, a.detail ?? null).run();
export const listAudit = (db: D1Database, limit = 50) => rows<AuditRow>(db.prepare('SELECT * FROM league_audit ORDER BY id DESC LIMIT ?').bind(limit));

// ---- Registry (what the league server pulls) ------------------------------------------------------------------------
export interface RegistryPlayer { userId: number; onlineId: string; ticketSha256: string; joinDynasties: number[]; disabled: boolean }
// Every member with a credential, lowest user id first. A banned member, or one whose credential has run out, is
// listed with disabled: true so the league server also drops connections it already accepted. joinDynasties stays
// empty: public dynasties need no grant, and the site has no private-dynasty grants to hand out yet.
export async function registryPlayers(db: D1Database, now = Date.now()): Promise<RegistryPlayer[]> {
  const list = await rows<Pick<LeaguePlayerRow, 'user_id' | 'online_id' | 'ticket_sha256' | 'expires_ms' | 'disabled'>>(db.prepare('SELECT user_id, online_id, ticket_sha256, expires_ms, disabled FROM league_players ORDER BY user_id'));
  return list.map((p) => ({ userId: p.user_id, onlineId: p.online_id, ticketSha256: p.ticket_sha256, joinDynasties: [], disabled: p.disabled === 1 || p.expires_ms <= now }));
}
