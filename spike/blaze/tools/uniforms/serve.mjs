// Local server for the FCS Uniform Studio: serves uniform-studio.html and gives it direct access to the game's DLC folder
// and archive, so the page loads the mod automatically. Also hands textures to an external DDS editor and repackages
// the bigfile whenever the DDS is saved.
//   node serve.mjs [--rpcs3 <RPCS3 root>] [--port 8781] [--open]
// The RPCS3 root defaults to rpcs3Root in ~/.ncaa-bridge/config.json. Binds 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const C = createRequire(import.meta.url)('./src/codec.cjs');
const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
let root = arg('--rpcs3');
if (!root) { try { root = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ncaa-bridge', 'config.json'), 'utf8')).rpcs3Root; } catch {} }
if (!root) { console.error('RPCS3 root unknown: pass --rpcs3 <folder> or set rpcs3Root in ~/.ncaa-bridge/config.json'); process.exit(1); }
const DLC = arg('--dlc') || path.join(root, 'dev_hdd0', 'game', 'BLUS31159', 'USRDIR', 'DLC');
const USRDIR = path.dirname(DLC);
const ARCHIVE = arg('--archive') || path.join(root, 'dev_hdd0', 'disc', 'BLUS31159-[NCAA Football 14]', 'PS3_GAME', 'USRDIR', 'qkl_fe2ig.ast');
const NO_LAUNCH = args.includes('--no-launch');
const WORK = path.join(process.env.LOCALAPPDATA || os.homedir(), 'ncaa-bridge', 'uniforms', 'work');
const BACKUP = path.join(process.env.LOCALAPPDATA || os.homedir(), 'ncaa-bridge', 'uniforms', 'backup');
const PORT = Number(arg('--port') || 8781);
if (!fs.existsSync(DLC)) { console.error(`DLC folder not found: ${DLC}`); process.exit(1); }
fs.mkdirSync(WORK, { recursive: true }); fs.mkdirSync(BACKUP, { recursive: true });

const FOLDER_RE = /^(FCS_DLC_[A-Z0-9]+)?$/i, NAME_RE = /^[A-Za-z0-9_.()-]+$/;
const fileKind = (n) => /_mixandmatch\.xml$/i.test(n) ? 'xml' : /_big\.ast$/i.test(n) ? 'big' : /\.ast\.edat$/i.test(n) ? 'edat' : null;
const safe = (folder, name) => {
  if (!FOLDER_RE.test(folder || '') || !NAME_RE.test(name) || name.includes('..')) throw new Error('bad path');
  return path.join(folder ? path.join(DLC, folder) : DLC, name);
};
const events = []; let evId = 0;
const emit = (type, msg, extra = {}) => { events.push({ id: ++evId, t: Date.now(), type, msg, ...extra }); if (events.length > 500) events.shift(); console.log(`${new Date().toLocaleTimeString()} ${type}: ${msg}`); };

function listFiles() {
  const out = [];
  const scan = (dir, folder) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory()) { if (!folder && /^FCS_DLC_/i.test(d.name)) scan(path.join(dir, d.name), d.name); continue; }
      const kind = fileKind(d.name); if (!kind) continue;
      const st = fs.statSync(path.join(dir, d.name));
      out.push({ folder, name: d.name, size: st.size, mtime: st.mtimeMs, kind });
    }
  };
  scan(DLC, '');
  return out;
}
function backupThenWrite(file, bytes) {
  if (fs.existsSync(file)) {
    const rel = path.relative(DLC, file).replace(/[\\/]/g, '__');
    const dst = path.join(BACKUP, `${rel}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
    fs.copyFileSync(file, dst);
  }
  fs.writeFileSync(file, bytes);
}

// ---------- archive (qkl_fe2ig.ast): TOC read once, entries sliced on demand ----------
let arc = null;
function archive() {
  if (arc) return arc;
  if (!fs.existsSync(ARCHIVE)) throw new Error(`archive not found: ${ARCHIVE}`);
  const fd = fs.openSync(ARCHIVE, 'r');
  const head = Buffer.alloc(64); fs.readSync(fd, head, 0, 64, 0);
  if (head.toString('latin1', 0, 8) !== 'BGFA1.05') throw new Error('qkl_fe2ig.ast is not a BGFA 1.05 archive');
  const tocOff = head.readUInt32LE(16), tocSize = head.readUInt32LE(24);
  const toc = Buffer.alloc(tocOff + tocSize); fs.readSync(fd, toc, 0, toc.length, 0);
  const parsed = C.parseBigfile(new Uint8Array(toc.buffer, toc.byteOffset, toc.length), 'archive');
  const map = new Map(); parsed.entries.forEach((e, i) => map.set(C.hex64(e.hash), { i, off: e.off, csize: e.csize, delta: e.delta }));
  arc = { fd, map, count: parsed.entries.length };
  return arc;
}
async function archiveEntry(name) {
  const a = archive();
  const e = a.map.get(C.hex64(C.fnv1a64(name.toUpperCase()))) || a.map.get(C.hex64(C.fnv1a64(name)));
  if (!e) return null;
  const buf = Buffer.alloc(e.csize); fs.readSync(a.fd, buf, 0, e.csize, e.off);
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  return C.isZlib(u8) ? await C.zlibInflate(u8) : u8;
}

// ---------- DDS hand-off: write the texture as DDS, open it, repackage when it changes ----------
const watched = new Map(); // ddsPath -> {folder, big, entry, mtime, size, stable}
function ddsPath(folder, big, entry) { const dir = path.join(WORK, folder || 'root', big.replace(/\.(ast|big)$/i, '')); fs.mkdirSync(dir, { recursive: true }); return path.join(dir, `${entry}.dds`); }
async function loadBig(folder, big) {
  const file = safe(folder, big); const u8 = new Uint8Array(fs.readFileSync(file));
  const parsed = C.parseBigfile(u8, big); for (const e of parsed.entries) await C.loadEntry(e);
  return { file, parsed };
}
async function openDds(folder, big, entry) {
  const { parsed } = await loadBig(folder, big);
  const e = parsed.entries.find((x) => x.name === entry); if (!e) throw new Error(`${entry} not in ${big}`);
  const t = C.parseTexture(e.data, entry); const p = ddsPath(folder, big, entry);
  fs.writeFileSync(p, C.toDDS(t));
  const st = fs.statSync(p); watched.set(p, { folder, big, entry, mtime: st.mtimeMs, size: st.size, stable: 0 });
  if (!NO_LAUNCH) spawn('cmd', ['/c', 'start', '', p], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  emit('dds-open', `${entry} written to ${p} and opened in the default DDS editor; it is repackaged into ${big} whenever you save it`, { folder, big, entry, path: p });
  return p;
}
async function reimport(folder, big, entry, src) {
  const p = src || ddsPath(folder, big, entry);
  const { file, parsed } = await loadBig(folder, big);
  const e = parsed.entries.find((x) => x.name === entry); if (!e) throw new Error(`${entry} not in ${big}`);
  const t = C.parseTexture(e.data, entry);
  const imp = C.fromDDS(new Uint8Array(fs.readFileSync(p)));
  const { bytes, mode } = C.textureFromImport(t, imp, C.resampleRGBA);
  e.data = bytes; e.dirty = true;
  const out = await C.buildBigfile(parsed);
  backupThenWrite(file, out);
  emit('repackaged', `${entry}: ${mode}; ${big} rewritten (${(out.length / 1024).toFixed(0)} KB, backup kept)`, { folder, big, entry });
  return { mode, size: out.length };
}
setInterval(async () => {
  for (const [p, w] of watched) {
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.mtimeMs !== w.mtime || st.size !== w.size) { w.mtime = st.mtimeMs; w.size = st.size; w.stable = 0; w.changed = true; continue; }
    if (w.changed && ++w.stable >= 2) { w.changed = false; w.stable = 0; try { await reimport(w.folder, w.big, w.entry, p); } catch (err) { emit('error', `${w.entry}: ${err.message}`, { folder: w.folder, big: w.big, entry: w.entry }); } }
  }
}, 1000);

// ---------- HTTP ----------
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve, reject) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject); });
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1'); const p = decodeURIComponent(url.pathname);
    if (req.method === 'GET' && (p === '/' || p === '/uniform-studio.html')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(fs.readFileSync(path.join(here, 'uniform-studio.html'))); return; }
    if (p === '/api/config') return json(res, 200, { dlcDir: DLC, usrDir: USRDIR, archive: fs.existsSync(ARCHIVE) ? ARCHIVE : null, work: WORK, backup: BACKUP, rpcs3: root, time: Date.now() });
    if (p === '/api/files') return json(res, 200, { files: listFiles() });
    if (p === '/api/events') { const since = Number(url.searchParams.get('since') || 0); return json(res, 200, { events: events.filter((e) => e.id > since), last: evId }); }
    let m;
    if ((m = /^\/api\/file\/([^/]*)\/([^/]+)$/.exec(p))) {
      const file = safe(m[1], m[2]);
      if (req.method === 'GET') { if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' }); res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' }); res.end(fs.readFileSync(file)); return; }
      if (req.method === 'PUT') { const body = await readBody(req); fs.mkdirSync(path.dirname(file), { recursive: true }); backupThenWrite(file, body); emit('saved', `${m[1] ? m[1] + '/' : ''}${m[2]} (${(body.length / 1024).toFixed(0)} KB)`); return json(res, 200, { ok: true, size: body.length }); }
    }
    if ((m = /^\/api\/archive\/([A-Za-z0-9_.-]+)$/.exec(p)) && req.method === 'GET') {
      if (url.searchParams.get('probe')) { const a = archive(); const e = a.map.get(C.hex64(C.fnv1a64(m[1].toUpperCase()))); return json(res, 200, e ? { found: true, entry: e.i, stored: e.csize, size: e.csize + e.delta } : { found: false }); }
      const bytes = await archiveEntry(m[1]);
      if (!bytes) return json(res, 404, { error: `no archive entry named ${m[1]}` });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' }); res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)); return;
    }
    if (p === '/api/dds/open' && req.method === 'POST') { const b = JSON.parse((await readBody(req)).toString()); const file = await openDds(b.folder || '', b.big, b.entry); return json(res, 200, { ok: true, path: file }); }
    if (p === '/api/dds/reimport' && req.method === 'POST') { const b = JSON.parse((await readBody(req)).toString()); const r = await reimport(b.folder || '', b.big, b.entry); return json(res, 200, { ok: true, ...r }); }
    if (p === '/api/open-folder' && req.method === 'POST') { const b = JSON.parse((await readBody(req)).toString()); const dir = b.folder ? safe(b.folder, 'x').slice(0, -1) : DLC; spawn('explorer', [dir], { detached: true, stdio: 'ignore' }).unref(); return json(res, 200, { ok: true }); }
    json(res, 404, { error: 'no such route' });
  } catch (err) { json(res, 500, { error: err.message }); console.error(err); }
});
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`FCS Uniform Studio: ${url}\n  DLC folder: ${DLC}\n  archive:    ${fs.existsSync(ARCHIVE) ? ARCHIVE : '(not found)'}\n  DDS work:   ${WORK}\n  backups:    ${BACKUP}`);
  if (args.includes('--open')) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
});
