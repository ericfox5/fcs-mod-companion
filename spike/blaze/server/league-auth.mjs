// Game-local credentials. These are league bearer credentials, never Sony tickets.
import crypto from 'node:crypto';
import { updateLockSeconds } from './cloud-config.mjs';
export const MAGIC = Buffer.from('FCSNP001');
export const digest = b => crypto.createHash('sha256').update(b).digest('hex');
export function validateRegistry(registry) {
  if (registry?.version !== 1 || !Array.isArray(registry.players)) throw new Error('Invalid league registry');
  const ids = new Set(), hashes = new Set();
  for (const p of registry.players) {
    if (!Number.isSafeInteger(p.userId) || p.userId <= 0 || p.userId > 0x7fffffff || !/^[A-Za-z0-9_-]{3,16}$/.test(p.onlineId)
        || !/^[a-f0-9]{64}$/.test(p.ticketSha256) || ids.has(p.userId) || hashes.has(p.ticketSha256)
        || !Array.isArray(p.joinDynasties) || p.joinDynasties.some(x => !Number.isSafeInteger(x) || x <= 0))
      throw new Error('Invalid or duplicate league identity');
    ids.add(p.userId); hashes.add(p.ticketSha256);
  }
  return registry;
}
export function authenticate(ticket, registry) {
  validateRegistry(registry);
  if (ticket.length !== 72 || !ticket.subarray(0, 8).equals(MAGIC)) throw new Error('Invalid league credential');
  const hash = Buffer.from(digest(ticket), 'hex');
  const p = registry.players.find(p => crypto.timingSafeEqual(Buffer.from(p.ticketSha256, 'hex'), hash));
  if (!p || p.disabled) throw new Error('Unknown or revoked league credential');
  return { userId: p.userId, onlineId: p.onlineId, personaId: p.userId,
    credentialSha256: p.ticketSha256, joinDynasties: [...p.joinDynasties], leagueAuthenticated: true };
}
// A dynasty's members, whatever the stored record looks like (old data has dynasties with no members at all).
export const membersOf = (d) => (Array.isArray(d?.members) ? d.members : []);
export const commissionerOf = (d) => membersOf(d).find((m) => m.commissioner) ?? membersOf(d)[0] ?? null;
// MHUM from the create request: how many people the commissioner allowed (the game's own maximum is 12).
export function maxHumans(d) { const n = Number(d?.request?.MHUM); return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 12; }
// Members the commissioner removed: they cannot rejoin until the commissioner invites them again (dod.mjs).
export const isRemovedMember = (d, userId) => Array.isArray(d?.removed) && d.removed.some((r) => r?.blazeId === userId);

// ---- the update lock (StartDynastyUpdate ... EndDynastyUpdate) ----
// d.update = { updt, byUser, startedAt, lastAt, touched }. It is only a lock while its holder keeps using it: after
// NCAA_UPDATE_LOCK_SECONDS (default 300) without a StartDynastyUpdate, sendTableUpdate or EndDynastyUpdate from the
// holder it no longer counts (dod.mjs then removes it). A record without times (written by an older server) has no
// age to judge; those are cleared when the server starts.
const unixNow = () => Math.floor(Date.now() / 1000);
let lockIdle = null;
export const lockIdleSeconds = () => (lockIdle ??= updateLockSeconds());
export function activeUpdate(d, now = unixNow()) {
  const u = d?.update;
  if (!u || typeof u !== 'object') return null;
  const at = u.lastAt ?? u.startedAt;
  return typeof at === 'number' && now - at > lockIdleSeconds() ? null : u;
}

export function canReadContent(c, session, dynasties) {
  return !!c && !!session?.leagueAuthenticated && (c.owner === session.userId ||
    membersOf(dynasties?.[c.group?.id]).some(m => m.blazeId === session.userId));
}
// A joiner downloads a public dynasty's file before the membership write. Listing stays on canReadContent.
// A dynasty with a password hands its files to members, and to someone who has given the password in this session.
export function canReadSharedContent(c, session, dynasties) {
  if (canReadContent(c, session, dynasties)) return true;
  if (!c || !session?.leagueAuthenticated) return false;
  return mayPreviewDynasty(dynasties?.[c.group?.id], session, session.userId);
}
const NO_FILTER = 0x7fffffff;
// Public is the default. A dynasty is private only when something explicitly says so.
export function isPublicDynasty(d) {
  if (!d || d.private === true || d.vis === 0) return false;
  return Number(d.request?.PRIV) !== 1;
}
// ---- dynasty passwords ----
// Stored as a salted scrypt hash in dynasty.passwordHash ("scrypt$N$r$p$<salt base64>$<key base64>"), never as text.
// dynasty.request.PASS (where the game's createDynasty request put the plain password, and what the site sync uploads
// with the other settings) is emptied when the hash is made. Nothing can read a password back: the game is sent an
// empty PASS, as it always was for someone who is not a member.
const SCRYPT = { N: 16384, r: 8, p: 1 }, KEY_BYTES = 32;
const HASH_FORM = /^scrypt\$(\d{1,7})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9+/]{8,88}={0,2})\$([A-Za-z0-9+/]{22,88}={0,2})$/;
export const isPasswordHash = (v) => typeof v === 'string' && HASH_FORM.test(v);
export function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = crypto.scryptSync(Buffer.from(String(password), 'utf8'), salt, KEY_BYTES, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
// Constant-time check of a password against a stored hash. Parameters come from the stored string, within bounds, so
// an edited file cannot make one check take minutes or gigabytes.
export function verifyPassword(password, stored) {
  const m = typeof stored === 'string' ? HASH_FORM.exec(stored) : null;
  if (!m) return false;
  const N = Number(m[1]), r = Number(m[2]), p = Number(m[3]);
  if (N < 1024 || N > 131072 || (N & (N - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 4) return false;
  const want = Buffer.from(m[5], 'base64');
  if (want.length < 16 || want.length > 64) return false;
  let got;
  try { got = crypto.scryptSync(Buffer.from(String(password), 'utf8'), Buffer.from(m[4], 'base64'), want.length, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }); } catch { return false; }
  return crypto.timingSafeEqual(got, want);
}
const plainPassword = (d) => (d?.request?.PASS == null ? '' : String(d.request.PASS));
export const hasPassword = (d) => isPasswordHash(d?.passwordHash) || plainPassword(d) !== '';
// Replaces a plain password (a dynasty stored by an older server, or one just created) with its hash.
// Returns true when the dynasty changed and must be saved.
export function protectDynastyPassword(d) {
  const plain = plainPassword(d);
  if (plain === '') return false;
  d.passwordHash = hashPassword(plain);
  d.request.PASS = '';
  return true;
}
// Wrong guesses are slow on purpose (scrypt), so they are also counted: after a few in a minute the answer is "no"
// without doing the work. A correct password is remembered for the session that gave it (a join is checked twice).
const WRONG_PER_MINUTE = 10, wrong = new Map(); // "user:dynasty" -> { start, count }
const proven = new WeakMap(); // session -> Map(dynasty id -> { mark: the stored hash, digest: of the password given })
function tooManyWrong(k, now) { const e = wrong.get(k); return !!e && now - e.start < 60000 && e.count >= WRONG_PER_MINUTE; }
function noteWrong(k, now) {
  let e = wrong.get(k);
  if (!e || now - e.start >= 60000) {
    if (wrong.size >= 20000) { for (const [x, v] of wrong) if (now - v.start >= 60000) wrong.delete(x); if (wrong.size >= 20000) wrong.delete(wrong.keys().next().value); }
    e = { start: now, count: 0 }; wrong.set(k, e);
  }
  e.count++;
}
const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest();
// An empty stored password matches any join. The password is never logged.
export function passwordMatches(d, body, session = null) {
  const stored = isPasswordHash(d?.passwordHash) ? d.passwordHash : '';
  const legacy = stored ? '' : plainPassword(d); // a record not converted yet (conversion happens when the store is loaded)
  if (!stored && legacy === '') return true;
  const mark = stored || 'plain', given = sha256(body?.PASS ?? '');
  const mine = session && typeof session === 'object' ? proven.get(session) : null;
  const hit = mine?.get(d.id);
  if (hit && hit.mark === mark && crypto.timingSafeEqual(hit.digest, given)) return true;
  const k = `${session?.userId ?? 0}:${d?.id ?? 0}`, now = Date.now();
  if (tooManyWrong(k, now)) return false;
  const ok = stored ? verifyPassword(String(body?.PASS ?? ''), stored) : crypto.timingSafeEqual(given, sha256(legacy));
  if (!ok) { noteWrong(k, now); return false; }
  if (stored && session && typeof session === 'object') { if (mine) mine.set(d.id, { mark, digest: given }); else proven.set(session, new Map([[d.id, { mark, digest: given }]])); }
  return true;
}
// Has this session already given the dynasty's current password (a join, or CheckDynastyPassword)?
export function passwordProven(d, session) {
  if (!isPasswordHash(d?.passwordHash) || !session || typeof session !== 'object') return false;
  return proven.get(session)?.get(d.id)?.mark === d.passwordHash;
}
export function mayJoinDynasty(d, session, body) {
  if (!d) return false;
  const members = membersOf(d);
  if (members.some((m) => m.blazeId === session?.userId)) return true;
  if (!members.length) return false; // nobody runs it: not joinable (a joiner would be a member with no commissioner)
  if (isRemovedMember(d, session?.userId)) return false; // removed by the commissioner: only an invitation re-admits
  if (members.length >= maxHumans(d)) return false; // the dynasty is full (MHUM)
  if (!passwordMatches(d, body, session)) return false;
  if (isPublicDynasty(d)) return true;
  return !!session?.leagueAuthenticated && session.joinDynasties?.includes(d.id);
}
export function canSeeInSearch(d, session, userId) {
  if (!d || !membersOf(d).length) return false; // a dynasty nobody is in is not listed
  if (isPublicDynasty(d)) return true;
  const id = userId ?? session?.userId;
  if (membersOf(d).some((m) => m.blazeId === id)) return true;
  return !!session?.leagueAuthenticated && session.joinDynasties?.includes(d.id);
}
// Anything beyond the search listing (status, file ids, files, tables). Members always. Someone who is not a member:
// only a dynasty they can see in search, and when it has a password only after giving it in this session.
export function mayPreviewDynasty(d, session, userId) {
  if (!canSeeInSearch(d, session, userId)) return false;
  const id = userId ?? session?.userId;
  if (membersOf(d).some((m) => m.blazeId === id)) return true;
  return !hasPassword(d) || passwordProven(d, session);
}
function filterOpen(v) {
  if (v === undefined || v === null) return true;
  const n = Number(v);
  return !Number.isFinite(n) || n < 0 || n >= NO_FILTER;
}
export function matchesDynastyQuery(d, body) {
  const query = String(body?.NAME ?? '').toLowerCase();
  if (query && !String(d.request?.NAME ?? '').toLowerCase().includes(query)) return false;
  const team = Number(body?.TEAM ?? 0);
  if (Number.isFinite(team) && team > 0 && team < 1023 && !membersOf(d).some((m) => m.team === team)) return false;
  for (const key of ['DSKL', 'OSKL', 'USKL', 'QTR']) {
    if (filterOpen(body?.[key])) continue;
    if (Number(d.request?.[key] ?? 0) !== Number(body[key])) return false;
  }
  if (!filterOpen(body?.PRIV)) {
    const priv = Number(body.PRIV);
    if (priv === 0 && !isPublicDynasty(d)) return false;
    if (priv === 1 && isPublicDynasty(d)) return false;
  }
  return true;
}
const reads = new Set([4,5,11,19,20,21,23,25,26,41,46,47,48,49,50,51,52,53,54,55,58,59,61,62,63,64,69,70,71,76,77,83,93,107]);
const commissioner = new Set([3,8,14,27,29,32,44,67,68,72,80,81,86,87,88,89,90,91,103]);
export function authorizeDod(command, body, session, store, content) {
  if (!session?.leagueAuthenticated) return false;
  if (body.TABL !== undefined) {
    const n = Number(body.TABL), table = Buffer.from([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255]).toString('ascii');
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff || !/^[A-Z0-9_]{4}$/.test(table)) return false;
  }
  if ([1,2,9,13,22].includes(command)) return true;
  const did = Number(body.DID ?? body.DYID ?? body.DYNI ?? 0), d = store.dynasties[did];
  // Hub reads have no dynasty id. SetMaxOwnedDynasties (67) is an account setting sent the same way.
  if (!did && (command === 67 || command === 69 || command === 70 || command === 93)) return true;
  if (!d) return false;
  const members = membersOf(d);
  const me = members.find(m => m.blazeId === session.userId);
  if (command === 6) return mayJoinDynasty(d, session, body);
  // CheckDynastyPassword: anyone who can see the dynasty may try its password (guesses are counted and slowed).
  if (command === 100) return canSeeInSearch(d, session, session.userId);
  // Public dynasties can be previewed before join; one with a password only after the password was given.
  // Writes stay member-only.
  if (!me) return reads.has(command) && mayPreviewDynasty(d, session, session.userId);
  if (command === 45) {
    const team = Number(body.NWTM);
    return Number.isInteger(team) && team > 0 && team < 1023 &&
      members.every(m => m.blazeId === me.blazeId || m.team !== team);
  }
  if (command === 58 && body.TMID !== undefined && Number(body.TMID) !== 1023) {
    const team = Number(body.TMID);
    if (!Number.isInteger(team) || team <= 0 || team >= 1023 || (me.team && me.team !== team)
        || members.some(m => m.blazeId !== me.blazeId && m.team === team)) return false;
  }
  if (reads.has(command)) return true;
  if (command === 14) {
    const target = Number(body.BZID) || session.userId;
    return target === session.userId || !!me.commissioner;
  }
  if (commissioner.has(command)) return !!me.commissioner;
  if ([12,56,57].includes(command)) {
    const upd = activeUpdate(d); // a lock its holder stopped using does not count
    const mine = !!upd && upd.byUser === session.userId;
    if (upd && !mine) {
      // Someone else is updating. A commissioner may start an update over a member's (the member's is dropped);
      // nobody else gets in, and a commissioner's own update is never taken over.
      const holder = members.find(m => m.blazeId === upd.byUser);
      if (!(command === 56 && me.commissioner && !holder?.commissioner)) return false;
    }
    if (command === 12) {
      const n = Number(body.TABL), table = Buffer.from([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255]).toString('ascii');
      return /^[A-Z0-9_]{4}$/.test(table) && mine;
    }
    const kind = Number(body.UPDT);
    if (![0,1,2].includes(kind) || (kind === 0 && !me.commissioner)) return false;
    if (command === 57 && mine && upd.updt !== kind) return false; // an update ends as the kind it started as
    if (command === 57 && (kind === 1 || kind === 2)) {
      const team = Number(body.TMID);
      // 0 and 1023 mean no team yet. Backing out of a join sends that and must not be a fatal error.
      if (team !== 0 && team !== 1023 && (!Number.isInteger(team) || team <= 0 || team >= 1023 || (me.team && me.team !== team)
          || members.some(m => m.blazeId !== me.blazeId && m.team === team))) return false;
    }
    if (command === 57 && Number(body.FID)) {
      const c = content(Number(body.FID));
      if (!c || c.owner !== session.userId || (c.group && c.group.id !== did)) return false;
    }
    return true;
  }
  if (command === 24) return Number(body.TMID) === me.team &&
    [Number(body.HTID),Number(body.ATID)].includes(me.team) && Number(body.GMWK) === d.week;
  if ([28,84].includes(command)) return body.TMID === undefined || Number(body.TMID) === me.team;
  // Unimplemented or unreviewed writes are not granted by a successful login.
  return false;
}
