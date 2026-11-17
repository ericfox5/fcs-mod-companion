// The player registry the Blaze stub authenticates against, and its sync from the website.
//
//   RegistryStore       the registry in memory, indexed by user id and credential hash. It never throws at a caller and
//                       never falls open: with nothing valid loaded it is empty, and an empty registry rejects everyone.
//   syncOnce            GET {SITE_URL}/api/bridge/league-registry with `Authorization: Bearer <bridge token>` and
//                       If-None-Match; validates the payload, writes the cache file atomically, swaps the store.
//   startRegistrySync   repeats syncOnce on a timer. An unreachable site or a bad payload keeps the last good registry.
//                       How long ago the site last confirmed the list is tracked (and survives a restart: it is the
//                       cache file's timestamp). Past warnAfterMs the log has a clear WARNING, once an hour. Past
//                       maxAgeMs the store stops taking NEW sign-ins (signInsOpen() is false) until the site answers
//                       again; sessions that are already signed in are left alone. 0 turns either off.
//
// Payload (and cache file): { version: 1, generatedAt, players: [{ userId, onlineId, ticketSha256, joinDynasties: [],
// disabled: boolean }] }. Site-issued user ids start at 800000 (minUserId); a payload naming a lower id is refused, so
// the site can never hand out an id an operator-provisioned league owner already holds.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { validateRegistry, MAGIC, digest } from './league-auth.mjs';

export const EMPTY_REGISTRY = Object.freeze({ version: 1, generatedAt: null, players: Object.freeze([]) });
const MAX_PLAYERS = 200000;

// Strict copy of a registry: only the known fields, exact types. Throws on anything unexpected.
export function normalizeRegistry(raw, { minUserId = 1 } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('registry is not an object');
  if (raw.version !== 1) throw new Error('registry version is not 1');
  if (!Array.isArray(raw.players)) throw new Error('registry has no players list');
  if (raw.players.length > MAX_PLAYERS) throw new Error('registry has too many players');
  if (raw.generatedAt !== undefined && raw.generatedAt !== null && typeof raw.generatedAt !== 'string' && typeof raw.generatedAt !== 'number') throw new Error('registry generatedAt is not a date');
  const players = raw.players.map((p, i) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error(`player ${i} is not an object`);
    if (p.disabled !== undefined && typeof p.disabled !== 'boolean') throw new Error(`player ${i}: disabled is not true or false`);
    if (typeof p.onlineId !== 'string' || typeof p.ticketSha256 !== 'string') throw new Error(`player ${i}: onlineId and ticketSha256 must be strings`);
    if (!Number.isSafeInteger(p.userId) || p.userId < minUserId) throw new Error(`player ${i}: user id is below ${minUserId}`);
    return { userId: p.userId, onlineId: p.onlineId, ticketSha256: p.ticketSha256, joinDynasties: Array.isArray(p.joinDynasties) ? [...p.joinDynasties] : p.joinDynasties, disabled: p.disabled === true };
  });
  const out = { version: 1, generatedAt: raw.generatedAt ?? null, players };
  validateRegistry(out); // ids, names, hashes, duplicates, join grants
  return out;
}

// tmp file + fsync + rename: a reader sees the old file or the new file, never half of one.
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

export class RegistryStore extends EventEmitter {
  // file: where the registry lives on disk. watch: re-read it when it changes (an operator-edited static file).
  constructor({ file = '', watch = false, minUserId = 1, log = () => {} } = {}) {
    super();
    this.file = file; this.watch = watch; this.minUserId = minUserId; this.log = log;
    this.registry = EMPTY_REGISTRY; this.byId = new Map(); this.byHash = new Map();
    this.stamp = ''; this.loadedAt = 0; this.lastError = '';
    // set by startRegistrySync: when the site last confirmed this list (ms; 0 = not tracked) and the age limit
    this.lastContact = 0; this.maxAgeMs = 0;
  }
  // How long since the site last confirmed the member list (ms); 0 when that is not tracked (a static file).
  ageMs(now = Date.now()) { return this.lastContact ? Math.max(0, now - this.lastContact) : 0; }
  // False when the list is older than the configured maximum: no new sign-ins until the site is reachable again.
  signInsOpen(now = Date.now()) { return !this.maxAgeMs || !this.lastContact || now - this.lastContact <= this.maxAgeMs; }
  #swap(reg) {
    this.registry = reg; this.byId = new Map(reg.players.map((p) => [p.userId, p])); this.byHash = new Map(reg.players.map((p) => [p.ticketSha256, p]));
    this.loadedAt = Date.now();
    this.emit('update', reg);
  }
  // Replaces the registry with an already validated copy.
  set(reg) { this.#swap(normalizeRegistry(reg, { minUserId: this.minUserId })); this.lastError = ''; }
  // Loads the file. A missing or invalid file is an EMPTY registry when failClosed (a static file an operator broke
  // must not keep revoked players in); the synced cache instead keeps what is in memory. Returns true when loaded.
  loadFile({ failClosed = true } = {}) {
    try {
      const st = fs.statSync(this.file);
      const reg = normalizeRegistry(JSON.parse(fs.readFileSync(this.file, 'utf8')), { minUserId: this.minUserId });
      this.stamp = `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
      this.#swap(reg); this.lastError = '';
      return true;
    } catch (e) {
      const msg = e.code === 'ENOENT' ? 'registry file not found' : `registry file rejected: ${e.message}`;
      if (msg !== this.lastError) this.log(`${msg}${failClosed ? '; nobody can log in until it is fixed' : ''}`);
      this.lastError = msg;
      if (failClosed && this.registry.players.length) this.#swap(EMPTY_REGISTRY);
      return false;
    }
  }
  // Re-reads a watched file when its timestamp or size changed.
  refresh() {
    if (!this.watch || !this.file) return;
    let stamp = 'missing';
    try { const st = fs.statSync(this.file); stamp = `${st.mtimeMs}:${st.ctimeMs}:${st.size}`; } catch { /* missing */ }
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    this.loadFile({ failClosed: true });
  }
  current() { this.refresh(); return this.registry; }
  find(userId) { this.refresh(); return this.byId.get(userId) ?? null; }
  // A logged-in session is still good: the account exists, is not disabled, and still has the credential it used.
  isActive(session) {
    const p = session ? this.find(session.userId) : null;
    return !!p && !p.disabled && p.ticketSha256 === session.credentialSha256;
  }
  // Same result and errors as league-auth.mjs authenticate(), without re-validating the registry on every login.
  authenticate(ticket) {
    this.refresh();
    if (!Buffer.isBuffer(ticket) || ticket.length !== 72 || !ticket.subarray(0, 8).equals(MAGIC)) throw new Error('Invalid league credential');
    const p = this.byHash.get(digest(ticket));
    if (!p || p.disabled) throw new Error('Unknown or revoked league credential');
    return { userId: p.userId, onlineId: p.onlineId, personaId: p.userId, credentialSha256: p.ticketSha256, joinDynasties: [...p.joinDynasties], leagueAuthenticated: true };
  }
}

async function readLimited(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('registry response too large');
  if (!res.body?.getReader) { const b = Buffer.from(await res.arrayBuffer()); if (b.length > maxBytes) throw new Error('registry response too large'); return b; }
  const reader = res.body.getReader(); const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > maxBytes) { try { await reader.cancel(); } catch { /* closing anyway */ } throw new Error('registry response too large'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// One pull. Never throws: { status: 'updated' | 'unchanged' | 'error', etag, error? }. On 'error' the store and the
// cache file are left exactly as they were. The token is never part of an error message.
export async function syncOnce({ url, token, store, file, etag = '', fetchImpl = fetch, timeoutMs = 15000, maxBytes = 32 * 1024 * 1024, minUserId = 800000 }) {
  try {
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (etag) headers['if-none-match'] = etag;
    const res = await fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 304) return { status: 'unchanged', etag };
    if (res.status !== 200) { try { await res.body?.cancel?.(); } catch { /* ignore */ } return { status: 'error', etag, error: `site answered ${res.status}` }; }
    const text = (await readLimited(res, maxBytes)).toString('utf8');
    let raw; try { raw = JSON.parse(text); } catch { return { status: 'error', etag, error: 'registry response is not JSON' }; }
    let reg; try { reg = normalizeRegistry(raw, { minUserId }); } catch (e) { return { status: 'error', etag, error: `registry response rejected: ${e.message}` }; }
    const nextEtag = res.headers.get('etag') ?? '';
    const same = JSON.stringify(reg.players) === JSON.stringify(store.registry.players);
    if (same && store.loadedAt) return { status: 'unchanged', etag: nextEtag };
    // Disk first, so a restart does not bring a revoked player back. If the disk write fails the new registry still
    // takes effect in memory (revocations must not wait for a full disk to be fixed) and the ETag is dropped so the
    // next pull tries the write again.
    let warning = '';
    if (file) { try { writeAtomic(file, JSON.stringify(reg, null, 1) + '\n'); } catch (e) { warning = `cache file not written (${e.code ?? e.message})`; } }
    store.set(reg);
    return { status: 'updated', etag: warning ? '' : nextEtag, players: reg.players.length, disabled: reg.players.filter((p) => p.disabled).length, warning };
  } catch (e) {
    const reason = e?.name === 'TimeoutError' ? 'timed out' : (e?.cause?.code ?? e?.code ?? e?.message ?? 'failed');
    return { status: 'error', etag, error: `site unreachable (${reason})` };
  }
}

// Loads the cache, pulls once now, then every intervalMs. Returns { stop, syncNow, ready } (ready resolves after the
// first pull, whatever its result).
const hoursText = (ms) => { const h = ms / 3600000; return h >= 10 ? `${Math.round(h)} hours` : `${Math.round(h * 10) / 10} hours`; };
export function startRegistrySync({ url, token, store, file, intervalMs = 60000, minUserId = 800000, log = () => {}, fetchImpl = fetch, timeoutMs = 15000, warnAfterMs = 0, maxAgeMs = 0, now = Date.now }) {
  store.minUserId = minUserId; store.maxAgeMs = maxAgeMs;
  if (file && fs.existsSync(file)) {
    if (store.loadFile({ failClosed: false })) {
      // the file is written on every change and its time is refreshed on every confirmed pull: it is the last contact
      try { store.lastContact = Math.min(now(), fs.statSync(file).mtimeMs); } catch { store.lastContact = now(); }
      log(`loaded the cached registry: ${store.registry.players.length} player(s), last confirmed with the site ${new Date(store.lastContact).toISOString()}`);
    }
  } else log('no cached registry yet: nobody can log in until the first sync succeeds');
  let etag = '', busy = false, failures = 0, lastOk = 0, lastTouch = 0, lastWarn = 0, closed = false;
  // Called after every pull. Says when the list is getting old, and when sign-ins stop and start again.
  const checkAge = () => {
    if (!store.lastContact) return;
    const t = now(), age = t - store.lastContact;
    const open = store.signInsOpen(t);
    if (!open && !closed) { closed = true; lastWarn = t; log(`WARNING: NEW SIGN-INS ARE STOPPED. The member list was last confirmed with the site ${hoursText(age)} ago, more than the ${hoursText(maxAgeMs)} allowed (NCAA_REGISTRY_MAX_AGE_HOURS). Players already signed in keep playing. Sign-ins start again by themselves when the site answers.`); return; }
    if (open && closed) { closed = false; log('new sign-ins are accepted again: the site confirmed the member list'); return; }
    if (warnAfterMs && age > warnAfterMs && t - lastWarn >= 3600000) {
      lastWarn = t;
      log(`WARNING: the member list has not been confirmed with the site for ${hoursText(age)} (NCAA_REGISTRY_WARN_HOURS). Players disabled on the site since then can still sign in.${closed ? ' New sign-ins are stopped.' : maxAgeMs ? ` New sign-ins stop at ${hoursText(maxAgeMs)} (NCAA_REGISTRY_MAX_AGE_HOURS).` : ''}`);
    }
  };
  const confirmed = () => {
    const t = now(); store.lastContact = t;
    // remembered across a restart: refresh the cache file's time, at most every five minutes
    if (file && t - lastTouch >= 300000) { lastTouch = t; try { const d = new Date(t); fs.utimesSync(file, d, d); } catch { /* no cache file yet, or read-only: the next change writes it */ } }
  };
  const syncNow = async () => {
    if (busy) return { status: 'busy' }; busy = true;
    try {
      const r = await syncOnce({ url, token, store, file, etag, fetchImpl, timeoutMs, minUserId });
      etag = r.etag ?? '';
      if (r.status === 'error') {
        failures++;
        if (failures === 1 || failures % 30 === 0) log(`registry sync failed (${r.error}); still serving the last good copy (${store.registry.players.length} player(s)${lastOk ? `, synced ${new Date(lastOk).toISOString()}` : ', never synced this run'})`);
      } else {
        if (failures) log(`registry sync is working again after ${failures} failure(s)`);
        failures = 0; lastOk = Date.now(); confirmed();
        if (r.status === 'updated') log(`registry updated from the site: ${r.players} player(s), ${r.disabled} disabled${r.warning ? `; WARNING ${r.warning}` : ''}`);
      }
      checkAge();
      return r;
    } finally { busy = false; }
  };
  const ready = syncNow();
  const timer = setInterval(syncNow, intervalMs); timer.unref?.();
  return { stop: () => clearInterval(timer), syncNow, ready };
}
