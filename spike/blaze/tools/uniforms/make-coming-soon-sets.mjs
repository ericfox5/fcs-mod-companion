// Placeholder uniform sets for the FCS slots whose mod XML is the one-row "Coming Soon" set (no Home/Away rows: crashes
// at game load). Teambuilder team saves (a library of decrypted BLUS31159-TEAM-### folders) hold no uniform art: their TUNI
// rows are a colour/stripe recipe the game renders at run time, next to two DXT3 logos (256 wordmark, 128 helmet logo). So
// each set here is the mod's own placeholder parts (FCSXXX_*_2042_*, the same scenes as Hampton's) recoloured to the save's
// TUNI colours, with the 128px logo on both helmet sides and the COMING SOON text / FCS patches erased. Teams without a
// readable save get the same set from school colours and their ESPN logo (archive/logos/teams, not in git). Richmond and
// Long Island already have art in the DLC folders (RICHMO_*, LIUXXX_*) that no XML points at; they only get an XML.
//   node spike/blaze/tools/uniforms/make-coming-soon-sets.mjs [--library <FCS_Team_Library>] [--only SLOT,SLOT] [--no-install]
// Writes the bigfiles and <SLOT>_Pack0_MixAndMatch.XML into the RPCS3 DLC folders (a replaced file is backed up first under
// %LOCALAPPDATA%\ncaa-bridge\uniforms\backup, as the studio does) and the same files plus PNG previews into ./dist/coming-soon.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import zlib from 'node:zlib';
import { createRequire } from 'node:module'; import { createHash } from 'node:crypto';
import { parseDb } from '../../server/tdb-read.mjs';
const C = createRequire(import.meta.url)('./src/codec.cjs');

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const args = process.argv.slice(2); const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const library = arg('--library') || path.join(os.homedir(), 'OneDrive', 'Desktop', 'FCS_Team_Library');
const only = arg('--only') ? arg('--only').toUpperCase().split(',') : null; const install = !args.includes('--no-install');
const force = args.includes('--force'); // replace installed files even if they changed since this script wrote them
let rpcs3 = process.env.NCAA_RPCS3;
try { const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ncaa-bridge', 'config.json'), 'utf8')); rpcs3 ??= c.rpcs3Root ?? c.rpcs3; } catch {}
const DLC = rpcs3 ? path.join(rpcs3, 'dev_hdd0', 'game', 'BLUS31159', 'USRDIR', 'DLC') : null;
const BACKUP = path.join(process.env.LOCALAPPDATA || os.homedir(), 'ncaa-bridge', 'uniforms', 'backup');
const DIST = path.join(here, 'dist', 'coming-soon');
if (!DLC || !fs.existsSync(DLC)) throw new Error(`RPCS3 DLC folder not found (${DLC ?? 'no rpcs3Root in ~/.ncaa-bridge/config.json'}); the donor parts are read from it`);

// Teambuilder saves by school name (HED-DATA @0x20). The helmet gets the 128px logo unless `logo` says otherwise
// (Merrimack's 128 is a Nike swoosh; its 256 is the MC mark). Davidson and Drake are still encrypted in the 2022 library
// and St. Thomas and Stonehill are not in it: they take `colours` (primary/secondary, sampled from the logo) and an ESPN
// logo id. Robert Morris sits on NOTDAM, whose mod XML declares no parts at all; Stonehill on CLEMSO, whose archive XML
// still dresses it in Delaware's art (the team it replaced). `chest` is the word set below the collar on both jerseys.
const LOGOS = path.resolve(here, '..', '..', '..', '..', 'archive', 'logos', 'teams');
const SETS = [
  { slot: 'NOTDAM', team: 'Robert Morris', save: 'Robert Morris', folder: 'FCS_DLC_NEC', chest: 'COLONIALS' },
  { slot: 'WYOMIN', team: 'Davidson', colours: { P: 0xc8202a, S: 0x101010 }, espn: 2166, folder: 'FCS_DLC_PIONEER', chest: 'DAVIDSON' },
  { slot: 'BOISES', team: 'Drake', colours: { P: 0x005a9c, S: 0xffffff }, espn: 2181, folder: 'FCS_DLC_PIONEER', chest: 'DRAKE' },
  { slot: 'UNLVXX', team: 'St. Thomas', colours: { P: 0x582878, S: 0x97999b }, espn: 2900, folder: 'FCS_DLC_PIONEER', chest: 'TOMMIES' },
  { slot: 'CLEMSO', team: 'Stonehill', colours: { P: 0x372d7d, S: 0x231f20 }, espn: 284, folder: 'FCS_DLC_NEC', chest: 'STONEHILL' },
  { slot: 'NILLIN', team: 'Central Connecticut', save: 'CCSU', folder: 'FCS_DLC_NEC', chest: 'BLUE DEVILS' },
  { slot: 'BALLST', team: 'Duquesne', save: 'Duquesne', folder: 'FCS_DLC_NEC', chest: 'DUQUESNE' },
  { slot: 'EMICHI', team: 'Merrimack', save: 'Merrimack', folder: 'FCS_DLC_NEC', logo: 256, chest: 'MERRIMACK' },
  { slot: 'CMICHI', team: 'Sacred Heart', save: 'Sacred Heart', folder: 'FCS_DLC_NEC', chest: 'PIONEERS' },
  { slot: 'WMICHI', team: 'Saint Francis', save: 'Saint Francis', folder: 'FCS_DLC_NEC', chest: 'RED FLASH' },
  { slot: 'HAWAII', team: 'Presbyterian', save: 'Presbyterian', folder: 'FCS_DLC_PIONEER', chest: 'BLUE HOSE' },
];
// Extra helmets for teams that have their own art: the donor (archive or DLC) recoloured outside its logos and added to
// the team's XML (the archive one copied to the DLC folder if it has none) as a non-official option. Villanova's white
// helmet is DUKEXX_helmet_2013_Black1 (a navy V with a white then a thin navy outline on a flat 255 shell); its navy one
// takes the V's own navy, so the outer outline melts into the shell as on the real helmet. Outside the logos the shell is
// painted flat (the white one has faint seam dots that would show on navy); only the light silhouette (the area at the
// bottom middle every helmet texture has) keeps its edges, recoloured by projection.
const HELMET_OPTIONS = [
  { slot: 'DUKEXX', team: 'Villanova', folder: 'FCS_DLC_CAA', from: 'DUKEXX_HELMET_2013_BLACK1', to: 'DUKEXX_HELMET_2026_NAVYBL', name: 'Navy',
    shell: [255, 255, 255], colour: [0, 36, 99], silhouette: { rect: [680, 610, 1370, 1024], colour: [239, 235, 239] },
    logoAreas: [[330, 320, 690, 650], [1390, 315, 1730, 645]], keep: [[1426, 914, 2048, 1024]] },
];
// Slots whose own art is already in a DLC folder. LIUXXX_HELMET_2020_BLUEX is a jersey (a TENNES jersey scene with number
// and name decals) under a helmet name; it is copied as LIUXXX_JERSEY_2020_BLUEX. Jersey uvSet/decalUV are the values the
// mod uses most for the same scene template (MARSHA: Alabama State, Cornell; TENNES: Samford).
const EXISTING = [
  { slot: 'NMEXST', team: 'Richmond', folder: 'FCS_DLC_PATRIOT', uvSet: 1, decalUV: '-0.1470000595,0.2349994332,0.08399994671,0.03699989244', parts: [
    ['helmet', 'White', 'RICHMO_HELMET_2023_WHITE', ['Home', 'Away']],
    ['jersey', 'Blue', 'RICHMO_JERSEY_2023_BLUEX', ['Home'], 'dark'], ['jersey', 'White', 'RICHMO_JERSEY_2023_WHITE', ['Away'], 'light'],
    ['pants', 'White', 'RICHMO_PANTSX_2023_WHITE', ['Home', 'Away']], ['pants', 'Blue', 'RICHMO_PANTSX_2023_BLUEX', []]] },
  { slot: 'TOLEDO', team: 'Long Island', folder: 'FCS_DLC_NEC', uvSet: 1, decalUV: '-0.1400000006,0.25,0.07999999821,0.03999999911',
    copy: [['LIUXXX_HELMET_2020_BLUEX', 'LIUXXX_JERSEY_2020_BLUEX']], parts: [
    ['helmet', 'Gold', 'LIUXXX_HELMET_2020_YELLO', ['Home', 'Away']],
    ['jersey', 'Blue', 'LIUXXX_JERSEY_2020_BLUEX', ['Home'], 'dark'], ['jersey', 'White', 'LIUXXX_JERSEY_2020_WHITE', ['Away'], 'light'],
    ['pants', 'Gold', 'LIUXXX_PANTSX_2020_YELLO', ['Home', 'Away']], ['pants', 'Blue', 'LIUXXX_PANTSX_2020_BLUEX', []]] },
];
// Donor parts (FCS_DLC_CAA) and where their placeholder marks sit in the top mip.
const DONOR = { helmet: 'FCSXXX_HELMET_2042_BLUEX', jersey: 'FCSXXX_JERSEY_2042_TEA', pants: 'FCSXXX_PANTSX_2042_GREEN' };
const JERSEY_PARAMS = { uvSet: 1, decalUV: '-0.1470000595,0.2349994332,0.08399994671,0.03699989244' }; // FCSXXX's own XML
const HELMET_LOGO_AREAS = [[270, 260, 670, 650], [1405, 260, 1810, 655]]; // x0,y0,x1,y1: the two side logos
const HELMET_KEEP = [[1430, 916, 2048, 1024]]; // hardware strip (Riddell tag, screws): never recoloured
const JERSEY_ERASE = [[380, 1534, 440, 1590], [388, 1586, 630, 1624]]; // FCS chest badge, COMING SOON
const CHEST = { cx: 511, cy: 1603, height: 22, maxWidth: 230 }; // where COMING SOON sat: front, below the collar
const PANTS_LOGO_AREA = [1240, 70, 1470, 290]; // FCS hip logo (its exact box is found in here)

// ---------- Teambuilder save ----------
function readBits(buf, bitOffset, bits) { let v = 0, p = bitOffset, left = bits; while (left > 0) { const byte = buf[p >>> 3], ib = p & 7, take = Math.min(8 - ib, left); v = v * (1 << take) + ((byte >>> (8 - ib - take)) & ((1 << take) - 1)); p += take; left -= take; } return v; }
function rowsOf(t) {
  const out = [];
  for (let r = 0; r < t.header.currentRecords; r++) {
    const base = r * t.header.lengthBytes * 8, o = {};
    for (const f of t.fields) {
      if (f.type === 0) { o[f.name] = t.data.subarray((base + f.bitOffset) >> 3, (base + f.bitOffset + f.bits) >> 3).toString('latin1').replace(/\0.*$/s, ''); continue; }
      if (f.type !== 1) o[f.name] = readBits(t.data, base + f.bitOffset, f.bits);
    }
    out.push(o);
  }
  return out;
}
// USR-DATA = DXT3 logos as DDS files back to back, then an EA DB (TEAM, TUNI, COCH, ..., PLAY, DCHT).
function readTeamSave(dir) {
  const b = fs.readFileSync(path.join(dir, 'USR-DATA'));
  if (b.toString('latin1', 0, 4) !== 'DDS ') throw new Error(`${dir}: USR-DATA is still encrypted (decrypt it with pfdtool first)`);
  const logos = []; let p = 0;
  while (b.toString('latin1', p, p + 4) === 'DDS ') {
    const h = b.readUInt32LE(p + 12), w = b.readUInt32LE(p + 16);
    logos.push({ width: w, height: h, rgba: C.decodeDXT(new Uint8Array(b.buffer, b.byteOffset + p + 128, w * h), w, h, 'DXT3') }); p += 128 + w * h;
  }
  const db = parseDb(b.subarray(p));
  return { logos, team: rowsOf(db.tables.get('TEAM'))[0], tuni: rowsOf(db.tables.get('TUNI')) };
}
function findSave(name) {
  for (const conf of fs.readdirSync(library)) {
    const sd = path.join(library, conf, 'PS3', 'SAVEDATA'); if (!fs.existsSync(sd)) continue;
    for (const d of fs.readdirSync(sd)) {
      const hed = path.join(sd, d, 'HED-DATA'); if (!/TEAM-\d+$/.test(d) || !fs.existsSync(hed)) continue;
      if (fs.readFileSync(hed).toString('latin1', 0x20, 0x37).replace(/\0.*$/s, '') === name) return path.join(sd, d);
    }
  }
  throw new Error(`no Teambuilder save named ${JSON.stringify(name)} under ${library}`);
}

// ---------- colours ----------
// TUNI colour fields are (palette tag << 24) | 0xRRGGBB, tag 1 = team primary, 2 = secondary, 0 = custom; 0 is "not used".
// Read off the library's saves: CJOB/CJTB home/away jersey body, JOFP/JOFT home number fill/trim, JONG home name,
// JT* the same for away, CHOF helmet shell, CPAC/CPAB pants.
const rgbOf = (v) => [(v >> 16) & 255, (v >> 8) & 255, v & 255];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const WHITE = [240, 240, 240];
const apart = (base, cands) => cands.find((c) => c && dist(c, base) > 60) || cands[cands.length - 1];
function colours(team, tuni) {
  const u = tuni.find((r) => r.TUCO === 1) || tuni[0];
  const set = (k) => u[k] !== undefined && u[k] !== 0;
  const pick = (keys, fallback) => { for (const k of keys) if (set(k)) return rgbOf(u[k]); return fallback; };
  const P = [team.TBCR, team.TBCG, team.TBCB], S = [team.TB2R, team.TB2G, team.TB2B];
  const home = pick(['CJOB'], P), away = pick(['CJTB'], WHITE);
  const homeNum = pick(['JOFP'], WHITE), awayNum = pick(['JTFP'], P);
  const pants = pick(['CPAC', 'CPAB'], WHITE), altPants = dist(pants, WHITE) < 40 ? P : WHITE;
  return {
    P, S, helmet: pick(['CHOF'], P),
    dark: { base: home, num: homeNum, trim: pick(['JOFT'], S), name: pick(['JONG'], homeNum), accent: apart(home, [pick(['JOFT'], null), homeNum, S, WHITE]) },
    light: { base: away, num: awayNum, trim: pick(['JTFT'], S), name: pick(['JTNG'], awayNum), accent: apart(away, [awayNum, pick(['JTFT'], null), P]) },
    pants: [{ base: pants, stripe: apart(pants, [P, S, WHITE, [20, 20, 20]]) }, { base: altPants, stripe: apart(altPants, [P, S, WHITE]) }],
  };
}
// The same shape from two school colours: primary helmet and home jersey, white numbers at home and primary away.
function schoolColours({ P: p, S: s }) {
  const P = rgbOf(p), S = rgbOf(s);
  return {
    P, S, helmet: P,
    dark: { base: P, num: WHITE, trim: apart(WHITE, [S, P]), name: WHITE, accent: apart(P, [WHITE, S]) },
    light: { base: WHITE, num: P, trim: apart(P, [S, WHITE]), name: P, accent: P },
    pants: [{ base: WHITE, stripe: P }, { base: P, stripe: apart(P, [S, WHITE]) }],
  };
}
// Colour tokens for the part names (5 letters for helmet/pants, 3 for jerseys, as the donor names have).
function colourName(c) {
  const [r, g, b] = c.map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0; if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60;
  if (s < 0.15 || l < 0.06) return l > 0.85 ? ['WHITE', 'WHI'] : l > 0.6 ? ['SILVR', 'SIL'] : l > 0.2 ? ['GREYX', 'GRY'] : ['BLACK', 'BLK'];
  if (h < 15 || h >= 330) return l < 0.3 ? ['MAROO', 'MAR'] : ['REDXX', 'RED'];
  if (h < 40) return l < 0.3 ? ['BROWN', 'BRN'] : ['ORANG', 'ORA'];
  if (h < 65) return l > 0.55 && s > 0.8 ? ['YELLO', 'YLO'] : ['GOLDX', 'GLD'];
  if (h < 160) return ['GREEN', 'GRN'];
  if (h < 195) return ['TEALX', 'TEA'];
  if (h < 245) return l < 0.22 ? ['NAVYX', 'NAV'] : ['BLUEX', 'BLU']; // Stonehill's indigo purple is 247

  return ['PURPL', 'PUR'];
}
const title = (c) => ({ WHITE: 'White', SILVR: 'Silver', GREYX: 'Grey', BLACK: 'Black', MAROO: 'Maroon', REDXX: 'Red', BROWN: 'Brown', ORANG: 'Orange', YELLO: 'Yellow', GOLDX: 'Gold', GREEN: 'Green', TEALX: 'Teal', NAVYX: 'Navy', BLUEX: 'Blue', PURPL: 'Purple' })[colourName(c)[0]];

// ---------- pixels ----------
// Mean of the opaque pixels near a seed colour: the donor's exact key colour.
function keyColour(rgba, seed, radius = 24) {
  const acc = [0, 0, 0]; let n = 0;
  for (let o = 0; o < rgba.length; o += 4) { if (rgba[o + 3] < 250) continue; const c = [rgba[o], rgba[o + 1], rgba[o + 2]]; if (dist(c, seed) > radius) continue; acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; n++; }
  return n ? acc.map((v) => v / n) : seed;
}
const inRects = (x, y, rects) => rects.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1);
// Palette remap that keeps shading and anti-aliasing: each pixel is projected onto the segment between its two nearest
// donor key colours, takes the same blend of their targets, and keeps its residual (seams, folds). dst null = keep.
function recolour(img, palette, keep = [], skip = null) {
  const { rgba, width } = img; const pal = palette.map((p) => ({ src: p.src, dst: p.dst || p.src }));
  for (let i = 0, o = 0; o < rgba.length; i++, o += 4) {
    if ((skip && skip[i]) || (keep.length && inRects(i % width, (i / width) | 0, keep))) continue;
    const c = [rgba[o], rgba[o + 1], rgba[o + 2]];
    let a = 0, b = -1, da = Infinity, db = Infinity;
    pal.forEach((p, k) => { const d = dist(c, p.src); if (d < da) { db = da; b = a; da = d; a = k; } else if (d < db) { db = d; b = k; } });
    let t = 0, base = pal[a].src, tgt = pal[a].dst;
    if (b >= 0) {
      const s0 = pal[a].src, s1 = pal[b].src, v = [s1[0] - s0[0], s1[1] - s0[1], s1[2] - s0[2]], vv = v[0] ** 2 + v[1] ** 2 + v[2] ** 2;
      t = vv ? Math.max(0, Math.min(1, ((c[0] - s0[0]) * v[0] + (c[1] - s0[1]) * v[1] + (c[2] - s0[2]) * v[2]) / vv)) : 0;
      base = s0.map((x, j) => x + t * v[j]); tgt = pal[a].dst.map((x, j) => x + t * (pal[b].dst[j] - x));
    }
    for (let j = 0; j < 3; j++) rgba[o + j] = tgt[j] + (c[j] - base[j]);
  }
}
function fill(img, rects, colour) {
  const { rgba, width, height } = img;
  for (const [x0, y0, x1, y1] of rects) for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
    const o = (y * width + x) * 4; if (rgba[o + 3] === 0) continue; rgba[o] = colour[0]; rgba[o + 1] = colour[1]; rgba[o + 2] = colour[2];
  }
}
// Bounding box of the pixels in an area that are not the shell colour (the donor's side logo).
function markBox(img, [x0, y0, x1, y1], shell) {
  let bx0 = x1, by0 = y1, bx1 = x0, by1 = y0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * img.width + x) * 4; if (dist([img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]], shell) > 40) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x + 1); by1 = Math.max(by1, y + 1); } }
  return bx1 > bx0 ? [bx0, by0, bx1, by1] : [x0, y0, x1, y1];
}
// Composite a logo (its opaque bounding box, premultiplied colour) centred in a box at 92% of its size: bilinear when
// enlarging (the 128px Teambuilder logos), a box average when shrinking (ESPN logos are 500 to 4096px).
function stamp(img, logo, [x0, y0, x1, y1]) {
  let lx0 = logo.width, ly0 = logo.height, lx1 = 0, ly1 = 0;
  for (let y = 0; y < logo.height; y++) for (let x = 0; x < logo.width; x++) if (logo.rgba[(y * logo.width + x) * 4 + 3] > 8) { lx0 = Math.min(lx0, x); ly0 = Math.min(ly0, y); lx1 = Math.max(lx1, x + 1); ly1 = Math.max(ly1, y + 1); }
  const lw = lx1 - lx0, lh = ly1 - ly0, s = 0.92 * Math.min((x1 - x0) / lw, (y1 - y0) / lh), w = Math.round(lw * s), h = Math.round(lh * s);
  const ox = Math.round((x0 + x1 - w) / 2), oy = Math.round((y0 + y1 - h) / 2);
  const at = (x, y) => { x = Math.max(0, Math.min(logo.width - 1, x)); y = Math.max(0, Math.min(logo.height - 1, y)); const o = (y * logo.width + x) * 4, a = logo.rgba[o + 3] / 255; return [logo.rgba[o] * a, logo.rgba[o + 1] * a, logo.rgba[o + 2] * a, a]; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = [0, 0, 0, 0];
    if (s < 1) {
      const sx0 = Math.floor(lx0 + x / s), sx1 = Math.max(sx0 + 1, Math.floor(lx0 + (x + 1) / s)), sy0 = Math.floor(ly0 + y / s), sy1 = Math.max(sy0 + 1, Math.floor(ly0 + (y + 1) / s));
      for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) { const v = at(xx, yy); for (let j = 0; j < 4; j++) p[j] += v[j]; }
      const n = (sx1 - sx0) * (sy1 - sy0); for (let j = 0; j < 4; j++) p[j] /= n;
    } else {
      const sx = lx0 + (x + 0.5) / s - 0.5, sy = ly0 + (y + 0.5) / s - 0.5, fx = Math.floor(sx), fy = Math.floor(sy), tx = sx - fx, ty = sy - fy;
      const q = [at(fx, fy), at(fx + 1, fy), at(fx, fy + 1), at(fx + 1, fy + 1)], wts = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
      q.forEach((v, k) => { for (let j = 0; j < 4; j++) p[j] += v[j] * wts[k]; });
    }
    const o = ((oy + y) * img.width + ox + x) * 4; for (let j = 0; j < 3; j++) img.rgba[o + j] = p[j] + img.rgba[o + j] * (1 - p[3]);
  }
}

// ---------- bigfiles ----------
const fileIndex = new Map();
for (const f of fs.readdirSync(DLC)) { const d = path.join(DLC, f); if (!fs.statSync(d).isDirectory()) continue; for (const x of fs.readdirSync(d)) fileIndex.set(x.toLowerCase(), path.join(d, x)); }
function bigPath(scene) { const p = fileIndex.get(`${scene}_big.ast`.toLowerCase()); if (!p) throw new Error(`${scene}_big.ast is not in any DLC folder`); return p; }
const loadBig = (scene) => C.parseBigfile(new Uint8Array(fs.readFileSync(bigPath(scene))), scene);
const entry = (big, suffix) => big.entries.find((e) => e.name.toUpperCase().endsWith(suffix));
async function texture(big, suffix) { const e = entry(big, suffix); const t = C.parseTexture(await C.loadEntry(e), e.name); return { e, t, img: C.decodeMip(t, 0) }; }
function put(e, t, img) { const enc = C.encodeTexture(t, img.rgba); e.data = enc.bytes; e.dirty = true; return enc; }
// A renamed copy of a donor (full-name map: entry names, hashes and scene paths), as the studio's New set does.
async function cloneAs(donor, name) { const big = loadBig(donor); await C.renameBigfile(big, [{ from: donor, to: name }]); return big; }
// qkl_fe2ig.ast entries by name (FNV-1a 64 of the upper-cased name), for donors and XMLs that only live in the archive.
const ARCHIVE = path.join(rpcs3, 'dev_hdd0', 'disc', 'BLUS31159-[NCAA Football 14]', 'PS3_GAME', 'USRDIR', 'qkl_fe2ig.ast');
let arc = null;
async function archiveEntry(name) {
  if (!arc) {
    const fd = fs.openSync(ARCHIVE, 'r'), head = Buffer.alloc(64); fs.readSync(fd, head, 0, 64, 0);
    const toc = Buffer.alloc(head.readUInt32LE(16) + head.readUInt32LE(24)); fs.readSync(fd, toc, 0, toc.length, 0);
    arc = { fd, map: new Map(C.parseBigfile(new Uint8Array(toc.buffer, toc.byteOffset, toc.length), 'archive').entries.map((e) => [C.hex64(e.hash), e])) };
  }
  const e = arc.map.get(C.hex64(C.fnv1a64(name.toUpperCase()))); if (!e) throw new Error(`${name} is not in qkl_fe2ig.ast`);
  const buf = Buffer.alloc(e.csize); fs.readSync(arc.fd, buf, 0, e.csize, e.off); const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  return C.isZlib(u8) ? C.zlibInflate(u8) : u8;
}
async function donorBig(name) { return fileIndex.has(`${name}_big.ast`.toLowerCase()) ? loadBig(name) : C.parseBigfile(await archiveEntry(`${name}_big`), name); }

// ESPN logos carry ® / ™ specks off to one side: clear opaque islands under 2% of the largest so they do not shift the fit.
function cleanLogo(logo) {
  const { width: w, height: h, rgba } = logo, label = new Int32Array(w * h).fill(-1), sizes = [];
  for (let i = 0; i < w * h; i++) {
    if (label[i] >= 0 || rgba[i * 4 + 3] <= 8) continue;
    const id = sizes.length, stack = [i]; label[i] = id; let n = 0;
    while (stack.length) {
      const p = stack.pop(); n++; const x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy, q = ny * w + nx; if (nx >= 0 && ny >= 0 && nx < w && ny < h && label[q] < 0 && rgba[q * 4 + 3] > 8) { label[q] = id; stack.push(q); } }
    }
    sizes.push(n);
  }
  const big = Math.max(...sizes);
  for (let i = 0; i < w * h; i++) if (label[i] >= 0 && sizes[label[i]] < 0.02 * big) rgba[i * 4 + 3] = 0;
  return logo;
}

// The jersey's own name font (NAME_DECAL: 64x128 cells, two per row, in the kerning table's character order) set as a
// small word at CHEST, in the number colour. Glyph widths come from their alpha; letters sit on rows 14..107 of a cell.
function chestText(img, font, text, colour) {
  const order = new TextDecoder().decode(font.kerning).split(/\r?\n/)[2], top = 14, bottom = 107;
  const glyphs = [...text.toUpperCase()].map((ch) => {
    const i = order.indexOf(ch); if (ch === ' ' || i < 0) return null;
    const cx = (i % 2) * 64, cy = ((i / 2) | 0) * 128; let l = 64, r = 0;
    for (let y = cy + top; y < cy + bottom; y++) for (let x = cx; x < cx + 64; x++) if (font.img.rgba[(y * font.img.width + x) * 4 + 3] > 64) { l = Math.min(l, x - cx); r = Math.max(r, x - cx + 1); }
    return { x: cx + l, y: cy + top, w: Math.max(1, r - l) };
  });
  let s = CHEST.height / (bottom - top); const gap = 0.16 * CHEST.height, space = 0.45 * CHEST.height;
  const width = (k) => glyphs.reduce((a, g) => a + (g ? g.w * k : space) + gap, -gap);
  if (width(s) > CHEST.maxWidth) s *= CHEST.maxWidth / width(s);
  const h = Math.round((bottom - top) * s), oy = Math.round(CHEST.cy - h / 2); let ox = CHEST.cx - width(s) / 2;
  for (const g of glyphs) {
    if (!g) { ox += space + gap; continue; }
    const w = Math.round(g.w * s), x0 = Math.round(ox);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx0 = g.x + Math.floor(x / s), sx1 = Math.max(sx0 + 1, g.x + Math.floor((x + 1) / s)), sy0 = g.y + Math.floor(y / s), sy1 = Math.max(sy0 + 1, g.y + Math.floor((y + 1) / s));
      let a = 0; for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) a += font.img.rgba[(yy * font.img.width + xx) * 4 + 3];
      a /= 255 * (sx1 - sx0) * (sy1 - sy0); const o = ((oy + y) * img.width + x0 + x) * 4;
      for (let j = 0; j < 3; j++) img.rgba[o + j] = colour[j] * a + img.rgba[o + j] * (1 - a);
    }
    ox += g.w * s + gap;
  }
}

function png(rgba, w, h) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// 8-bit RGB/RGBA, non-interlaced (the ESPN logos)
function readPng(buf) {
  let p = 8, w, h, ct; const idat = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p), t = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len); if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; if (d[8] !== 8 || d[12] || (ct !== 2 && ct !== 6)) throw new Error('PNG must be 8-bit RGB/RGBA, non-interlaced'); } else if (t === 'IDAT') idat.push(d); p += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat)), bpp = ct === 6 ? 4 : 3, stride = w * bpp, out = new Uint8ClampedArray(w * h * 4); let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0, pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      line[x] = (line[x] + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0)) & 255;
    }
    for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; out[o] = line[x * bpp]; out[o + 1] = line[x * bpp + 1]; out[o + 2] = line[x * bpp + 2]; out[o + 3] = bpp === 4 ? line[x * bpp + 3] : 255; }
    prev = line;
  }
  return { rgba: out, width: w, height: h };
}
const preview = (img, file) => { const h = C.downsample(img.rgba, img.width, img.height); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, png(h.rgba, h.width, h.height)); };

// installed.json (in dist) holds the SHA-1 of every file this script installed. An installed file whose hash no longer
// matches was edited since (studio) and is kept unless --force, or unless the new bytes were built from the installed file
// itself (`merged`: an XML with a part added). Files the script never wrote are replaced after a backup, as the studio does.
const MANIFEST = path.join(DIST, 'installed.json');
const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
const sha1 = (b) => createHash('sha1').update(b).digest('hex');
function write(folder, name, bytes, merged = false) {
  const dist = path.join(DIST, folder, name), file = path.join(DLC, folder, name), key = `${folder}/${name}`;
  if (install && !force && !merged && fs.existsSync(file) && manifest[key] && sha1(fs.readFileSync(file)) !== manifest[key]) { console.log(`  KEPT ${path.relative(DLC, file)}: changed since this script installed it (--force replaces it)`); return; }
  fs.mkdirSync(path.dirname(dist), { recursive: true }); fs.writeFileSync(dist, bytes);
  if (!install) return;
  if (fs.existsSync(file)) { fs.mkdirSync(BACKUP, { recursive: true }); fs.copyFileSync(file, path.join(BACKUP, `${folder}__${name}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`)); }
  fs.writeFileSync(file, bytes); manifest[key] = sha1(bytes); fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  console.log(`  wrote ${path.relative(DLC, file)}`);
}

// ---------- XML ----------
function xml(parts, jersey) {
  const L = ['<?xml version="1.0" ?><root>', ...['jersey', 'helmet', 'pants', 'socks', 'shoes', 'gloves'].map((t) => `  <partType name="${t}"/>`), '', '  <officialType name="Home"/>', '  <officialType name="Away"/>', ''];
  const offs = (o) => o.map((n) => `    <official name="${n}"/>`);
  for (const [type, name, scene, o, shade] of parts) {
    if (type === 'jersey') L.push(`  <part name="${name}" shade="${shade}" type="jersey">`, `    <bigfile name="${scene}_big"/>`, `    <scene name="${scene}"/>`, `    <kerningTable name="${scene}_NAME"/>`,
      `    <fontColorTexture name="${scene}_NAME_DECAL"/>`, `    <numberColorTexture name="${scene}_NUMS_DECAL"/>`, '    <nameScaleAtMin value="1.0"/>', '    <nameMinWidth value="0.6"/>', '    <nameMaxWidth value="0.6"/>',
      `    <uvSet value="${jersey.uvSet}"/>`, ...offs(o), `  <decalUV value="${jersey.decalUV}"/></part>`);
    else L.push(`  <part name="${name}" type="${type}">`, `    <bigfile name="${/^generic_/i.test(scene) ? scene.toLowerCase() : scene}_big"/>`, `    <scene name="${scene}"/>`, ...offs(o), '  </part>');
  }
  L.push('</root>', '');
  return L.join('\n');
}
const ACCESSORIES = [['socks', 'White', 'GENERIC_SOCKSX_WHITE', ['Home', 'Away']], ['socks', 'Black', 'GENERIC_SOCKSX_BLACK', []],
  ['shoes', 'White', 'generic_shoesx_whiwhi', ['Home', 'Away']], ['shoes', 'Black', 'generic_shoesx_blabla', []]];

// ---------- build ----------
async function buildSet(s) {
  let k, logo;
  if (s.save) {
    const dir = findSave(s.save); const { logos, team, tuni } = readTeamSave(dir); k = colours(team, tuni);
    logo = logos.find((l) => l.width === (s.logo || 128)) || logos[logos.length - 1];
    console.log(`${s.team} (${s.slot}) from ${path.relative(library, dir)}: ${team.TDNA} ${team.TMNA}`);
  } else {
    k = schoolColours(s.colours); logo = cleanLogo(readPng(fs.readFileSync(path.join(LOGOS, `${s.espn}.png`))));
    console.log(`${s.team} (${s.slot}) from school colours and ESPN logo ${s.espn}`);
  }
  const year = '2026', parts = [], pv = (n) => path.join(DIST, 'previews', s.slot, `${n}.png`);

  // helmet: shell recoloured, the two FCS logos replaced by the 128px Teambuilder logo
  const [h5] = colourName(k.helmet); const hName = `${s.slot}_HELMET_${year}_${h5}`; const hb = await cloneAs(DONOR.helmet, hName);
  const col = await texture(hb, '_HELMETBAKED_COL'); const shell = keyColour(col.img.rgba, [4, 44, 52]);
  const boxes = HELMET_LOGO_AREAS.map((a) => markBox(col.img, a, shell));
  fill(col.img, boxes.map(([x0, y0, x1, y1]) => [x0 - 4, y0 - 4, x1 + 4, y1 + 4]), shell);
  recolour(col.img, [{ src: shell, dst: k.helmet }, { src: keyColour(col.img.rgba, [236, 236, 236]), dst: null }, { src: keyColour(col.img.rgba, [196, 196, 196]), dst: null }], HELMET_KEEP);
  for (const b of boxes) stamp(col.img, logo, b);
  const enc = put(col.e, col.t, col.img); const pride = entry(hb, '_PRIDE'); pride.data = enc.bytes; pride.dirty = true; // the mod's PRIDE layout is a copy of COL
  write(s.folder, `${hName}_big.ast`, await C.buildBigfile(hb)); preview(col.img, pv('helmet'));
  parts.push(['helmet', title(k.helmet), hName, ['Home', 'Away']]);

  // jerseys: dark (home) and light (away) from the one placeholder jersey
  for (const shade of ['dark', 'light']) {
    const j = k[shade], [, j3] = colourName(j.base); const name = `${s.slot}_JERSEY_${year}_${j3}`; const jb = await cloneAs(DONOR.jersey, name);
    const body = await texture(jb, '_JERSEYBAKED_COL'); const base = keyColour(body.img.rgba, [44, 68, 76]);
    const names = await texture(jb, '_NAME_DECAL'), kerning = await C.loadEntry(entry(jb, '_NAME'));
    fill(body.img, JERSEY_ERASE, base);
    recolour(body.img, [{ src: base, dst: j.base }, { src: keyColour(body.img.rgba, [236, 244, 236]), dst: j.accent }]);
    if (s.chest) chestText(body.img, { img: names.img, kerning }, s.chest, j.num);
    put(body.e, body.t, body.img); preview(body.img, pv(`jersey-${shade}`));
    const nums = await texture(jb, '_NUMS_DECAL');
    recolour(nums.img, [{ src: keyColour(nums.img.rgba, [164, 156, 132]), dst: j.num }, { src: keyColour(nums.img.rgba, [4, 44, 52]), dst: j.trim }]);
    put(nums.e, nums.t, nums.img); preview(nums.img, pv(`numbers-${shade}`));
    for (let o = 0; o < names.img.rgba.length; o += 4) { names.img.rgba[o] = j.name[0]; names.img.rgba[o + 1] = j.name[1]; names.img.rgba[o + 2] = j.name[2]; }
    put(names.e, names.t, names.img);
    write(s.folder, `${name}_big.ast`, await C.buildBigfile(jb));
    parts.push(['jersey', title(j.base), name, [shade === 'dark' ? 'Home' : 'Away'], shade]);
  }

  // pants: the Teambuilder pants colour (Home and Away) and a second one (white, or the primary if those are white)
  for (const [i, p] of k.pants.entries()) {
    const [p5] = colourName(p.base); const name = `${s.slot}_PANTSX_${year}_${p5}`; const pb = await cloneAs(DONOR.pants, name);
    const body = await texture(pb, '_PANTSBAKED_COL'); const base = keyColour(body.img.rgba, [44, 68, 76]);
    const [x0, y0, x1, y1] = markBox(body.img, PANTS_LOGO_AREA, base); fill(body.img, [[x0 - 4, y0 - 4, x1 + 4, y1 + 4]], base);
    recolour(body.img, [{ src: base, dst: p.base }, { src: keyColour(body.img.rgba, [236, 236, 236]), dst: p.stripe }]);
    put(body.e, body.t, body.img); preview(body.img, pv(`pants-${i}`));
    write(s.folder, `${name}_big.ast`, await C.buildBigfile(pb));
    parts.push(['pants', title(p.base), name, i === 0 ? ['Home', 'Away'] : []]);
  }
  fs.mkdirSync(path.join(DIST, 'previews', s.slot), { recursive: true });
  fs.writeFileSync(path.join(DIST, 'previews', s.slot, 'logo.png'), png(logo.rgba, logo.width, logo.height));
  write(s.folder, `${s.slot}_Pack0_MixAndMatch.XML`, xml([...parts, ...ACCESSORIES], JERSEY_PARAMS));
}
async function buildExisting(s) {
  console.log(`${s.team} (${s.slot}): XML for its own art`);
  for (const [from, to] of s.copy || []) { const big = await cloneAs(from, to); write(path.basename(path.dirname(bigPath(from))), `${to}_big.AST`, await C.buildBigfile(big)); }
  if (install) for (const [, , scene] of s.parts) if (!(s.copy || []).some(([, to]) => to === scene)) bigPath(scene);
  write(s.folder, `${s.slot}_Pack0_MixAndMatch.XML`, xml([...s.parts, ...ACCESSORIES], s));
}

async function buildHelmetOption(o) {
  console.log(`${o.team} (${o.slot}): ${o.name} helmet option from ${o.from}`);
  const big = await donorBig(o.from); await C.renameBigfile(big, [{ from: o.from, to: o.to }]);
  const col = await texture(big, '_HELMETBAKED_COL'), img = col.img, logo = new Uint8Array(img.width * img.height);
  // each logo = the pixels away from the shell colour plus whatever they enclose (a flood of the shell from the area's edge)
  for (const [x0, y0, x1, y1] of o.logoAreas) {
    const w = x1 - x0, h = y1 - y0, seen = new Uint8Array(w * h), stack = [];
    const ink = (x, y) => { const p = ((y0 + y) * img.width + x0 + x) * 4; return dist([img.rgba[p], img.rgba[p + 1], img.rgba[p + 2]], o.shell) > 60; };
    for (let x = 0; x < w; x++) stack.push(x, 0, x, h - 1); for (let y = 0; y < h; y++) stack.push(0, y, w - 1, y);
    while (stack.length) { const y = stack.pop(), x = stack.pop(); if (x < 0 || y < 0 || x >= w || y >= h || seen[y * w + x] || ink(x, y)) continue; seen[y * w + x] = 1; stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1); }
    // only the largest piece is the logo; seam dots near it are ink too
    const part = new Int32Array(w * h).fill(-1), sizes = [];
    for (let i = 0; i < w * h; i++) {
      if (seen[i] || part[i] >= 0) continue; const id = sizes.length, st = [i]; part[i] = id; let n = 0;
      while (st.length) { const p = st.pop(); n++; const x = p % w, y = (p / w) | 0; for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) { const q = ny * w + nx; if (nx >= 0 && ny >= 0 && nx < w && ny < h && !seen[q] && part[q] < 0) { part[q] = id; st.push(q); } } }
      sizes.push(n);
    }
    const keepId = sizes.indexOf(Math.max(...sizes));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (part[y * w + x] === keepId) logo[(y0 + y) * img.width + x0 + x] = 1;
  }
  const outside = new Uint8Array(logo.length);
  for (let i = 0; i < logo.length; i++) {
    const x = i % img.width, y = (i / img.width) | 0; if (logo[i] || inRects(x, y, o.keep)) continue;
    if (inRects(x, y, [o.silhouette.rect])) continue;
    outside[i] = 1; img.rgba[i * 4] = o.colour[0]; img.rgba[i * 4 + 1] = o.colour[1]; img.rgba[i * 4 + 2] = o.colour[2];
  }
  recolour(img, [{ src: o.shell, dst: o.colour }, { src: o.silhouette.colour, dst: null }], o.keep, logo.map((v, i) => v | outside[i]));
  const enc = put(col.e, col.t, img); const pride = entry(big, '_PRIDE'); if (pride) { pride.data = enc.bytes; pride.dirty = true; }
  write(o.folder, `${o.to}_big.ast`, await C.buildBigfile(big)); preview(img, path.join(DIST, 'previews', o.slot, `helmet-${o.name.toLowerCase()}.png`));
  // the team's XML (installed one, else the archive's) with the helmet added after its last helmet part, no official rows
  const xmlName = `${o.slot}_Pack0_MixAndMatch.XML`, installed = fileIndex.get(xmlName.toLowerCase());
  let x = installed ? fs.readFileSync(installed, 'latin1') : Buffer.from(await archiveEntry(`${o.slot}_MIXANDMATCH`)).toString('latin1');
  if (!x.includes(`"${o.to}_big"`)) {
    const nl = x.includes('\r\n') ? '\r\n' : '\n', helmets = [...x.matchAll(/<part[^>]*type="helmet"[^>]*>[\s\S]*?<\/part>/g)], at = helmets.length ? helmets.at(-1).index + helmets.at(-1)[0].length : x.indexOf('</root>');
    x = x.slice(0, at) + [ '', `  <part name="${o.name}" type="helmet">`, `    <bigfile name="${o.to}_big"/>`, `    <scene name="${o.to}"/>`, '  </part>'].join(nl) + x.slice(at);
  }
  write(installed ? path.basename(path.dirname(installed)) : o.folder, xmlName, Buffer.from(x, 'latin1'), true);
}

for (const s of SETS) if (!only || only.includes(s.slot)) await buildSet(s);
for (const s of EXISTING) if (!only || only.includes(s.slot)) await buildExisting(s);
for (const o of HELMET_OPTIONS) if (!only || only.includes(o.slot)) await buildHelmetOption(o);
console.log(`done; copies and previews in ${DIST}${install ? '' : ' (--no-install: DLC folders untouched)'}`);
