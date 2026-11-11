// Uniform colours and face skin tones for the 3D figures on the odds board (worker/client/hero3d.mjs).
//
//   node tools/uniform-colours.mjs [--only ABBR,ABBR] [--no-faces]
//
// Uniforms: for every FCS team, the parts its <SLOT>_Pack0_MixAndMatch.XML marks as the official Home and Away helmet,
// jersey and pants, each read from its own texture (the game's art, in the RPCS3 DLC folders or the disc archive) and
// reduced to its main colour and its main trim colour. Written to worker/src/pages/uniforms.generated.ts by TGID.
// Teams whose XML names no official set take their newest art by file name; encrypted (.edat) art cannot be read.
// Faces: the main skin colour of each in-game head (face_<n>.png, the files `ncaa-bridge photos` uploads), written to
// worker/src/pages/face-skin.generated.ts.
// Needs the RPCS3 folder and faces folder from ~/.ncaa-bridge/config.json (rpcs3Root, facesDir).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const UNI = path.join(here, '..', 'spike', 'blaze', 'tools', 'uniforms');
const C = require(path.join(UNI, 'src', 'codec.cjs'));
const mapping = JSON.parse(fs.readFileSync(path.join(UNI, 'src', 'fcs-mapping.json'), 'utf8'));
const args = process.argv.slice(2); const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const only = arg('--only') ? arg('--only').toUpperCase().split(',') : null;
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ncaa-bridge', 'config.json'), 'utf8'));
const rpcs3 = process.env.NCAA_RPCS3 ?? cfg.rpcs3Root ?? cfg.rpcs3;
const DLC = path.join(rpcs3, 'dev_hdd0', 'game', 'BLUS31159', 'USRDIR', 'DLC');
if (!fs.existsSync(DLC)) throw new Error(`RPCS3 DLC folder not found: ${DLC}`);
const ARCHIVE = path.join(rpcs3, 'dev_hdd0', 'disc', 'BLUS31159-[NCAA Football 14]', 'PS3_GAME', 'USRDIR', 'qkl_fe2ig.ast');

// ---------- files: the DLC folders first, then the disc archive (entries by FNV-1a 64 of the upper-cased name) ----------
const fileIndex = new Map();
for (const f of fs.readdirSync(DLC)) { const d = path.join(DLC, f); if (!fs.statSync(d).isDirectory()) continue; for (const x of fs.readdirSync(d)) fileIndex.set(x.toLowerCase(), path.join(d, x)); }
let arc = null;
async function archiveEntry(name) {
  if (arc === null) {
    if (!fs.existsSync(ARCHIVE)) arc = false;
    else {
      const fd = fs.openSync(ARCHIVE, 'r'), head = Buffer.alloc(64); fs.readSync(fd, head, 0, 64, 0);
      const toc = Buffer.alloc(head.readUInt32LE(16) + head.readUInt32LE(24)); fs.readSync(fd, toc, 0, toc.length, 0);
      arc = { fd, map: new Map(C.parseBigfile(new Uint8Array(toc.buffer, toc.byteOffset, toc.length), 'archive').entries.map((e) => [C.hex64(e.hash), e])) };
    }
  }
  if (!arc) return null;
  const e = arc.map.get(C.hex64(C.fnv1a64(name.toUpperCase()))); if (!e) return null;
  const buf = Buffer.alloc(e.csize); fs.readSync(arc.fd, buf, 0, e.csize, e.off); const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  return C.isZlib(u8) ? C.zlibInflate(u8) : u8;
}
async function loadBig(name) {
  const p = fileIndex.get(`${name}.ast`.toLowerCase());
  if (p) return C.parseBigfile(new Uint8Array(fs.readFileSync(p)), name);
  const a = await archiveEntry(name); return a ? C.parseBigfile(a, name) : null;
}
async function loadXml(slot) {
  const names = [`${slot}_Pack0_MixAndMatch.XML`];
  for (const n of names) { const p = fileIndex.get(n.toLowerCase()); if (p) return { text: fs.readFileSync(p, 'utf8'), from: 'dlc' }; }
  for (const n of [`${slot}_Pack0_MixAndMatch.XML`, `${slot}_Pack0_MixAndMatch`]) { const a = await archiveEntry(n); if (a) return { text: Buffer.from(a).toString('utf8'), from: 'archive' }; }
  return null;
}

// ---------- colours ----------
const hex = (c) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// the main colour of an image and the most common colour clearly different from it: 4-bit-per-channel buckets, each
// bucket reported as the mean of its pixels; transparent pixels are skipped
function palette(img, { minAlpha = 128, region = null } = {}) {
  const { width: w, height: h, rgba } = img; const buckets = new Map(); let n = 0;
  const [x0, y0, x1, y1] = region ? [Math.floor(region[0] * w), Math.floor(region[1] * h), Math.ceil(region[2] * w), Math.ceil(region[3] * h)] : [0, 0, w, h];
  const step = Math.max(1, Math.floor(Math.min(w, h) / 256));
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    const i = (y * w + x) * 4; if (rgba[i + 3] < minAlpha) continue;
    const k = ((rgba[i] >> 4) << 8) | ((rgba[i + 1] >> 4) << 4) | (rgba[i + 2] >> 4); let b = buckets.get(k);
    if (!b) buckets.set(k, (b = [0, 0, 0, 0])); b[0] += rgba[i]; b[1] += rgba[i + 1]; b[2] += rgba[i + 2]; b[3]++; n++;
  }
  if (!n) return null;
  // merge neighbouring buckets into the biggest ones so a shaded panel counts as one colour
  const list = [...buckets.values()].map((b) => ({ c: [b[0] / b[3], b[1] / b[3], b[2] / b[3]], n: b[3] })).sort((a, b) => b.n - a.n);
  const groups = [];
  for (const b of list) { const g = groups.find((x) => dist(x.c, b.c) < 42); if (g) { const t = g.n + b.n; g.c = g.c.map((v, i) => (v * g.n + b.c[i] * b.n) / t); g.n = t; } else groups.push({ c: b.c.slice(), n: b.n }); }
  groups.sort((a, b) => b.n - a.n);
  const main = groups[0]; const trim = groups.find((g) => g !== main && dist(g.c, main.c) > 90 && g.n > n * 0.015);
  return { main: hex(main.c), trim: trim ? hex(trim.c) : null, share: main.n / n };
}
async function colourOf(bigName, suffix = '_COL') {
  const big = await loadBig(bigName); if (!big) return null;
  const e = big.entries.find((x) => x.name.toUpperCase().endsWith(suffix)); if (!e) return null;
  const t = C.parseTexture(await C.loadEntry(e), e.name); const level = Math.min(t.mips - 1, Math.max(0, Math.round(Math.log2(Math.max(t.width, t.height) / 512))));
  return palette(C.decodeMip(t, level));
}

// ---------- the XML: parts, their bigfiles and which official set (Home / Away) they belong to ----------
function parseParts(xml) {
  const parts = [];
  for (const m of xml.matchAll(/<part\b([^>]*)>([\s\S]*?)<\/part>/g)) {
    const attr = (k) => new RegExp(`${k}="([^"]*)"`).exec(m[1])?.[1] ?? null; const body = m[2];
    const one = (tag) => new RegExp(`<${tag} name="([^"]*)"`).exec(body)?.[1] ?? null;
    parts.push({ name: attr('name'), type: attr('type'), shade: attr('shade'), bigfile: one('bigfile'), numbers: one('numberColorTexture'), official: [...body.matchAll(/<official name="([^"]*)"/g)].map((x) => x[1]) });
  }
  return parts;
}
async function uniform(parts, set) {
  const pick = (type) => parts.find((p) => p.type === type && p.official.includes(set)) ?? null;
  const out = {}; const src = {};
  for (const type of ['helmet', 'jersey', 'pants']) {
    const p = pick(type); if (!p?.bigfile) continue;
    const c = await colourOf(p.bigfile).catch(() => null); if (!c) continue;
    out[type] = c.main; src[type] = p.name;
    if (type === 'jersey') {
      if (c.trim) out.trim = c.trim;
      // the number colour: the number sheet's main opaque colour (its own bigfile entry)
      const big = await loadBig(p.bigfile); const e = big?.entries.find((x) => x.name.toUpperCase().endsWith('_NUMS_DECAL'));
      if (e) { const t = C.parseTexture(await C.loadEntry(e), e.name); const n = palette(C.decodeMip(t, Math.min(t.mips - 1, 1)), { minAlpha: 200 }); if (n) out.number = n.main; }
    }
    if (type === 'helmet' && c.trim) out.helmetTrim = c.trim;
    if (type === 'pants' && c.trim) out.pantsTrim = c.trim;
  }
  return { out, src };
}

// ---------- teams whose XML names no official set (or that have none): pick from the team's own art by file name ----------
// <PREFIX>_<HELMET|JERSEY|PANTSX>_<YEAR>_<COLOUR>_big: the newest year; the white jersey is the road one, a coloured one
// the home one; light pants with the dark jersey and dark pants with the white one where the team has both.
const PREFIX = { AAMU: 'BAMAAM', ALST: 'BAMAST', BRWN: 'BROWNX', BUT: 'BUTLER', CP: 'CALPOL', CAMP: 'CAMBEL', CLMB: 'COLOMB', COR: 'CORNEL', DART: 'DARTMO', DAY: 'DAYTON', ETSU: 'ETSUXX', ELON: 'ELONXX',
  FAMU: 'FAMUXX', FUR: 'FURMAN', GRAM: 'GRAMXX', HAMP: 'HAMPTO', HARV: 'HARVAR', IDHO: 'IDAHOX', IDST: 'IDASTA', MAINE: 'MAINEX', MRST: 'MARIST', MER: 'MERCER', MVSU: 'MVSUXX', MONM: 'MONMOU', MORE: 'MORHED',
  NCAT: 'NCATXX', NDAK: 'UNDXXX', UNCO: 'UNCOLO', UNI: 'UNIXXX', PENN: 'PENNXX', PSU: 'PORTST', PVAMU: 'PVAMUX', PRIN: 'PRINCE', URI: 'RHODEX', SAC: 'SACSTX', SAM: 'SAMFOR', USD: 'SANDGO', SDSU: 'SDSUXX',
  STET: 'STETSN', STON: 'STONYB', TXSO: 'TEXSOU', CIT: 'CITXXX', TOWS: 'TOWSON', ALBY: 'ALBANY', UAPB: 'UAPBXX', UCD: 'UCDAVI', UTU: 'UTTECH', VALPO: 'VALPOR', WEB: 'WEBERX', WCU: 'WCUXXX', WOF: 'WOFFOR', YALE: 'YALEXX' };
const art = new Map(); // prefix -> [{ type, year, colour, name }]
for (const f of fileIndex.keys()) { const m = /^([a-z0-9]+)_(helmet|jersey|pantsx?)_(\d{4})_([a-z0-9]+)_big\.ast$/.exec(f); if (!m) continue; const k = m[1].toUpperCase(); if (!art.has(k)) art.set(k, []); art.get(k).push({ type: m[2].startsWith('pants') ? 'pants' : m[2], year: Number(m[3]), colour: m[4].toUpperCase(), name: f.replace(/\.ast$/, '') }); }
const lumOf = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; };
async function guess(prefix) {
  const files = (art.get(prefix) ?? []).filter((x) => x.year <= 2100); if (!files.length) return null;
  const newest = (type) => { const l = files.filter((x) => x.type === type); const y = Math.max(...l.map((x) => x.year)); return l.filter((x) => x.year === y); };
  const withCol = async (l) => (await Promise.all(l.map(async (x) => ({ ...x, c: await colourOf(x.name).catch(() => null) })))).filter((x) => x.c);
  const [he, je, pa] = await Promise.all([withCol(newest('helmet')), withCol(newest('jersey')), withCol(newest('pants'))]);
  if (!je.length) return null;
  const by = (l, f) => l.slice().sort((a, b) => f(a) - f(b))[0];
  const jHome = by(je, (x) => lumOf(x.c.main)), jAway = by(je, (x) => -lumOf(x.c.main));
  const pHome = pa.length ? by(pa, (x) => -lumOf(x.c.main)) : null, pAway = pa.length ? by(pa, (x) => lumOf(x.c.main)) : null;
  const helmet = he.length ? by(he, (x) => (x.colour.startsWith('WHIT') ? 1 : 0)) : null;
  const numbers = async (x) => { const big = await loadBig(x.name); const e = big?.entries.find((y) => y.name.toUpperCase().endsWith('_NUMS_DECAL')); if (!e) return null; const t = C.parseTexture(await C.loadEntry(e), e.name); return palette(C.decodeMip(t, Math.min(t.mips - 1, 1)), { minAlpha: 200 })?.main ?? null; };
  const set = async (j, p) => { const o = { jersey: j.c.main }; if (j.c.trim) o.trim = j.c.trim; const n = await numbers(j); if (n) o.number = n; if (helmet) { o.helmet = helmet.c.main; if (helmet.c.trim) o.helmetTrim = helmet.c.trim; } if (p) { o.pants = p.c.main; if (p.c.trim) o.pantsTrim = p.c.trim; } return o; };
  return { home: await set(jHome, pHome), away: await set(jAway, pAway) };
}

const result = {}; const report = [];
const line = (t, from, u) => `${t.abbr.padEnd(6)} ${t.slot}  ${from.padEnd(7)} home ${u.home.helmet ?? '-------'} ${u.home.jersey ?? '-------'} ${u.home.pants ?? '-------'} n${u.home.number ?? ''}   away ${u.away.helmet ?? '-------'} ${u.away.jersey ?? '-------'} ${u.away.pants ?? '-------'} n${u.away.number ?? ''}`;
for (const t of mapping.teams) {
  if (only && !only.includes(t.abbr.toUpperCase())) continue;
  const xml = await loadXml(t.slot); const ok = (u) => u.helmet && u.jersey && u.pants;
  if (xml) {
    const parts = parseParts(xml.text); const home = (await uniform(parts, 'Home')).out, away = (await uniform(parts, 'Away')).out;
    if (ok(home) && ok(away)) { result[t.tgid] = { home, away }; report.push(line(t, xml.from, result[t.tgid])); continue; }
  }
  // no official set in the XML: the team's own art by file name (the listed prefix, or the one most of the XML's parts use)
  let prefix = PREFIX[t.abbr];
  if (!prefix && xml) { const n = new Map(); for (const p of parseParts(xml.text)) { const k = (p.bigfile ?? '').split('_')[0].toUpperCase(); if (k && k !== 'GENERIC' && art.has(k)) n.set(k, (n.get(k) ?? 0) + 1); } prefix = [...n].sort((a, b) => b[1] - a[1])[0]?.[0]; }
  const g = prefix ? await guess(prefix) : null;
  if (g && g.home.jersey) { result[t.tgid] = g; report.push(line(t, 'files', g)); } else report.push(`${t.abbr.padEnd(6)} ${t.slot}  none`);
}
console.log(report.join('\n'));
if (!only) {
  const out = path.join(here, '..', 'worker', 'src', 'pages', 'uniforms.generated.ts');
  fs.writeFileSync(out, `// Generated by tools/uniform-colours.mjs from the game's own uniform art: the main colour of each team's official Home
// and Away helmet, jersey and pants (plus trim and number colours), by TGID. Used for the 3D figures on the odds board.
export interface Kit { helmet?: string; helmetTrim?: string; jersey?: string; trim?: string; number?: string; pants?: string; pantsTrim?: string }
export const UNIFORMS: Record<number, { home: Kit; away: Kit }> = ${JSON.stringify(result)};
`);
  console.log(`\n${Object.keys(result).length} of ${mapping.teams.length} teams -> ${out}`);
}

// ---------- faces: the skin colour of each in-game head ----------
if (!args.includes('--no-faces') && !only && cfg.facesDir && fs.existsSync(cfg.facesDir)) {
  const sharp = require('sharp'); const skin = {};
  for (const f of fs.readdirSync(cfg.facesDir)) {
    const m = /^face_(\d+)\.png$/i.exec(f); if (!m) continue;
    const { data, info } = await sharp(path.join(cfg.facesDir, f)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    // the middle of the face (cheeks, nose, forehead): the median of the opaque pixels there, darkest and lightest fifths dropped
    const px = []; const w = info.width, h = info.height;
    for (let y = Math.floor(h * 0.3); y < h * 0.62; y++) for (let x = Math.floor(w * 0.34); x < w * 0.66; x++) { const i = (y * w + x) * 4; if (data[i + 3] > 200) px.push([data[i], data[i + 1], data[i + 2]]); }
    if (px.length < 20) continue;
    px.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2])); const mid = px.slice(Math.floor(px.length * 0.2), Math.ceil(px.length * 0.8));
    skin[Number(m[1])] = hex([0, 1, 2].map((k) => mid.reduce((s, p) => s + p[k], 0) / mid.length));
  }
  const ids = Object.keys(skin).map(Number).sort((a, b) => a - b);
  const ts = `// Generated by tools/uniform-colours.mjs from the in-game head images (face_<n>.png): the main skin colour of each\n// face id (PLAY.PGHE, players.head_id). Used for the 3D figures on the odds board.\nexport const FACE_SKIN: ReadonlyMap<number, string> = new Map([\n${ids.map((i) => `  [${i}, '${skin[i]}'],`).join('\n')}\n]);\n`;
  const out = path.join(here, '..', 'worker', 'src', 'pages', 'face-skin.generated.ts'); fs.writeFileSync(out, ts);
  console.log(`${ids.length} faces -> ${out}`);
}
if (arc) fs.closeSync(arc.fd);
