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
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'private', 'locker');
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
const uploadUrl = (c) => `${baseUrl}/locker/upload?cid=${c.cid}`;     // the client appends "&pers=<persona>"
const downloadUrl = (c) => `${baseUrl}/locker/download?cid=${c.cid}`;

// Blaze::Locker::ContentInfo, members in tag order. BOID/GPID (object ids) and HIDE are left out: the client keeps their defaults.
function contentInfo(w, c) {
  w.list('ATTR', T.STRUCT, c.attrs ?? [], (x, a) => { x.str('NAME', str(a.NAME)); x.str('VALU', str(a.VALU)); x.push(0); });
  w.str('CCAT', c.ccat); w.int('CDAT', c.cdat); w.int('CID', c.cid); w.int('COID', c.coid); w.str('DESC', c.desc); w.str('DFMT', '');
  w.int('EDAT', c.edat); w.int('EID', c.owner); w.str('ENAM', c.persona); w.str('GURL', downloadUrl(c)); w.str('NAME', c.name); w.int('PERM', c.perm);
  w.int('RATE', 0); w.int('RCNT', 0); w.int('SIZE', c.size); w.int('STTS', c.status);
  w.map('SUBL', T.STRING, T.STRUCT, [], () => {}, () => {});
  w.list('TAGS', T.STRUCT, c.tags ?? [], (x, t) => { x.str('TAG', str(t.TAG)); x.int('TGID', num(t.TGID)); x.push(0); });
  w.int('UCNT', c.ucnt ?? 0); w.int('UDAT', c.udat); w.str('UURL', uploadUrl(c)); w.str('XID', '');
}
const infoReply = (c) => (w) => w.struct('INFO', (x) => contentInfo(x, c));
const listReply = (list) => (w) => { w.list('LKRS', T.STRUCT, list, (x, c) => { contentInfo(x, c); x.push(0); }); w.int('MSIZ', 0); w.int('TCNT', list.length); };
const find = (cid) => store.contents[String(cid)];
const summary = (c) => `CID ${c.cid} "${c.name}" (${c.ccat}, ${c.size} bytes, status ${c.status})`;

export function handleLocker({ p, body, session, reply, replyError }) {
  const name = LOCKER_COMMANDS[p.command] ?? `cmd${p.command}`;
  const note = (extra = '') => `(Locker ${name}${extra})`;
  const owner = session?.userId ?? 0, persona = session?.onlineId ?? 'Player';
  switch (p.command) {
    case 1: { // createContent
      const cid = store.nextId++;
      const c = {
        cid, ccat: str(body.CCAT), name: str(body.NAME), desc: str(body.DESC), perm: num(body.PERM), coid: num(body.COID) || owner,
        owner, persona, attrs: items(body.ATTR), tags: items(body.TAGS), edat: num(body.EDAT), cdat: now(), udat: now(), size: 0, status: 0, ucnt: 0, confirmed: false,
      };
      store.contents[cid] = c; save();
      return reply(infoReply(c), note(`: ${summary(c)} -> upload to ${uploadUrl(c)}`));
    }
    case 3: { // confirmUpload {INFO, STST}
      const c = find(num(body.INFO?.CID, -1));
      if (!c) return replyError(LOCKER_ERR_CONTENT_NOT_FOUND, note(`: unknown CID ${body.INFO?.CID}`));
      c.confirmed = true; c.status = 1; c.size = blobSize(c.cid); c.udat = now(); c.stst = num(body.STST); save();
      return reply(infoReply(c), note(`: ${summary(c)} STST ${body.STST}`));
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
      return reply(infoReply(c), note(`: ${summary(c)}`));
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
      return reply(infoReply(c), note(`: ${summary(c)}`));
    }
    case 9: case 16: case 20: { // listContent / listContentForUsers / listContentForTag
      // Filters seen from the console: EID (owner, 0 = any), GPID (owner group = the dynasty objid set by setOwnerGroup, id 0 = any),
      // PEND 1 = only unconfirmed uploads (the client deletes whatever this returns when it exits a dynasty: run 22).
      const ccat = str(body.CCAT ?? body.CAT);
      const eids = (p.command === 16 ? items(body.EID).map((x) => num(x, -1)) : (body.EID !== undefined ? [num(body.EID)] : [])).filter((x) => x > 0);
      const gid = num(body.GPID?.id, 0); const pendingOnly = num(body.PEND) === 1;
      const list = Object.values(store.contents).filter((c) => (!ccat || c.ccat === ccat) && (eids.length ? eids.includes(c.owner) : true) && (gid ? c.group?.id === gid : true) && (pendingOnly ? !c.confirmed : true));
      return reply(listReply(list), note(`: ${list.length} item(s) in "${ccat}" (owner ${eids.join('/') || 'any'}, group ${gid || 'any'}${pendingOnly ? ', pending only' : ''})`));
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
      log('locker-http', `${req.socket.remoteAddress}:${req.socket.remotePort} ${req.method} ${url.pathname}`, { query: q, headers: req.headers, bytes: data.length, head: data.subarray(0, 48).toString('hex') });
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
        return res.end(bytes);
      }
      return sendText(res, 404, xmlErr(14, 'LOCKER_ERR_CONTENT_NOT_FOUND'));
    });
    req.on('error', (e) => log('locker-http', `request error ${e.message}`));
  });
  server.on('clientError', (e, s) => { log('locker-http', `client error ${e.message}`); s.destroy(); });
  server.listen(port, '0.0.0.0', () => log('locker-http', `locker file endpoint listening on tcp/${port} (urls use ${baseUrl}); ${Object.keys(store.contents).length} stored item(s)`));
  return server;
}
