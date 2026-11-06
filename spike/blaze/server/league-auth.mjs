// Game-local credentials. These are league bearer credentials, never Sony tickets.
import crypto from 'node:crypto';
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
export function canReadContent(c, session, dynasties) {
  return !!c && !!session?.leagueAuthenticated && (c.owner === session.userId ||
    !!dynasties[c.group?.id]?.members.some(m => m.blazeId === session.userId));
}
// A joiner downloads a public dynasty's file before the membership write. Listing stays on canReadContent.
export function canReadSharedContent(c, session, dynasties) {
  if (canReadContent(c, session, dynasties)) return true;
  if (!c || !session?.leagueAuthenticated) return false;
  return canSeeInSearch(dynasties?.[c.group?.id], session, session.userId);
}
const NO_FILTER = 0x7fffffff;
// Public is the default. A dynasty is private only when something explicitly says so.
export function isPublicDynasty(d) {
  if (!d || d.private === true || d.vis === 0) return false;
  return Number(d.request?.PRIV) !== 1;
}
// An empty stored password matches any join. The password is never logged.
export function passwordMatches(d, body) {
  const expected = d?.request?.PASS == null ? '' : String(d.request.PASS);
  if (expected === '') return true;
  return String(body?.PASS ?? '') === expected;
}
export function mayJoinDynasty(d, session, body) {
  if (!d) return false;
  if (d.members?.some((m) => m.blazeId === session?.userId)) return true;
  if (!passwordMatches(d, body)) return false;
  if (isPublicDynasty(d)) return true;
  return !!session?.leagueAuthenticated && session.joinDynasties?.includes(d.id);
}
export function canSeeInSearch(d, session, userId) {
  if (!d) return false;
  if (isPublicDynasty(d)) return true;
  const id = userId ?? session?.userId;
  if (d.members?.some((m) => m.blazeId === id)) return true;
  return !!session?.leagueAuthenticated && session.joinDynasties?.includes(d.id);
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
  if (Number.isFinite(team) && team > 0 && team < 1023 && !(d.members ?? []).some((m) => m.team === team)) return false;
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
  const me = d.members.find(m => m.blazeId === session.userId);
  if (command === 6) return mayJoinDynasty(d, session, body);
  // Public dynasties can be previewed before join. Writes stay member-only.
  if (!me) return reads.has(command) && canSeeInSearch(d, session, session.userId);
  if (command === 45) {
    const team = Number(body.NWTM);
    return Number.isInteger(team) && team > 0 && team < 1023 &&
      d.members.every(m => m.blazeId === me.blazeId || m.team !== team);
  }
  if (command === 58 && body.TMID !== undefined && Number(body.TMID) !== 1023) {
    const team = Number(body.TMID);
    if (!Number.isInteger(team) || team <= 0 || team >= 1023 || (me.team && me.team !== team)
        || d.members.some(m => m.blazeId !== me.blazeId && m.team === team)) return false;
  }
  if (reads.has(command)) return true;
  if (command === 14) {
    const target = Number(body.BZID) || session.userId;
    return target === session.userId || !!me.commissioner;
  }
  if (commissioner.has(command)) return !!me.commissioner;
  if ([12,56,57].includes(command)) {
    if (d.update && d.update.byUser !== session.userId) return false;
    if (command === 12) {
      const n = Number(body.TABL), table = Buffer.from([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255]).toString('ascii');
      return /^[A-Z0-9_]{4}$/.test(table) && !!d.update && d.update.byUser === session.userId;
    }
    const kind = Number(body.UPDT);
    if (![0,1,2].includes(kind) || (kind === 0 && !me.commissioner)) return false;
    if (d.update && d.update.updt !== kind) return false;
    if (command === 57 && (kind === 1 || kind === 2)) {
      const team = Number(body.TMID);
      // 0 and 1023 mean no team yet. Backing out of a join sends that and must not be a fatal error.
      if (team !== 0 && team !== 1023 && (!Number.isInteger(team) || team <= 0 || team >= 1023 || (me.team && me.team !== team)
          || d.members.some(m => m.blazeId !== me.blazeId && m.team === team))) return false;
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
