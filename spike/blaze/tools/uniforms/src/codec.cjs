// codec.js — NCAA 14 (PS3) uniform asset codec: BGFA 1.05 bigfiles, "p3R" DXT textures, DDS, scene renaming.
// Pure functions over Uint8Array; no DOM. Shared by the Uniform Studio page and the Node test harness.
'use strict';

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

function fnv1a64(str) {
  let h = FNV_OFFSET;
  for (const c of new TextEncoder().encode(str)) { h ^= BigInt(c); h = (h * FNV_PRIME) & MASK64; }
  return h;
}
const hex64 = (h) => h.toString(16).padStart(16, '0');

function ascii(u8, a, b) { let s = ''; for (let i = a; i < b; i++) s += String.fromCharCode(u8[i]); return s; }
function isZlib(u8) { return u8.length > 2 && u8[0] === 0x78 && (u8[1] === 0xda || u8[1] === 0x9c || u8[1] === 0x01 || u8[1] === 0x5e); }

async function streamBytes(u8, stream) {
  const w = stream.writable.getWriter();
  w.write(u8); w.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}
const zlibInflate = (u8) => streamBytes(u8, new DecompressionStream('deflate'));
const zlibDeflate = (u8) => streamBytes(u8, new CompressionStream('deflate'));

// ---------- BGFA 1.05 container (bigfiles and the qkl_*.ast archives share the layout) ----------
// header (64 B): 'BGFA1.05', u32 n+1, u32 n, u32 tocOff(64), u32 0, u32 tocSize, u32 0, u32 widths(0x04080100), u32 widths2(0x404),
// u32 prefixWords, u32 nameWidth(64), 4 x u32 0. TOC: prefixWords x u32, then records
// {u16 flags, u64 fnv1a64(name), u32 off, u32 csize, u32 usize-csize, char name[nameWidth]}. Entry bytes are zlib streams.
function parseBigfile(u8, label = '') {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (ascii(u8, 0, 8) !== 'BGFA1.05') throw new Error(`${label || 'file'}: not a BGFA 1.05 container`);
  const tocOff = dv.getUint32(16, true), tocSize = dv.getUint32(24, true);
  const w8 = dv.getUint32(32, true), w9 = dv.getUint32(36, true), pw = dv.getUint32(40, true), nw = dv.getUint32(44, true);
  const widths = { offW: (w8 >>> 24) & 255, hashW: (w8 >>> 16) & 255, csW: (w9 >>> 8) & 255, usW: w9 & 255, nw };
  const rec = 2 + widths.hashW + widths.offW + widths.csW + widths.usW + nw;
  const prefix = [];
  for (let i = 0; i < pw; i++) prefix.push(dv.getUint32(tocOff + i * 4, true));
  const entries = [];
  const readN = (p, n) => { let v = 0n; for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(u8[p + i]); return v; };
  for (let p = tocOff + pw * 4; p + rec <= tocOff + tocSize; p += rec) {
    let q = p;
    const flags = dv.getUint16(q, true); q += 2;
    const hash = readN(q, widths.hashW); q += widths.hashW;
    const off = Number(readN(q, widths.offW)); q += widths.offW;
    const csize = Number(readN(q, widths.csW)); q += widths.csW;
    const delta = Number(readN(q, widths.usW)); q += widths.usW;
    let name = ''; for (let i = 0; i < nw && u8[q + i]; i++) name += String.fromCharCode(u8[q + i]);
    entries.push({ flags, hash, name, off, csize, delta, raw: u8.subarray(off, off + csize), data: null, dirty: false });
  }
  return { label, header: u8.slice(0, 64), prefix, widths, entries, dataStart: tocOff + tocSize, size: u8.length };
}

async function loadEntry(e) {
  if (!e.data) e.data = isZlib(e.raw) ? await zlibInflate(e.raw) : e.raw.slice();
  return e.data;
}

async function buildBigfile(big) {
  const n = big.entries.length, nw = 64, rec = 2 + 8 + 4 + 4 + 4 + nw;
  const tocOff = 64, tocSize = big.prefix.length * 4 + rec * n;
  const blobs = [];
  for (const e of big.entries) {
    if (e.dirty || !e.raw || !isZlib(e.raw)) { if (!e.data) await loadEntry(e); blobs.push({ comp: await zlibDeflate(e.data), usize: e.data.length }); }
    else blobs.push({ comp: e.raw, usize: e.csize + e.delta });
  }
  const total = tocOff + tocSize + blobs.reduce((s, b) => s + b.comp.length, 0);
  const out = new Uint8Array(total); const dv = new DataView(out.buffer);
  out.set(big.header.subarray(0, 64), 0);
  dv.setUint32(8, n + 1, true); dv.setUint32(12, n, true); dv.setUint32(16, tocOff, true); dv.setUint32(20, 0, true);
  dv.setUint32(24, tocSize, true); dv.setUint32(28, 0, true); dv.setUint32(32, 0x04080100, true); dv.setUint32(36, 0x404, true);
  dv.setUint32(40, big.prefix.length, true); dv.setUint32(44, nw, true);
  let p = tocOff;
  for (const w of big.prefix) { dv.setUint32(p, w >>> 0, true); p += 4; }
  let off = tocOff + tocSize;
  big.entries.forEach((e, i) => {
    const b = blobs[i];
    dv.setUint16(p, e.flags, true); p += 2;
    let h = e.hash; for (let k = 0; k < 8; k++) { out[p + k] = Number(h & 0xffn); h >>= 8n; } p += 8;
    dv.setUint32(p, off, true); p += 4; dv.setUint32(p, b.comp.length, true); p += 4; dv.setUint32(p, (b.usize - b.comp.length) >>> 0, true); p += 4;
    for (let k = 0; k < nw; k++) out[p + k] = k < e.name.length ? e.name.charCodeAt(k) : 0; p += nw;
    out.set(b.comp, off); off += b.comp.length;
  });
  return out;
}

function entryKind(name) {
  const m = /_(COL|NORM|DECAL|NAME|PRIDE|SPEC|MASK|ALPHA)$/.exec(name);
  if (!m) return 'scene';
  return m[1] === 'NAME' ? 'kerning' : 'texture';
}

// ---------- "p3R" textures ----------
// 128-byte header: 'p3R'\x02, u32 0x7c, u32 0x000a1007, u32 HEIGHT @12, u32 WIDTH @16 (DDS order: a 1024-wide x 2048-tall
// jersey stores 0x800 then 0x400; read the other way round, every texture decodes as two squashed copies side by side),
// u32 topMipBytes @20, u32 1 @24, u32 mipCount @28, ..., u32 0x20 @0x4c, u32 4 @0x50, fourcc @0x54, ..., u32 @0x6c;
// DXT blocks (top mip first, then the chain) from 0x80.
const BLOCK_BYTES = { DXT1: 8, DXT3: 16, DXT5: 16 };
function parseTexture(u8, name = '') {
  if (ascii(u8, 0, 3) !== 'p3R') throw new Error(`${name}: not a p3R texture`);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const fourcc = ascii(u8, 84, 88);
  if (!BLOCK_BYTES[fourcc]) throw new Error(`${name}: unsupported texture format ${JSON.stringify(fourcc)}`);
  const height = dv.getUint32(12, true), width = dv.getUint32(16, true), mips = dv.getUint32(28, true) || 1;
  const t = { name, header: u8.slice(0, 128), fourcc, width, height, mips, data: u8.subarray(128), trailer: new Uint8Array(0) };
  const need = chainBytes(width, height, mips, fourcc);
  if (t.data.length > need) { t.trailer = t.data.slice(need); t.data = t.data.subarray(0, need); }
  return t;
}
const mipDims = (w, h, level) => [Math.max(1, w >> level), Math.max(1, h >> level)];
const mipBytes = (w, h, fourcc) => Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * BLOCK_BYTES[fourcc];
function chainBytes(w, h, mips, fourcc) { let s = 0; for (let i = 0; i < mips; i++) { const [mw, mh] = mipDims(w, h, i); s += mipBytes(mw, mh, fourcc); } return s; }
function mipOffset(t, level) { let s = 0; for (let i = 0; i < level; i++) { const [mw, mh] = mipDims(t.width, t.height, i); s += mipBytes(mw, mh, t.fourcc); } return s; }

function c565(v) { return [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31]; }
function to565(r, g, b) { return ((Math.round(r * 31 / 255) & 31) << 11) | ((Math.round(g * 63 / 255) & 63) << 5) | (Math.round(b * 31 / 255) & 31); }

function decodeDXT(data, w, h, fourcc) {
  const out = new Uint8ClampedArray(w * h * 4);
  const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4)), bs = BLOCK_BYTES[fourcc];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const alpha = new Uint8Array(16);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const p = (by * bw + bx) * bs, cp = fourcc === 'DXT1' ? p : p + 8;
    if (fourcc === 'DXT5') {
      const a0 = data[p], a1 = data[p + 1];
      let bits = 0n; for (let i = 7; i >= 2; i--) bits = (bits << 8n) | BigInt(data[p + i]);
      for (let i = 0; i < 16; i++) {
        const k = Number((bits >> BigInt(3 * i)) & 7n);
        alpha[i] = k === 0 ? a0 : k === 1 ? a1 : a0 > a1 ? Math.round(((8 - k) * a0 + (k - 1) * a1) / 7) : k < 6 ? Math.round(((6 - k) * a0 + (k - 1) * a1) / 5) : k === 6 ? 0 : 255;
      }
    } else if (fourcc === 'DXT3') {
      for (let i = 0; i < 16; i++) { const v = (data[p + (i >> 1)] >> ((i & 1) * 4)) & 15; alpha[i] = v * 17; }
    } else alpha.fill(255);
    const c0 = dv.getUint16(cp, true), c1 = dv.getUint16(cp + 2, true), idx = dv.getUint32(cp + 4, true);
    const [r0, g0, b0] = c565(c0), [r1, g1, b1] = c565(c1);
    const pal = (fourcc === 'DXT1' && c0 <= c1)
      ? [[r0, g0, b0, 255], [r1, g1, b1, 255], [(r0 + r1) / 2, (g0 + g1) / 2, (b0 + b1) / 2, 255], [0, 0, 0, 0]]
      : [[r0, g0, b0, 255], [r1, g1, b1, 255], [(2 * r0 + r1) / 3, (2 * g0 + g1) / 3, (2 * b0 + b1) / 3, 255], [(r0 + 2 * r1) / 3, (g0 + 2 * g1) / 3, (b0 + 2 * b1) / 3, 255]];
    for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++) {
      const x = bx * 4 + px, y = by * 4 + py; if (x >= w || y >= h) continue;
      const i = py * 4 + px, c = pal[(idx >>> (2 * i)) & 3], o = (y * w + x) * 4;
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = fourcc === 'DXT1' ? c[3] : alpha[i];
    }
  }
  return out;
}

function decodeMip(t, level = 0) {
  const [w, h] = mipDims(t.width, t.height, level);
  const o = mipOffset(t, level), n = mipBytes(w, h, t.fourcc);
  return { width: w, height: h, rgba: decodeDXT(t.data.subarray(o, o + n), w, h, t.fourcc) };
}

// Color block encoder: bounding box + least-squares refinement (after stb_dxt). Returns [c0, c1, indices].
function encodeColorBlock(px, w4, alphaMode) {
  // px: 16 x [r,g,b,a]; alphaMode: DXT1 with transparent pixels -> 3-color mode
  const opaque = px.filter((p) => !alphaMode || p[3] >= 128);
  if (opaque.length === 0) return [0, 0, 0xffffffff];
  let mn = [255, 255, 255], mx = [0, 0, 0];
  for (const p of opaque) for (let c = 0; c < 3; c++) { if (p[c] < mn[c]) mn[c] = p[c]; if (p[c] > mx[c]) mx[c] = p[c]; }
  for (let c = 0; c < 3; c++) { const ins = (mx[c] - mn[c]) / 16; mn[c] = Math.min(255, mn[c] + ins); mx[c] = Math.max(0, mx[c] - ins); }
  let c0 = to565(mx[0], mx[1], mx[2]), c1 = to565(mn[0], mn[1], mn[2]);
  const fit = (c0v, c1v) => {
    const e0 = c565(c0v), e1 = c565(c1v);
    const pal = alphaMode ? [e0, e1, [(e0[0] + e1[0]) / 2, (e0[1] + e1[1]) / 2, (e0[2] + e1[2]) / 2]]
      : [e0, e1, [(2 * e0[0] + e1[0]) / 3, (2 * e0[1] + e1[1]) / 3, (2 * e0[2] + e1[2]) / 3], [(e0[0] + 2 * e1[0]) / 3, (e0[1] + 2 * e1[1]) / 3, (e0[2] + 2 * e1[2]) / 3]];
    let idx = 0, err = 0;
    for (let i = 0; i < 16; i++) {
      const p = px[i];
      if (alphaMode && p[3] < 128) { idx |= 3 << (2 * i); continue; }
      let best = 0, bd = Infinity;
      for (let k = 0; k < pal.length; k++) { const d = (p[0] - pal[k][0]) ** 2 + (p[1] - pal[k][1]) ** 2 + (p[2] - pal[k][2]) ** 2; if (d < bd) { bd = d; best = k; } }
      idx |= best << (2 * i); err += bd;
    }
    return [idx >>> 0, err];
  };
  let [idx, err] = fit(c0, c1);
  // refinement: least squares over the current index assignment (4-colour mode only)
  if (!alphaMode) for (let iter = 0; iter < 2; iter++) {
    const W = [1, 0, 2 / 3, 1 / 3]; let a00 = 0, a01 = 0, a11 = 0; const b0 = [0, 0, 0], b1 = [0, 0, 0];
    for (let i = 0; i < 16; i++) { const k = (idx >>> (2 * i)) & 3, wA = W[k], wB = 1 - wA; a00 += wA * wA; a01 += wA * wB; a11 += wB * wB; for (let c = 0; c < 3; c++) { b0[c] += wA * px[i][c]; b1[c] += wB * px[i][c]; } }
    const det = a00 * a11 - a01 * a01; if (Math.abs(det) < 1e-6) break;
    const n0 = [0, 0, 0], n1 = [0, 0, 0];
    for (let c = 0; c < 3; c++) { n0[c] = Math.max(0, Math.min(255, (a11 * b0[c] - a01 * b1[c]) / det)); n1[c] = Math.max(0, Math.min(255, (a00 * b1[c] - a01 * b0[c]) / det)); }
    const nc0 = to565(n0[0], n0[1], n0[2]), nc1 = to565(n1[0], n1[1], n1[2]);
    if (nc0 === c0 && nc1 === c1) break;
    const [ni, ne] = fit(nc0, nc1);
    if (ne < err) { c0 = nc0; c1 = nc1; idx = ni; err = ne; } else break;
  }
  if (alphaMode) { if (c0 > c1) { [c0, c1] = [c1, c0]; [idx] = fit(c0, c1); } }
  else if (c0 < c1) { [c0, c1] = [c1, c0]; [idx] = fit(c0, c1); }
  else if (c0 === c1) { idx = 0; }
  return [c0, c1, idx];
}

function encodeDXT(rgba, w, h, fourcc) {
  const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4)), bs = BLOCK_BYTES[fourcc];
  const out = new Uint8Array(bw * bh * bs); const dv = new DataView(out.buffer);
  const px = Array.from({ length: 16 }, () => [0, 0, 0, 255]);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    for (let py = 0; py < 4; py++) for (let px_ = 0; px_ < 4; px_++) {
      const x = Math.min(w - 1, bx * 4 + px_), y = Math.min(h - 1, by * 4 + py), o = (y * w + x) * 4, p = px[py * 4 + px_];
      p[0] = rgba[o]; p[1] = rgba[o + 1]; p[2] = rgba[o + 2]; p[3] = rgba[o + 3];
    }
    const p = (by * bw + bx) * bs;
    let cp = p;
    if (fourcc === 'DXT5') {
      let a0 = 0, a1 = 255; for (const q of px) { if (q[3] > a0) a0 = q[3]; if (q[3] < a1) a1 = q[3]; }
      out[p] = a0; out[p + 1] = a1; let bits = 0n;
      for (let i = 0; i < 16; i++) {
        let k = 0;
        if (a0 > a1) { const t = Math.round(7 * (a0 - px[i][3]) / (a0 - a1)); k = t === 0 ? 0 : t === 7 ? 1 : t + 1; }
        bits |= BigInt(k) << BigInt(3 * i);
      }
      for (let i = 2; i < 8; i++) { out[p + i] = Number(bits & 0xffn); bits >>= 8n; }
      cp = p + 8;
    } else if (fourcc === 'DXT3') {
      for (let i = 0; i < 16; i += 2) out[p + (i >> 1)] = (Math.round(px[i][3] / 17) & 15) | ((Math.round(px[i + 1][3] / 17) & 15) << 4);
      cp = p + 8;
    }
    const alphaMode = fourcc === 'DXT1' && px.some((q) => q[3] < 128);
    const [c0, c1, idx] = encodeColorBlock(px, w, alphaMode);
    dv.setUint16(cp, c0, true); dv.setUint16(cp + 2, c1, true); dv.setUint32(cp + 4, idx >>> 0, true);
  }
  return out;
}

function downsample(rgba, w, h) {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const acc = [0, 0, 0, 0]; let n = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const sx = Math.min(w - 1, x * 2 + dx), sy = Math.min(h - 1, y * 2 + dy), o = (sy * w + sx) * 4;
      for (let c = 0; c < 4; c++) acc[c] += rgba[o + c]; n++;
    }
    const o = (y * nw + x) * 4; for (let c = 0; c < 4; c++) out[o + c] = acc[c] / n;
  }
  return { rgba: out, width: nw, height: nh };
}

// Re-encode a texture from full-size RGBA, keeping the template's dimensions, format, mip count, header and trailer.
function encodeTexture(template, rgba) {
  const t = template; const parts = []; let cur = { rgba, width: t.width, height: t.height };
  for (let i = 0; i < t.mips; i++) {
    if (i > 0) cur = downsample(cur.rgba, cur.width, cur.height);
    parts.push(encodeDXT(cur.rgba, cur.width, cur.height, t.fourcc));
  }
  const data = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { data.set(p, o); o += p.length; }
  const out = new Uint8Array(128 + data.length + t.trailer.length);
  out.set(t.header, 0); out.set(data, 128); out.set(t.trailer, 128 + data.length);
  return { ...t, header: out.slice(0, 128), data: out.subarray(128, 128 + data.length), trailer: out.slice(128 + data.length), bytes: out };
}
function textureBytes(t) {
  const out = new Uint8Array(128 + t.data.length + t.trailer.length); out.set(t.header, 0); out.set(t.data, 128); out.set(t.trailer, 128 + t.data.length); return out;
}

// ---------- DDS ----------
function toDDS(t) {
  const h = new Uint8Array(128); const dv = new DataView(h.buffer);
  h.set([0x44, 0x44, 0x53, 0x20], 0); dv.setUint32(4, 124, true);
  dv.setUint32(8, 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000 | (t.mips > 1 ? 0x20000 : 0), true);
  dv.setUint32(12, t.height, true); dv.setUint32(16, t.width, true); dv.setUint32(20, mipBytes(t.width, t.height, t.fourcc), true);
  dv.setUint32(28, t.mips, true);
  dv.setUint32(76, 32, true); dv.setUint32(80, 0x4, true); for (let i = 0; i < 4; i++) h[84 + i] = t.fourcc.charCodeAt(i);
  dv.setUint32(108, 0x1000 | (t.mips > 1 ? 0x400000 | 0x8 : 0), true);
  const out = new Uint8Array(128 + t.data.length); out.set(h, 0); out.set(t.data, 128); return out;
}
// Returns {fourcc, width, height, mips, data} for DXT files or {rgba, width, height} for 32-bit uncompressed ones.
function fromDDS(u8) {
  if (ascii(u8, 0, 4) !== 'DDS ') throw new Error('not a DDS file');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const height = dv.getUint32(12, true), width = dv.getUint32(16, true), mips = Math.max(1, dv.getUint32(28, true));
  const pfFlags = dv.getUint32(80, true); let fourcc = ascii(u8, 84, 88); let body = u8.subarray(128);
  if (pfFlags & 0x4) {
    if (fourcc === 'DX10') {
      const fmt = dv.getUint32(128, true); body = u8.subarray(148);
      fourcc = { 71: 'DXT1', 72: 'DXT1', 74: 'DXT3', 75: 'DXT3', 77: 'DXT5', 78: 'DXT5' }[fmt];
      if (!fourcc) { if (fmt === 28 || fmt === 87 || fmt === 88) return rgbaFromDDS(body, width, height, fmt === 28 ? 'rgba' : 'bgra'); throw new Error(`DDS DXGI format ${fmt} not supported`); }
    }
    if (!BLOCK_BYTES[fourcc]) throw new Error(`DDS format ${fourcc} not supported (use DXT1, DXT3 or DXT5, or 32-bit uncompressed)`);
    return { fourcc, width, height, mips, data: body };
  }
  const bpp = dv.getUint32(88, true);
  if (bpp !== 32) throw new Error(`DDS ${bpp}-bit uncompressed not supported`);
  const rm = dv.getUint32(92, true), bm = dv.getUint32(100, true);
  return rgbaFromDDS(body, width, height, rm === 0xff ? 'rgba' : bm === 0xff ? 'bgra' : 'bgra', pfFlags & 0x1);
}
function rgbaFromDDS(body, width, height, order) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (order === 'rgba') { out[o] = body[o]; out[o + 1] = body[o + 1]; out[o + 2] = body[o + 2]; out[o + 3] = body[o + 3]; }
    else { out[o] = body[o + 2]; out[o + 1] = body[o + 1]; out[o + 2] = body[o]; out[o + 3] = body[o + 3]; }
  }
  return { rgba: out, width, height };
}

// Build replacement texture bytes for an entry from an imported image: a DDS ({fourcc,width,height,mips,data}) with the same
// format and size is copied block-for-block (mips regenerated if it has too few), anything else is decoded/resampled and re-encoded.
function textureFromImport(template, imp, resample) {
  const t = template;
  if (imp.fourcc && imp.fourcc === t.fourcc && imp.width === t.width && imp.height === t.height) {
    const need = chainBytes(t.width, t.height, t.mips, t.fourcc);
    if (imp.mips >= t.mips && imp.data.length >= need) {
      const out = new Uint8Array(128 + need + t.trailer.length); out.set(t.header, 0); out.set(imp.data.subarray(0, need), 128); out.set(t.trailer, 128 + need);
      return { bytes: out, mode: 'copied blocks' };
    }
    const top = decodeDXT(imp.data.subarray(0, mipBytes(t.width, t.height, t.fourcc)), t.width, t.height, t.fourcc);
    return { bytes: encodeTexture(t, top).bytes, mode: 'copied top level, mips regenerated' };
  }
  let rgba = imp.rgba, w = imp.width, h = imp.height;
  if (!rgba) rgba = decodeDXT(imp.data.subarray(0, mipBytes(w, h, imp.fourcc)), w, h, imp.fourcc);
  if (w !== t.width || h !== t.height) {
    if (!resample) throw new Error(`image is ${w}x${h} but the texture is ${t.width}x${t.height}`);
    rgba = resample(rgba, w, h, t.width, t.height);
  }
  return { bytes: encodeTexture(t, rgba).bytes, mode: `re-encoded as ${t.fourcc}` };
}
// nearest/box resample without a canvas (used by the server)
function resampleRGBA(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const x0 = Math.floor(x * sw / dw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / dw)), y0 = Math.floor(y * sh / dh), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / dh));
    const acc = [0, 0, 0, 0]; let n = 0;
    for (let yy = y0; yy < y1 && yy < sh; yy++) for (let xx = x0; xx < x1 && xx < sw; xx++) { const o = (yy * sw + xx) * 4; for (let c = 0; c < 4; c++) acc[c] += src[o + c]; n++; }
    const o = (y * dw + x) * 4; for (let c = 0; c < 4; c++) out[o + c] = acc[c] / (n || 1);
  }
  return out;
}

// ---------- Names and renaming ----------
// <SLOT6>_<PART6>_<YEAR4>_<COLOR> ; the scene file refers to textures by lower-case Maya paths, the TOC by upper-case names.
function splitName(name) {
  const m = /^([A-Z0-9]{6})_([A-Z0-9]{6})_(\d{4})_([A-Z0-9]+?)(?:_(COL|NORM|DECAL|NAME|PRIDE|SPEC|MASK|ALPHA|[A-Z]+))?$/i.exec(name);
  if (!m) return null;
  return { slot: m[1], part: m[2], year: m[3], color: m[4], suffix: m[5] || '' };
}
function caseLike(src, dst) { return src === src.toUpperCase() ? dst.toUpperCase() : src === src.toLowerCase() ? dst.toLowerCase() : dst; }
function replaceBytesCI(data, from, to) {
  if (from.length !== to.length) throw new Error(`replacement must keep the length (${from} -> ${to})`);
  const out = data.slice(); const f = from.toLowerCase(); let count = 0;
  for (let i = 0; i + f.length <= out.length; i++) {
    let ok = true;
    for (let k = 0; k < f.length; k++) { const c = String.fromCharCode(out[i + k]).toLowerCase(); if (c !== f[k]) { ok = false; break; } }
    if (!ok) continue;
    const seg = ascii(out, i, i + f.length), rep = caseLike(seg, to);
    for (let k = 0; k < rep.length; k++) out[i + k] = rep.charCodeAt(k);
    count++; i += f.length - 1;
  }
  return [out, count];
}
// map: [{from, to}] (equal lengths). Renames entry names, rehashes, and patches scene/kerning text; textures are untouched.
async function renameBigfile(big, map) {
  const log = [];
  for (const e of big.entries) {
    let name = e.name;
    for (const { from, to } of map) { const [n] = replaceBytesCI(new TextEncoder().encode(name), from, to); name = new TextDecoder().decode(n); }
    if (name !== e.name) { log.push(`${e.name} -> ${name}`); e.name = name; e.hash = fnv1a64(name); }
    if (entryKind(e.name) === 'scene') {
      await loadEntry(e); let d = e.data, total = 0;
      for (const { from, to } of map) { const [n, c] = replaceBytesCI(d, from, to); d = n; total += c; }
      if (total) { e.data = d; e.dirty = true; log.push(`${e.name}: ${total} path reference(s) patched`); }
    }
  }
  return log;
}

// ---------- Mix-and-match XML ----------
const PART_TYPES = ['helmet', 'jersey', 'pants', 'socks', 'shoes', 'gloves'];
function partTemplate(type, name, bigfile, scene) {
  if (type === 'jersey') return `  <part name="${name}" shade="dark" type="jersey">
    <bigfile name="${bigfile}"/>
    <scene name="${scene}"/>
    <kerningTable name="${scene}_NAME"/>
    <fontColorTexture name="${scene}_NAME_DECAL"/>
    <numberColorTexture name="${scene}_NUMS_DECAL"/>
    <nameScaleAtMin value="1.0"/>
    <nameMinWidth value="0.6"/>
    <nameMaxWidth value="0.6"/>
    <numberSpacingOne value="0.3"/>
    <uvSet value="2"/>
  <decalUV value="-0.1400000006,0.2399999946,0.0700000003,0.03500000015"/></part>`;
  return `  <part name="${name}" type="${type}">
    <bigfile name="${bigfile}"/>
    <scene name="${scene}"/>
  </part>`;
}
function xmlForSet(officials, parts) {
  // parts: [{type, name, bigfile, scene, officials:[...]}]
  const lines = ['<?xml version="1.0" ?><root>'];
  for (const t of PART_TYPES.slice(0, 5)) lines.push(`  <partType name="${t}"/>`);
  lines.push('');
  for (const o of officials) lines.push(`  <officialType name="${o}"/>`);
  lines.push('');
  for (const p of parts) {
    let x = partTemplate(p.type, p.name, p.bigfile, p.scene);
    const offs = p.officials.map((o) => `    <official name="${o}"/>`).join('\n');
    x = x.replace(/\n(  <decalUV|  <\/part>)/, offs ? `\n${offs}\n$1` : '\n$1');
    lines.push(x, '');
  }
  lines.push('</root>', '');
  return lines.join('\n');
}

const Codec = { fnv1a64, hex64, ascii, isZlib, zlibInflate, zlibDeflate, parseBigfile, loadEntry, buildBigfile, entryKind,
  parseTexture, decodeMip, decodeDXT, encodeDXT, encodeTexture, textureBytes, downsample, mipDims, mipBytes, chainBytes, mipOffset,
  toDDS, fromDDS, textureFromImport, resampleRGBA, splitName, replaceBytesCI, renameBigfile, xmlForSet, partTemplate, PART_TYPES, BLOCK_BYTES };
if (typeof module !== 'undefined') module.exports = Codec;
if (typeof globalThis !== 'undefined') globalThis.Codec = Codec;
