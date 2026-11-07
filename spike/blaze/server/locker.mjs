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
const load = () => { try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return { nextId: 1, contents: {} }; } };
const store = load();
const save = () => { try { fs.writeFileSync(INDEX, JSON.stringify(store, null, 2)); } catch (e) { log('locker', `index write failed: ${e.message}`); } };
const blobPath = (cid) => path.join(DIR, `${cid}.bin`);
const blobSize = (cid) => { try { return fs.statSync(blobPath(cid)).size; } catch { return 0; } };

const now = () => Math.floor(Date.now() / 1000);
const str = (v, dflt = '') => (v === undefined || v === null ? dflt : String(v));
const num = (v, dflt = 0) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : dflt);
const items = (v) => (v && Array.isArray(v.items) ? v.items : []);

let baseUrl = 'http://127.0.0.1:17503';
let security = null;
const capabilities = new Map();
export const configureLockerAuth = options => { security = options; };
export const getContent = cid => find(cid);
function capability(c, session, mode) {
  if (!security) return '';
  const allowed = mode === 'download' ? canReadSharedContent(c,session,security.dynasties) : canReadContent(c,session,security.dynasties);
  if (!session || !security.isActive(session) || !allowed || (mode === 'upload' && c.owner !== session.userId)) return '&cap=denied';
  const now = Date.now();
  for (const [key, value] of capabilities) if (value.expires < now || !value.session.active) capabilities.delete(key);
  const token = crypto.randomBytes(24).toString('hex');
  capabilities.set(token,{ cid:c.cid, mode, session, expires:now+30*60*1000 });
  return `&cap=${token}`;
}
const uploadUrl = (c,s) => `${baseUrl}/locker/upload?cid=${c.cid}${capability(c,s,'upload')}`;
const downloadUrl = (c,s) => `${baseUrl}/locker/download?cid=${c.cid}${capability(c,s,'download')}`;

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
const find = (cid) => store.contents[String(cid)];
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
  fs.writeFileSync(blobPath(cid), bytes); c.size = bytes.length; c.udat = now(); save();
  return true;
}
export function publishContent(likeCid, bytes) {
  const like = find(likeCid);
  if (!like) return null;
  const cid = store.nextId++;
  fs.writeFileSync(blobPath(cid), bytes);
  const c = { ...JSON.parse(JSON.stringify(like)), cid, cdat: now(), udat: now(), size: bytes.length, status: 1, confirmed: true, uploadedBy: 'league', basedOn: like.cid };
  store.contents[cid] = c; save();
  return c;
}

export function handleLocker({ p, body, session, reply, replyError }) {
  const name = LOCKER_COMMANDS[p.command] ?? `cmd${p.command}`;
  const note = (extra = '') => `(Locker ${name}${extra})`;
  const owner = session?.userId ?? 0, persona = session?.onlineId ?? 'Player';
  if (security) {
    if (!session?.leagueAuthenticated || !security.isActive(session)) return replyError(0x4000,'unauthenticated Locker request');
    const ids = p.command === 5 ? items(body.CIDS).map(Number) : [Number(body.CID ?? body.INFO?.CID)].filter(Number.isFinite);
    if (![1,3,4,5,8,9,13,14,16,20].includes(p.command)) return replyError(0x4000,'unreviewed Locker command');
    for (const id of ids) {
      const c = find(id);
      const allowed = [8,13].includes(p.command) ? canReadSharedContent(c,session,security.dynasties) : canReadContent(c,session,security.dynasties);
      if (!allowed || (![8,13].includes(p.command) && c.owner !== owner))
        return replyError(0x4000,'Locker ownership mismatch');
    }
    if (p.command === 14) {
      const d = security.dynasties[Number(body.GPID?.id)], m = d?.members.find(m => m.blazeId === owner);
      if (!m || (find(body.CID)?.name.endsWith('.dynasty') && !m.commissioner)) return replyError(0x4000,'Locker dynasty membership mismatch');
    }
  }
  switch (p.command) {
    case 1: { // createContent
      const cid = store.nextId++;
      const c = {
        cid, ccat: str(body.CCAT), name: str(body.NAME), desc: str(body.DESC), perm: num(body.PERM), coid: security ? owner : num(body.COID) || owner,
        owner, persona, attrs: items(body.ATTR), tags: items(body.TAGS), edat: num(body.EDAT), cdat: now(), udat: now(), size: 0, status: 0, ucnt: 0, confirmed: false,
      };
      store.contents[cid] = c; save();
      return reply(infoReply(c,session), note(`: ${summary(c)}`));
    }
    case 3: { // confirmUpload {INFO, STST}
      const c = find(num(body.INFO?.CID, -1));
      if (!c) return replyError(LOCKER_ERR_CONTENT_NOT_FOUND, note(`: unknown CID ${body.INFO?.CID}`));
      c.confirmed = true; c.status = 1; c.size = blobSize(c.cid); c.udat = now(); c.stst = num(body.STST); save();
      return reply(infoReply(c,session), note(`: ${summary(c)} STST ${body.STST}`));
    }
    case 4: { // updateContentInfo {ATTR, CCAT, CID, COID, DESC, EDAT, NAME, PERM, SIZE, TAGS}
      const c = find(num(body.CID, -1));
      if (!c) return replyError(LOCKER_ERR_CONTENT_NOT_FOUND, note(`: unknown CID ${body.CID}`));
      if (body.NAME !== undefined) c.name = str(body.NAME);
      if (body.DESC !== undefined) c.desc = str(body.DESC);
      if (body.PERM !== undefined) c.perm = num(body.PERM);
      if (body.EDAT !== undefined) c.edat = num(body.EDAT);
      if (body.ATTR) c.attrs = items(body.ATTR);
      if (body.TAGS) c.tags = items(body.TAGS);
      c.udat = now(); save();
      return reply(infoReply(c,session), note(`: ${summary(c)}`));
    }
    case 5: { // deleteContent {CCAT, CIDS}: records go to index trash and blobs to private/locker/trash/ (run 22 lost a dynasty this way)
      const ids = items(body.CIDS).map((x) => num(x, -1));
      fs.mkdirSync(path.join(DIR, 'trash'), { recursive: true });
      for (const id of ids) { const c = store.contents[String(id)]; if (c) { (store.trash ??= {})[String(id)] = { ...c, deletedAt: now() }; delete store.contents[String(id)]; } try { fs.renameSync(blobPath(id), path.join(DIR, 'trash', `${id}.bin`)); } catch { /* none */ } }
      save();
      return reply(undefined, note(`: deleted ${JSON.stringify(ids)}`));
    }
    case 8: { // getContentInfo {CCAT, CID, CVSF}
      const c = find(num(body.CID, -1));
      if (!c) return replyError(LOCKER_ERR_CONTENT_NOT_FOUND, note(`: unknown CID ${body.CID}`));
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
      const c = find(num(body.CID, -1));
      if (c) { c.group = { component: num(body.GPID?.component), type: num(body.GPID?.type), id: num(body.GPID?.id) }; save(); }
      return reply(undefined, note(c ? `: ${summary(c)} -> group ${JSON.stringify(c.group)}` : `: unknown CID ${body.CID}`));
    }
    case 13: { // incrementUseCount {CCAT, CID}
      const c = find(num(body.CID, -1));
      if (c) { c.ucnt = (c.ucnt ?? 0) + 1; save(); }
      return reply(undefined, note(c ? `: ${summary(c)} uses ${c.ucnt}` : `: unknown CID ${body.CID}`));
    }
    default:
      return reply(undefined, note(': empty response'));
  }
}

// HTTP side: the client POSTs the file to UURL (+ "&pers=<persona>") and GETs GURL for downloads.
export function startLockerHttp({ port, host = '127.0.0.1' }) {
  baseUrl = `http://${host}:${port}`;
  const xmlOk = '<LOCKER error="" errorCode="0"></LOCKER>';
  const xmlErr = (code, name) => `<error><component>${LOCKER}</component><errorCode>${code}</errorCode><errorName>${name}</errorName></error>`;
  const sendText = (res, status, body, type = 'text/xml') => { res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) }); res.end(body); };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const data = Buffer.concat(chunks);
      const url = new URL(req.url, baseUrl);
      const q = Object.fromEntries(url.searchParams);
      const c = find(q.cid);
      log('locker-http', `${req.socket.remoteAddress}:${req.socket.remotePort} ${req.method} ${url.pathname}`, { query: { ...q, cap:q.cap ? '[redacted]' : undefined }, bytes: data.length });
      if (security) {
        const cap = capabilities.get(q.cap), mode = url.pathname === '/locker/upload' ? 'upload' : 'download';
        if (!cap || cap.cid !== c?.cid || cap.mode !== mode || cap.expires < Date.now() || !security.isActive(cap.session)
            || !(mode === 'download' ? canReadSharedContent(c,cap.session,security.dynasties) : canReadContent(c,cap.session,security.dynasties)) || (mode === 'upload' && c.owner !== cap.session.userId))
          return sendText(res,403,xmlErr(0x4000,'LEAGUE_AUTH_REQUIRED'));
      }
      if (url.pathname === '/locker/upload' && (req.method === 'POST' || req.method === 'PUT')) {
        if (!c) return sendText(res, 404, xmlErr(14, 'LOCKER_ERR_CONTENT_NOT_FOUND'));
        try { fs.writeFileSync(blobPath(c.cid), data); } catch (e) { log('locker-http', `write failed: ${e.message}`); return sendText(res, 500, xmlErr(9, 'LOCKER_ERR_MAX_SIZE')); }
        c.size = data.length; c.udat = now(); c.uploadedBy = q.pers ?? ''; save();
        log('locker-http', `-> stored ${summary(c)} as ${blobPath(c.cid)}; replying ${xmlOk}`);
        return sendText(res, 200, xmlOk);
      }
      if (url.pathname === '/locker/download' && req.method === 'GET') {
        if (!c || !fs.existsSync(blobPath(c.cid))) return sendText(res, 404, xmlErr(14, 'LOCKER_ERR_CONTENT_NOT_FOUND'));
        const bytes = fs.readFileSync(blobPath(c.cid));
        log('locker-http', `-> sending ${summary(c)} (${bytes.length} bytes)`);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
        res.end(bytes);
        try { downloadHook?.(c); } catch (e) { log('locker-http', `download hook failed: ${e.message}`); }
        return undefined;
      }
      return sendText(res, 404, xmlErr(14, 'LOCKER_ERR_CONTENT_NOT_FOUND'));
    });
    req.on('error', (e) => log('locker-http', `request error ${e.message}`));
  });
  server.on('clientError', (e, s) => { log('locker-http', `client error ${e.message}`); s.destroy(); });
  server.listen(port, '0.0.0.0', () => log('locker-http', `locker file endpoint listening on tcp/${port} (urls use ${baseUrl}); ${Object.keys(store.contents).length} stored item(s)`));
  return server;
}
