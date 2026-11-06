// EA Sports World ("EASW-Version: 2.0.5.0") + XMS media service stand-in for NCAA 14's in-game Dynasty Wire.
// The console turns Sports World on only when the client config OSDK_EASW_ALLOWED_LOCALES lists its locale (up to four
// comma-separated 4-char patterns, '*' = any; the default "----" matches nothing, which is why the story step used to
// fail locally). It then signs in with POST <OSDK_EASW_AUTH_URL>/authentication<PS3?version=v2&locale=en_US&skuid=...>
// carrying its NP ticket, and reads EASW-Token / EASW-Session / EASW-Userid / EASW-Nucleus-Persona from the reply headers
// (SportsWorldConnectSuccess 0x10c1ac8; an empty token = failure). XMS calls go through the same signed client:
//   POST …/personas/<u>/sku/<s>/media[?maxed_slots=…]       multipart: "xml" (<create_media type slot>), "thumb", binaries
//   GET  …/media_content;full?platform=ps3&include_count=true&…  search -> <media_list count><media …/>…</media_list>
//   GET  …/personas/<u>/sku/<s>/media;full                   the persona's media (<media_list><media/>…)
//   GET  …/media/<id>/binary/<bid|name>   POST …/media/<id>;full?http-type=PUT   …/media/<id>?http-type=DELETE
//   POST …/media/<id>/downloadCount   POST /ns/gps/filter_blacklist   GET …/offensive_content   GET …/sku/<s>/configuration
// Media XML (XMSMediaConcrete::ParseXml 0x10def00): <media id slot sku type><name/><description/><date/><server_date/>
// <download_count/><ratings count/><owner/><thumbnail size>url</thumbnail><attributes><attribute key value/></attributes>
// <tags><tag name/></tags><binary id type name size uri/></media>; uploads answer <media_metadata …> with the same body.
// Story containers are described in story.mjs. Everything lands in private/xms/ (index.json, files/, raw/ request dumps).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { log } from './log.mjs';

const DIR = process.env.NCAA_XMS_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'private', 'xms'); // env override for offline tests
const FILES = path.join(DIR, 'files'), RAW = path.join(DIR, 'raw'), INDEX = path.join(DIR, 'index.json');
fs.mkdirSync(FILES, { recursive: true }); fs.mkdirSync(RAW, { recursive: true });

export const xmsEvents = new EventEmitter(); // 'stored' (media) after the console uploads or updates one
const db = (() => { try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return { nextId: 1001, media: {} }; } })();
const save = () => { const tmp = INDEX + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 1)); fs.renameSync(tmp, INDEX); };
let baseUrl = 'http://127.0.0.1:17504';
let identity = { personaId: 1000, name: 'Player' }; // the last console login (blaze.mjs ps3Login)
export const setLoginIdentity = (s) => { if (s?.personaId) identity = { personaId: Number(s.personaId), name: String(s.onlineId ?? s.name ?? 'Player') }; };
let reqSeq = 0;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlDate = (iso) => String(iso ?? new Date().toISOString()).slice(0, 19); // YYYY-MM-DDTHH:MM:SS (six numbers)
const fileOf = (id, bid) => path.join(FILES, `${id}-${bid}.bin`);
const thumbOf = (id) => path.join(FILES, `${id}-thumb.jpg`);

export const allMedia = () => Object.values(db.media);
export const getMedia = (id) => db.media[String(id)] ?? null;
export function readBinary(rec, which = 0) { const b = rec?.binaries?.[which]; return b && fs.existsSync(fileOf(rec.id, b.id)) ? fs.readFileSync(fileOf(rec.id, b.id)) : null; }

// Adds a media record. binaries: [{ name, type, bytes }]; thumb: Buffer | null.
export function addMedia({ type, slot = 0, name = '', description = '', date, attributes = {}, tags = [], binaries = [], thumb = null, ownerId, owner, origin = 'site', extra = {} }) {
  const id = db.nextId++; const now = new Date().toISOString();
  const rec = { id, type, slot, sku: 'NCAA14', ownerId: ownerId ?? identity.personaId, owner: owner ?? identity.name, name, description, date: date ?? now, serverDate: now, attributes: { ...attributes }, tags: [...tags], binaries: [], thumb: null, downloads: 0, origin, ...extra };
  binaries.forEach((b, i) => { fs.writeFileSync(fileOf(id, i + 1), b.bytes); rec.binaries.push({ id: i + 1, name: b.name, type: b.type, size: b.bytes.length }); });
  if (thumb?.length) { fs.writeFileSync(thumbOf(id), thumb); rec.thumb = { size: thumb.length }; }
  db.media[String(id)] = rec; save();
  return rec;
}
export function removeMedia(id) {
  const rec = getMedia(id); if (!rec) return false;
  for (const b of rec.binaries) fs.rmSync(fileOf(rec.id, b.id), { force: true });
  fs.rmSync(thumbOf(rec.id), { force: true });
  delete db.media[String(id)]; save(); return true;
}
export function updateMedia(id, patch) { const rec = getMedia(id); if (!rec) return null; Object.assign(rec, patch); save(); return rec; }

function mediaXml(rec, root = 'media') {
  const attrs = Object.entries(rec.attributes ?? {}).map(([k, v]) => `<attribute key="${esc(k)}" value="${esc(v)}"/>`).join('');
  const tags = (rec.tags ?? []).map((t) => `<tag name="${esc(t)}"/>`).join('');
  const bins = (rec.binaries ?? []).map((b) => `<binary id="${b.id}" type="${esc(b.type)}" name="${esc(b.name)}" size="${b.size}" uri="${esc(`${baseUrl}/xms/binary/${rec.id}/${b.id}`)}"/>`).join('');
  return `<${root} id="${rec.id}" type="${esc(rec.type)}" slot="${rec.slot ?? 0}" sku="${esc(rec.sku)}"><name>${esc(rec.name)}</name><description>${esc(rec.description)}</description>`
    + `<date>${xmlDate(rec.date)}</date><server_date>${xmlDate(rec.serverDate)}</server_date><download_count>${rec.downloads ?? 0}</download_count>`
    + `<ratings count="0">0.0</ratings><owner>${esc(rec.owner)}</owner>`
    + (rec.thumb ? `<thumbnail size="${rec.thumb.size}">${esc(`${baseUrl}/xms/thumb/${rec.id}.jpg`)}</thumbnail>` : '')
    + `<attributes>${attrs}</attributes><tags>${tags}</tags>${bins}</${root}>`;
}
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';

// <create_media type="T" slot="N"><description>…</><name>…</><date>…</><attributes><attribute value=V key=K/>…</attributes>
// <tags><tag name=T/></tags></create_media> (EA's formatter may close elements with "</>").
function parseCreateMedia(xml) {
  const attrOf = (s, k) => { const m = new RegExp(`\\b${k}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s/>]+))`).exec(s); return m ? (m[1] ?? m[2] ?? m[3]) : undefined; };
  const text = (tag) => { const m = new RegExp(`<${tag}>([\\s\\S]*?)</(?:${tag})?>`).exec(xml); return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&') : undefined; };
  const head = /<create_media\b([^>]*)>/.exec(xml)?.[1] ?? '';
  const attributes = {}; for (const m of xml.matchAll(/<attribute\b([^>]*?)\/?>/g)) { const k = attrOf(m[1], 'key'); if (k !== undefined) attributes[k] = attrOf(m[1], 'value') ?? ''; }
  const tags = [...xml.matchAll(/<tag\b([^>]*?)\/?>/g)].map((m) => attrOf(m[1], 'name')).filter((x) => x !== undefined);
  return { type: attrOf(head, 'type'), slot: Number(attrOf(head, 'slot') ?? 0), name: text('name'), description: text('description'), date: text('date'), attributes, tags };
}

function parseMultipart(body, contentType) {
  const b = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? ''); if (!b) return [];
  const sep = Buffer.from('--' + (b[1] ?? b[2])); const parts = [];
  let pos = body.indexOf(sep);
  while (pos !== -1) {
    const start = pos + sep.length; if (body.subarray(start, start + 2).toString() === '--') break;
    const next = body.indexOf(sep, start); if (next === -1) break;
    const chunk = body.subarray(start, next); const h = chunk.indexOf('\r\n\r\n');
    if (h !== -1) {
      const headers = chunk.subarray(0, h).toString('latin1'); let data = chunk.subarray(h + 4);
      if (data.subarray(-2).toString() === '\r\n') data = data.subarray(0, -2);
      const disp = /content-disposition:[^\r\n]*/i.exec(headers)?.[0] ?? '';
      parts.push({ name: /\bname="([^"]*)"/.exec(disp)?.[1] ?? '', filename: /filename="([^"]*)"/.exec(disp)?.[1] ?? null, type: /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1] ?? null, headers, data });
    }
    pos = next;
  }
  return parts;
}

// Which binary type a part becomes: the console names parts after the binary ("screen_jpg", "container", ...).
const BINARY_TYPES = { container: 'CONTAINER', screen_png: 'PNG_SCREENSHOT', screen_jpg: 'JPEG_SCREENSHOT', video_avi: 'AVI_VIDEO', video_flv: 'FLV_VIDEO', ncaafbschoolmt: 'NCAAFBSCHOOL_DATA' };
const IGNORED_QUERY = new Set(['platform', 'include_count', 'page_size', 'page_offset', 'page_num', 'order_by', 'sort_asc', 'translate_attributes', 'sku_guid', 'http-type', 'replaceList', 'maxed_slots', 'persona_type', 'bookmarked', 'group_id', 'keyword']);

function search(q) {
  const notes = [];
  let list = allMedia().filter((rec) => {
    for (const [k, v] of Object.entries(q)) {
      if (IGNORED_QUERY.has(k)) continue;
      if (k === 'media_id') { if (String(rec.id) !== v) return false; continue; }
      if (k === 'persona_id') { if (String(rec.ownerId) !== v) return false; continue; }
      if (k === 'gamer_tag') { if (rec.owner !== v) return false; continue; }
      if (k === 'type' || k === 'types' || k === 'media_type' || k === 'ctype') { if (v.split(',').every((t) => t.toLowerCase() !== String(rec.type).toLowerCase())) return false; continue; }
      if (k === 'attributes') { // the console's form: KEY#VALUE*KEY#VALUE (e.g. CONTAINER_GROUP#6*SEARCH_KEY_2#0)
        for (const pair of v.split('*').filter(Boolean)) { const i = pair.indexOf('#'); const key = i < 0 ? pair : pair.slice(0, i), val = i < 0 ? '' : pair.slice(i + 1); if (String(rec.attributes?.[key] ?? '') !== val) return false; }
        continue;
      }
      if (k in (rec.attributes ?? {})) { if (String(rec.attributes[k]) !== v) return false; continue; }
      if (/^[A-Z][A-Z0-9_]+$/.test(k)) return false; // an attribute filter this media does not carry
      if (!notes.includes(k)) notes.push(k);
    }
    return true;
  });
  list.sort((a, b) => String(b.serverDate).localeCompare(String(a.serverDate)) || b.id - a.id);
  if (q.sort_asc === 'true') list.reverse();
  const total = list.length, size = Number(q.page_size ?? 0) || 0;
  const off = q.page_num ? (Math.max(1, Number(q.page_num) || 1) - 1) * size : Number(q.page_offset ?? 0) || 0; // page_num counts from 1
  if (size) list = list.slice(off, off + size);
  return { list, total, notes };
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/xml; charset=UTF-8', 'Content-Length': buf.length, ...headers });
  res.end(buf);
}
const restError = (res, code, status = 404) => send(res, status, `${XML_HEAD}<rest_error><code>${code}</code></rest_error>`);

function authReply(res) {
  const token = crypto.randomBytes(16).toString('hex'), session = crypto.randomBytes(16).toString('hex');
  log('easw', `-> signed in persona ${identity.personaId} (${identity.name})`);
  send(res, 200, `${XML_HEAD}<authentication><persona_id>${identity.personaId}</persona_id></authentication>`, {
    'EASW-Token': token, 'EASW-Session': session, 'EASW-Userid': String(identity.personaId), 'EASW-Nucleus-Persona': String(identity.personaId),
  });
}

// sku_config: media slots for every media type the console registers (XMSFacade factories), no avatar/notifications.
const MEDIA_TYPES = ['MEDIA_CONTAINER', 'SCREENSHOT', 'GR_SCREENSHOT', 'VIDEOS', 'GR_VIDEO', 'PHOTOFACE', 'NCAAFBSCHOOLMT'];
const skuConfig = () => `${XML_HEAD}<sku_config><gameplay_triggers/><game_avatar><head_silhouette></head_silhouette><body_silhouette></body_silhouette></game_avatar>`
  + `<notification default_poll_interval="0"/><buffer_accomplishments>false</buffer_accomplishments><media_configuration>`
  + MEDIA_TYPES.map((t) => `<config><supported_types><type>${t}</type></supported_types><guid>${t}</guid><max_slots>500</max_slots><starting_slot>0</starting_slot></config>`).join('')
  + '</media_configuration></sku_config>';

function handle(req, res, body) {
  const url = new URL(req.url, baseUrl); const p = decodeURIComponent(url.pathname); const q = Object.fromEntries(url.searchParams);
  const method = (q['http-type'] ?? req.method).toUpperCase();
  const seq = ++reqSeq;
  log('easw', `#${seq} ${req.method}${method !== req.method ? `(${method})` : ''} ${url.pathname}${url.search}`, { headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/^easw-(token|session|request-signature|content-signature)$/i.test(k))), bytes: body.length, head: body.subarray(0, 64).toString('latin1') });
  if (body.length || !/\/xms\/(binary|thumb)\//.test(p)) { try { fs.writeFileSync(path.join(RAW, `${Date.now()}-${seq}-${req.method}.bin`), Buffer.concat([Buffer.from(`${req.method} ${req.url}\n${JSON.stringify(req.headers)}\n\n`), body])); } catch { /* best effort */ } }

  // our own media URLs
  let m;
  if ((m = /^\/xms\/binary\/(\d+)\/(\d+)$/.exec(p))) { const rec = getMedia(m[1]); const b = rec?.binaries.find((x) => String(x.id) === m[2]); return b && fs.existsSync(fileOf(rec.id, b.id)) ? send(res, 200, fs.readFileSync(fileOf(rec.id, b.id)), { 'Content-Type': 'application/octet-stream' }) : restError(res, 'NoContent'); }
  if ((m = /^\/xms\/thumb\/(\d+)\.jpg$/.exec(p))) { const rec = getMedia(m[1]); return rec?.thumb && fs.existsSync(thumbOf(rec.id)) ? send(res, 200, fs.readFileSync(thumbOf(rec.id)), { 'Content-Type': 'image/jpeg' }) : restError(res, 'NoContent'); }

  // Sports World session
  if (/\/authentication/i.test(p) || /\/extension$/i.test(p)) return authReply(res);
  if (/\/sku\/[^/]+\/configuration$/.test(p)) return send(res, 200, skuConfig());

  // XMS
  if ((m = /\/media\/(\d+)\/downloadCount$/.exec(p))) { const rec = getMedia(m[1]); if (rec) updateMedia(rec.id, { downloads: (rec.downloads ?? 0) + 1 }); return send(res, 200, `${XML_HEAD}<long>${rec?.downloads ?? 0}</long>`); }
  if ((m = /\/media\/(\d+)\/binary(?:\/([^/]+))?$/.exec(p))) {
    const rec = getMedia(m[1]); if (!rec) return restError(res, 'NoContent');
    const b = rec.binaries.find((x) => String(x.id) === m[2] || x.name === m[2]) ?? (m[2] ? null : rec.binaries[0]);
    if (method === 'GET') return b && fs.existsSync(fileOf(rec.id, b.id)) ? send(res, 200, fs.readFileSync(fileOf(rec.id, b.id)), { 'Content-Type': 'application/octet-stream' }) : restError(res, 'NoContent');
    const parts = parseMultipart(body, req.headers['content-type']); const data = parts.find((x) => x.filename || x.name !== 'xml')?.data ?? body;
    if (m[2] === 'thumbnail' || /thumb/i.test(parts[0]?.name ?? '')) { fs.writeFileSync(thumbOf(rec.id), data); rec.thumb = { size: data.length }; }
    else { const target = b ?? { id: rec.binaries.length + 1, name: m[2] ?? 'binary', type: BINARY_TYPES[m[2]] ?? 'BINARY' }; fs.writeFileSync(fileOf(rec.id, target.id), data); target.size = data.length; if (!b) rec.binaries.push(target); }
    rec.serverDate = new Date().toISOString(); save(); xmsEvents.emit('stored', rec);
    return send(res, 200, XML_HEAD + mediaXml(rec, 'media_metadata'));
  }
  if ((m = /\/media\/(\d+)(?:;full)?$/.exec(p))) {
    const rec = getMedia(m[1]);
    if (method === 'DELETE') { log('easw', `-> delete media ${m[1]}${rec ? '' : ' (unknown)'}`); removeMedia(m[1]); return send(res, 200, `${XML_HEAD}<void/>`); }
    if (!rec) return restError(res, 'NoContent');
    if (method === 'PUT' || method === 'POST') {
      const c = parseCreateMedia(body.toString('latin1'));
      updateMedia(rec.id, { name: c.name ?? rec.name, description: c.description ?? rec.description, attributes: q.replaceList === 'true' ? c.attributes : { ...rec.attributes, ...c.attributes }, tags: c.tags.length ? c.tags : rec.tags, serverDate: new Date().toISOString() });
      xmsEvents.emit('stored', rec);
    }
    return send(res, 200, XML_HEAD + mediaXml(rec, 'media_metadata'));
  }
  if (/\/personas\/[^/]+\/sku\/[^/]+\/media$/.test(p) && req.method === 'POST') {
    const parts = parseMultipart(body, req.headers['content-type']);
    const xmlPart = parts.find((x) => x.name === 'xml'); const c = parseCreateMedia(xmlPart ? xmlPart.data.toString('latin1') : body.toString('latin1'));
    const thumb = parts.find((x) => x.name === 'thumb')?.data ?? null;
    const bins = parts.filter((x) => x.name !== 'xml' && x.name !== 'thumb').map((x) => ({ name: x.name || x.filename || 'binary', type: BINARY_TYPES[x.name] ?? BINARY_TYPES[x.filename] ?? 'BINARY', bytes: x.data }));
    const rec = addMedia({ type: c.type ?? 'UNKNOWN', slot: c.slot, name: c.name ?? '', description: c.description ?? '', date: c.date, attributes: c.attributes, tags: c.tags, binaries: bins, thumb, origin: 'console' });
    log('easw', `-> stored console media ${rec.id} type ${rec.type} "${rec.name}" (${bins.map((b) => `${b.name} ${b.bytes.length} B`).join(', ') || 'no binaries'}${thumb ? `, thumb ${thumb.length} B` : ''})`, rec.attributes);
    xmsEvents.emit('stored', rec);
    return send(res, 200, XML_HEAD + mediaXml(rec, 'media_metadata'));
  }
  if (/\/media_content(;full)?$/.test(p) || /\/personas\/[^/]+\/sku\/[^/]+\/media(;full)?$/.test(p)) {
    const mine = /\/personas\//.test(p);
    const filters = { ...q }; if (mine) { const who = /\/personas\/([^/]+)\//.exec(p)?.[1]; if (q.persona_type === 'gamertag') filters.gamer_tag = who; else if (who && who !== '$u') filters.persona_id = who; }
    const { list, total, notes } = search(filters);
    log('easw', `-> ${mine ? 'media list' : 'search'}: ${list.length}/${total} item(s)${notes.length ? `; unhandled filters ${notes.join(', ')}` : ''}`);
    return send(res, 200, `${XML_HEAD}<media_list count="${total}">${list.map((r) => mediaXml(r)).join('')}</media_list>`);
  }
  if (/filter_blacklist$/.test(p)) { const t = /content_type="([^"]*)"/.exec(body.toString('latin1'))?.[1] ?? ''; return send(res, 200, `${XML_HEAD}<blacklist><content_id_list content_type="${esc(t)}"></content_id_list></blacklist>`); }
  if (/offensive_content$/.test(p)) return send(res, 200, req.method === 'GET' ? `${XML_HEAD}<offensive_summary_list-full></offensive_summary_list-full>` : `${XML_HEAD}<void/>`);
  log('easw', `-> unhandled path, answered <void/>`);
  return send(res, 200, `${XML_HEAD}<void/>`);
}

export function startEaswHttp({ port = 17504, host = '127.0.0.1' } = {}) {
  baseUrl = `http://${host}:${port}`;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { handle(req, res, Buffer.concat(chunks)); } catch (e) { log('easw', `handler error ${e.stack ?? e.message}`); if (!res.headersSent) send(res, 500, `${XML_HEAD}<rest_error><code>InvalidInput</code></rest_error>`); } });
    req.on('error', (e) => log('easw', `request error ${e.message}`));
  });
  server.on('clientError', (e, s) => { log('easw', `client error ${e.message}`); s.destroy(); });
  server.listen(port, '0.0.0.0', () => log('easw', `Sports World / XMS listening on tcp/${port} (urls use ${baseUrl}); ${allMedia().length} stored media`));
  return server;
}
export const easwBaseUrl = () => baseUrl;
// Rewrites one stored binary (e.g. a game recap's container after the coach wrote their side of the story on the site).
export function replaceBinary(id, which, bytes) {
  const rec = getMedia(id); const b = rec?.binaries?.[which]; if (!b) return null;
  fs.writeFileSync(fileOf(rec.id, b.id), bytes); b.size = bytes.length; rec.serverDate = new Date().toISOString(); save();
  return rec;
}
