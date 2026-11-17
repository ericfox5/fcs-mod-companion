// Blaze Locker (component 20) for the NCAA 14 spike, plus the HTTP endpoint the client is pointed at for the file bytes.
// Online Dynasty stores its files ("<persona>;<team>;<status>;0;0.team" in category "LeagueStorage") through EA Locker:
//   createContent(1) {ATTR, CCAT, COID, DESC, EDAT, NAME, PERM, SUBL, TAGS} -> {INFO ContentInfo}
//   HTTP POST <ContentInfo.UURL>&pers=<persona>   body = file bytes; the client parses the reply as XML:
//       <LOCKER error="" errorCode="0"> = success, <error><component/><errorCode/><errorName/></error> = failure,
//       anything else (even an empty body) = success unless the strategy expected a TDF (see NOTES.md, run 11).
//   confirmUpload(3) {INFO, STST} -> {INFO}
//   getContentInfo(8) {CCAT, CID, CVSF} -> {INFO};  HTTP GET <GURL>&pers=<persona> -> raw bytes;  incrementUseCount(13).
// Command ids come from the client's getCommandName switch at 0x795860; member tables from private/tdf-classes.json
// (ContentInfo table at 0x1c975b8, CreateContentInfoRequest at 0x1c97720).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { canReadContent, canReadSharedContent } from './league-auth.mjs';
import { fileURLToPath } from 'node:url';
import { T } from './tdf.mjs';
import { log } from './log.mjs';
import { hardenHttpServer, createConnectionGuard, exitOnListenError } from './net-guard.mjs';
import { isCloud } from './cloud-config.mjs';
import { loadJsonState, saveJsonState, writeFileAtomic, commitFileAtomic, maxNumericName, damagedHint, fatalState } from './state-file.mjs';
import { stateBudget } from './storage-budget.mjs';

export const LOCKER = 20;
export const LOCKER_COMMANDS = {
  1: 'createContent', 2: 'createSubContent', 3: 'confirmUpload', 4: 'updateContentInfo', 5: 'deleteContent', 6: 'copyContentReference',
  7: 'bookmarkContentReference', 8: 'getContentInfo', 9: 'listContent', 10: 'getTopN', 11: 'getLeaderboardView', 12: 'updateRating',
  13: 'incrementUseCount', 14: 'setOwnerGroup', 15: 'removeOwnerGroup', 16: 'listContentForUsers', 17: 'wipeContent', 18: 'getCategoryList',
  19: 'getLeaderboardList', 20: 'listContentForTag',
};
// The packet header carries a 16-bit error code; the client turns it into (code << 16) | component and its error switch
// knows LOCKER codes 2, 3, 5, 6, 9, 10, 22. The LOCKER_ERR_* string table order suggests 14 = CONTENT_NOT_FOUND;
// unverified, it only decides which message the game shows.
export const LOCKER_ERR_CONTENT_NOT_FOUND = 14;

// ---- persistent content store: private/locker/index.json + private/locker/<cid>.bin (gitignored) ----
const DIR = path.join(process.env.NCAA_PRIVATE
  ? path.resolve(process.env.NCAA_PRIVATE)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'private'), 'locker');
const INDEX = path.join(DIR, 'index.json');
fs.mkdirSync(DIR, { recursive: true });
// The index is written in one step (temp file + rename) and the copy it replaces is kept as index.json.bak. A
// truncated or damaged index is replaced by that copy at start (state-file.mjs); same name and format as before.
const stateLog = (m) => log('locker', m);
const validIndex = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && !!v.contents && typeof v.contents === 'object' && !Array.isArray(v.contents);
const loaded = loadJsonState(INDEX, { validate: validIndex, log: stateLog, what: 'the Locker index (locker/index.json)' });
if (loaded.source === 'unreadable' && isCloud()) fatalState('locker', INDEX);
const store = loaded.value ?? { nextId: 1, contents: {} };
if (!Number.isSafeInteger(store.nextId) || store.nextId < 1) store.nextId = 1;
if (loaded.source !== 'file') {
  // not the newest index (first start, a recovery, or a lost file): new ids must not reuse a file already on disk
  const floor = Math.max(maxNumericName(DIR), maxNumericName(path.join(DIR, 'trash')), ...Object.keys(store.contents).map((k) => Number(k) || 0), ...Object.keys(store.trash ?? {}).map((k) => Number(k) || 0), (loaded.source === 'none' ? 0 : damagedHint(INDEX, 'nextId')) - 1) + 1;
  if (store.nextId < floor) { log('locker', `next file id moved from ${store.nextId} to ${floor}: files with lower ids are already on disk`); store.nextId = floor; }
}
const save = () => { try { saveJsonState(INDEX, store, { pretty: 2, backup: true, log: stateLog }); } catch (e) { log('locker', `index write failed: ${e.message}`); } };
const blobPath = (cid) => path.join(DIR, `${cid}.bin`);
// An upload is received into <cid>.<random>.upload.tmp and renamed into place when it is complete. One left behind
// by a crash is removed here.
try { for (const f of fs.readdirSync(DIR)) if (f.endsWith('.upload.tmp')) fs.rmSync(path.join(DIR, f), { force: true }); } catch { /* nothing to clean */ }
const blobSize = (cid) => { try { return fs.statSync(blobPath(cid)).size; } catch { return 0; } };
// A file's bytes, written in one step so a reader (a console download, the site sync) never sees half a file.
const writeBlob = (cid, bytes) => { const before = blobSize(cid); writeFileAtomic(blobPath(cid), bytes); stateBudget.recordWrite(blobPath(cid), bytes.length, before); };
// Highest dynasty id any stored file belongs to (dod.mjs keeps new dynasty ids above it after a recovery).
export const maxGroupId = () => Object.values(store.contents).reduce((a, c) => Math.max(a, Number(c.group?.id) || 0), 0);

const now = () => Math.floor(Date.now() / 1000);
const str = (v, dflt = '') => (v === undefined || v === null ? dflt : String(v));
const num = (v, dflt = 0) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : dflt);
const items = (v) => (v && Array.isArray(v.items) ? v.items : []);

let baseUrl = () => 'http://127.0.0.1:17503'; // what consoles are sent (startLockerHttp sets it; may follow a DNS change)
let security = null;
// Optional caps (cloud mode): { maxUploadBytes, lockerQuotaBytes, lockerMaxItems }. Without them only the upload size
// is bounded (256 MB), as a guard against a runaway client.
let quota = null;
export const configureLockerLimits = (limits) => { quota = limits; };
const capabilities = new Map();
const sessionCaps = new WeakMap(); // session -> Map("cid:mode" -> token): one live capability per file and direction
const CAP_MS = 30 * 60 * 1000;
let lastPrune = 0;
export const configureLockerAuth = options => { security = options; };
export const getContent = cid => find(cid);
function pruneCapabilities(now) {
  if (now - lastPrune < 60000) return; lastPrune = now;
  for (const [key, value] of capabilities) if (value.expires < now || !value.session.active) { capabilities.delete(key); sessionCaps.get(value.session)?.delete(`${value.cid}:${value.mode}`); }
}
function capability(c, session, mode) {
  if (!security) return '';
  const allowed = mode === 'download' ? canReadSharedContent(c,session,security.dynasties) : canReadContent(c,session,security.dynasties);
  if (!session || !security.isActive(session) || !allowed || (mode === 'upload' && c.owner !== session.userId)) return '&cap=denied';
  const now = Date.now();
  pruneCapabilities(now);
  // The same file listed again reuses its capability (with a fresh expiry) instead of minting another: a client that
  // lists its files in a loop cannot grow this table.
  let mine = sessionCaps.get(session); if (!mine) { mine = new Map(); sessionCaps.set(session, mine); }
  const slot = `${c.cid}:${mode}`, held = mine.get(slot), live = held && capabilities.get(held);
  if (live && live.expires > now) { live.expires = now + CAP_MS; return `&cap=${held}`; }
  const token = crypto.randomBytes(24).toString('hex');
  capabilities.set(token,{ cid:c.cid, mode, session, expires:now+CAP_MS });
  mine.set(slot, token);
  return `&cap=${token}`;
}
// Called when a session ends or is revoked: its capabilities stop working at once.
export function revokeSessionCapabilities(session) {
  const mine = sessionCaps.get(session); if (!mine) return;
  for (const token of mine.values()) capabilities.delete(token);
  sessionCaps.delete(session);
}
const uploadUrl = (c,s) => `${baseUrl()}/locker/upload?cid=${c.cid}${capability(c,s,'upload')}`;
const downloadUrl = (c,s) => `${baseUrl()}/locker/download?cid=${c.cid}${capability(c,s,'download')}`;

// Blaze::Locker::ContentInfo, members in tag order. BOID/GPID (object ids) and HIDE are left out: the client keeps their defaults.
function contentInfo(w, c, session) {
  w.list('ATTR', T.STRUCT, c.attrs ?? [], (x, a) => { x.str('NAME', str(a.NAME)); x.str('VALU', str(a.VALU)); x.push(0); });
  w.str('CCAT', c.ccat); w.int('CDAT', c.cdat); w.int('CID', c.cid); w.int('COID', c.coid); w.str('DESC', c.desc); w.str('DFMT', '');
  w.int('EDAT', c.edat); w.int('EID', c.owner); w.str('ENAM', c.persona); w.str('GURL', downloadUrl(c,session)); w.str('NAME', c.name); w.int('PERM', c.perm);
  w.int('RATE', 0); w.int('RCNT', 0); w.int('SIZE', c.size); w.int('STTS', c.status);
  w.map('SUBL', T.STRING, T.STRUCT, [], () => {}, () => {});
  w.list('TAGS', T.STRUCT, c.tags ?? [], (x, t) => { x.str('TAG', str(t.TAG)); x.int('TGID', num(t.TGID)); x.push(0); });
  w.int('UCNT', c.ucnt ?? 0); w.int('UDAT', c.udat); w.str('UURL', uploadUrl(c,session)); w.str('XID', '');
}
const infoReply = (c,s) => (w) => w.struct('INFO', (x) => contentInfo(x, c,s));
const listReply = (list,s) => (w) => { w.list('LKRS', T.STRUCT, list, (x, c) => { contentInfo(x, c,s); x.push(0); }); w.int('MSIZ', 0); w.int('TCNT', list.length); };
// only a plain decimal id that is really in the store (never "__proto__", "constructor", "../x")
const find = (cid) => { const k = String(cid); return /^\d{1,15}$/.test(k) && Object.hasOwn(store.contents, k) ? store.contents[k] : undefined; };
const usedBy = (owner) => { let bytes = 0, count = 0; for (const c of Object.values(store.contents)) if (c.owner === owner) { bytes += c.size || 0; count++; } return { bytes, count }; };
// A file id from the wire: a positive whole number, or -1. Each command works out its target ONCE (targetsOf) and the
// permission check and the action both use that value: the check can never look at one file and the action at another.
const cidOf = (v) => { const n = typeof v === 'bigint' ? Number(v) : v; return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : -1; };
function targetsOf(command, body) {
  const cid = command === 3 ? cidOf(body?.INFO?.CID) : [4, 8, 13, 14].includes(command) ? cidOf(body?.CID) : -1;
  return { cid, cids: command === 5 ? items(body?.CIDS).map(cidOf) : [], groupId: command === 14 ? cidOf(body?.GPID?.id) : -1 };
}
const clip = (v, n) => String(v ?? '').slice(0, n);
const clipList = (list, n, fn) => list.slice(0, n).map(fn);
const cleanAttr = (a) => ({ NAME: clip(a?.NAME, 64), VALU: clip(a?.VALU, 512) });
const cleanTag = (t) => ({ TAG: clip(t?.TAG, 64), TGID: num(t?.TGID) });
const summary = (c) => `CID ${c.cid} "${c.name}" (${c.ccat}, ${c.size} bytes, status ${c.status})`;

// Newest confirmed file in a dynasty's storage whose name ends with `suffix` and that was created at or after `since`
// (unix seconds): the coaching carousel's .contract packages (dod.mjs). A file without an owner group counts when one
// of `owners` (the dynasty's members) created it.
export function latestContent({ group, suffix, since = 0, owners = [] }) {
  return Object.values(store.contents)
    .filter((c) => c.confirmed && c.name.endsWith(suffix) && c.cdat >= since && (c.group ? c.group.id === group : owners.includes(c.owner)))
    .sort((a, b) => b.cid - a.cid)[0] ?? null;
}

// A file the league server publishes itself: a console's dynasty file with site edits written in (dod.mjs refreshPatch).
// Stored like an upload and listed with the metadata of the file it stands in for (name, category, owner, group).
// called with the content record after every successful download (dod.mjs: the console's current dynasty file)
let downloadHook = null;
export const setDownloadHook = (fn) => { downloadHook = fn; };
// The stored blob of an item, and replacing it in place (same cid: the console already holds the id).
export const readContentBlob = (cid) => (find(cid) && fs.existsSync(blobPath(cid)) ? fs.readFileSync(blobPath(cid)) : null);
export function replaceContentBlob(cid, bytes) {
  const c = find(cid); if (!c) return false;
  writeBlob(cid, bytes); c.size = bytes.length; c.udat = now(); save();
  return true;
}
export function publishContent(likeCid, bytes) {
  const like = find(likeCid);
  if (!like) return null;
  if (!stateBudget.fits(bytes.length)) { stateBudget.refused(`publishing a copy of Locker file ${like.cid} with site edits`); return null; }
  const cid = store.nextId++;
  writeBlob(cid, bytes);
  const c = { ...JSON.parse(JSON.stringify(like)), cid, cdat: now(), udat: now(), size: bytes.length, status: 1, confirmed: true, uploadedBy: 'league', basedOn: like.cid };
  store.contents[cid] = c; save();
  return c;
}

export function handleLocker({ p, body, session, reply, replyError }) {
  const name = LOCKER_COMMANDS[p.command] ?? `cmd${p.command}`;
  const note = (extra = '') => `(Locker ${name}${extra})`;
  const owner = session?.userId ?? 0, persona = session?.onlineId ?? 'Player';
  const { cid, cids, groupId } = targetsOf(p.command, body);
  const target = cid > 0 ? find(cid) : undefined; // the one file commands 3, 4, 8, 13 and 14 are about
  if (security) {
    if (!session?.leagueAuthenticated || !security.isActive(session)) return replyError(0x4000,'unauthenticated Locker request');
    if (![1,3,4,5,8,9,13,14,16,20].includes(p.command)) return replyError(0x4000,'unreviewed Locker command');
    const ids = p.command === 5 ? cids : cid > 0 ? [cid] : [];
    for (const id of ids) {
      const c = id > 0 ? find(id) : undefined;
      const allowed = [8,13].includes(p.command) ? canReadSharedContent(c,session,security.dynasties) : canReadContent(c,session,security.dynasties);
      if (!allowed || (![8,13].includes(p.command) && c.owner !== owner))
        return replyError(0x4000,'Locker ownership mismatch');
    }
    const memberOf = (gid) => { const d = gid > 0 && Object.hasOwn(security.dynasties, gid) ? security.dynasties[gid] : null; return (Array.isArray(d?.members) ? d.members : []).find((m) => m.blazeId === owner) ?? null; };
    if (p.command === 14) {
      const m = memberOf(groupId);
      if (!m || (target?.name.endsWith('.dynasty') && !m.commissioner)) return replyError(0x4000,'Locker dynasty membership mismatch');
    }
    // a file already tied to a dynasty cannot be renamed into its dynasty file by someone who is not the commissioner
    if (p.command === 4 && target?.group?.id && body.NAME !== undefined && clip(body.NAME, 128).endsWith('.dynasty') && !target.name.endsWith('.dynasty') && !memberOf(target.group.id)?.commissioner)
      return replyError(0x4000,'Locker dynasty file rename refused');
  }
  switch (p.command) {
    case 1: { // createContent
      if (quota && usedBy(owner).count >= quota.lockerMaxItems) return replyError(9, note(`: user ${owner} is at the ${quota.lockerMaxItems}-file limit`));
      if (quota) makeRoom(owner, 0, 1); // deleted files count too: the oldest of them make way for the new one
      const cid = store.nextId++;
      const c = {
        cid, ccat: clip(body.CCAT, 64), name: clip(body.NAME, 128), desc: clip(body.DESC, 512), perm: num(body.PERM), coid: security ? owner : num(body.COID) || owner,
        owner, persona, attrs: clipList(items(body.ATTR), 64, cleanAttr), tags: clipList(items(body.TAGS), 64, cleanTag), edat: num(body.EDAT), cdat: now(), udat: now(), size: 0, status: 0, ucnt: 0, confirmed: false,
      };
      store.contents[cid] = c; save();
      return reply(infoReply(c,session), note(`: ${summary(c)}`));
    }
    case 3: { // confirmUpload {INFO, STST}
      const c = target;
      if (!c) return replyError(LOCKER_ERR_CONTENT_NOT_FOUND, note(`: unknown CID ${cid}`));
      c.confirmed = true; c.status = 1; c.size = blobSize(c.cid); c.udat = now(); c.stst = num(body.STST); save();
      return reply(infoReply(c,session), note(`: ${summary(c)} STST ${body.STST}`));
    }
    case 4: { // updateContentInfo {ATTR, CCAT, CID, COID, DESC, EDAT, NAME, PERM, SIZE, TAGS}
      const c = target;
      if (!c) return replyError(LOCKER_ERR_CONTENT_NOT_FOUND, note(`: unknown CID ${cid}`));
      if (body.NAME !== undefined) c.name = clip(body.NAME, 128);
      if (body.DESC !== undefined) c.desc = clip(body.DESC, 512);
      if (body.PERM !== undefined) c.perm = num(body.PERM);
      if (body.EDAT !== undefined) c.edat = num(body.EDAT);
      if (body.ATTR) c.attrs = clipList(items(body.ATTR), 64, cleanAttr);
      if (body.TAGS) c.tags = clipList(items(body.TAGS), 64, cleanTag);
      c.udat = now(); save();
      return reply(infoReply(c,session), note(`: ${summary(c)}`));
    }
    case 5: { // deleteContent {CCAT, CIDS}: records go to index trash and blobs to private/locker/trash/ (run 22 lost a dynasty this way)
      const ids = cids.filter((id) => id > 0);
      fs.mkdirSync(path.join(DIR, 'trash'), { recursive: true });
      const owners = new Set([owner]);
      for (const id of ids) { const c = find(id); if (c) { owners.add(c.owner); (store.trash ??= {})[String(id)] = { ...c, deletedAt: now() }; delete store.contents[String(id)]; } try { fs.renameSync(blobPath(id), path.join(DIR, 'trash', `${id}.bin`)); } catch { /* none */ } }
      if (quota) for (const o of owners) makeRoom(o); // live files + deleted files stay within the player's quota
      save();
      return reply(undefined, note(`: deleted ${JSON.stringify(ids)}`));
    }
    case 8: { // getContentInfo {CCAT, CID, CVSF}
      const c = target;
      if (!c) return replyError(LOCKER_ERR_CONTENT_NOT_FOUND, note(`: unknown CID ${cid}`));
      return reply(infoReply(c,session), note(`: ${summary(c)}`));
    }
    case 9: case 16: case 20: { // listContent / listContentForUsers / listContentForTag
      // Filters seen from the console: EID (owner, 0 = any), GPID (owner group = the dynasty objid set by setOwnerGroup, id 0 = any),
      // PEND 1 = only unconfirmed uploads (the client deletes whatever this returns when it exits a dynasty: run 22).
      const ccat = str(body.CCAT ?? body.CAT);
      const eids = (p.command === 16 ? items(body.EID).map((x) => num(x, -1)) : (body.EID !== undefined ? [num(body.EID)] : [])).filter((x) => x > 0);
      const gid = num(body.GPID?.id, 0); const pendingOnly = num(body.PEND) === 1;
      const list = Object.values(store.contents).filter((c) => (!ccat || c.ccat === ccat) && (eids.length ? eids.includes(c.owner) : true) && (gid ? c.group?.id === gid : true) && (pendingOnly ? !c.confirmed : true));
      const visible = security ? list.filter(c => canReadContent(c,session,security.dynasties)) : list;
      return reply(listReply(visible,session), note(`: ${visible.length} visible item(s)`));
    }
    case 14: { // setOwnerGroup {CCAT, CID, GPID objid}: ties the file to the dynasty
      const c = target;
      if (c) { c.group = { component: num(body.GPID?.component), type: num(body.GPID?.type), id: Math.max(0, groupId) }; save(); }
      return reply(undefined, note(c ? `: ${summary(c)} -> group ${JSON.stringify(c.group)}` : `: unknown CID ${cid}`));
    }
    case 13: { // incrementUseCount {CCAT, CID}
      const c = target;
      if (c) { c.ucnt = (c.ucnt ?? 0) + 1; save(); }
      return reply(undefined, note(c ? `: ${summary(c)} uses ${c.ucnt}` : `: unknown CID ${cid}`));
    }
    default:
      return reply(undefined, note(': empty response'));
  }
}

// With limits on, a player's deleted files (the trash) count toward the same quota as their live files: live +
// deleted never pass lockerQuotaBytes or lockerMaxItems. Deleted files never block a new upload: the oldest of them
// are removed to make room (extraBytes / extraItems = what is about to be stored). Before this the trash had a quota
// of its own, so upload, delete, upload again could hold twice the quota, and a deleted file stopped counting at all
// against the live quota.
function makeRoom(owner, extraBytes = 0, extraItems = 0) {
  const mine = Object.entries(store.trash ?? {}).filter(([, c]) => c.owner === owner).sort((a, b) => (a[1].deletedAt ?? 0) - (b[1].deletedAt ?? 0) || a[1].cid - b[1].cid);
  if (!mine.length) return;
  const live = usedBy(owner);
  let bytes = mine.reduce((a, [, c]) => a + (c.size || 0), 0), dropped = 0;
  while (mine.length && (live.count + extraItems + mine.length > quota.lockerMaxItems || live.bytes + extraBytes + bytes > quota.lockerQuotaBytes)) {
    const [id, c] = mine.shift(); bytes -= c.size || 0; dropped++;
    const p = path.join(DIR, 'trash', `${Number(id)}.bin`); let size = 0; try { size = fs.statSync(p).size; } catch { /* no blob */ }
    try { fs.rmSync(p, { force: true }); stateBudget.recordRemove(p, size); } catch { /* next prune */ }
    delete store.trash[id];
  }
  if (dropped) log('locker', `trash of user ${owner}: ${dropped} oldest deleted file(s) removed to stay within the storage limit`);
}
// Deleted files are kept in trash/ so a lost dynasty can be recovered; pruneTrash drops what is older than maxAgeDays.
export function pruneTrash(maxAgeDays = 14) {
  const dir = path.join(DIR, 'trash'), cutoff = Date.now() - maxAgeDays * 86400000; let n = 0;
  try { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p, { force: true }); n++; } } } catch { /* no trash yet */ }
  for (const [id, c] of Object.entries(store.trash ?? {})) if ((c.deletedAt ?? 0) * 1000 < cutoff) { delete store.trash[id]; n++; }
  if (n) { save(); log('locker', `trash: removed ${n} entr${n === 1 ? 'y' : 'ies'} older than ${maxAgeDays} days`); }
  return n;
}

// HTTP side: the client POSTs the file to UURL (+ "&pers=<persona>") and GETs GURL for downloads.
// host: a string, or a function returning the current address (cloud mode re-resolves its public name).
// In registry mode the capability in the URL is checked BEFORE the body is read, so a stranger cannot make the server
// buffer an upload; the body itself is capped (limits.maxUploadBytes) and counted against the owner's quota.
// Uploads in progress. One at a time per file: a second POST to the same link while the first is still arriving is
// refused, so one link cannot be used to hold many uploads open at once. The bytes go straight to a temp file (a few
// KB in memory at a time, whatever the file size) and are counted as they arrive against the upload size limit, the
// player's quota (their other uploads in progress included) and the league's storage budget.
const uploading = new Set(); // cid
const arriving = new Map(); // owner -> bytes of their uploads in progress
let arrivingTotal = 0;
// Receives a request body into `tmp`. allow(bytesSoFar) is asked as the bytes arrive; false stops the upload.
// Resolves { ok: true, size } or { ok: false, status, size } (413 too large / refused, 400 broken upload, 500 disk).
function receiveToFile(req, tmp, { max, allow = () => true }) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && (declared > max || !allow(declared, true))) { req.resume(); return resolve({ ok: false, status: 413, size: declared }); }
    let out; try { out = fs.createWriteStream(tmp, { flags: 'wx' }); } catch (e) { req.resume(); return resolve({ ok: false, status: 500, size: 0, error: e }); }
    let size = 0, done = false;
    const finish = (r) => {
      if (done) return; done = true;
      if (r.ok) return resolve(r);
      req.pause(); out.once('close', () => fs.rm(tmp, { force: true }, () => resolve(r))); out.destroy();
    };
    out.on('error', (e) => finish({ ok: false, status: 500, size, error: e }));
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > max || !allow(size, false)) return finish({ ok: false, status: 413, size });
      if (!out.write(chunk)) { req.pause(); out.once('drain', () => { if (!done) req.resume(); }); }
    });
    req.on('end', () => { if (!done) out.end(() => finish({ ok: true, size })); });
    req.on('error', () => finish({ ok: false, status: 400, size }));
    req.on('aborted', () => finish({ ok: false, status: 400, size }));
    req.on('close', () => { if (!req.complete) finish({ ok: false, status: 400, size }); });
  });
}

export function startLockerHttp({ port, host = '127.0.0.1', bind = '0.0.0.0', limits = null, hardened = false }) {
  const hostOf = typeof host === 'function' ? host : () => host;
  let listenPort = port;
  baseUrl = () => `http://${hostOf()}:${listenPort}`;
  if (limits) quota = limits;
  const maxUpload = quota?.maxUploadBytes ?? 256 * 1024 * 1024;
  const xmlOk = '<LOCKER error="" errorCode="0"></LOCKER>';
  const xmlErr = (code, name) => `<error><component>${LOCKER}</component><errorCode>${code}</errorCode><errorName>${name}</errorName></error>`;
  const sendText = (res, status, body, type = 'text/xml') => { if (res.headersSent || res.destroyed) return; res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), ...(status >= 400 ? { connection: 'close' } : {}) }); res.end(body); };
  const handle = async (req, res) => {
    let url; try { url = new URL(req.url, 'http://locker'); } catch { req.resume(); return sendText(res, 400, xmlErr(0x4000, 'BAD_REQUEST')); }
    const q = Object.fromEntries(url.searchParams);
    const c = find(q.cid);
    const isUpload = url.pathname === '/locker/upload' && (req.method === 'POST' || req.method === 'PUT');
    const isDownload = url.pathname === '/locker/download' && req.method === 'GET';
    log('locker-http', `${req.socket.remoteAddress}:${req.socket.remotePort} ${req.method} ${url.pathname}`, { query: { ...q, cap:q.cap ? '[redacted]' : undefined }, bytes: Number(req.headers['content-length'] ?? 0) });
    if (security) {
      const cap = typeof q.cap === 'string' ? capabilities.get(q.cap) : undefined, mode = url.pathname === '/locker/upload' ? 'upload' : 'download';
      if (!cap || cap.cid !== c?.cid || cap.mode !== mode || cap.expires < Date.now() || !security.isActive(cap.session)
          || !(mode === 'download' ? canReadSharedContent(c,cap.session,security.dynasties) : canReadContent(c,cap.session,security.dynasties)) || (mode === 'upload' && c.owner !== cap.session.userId))
        { req.resume(); return sendText(res,403,xmlErr(0x4000,'LEAGUE_AUTH_REQUIRED')); }
    }
    if (isUpload) {
      if (!c) { req.resume(); return sendText(res, 404, xmlErr(14, 'LOCKER_ERR_CONTENT_NOT_FOUND')); }
      if (uploading.has(c.cid)) { req.resume(); log('locker-http', `-> upload for CID ${c.cid} refused (another upload of this file is still in progress)`); return sendText(res, 409, xmlErr(9, 'LOCKER_ERR_UPLOAD_IN_PROGRESS')); }
      const owner = c.owner, before = blobSize(c.cid), tmp = path.join(DIR, `${c.cid}.${crypto.randomBytes(6).toString('hex')}.upload.tmp`);
      // why an upload of n bytes cannot be stored right now ('' = it can); the player's other uploads in progress count
      let mine = 0, why = '';
      const refusal = (n) => (quota && usedBy(owner).bytes - (c.size || 0) + (arriving.get(owner) ?? 0) - mine + n > quota.lockerQuotaBytes ? 'quota'
        : !stateBudget.fits(arrivingTotal - mine + n - before) ? 'budget' : '');
      const allow = (n, declared) => { why = refusal(n); if (why) return false; if (!declared) { arriving.set(owner, (arriving.get(owner) ?? 0) + n - mine); arrivingTotal += n - mine; mine = n; } return true; };
      uploading.add(c.cid);
      let r;
      try { r = await receiveToFile(req, tmp, { max: maxUpload, allow }); }
      finally { uploading.delete(c.cid); const left = (arriving.get(owner) ?? 0) - mine; if (left > 0) arriving.set(owner, left); else arriving.delete(owner); arrivingTotal = Math.max(0, arrivingTotal - mine); mine = 0; }
      if (r.ok && find(c.cid) !== c) { r = { ok: false, status: 404, size: r.size }; fs.rmSync(tmp, { force: true }); } // deleted while it was arriving
      if (r.ok) { why = refusal(r.size); if (why) { fs.rmSync(tmp, { force: true }); r = { ok: false, status: 413, size: r.size }; } }
      if (!r.ok) {
        if (why === 'quota') log('locker-http', `-> upload for CID ${c.cid} refused (user ${owner} is over the storage quota)`);
        else if (why === 'budget') { stateBudget.refused(`a ${r.size}-byte Locker upload by user ${owner}`); log('locker-http', `-> upload for CID ${c.cid} refused (the league's storage is full)`); }
        else log('locker-http', `-> upload for CID ${c.cid} refused (${r.status === 413 ? 'too large' : r.status === 500 ? `write failed: ${r.error?.message ?? 'disk error'}` : r.status === 404 ? 'the file was deleted meanwhile' : 'broken upload'})`);
        return sendText(res, r.status, r.status === 404 ? xmlErr(14, 'LOCKER_ERR_CONTENT_NOT_FOUND') : xmlErr(9, 'LOCKER_ERR_MAX_SIZE'));
      }
      if (quota) makeRoom(owner, r.size - (c.size || 0)); // their deleted files make way for it
      try { commitFileAtomic(tmp, blobPath(c.cid)); stateBudget.recordWrite(blobPath(c.cid), r.size, before); }
      catch (e) { fs.rmSync(tmp, { force: true }); log('locker-http', `write failed: ${e.message}`); return sendText(res, 500, xmlErr(9, 'LOCKER_ERR_MAX_SIZE')); }
      c.size = r.size; c.udat = now(); c.uploadedBy = clip(q.pers, 64); save();
      log('locker-http', `-> stored ${summary(c)} as ${blobPath(c.cid)}; replying ${xmlOk}`);
      return sendText(res, 200, xmlOk);
    }
    req.resume(); // nothing else has a body worth reading
    if (isDownload) {
      if (!c || !fs.existsSync(blobPath(c.cid))) return sendText(res, 404, xmlErr(14, 'LOCKER_ERR_CONTENT_NOT_FOUND'));
      const bytes = fs.readFileSync(blobPath(c.cid));
      log('locker-http', `-> sending ${summary(c)} (${bytes.length} bytes)`);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
      res.end(bytes);
      try { downloadHook?.(c); } catch (e) { log('locker-http', `download hook failed: ${e.message}`); }
      return undefined;
    }
    return sendText(res, 404, xmlErr(14, 'LOCKER_ERR_CONTENT_NOT_FOUND'));
  };
  const server = http.createServer((req, res) => {
    req.on('error', (e) => log('locker-http', `request error ${e.message}`));
    res.on('error', () => {});
    handle(req, res).catch((e) => { log('locker-http', `handler error ${e.stack ?? e.message}`); try { sendText(res, 500, xmlErr(0x4000, 'SERVER_ERROR')); } catch { res.destroy(); } });
  });
  if (hardened) {
    hardenHttpServer(server, { guard: createConnectionGuard({ maxTotal: limits?.maxConns ?? 2000, maxPerIp: limits?.maxConnsPerIp ?? 16, perMinutePerIp: limits?.connsPerMinutePerIp ?? 0 }), requestMs: 300000, idleMs: 120000 });
    pruneTrash(); const t = setInterval(pruneTrash, 24 * 3600 * 1000); t.unref?.();
  }
  server.on('clientError', (e, s) => { log('locker-http', `client error ${e.message}`); s.destroy(); });
  exitOnListenError(server, (m) => log('locker-http', m), `listen on tcp/${port}`);
  server.listen(port, bind, () => { listenPort = server.address().port; log('locker-http', `locker file endpoint listening on tcp/${listenPort} (urls use ${baseUrl()}); ${Object.keys(store.contents).length} stored item(s)`); });
  return server;
}
