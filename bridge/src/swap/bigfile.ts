// The pieces of the uniform codec (spike/blaze/tools/uniforms/src/codec.cjs) the swap needs, on Node's zlib: a BGFA
// bigfile with named entries (DLC uniform parts: 2-byte flags, u64 FNV-1a of the upper-case name, u32 off / csize /
// usize-csize, 64-byte name), a same-length rename (entry names, hashes, and the scene / kerning text that refers to
// them), a rebuild, and DXT texture decoding plus a PNG encoder for logo previews.
import { deflateSync, inflateSync } from 'node:zlib';

export const fnv1a64 = (name: string): bigint => {
  let h = 0xcbf29ce484222325n;
  for (const c of Buffer.from(name.toUpperCase(), 'latin1')) { h ^= BigInt(c); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h;
};
export const inflateEntry = (raw: Uint8Array): Buffer => (raw[0] === 0x78 ? inflateSync(Buffer.from(raw)) : Buffer.from(raw));

export interface NamedEntry { flags: number; name: string; hash: bigint; raw: Buffer; data?: Buffer; dirty?: boolean }
export interface NamedBigfile { header: Buffer; prefix: number[]; entries: NamedEntry[] }
export function parseNamedBigfile(b: Buffer): NamedBigfile {
  if (b.toString('latin1', 0, 8) !== 'BGFA1.05') throw new Error('not a BGFA bigfile');
  const tocOff = b.readUInt32LE(16), tocSize = b.readUInt32LE(24), w8 = b.readUInt32LE(32), w9 = b.readUInt32LE(36), pw = b.readUInt32LE(40), nw = b.readUInt32LE(44);
  const fw = ((w8 >>> 8) & 255) + 1, hw = (w8 >>> 16) & 255, ow = (w8 >>> 24) & 255, cw = (w9 >>> 8) & 255, uw = w9 & 255, rec = fw + hw + ow + cw + uw + nw;
  const num = (p: number, w: number) => { let v = 0n; for (let i = w - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[p + i]!); return v; };
  const prefix: number[] = []; for (let i = 0; i < pw; i++) prefix.push(b.readUInt32LE(tocOff + i * 4));
  const entries: NamedEntry[] = [];
  for (let p = tocOff + pw * 4; p + rec <= tocOff + tocSize; p += rec) {
    let q = p; const flags = Number(num(q, fw)); q += fw; const hash = num(q, hw); q += hw; const off = Number(num(q, ow)); q += ow; const csize = Number(num(q, cw)); q += cw + uw;
    let name = ''; for (let i = 0; i < nw && b[q + i]; i++) name += String.fromCharCode(b[q + i]!);
    entries.push({ flags, name, hash, raw: Buffer.from(b.subarray(off, off + csize)) });
  }
  return { header: Buffer.from(b.subarray(0, 64)), prefix, entries };
}
// layout of the DLC bigfiles: header 64, 2-byte flags, 64-byte names, zlib entries back to back
export function buildNamedBigfile(big: NamedBigfile): Buffer {
  const n = big.entries.length, nw = 64, rec = 2 + 8 + 4 + 4 + 4 + nw, tocOff = 64, tocSize = big.prefix.length * 4 + rec * n;
  const blobs = big.entries.map((e) => {
    if (!e.dirty && e.raw[0] === 0x78) { const usize = inflateEntry(e.raw).length; return { comp: e.raw, usize }; }
    const d = e.data ?? inflateEntry(e.raw); return { comp: deflateSync(d), usize: d.length };
  });
  const out = Buffer.alloc(tocOff + tocSize + blobs.reduce((s, x) => s + x.comp.length, 0));
  big.header.copy(out, 0, 0, 64);
  out.writeUInt32LE(n + 1, 8); out.writeUInt32LE(n, 12); out.writeUInt32LE(tocOff, 16); out.writeUInt32LE(0, 20); out.writeUInt32LE(tocSize, 24); out.writeUInt32LE(0, 28);
  out.writeUInt32LE(0x04080100, 32); out.writeUInt32LE(0x404, 36); out.writeUInt32LE(big.prefix.length, 40); out.writeUInt32LE(nw, 44);
  let p = tocOff; for (const w of big.prefix) { out.writeUInt32LE(w >>> 0, p); p += 4; }
  let off = tocOff + tocSize;
  big.entries.forEach((e, i) => {
    const x = blobs[i]!; out.writeUInt16LE(e.flags, p); out.writeBigUInt64LE(e.hash, p + 2); out.writeUInt32LE(off, p + 10); out.writeUInt32LE(x.comp.length, p + 14); out.writeUInt32LE((x.usize - x.comp.length) >>> 0, p + 18);
    out.write(e.name.slice(0, nw), p + 22, 'latin1'); p += rec; x.comp.copy(out, off); off += x.comp.length;
  });
  return out;
}
// case-insensitive same-length replace, keeping the matched text's case style
export function replaceCI(data: Buffer, from: string, to: string): [Buffer, number] {
  if (from.length !== to.length) throw new Error(`rename must keep the length (${from} -> ${to})`);
  const out = Buffer.from(data), f = from.toLowerCase(); let count = 0;
  for (let i = 0; i + f.length <= out.length; i++) {
    let ok = true; for (let k = 0; k < f.length; k++) { if (String.fromCharCode(out[i + k]!).toLowerCase() !== f[k]) { ok = false; break; } }
    if (!ok) continue;
    const seg = out.toString('latin1', i, i + f.length), rep = seg === seg.toUpperCase() ? to.toUpperCase() : seg === seg.toLowerCase() ? to.toLowerCase() : to;
    out.write(rep, i, 'latin1'); count++; i += f.length - 1;
  }
  return [out, count];
}
const isText = (name: string) => !/_(COL|NORM|DECAL|PRIDE|SPEC|MASK|ALPHA)$/i.test(name); // scenes and kerning tables carry names
export function renameBigfile(big: NamedBigfile, map: { from: string; to: string }[]): void {
  for (const e of big.entries) {
    let name: Buffer = Buffer.from(e.name, 'latin1'); for (const m of map) name = replaceCI(name, m.from, m.to)[0];
    if (name.toString('latin1') !== e.name) { e.name = name.toString('latin1'); e.hash = fnv1a64(e.name); }
    if (isText(e.name)) { let d: Buffer = e.data ?? inflateEntry(e.raw), total = 0; for (const m of map) { const [n, c] = replaceCI(d, m.from, m.to); d = n; total += c; } if (total) { e.data = d; e.dirty = true; } }
  }
}

// ---- textures: DDS (logos) and p3R (uniform parts) DXT1/3/5 -> RGBA ----
export interface Rgba { width: number; height: number; rgba: Uint8Array }
const BLOCK: Record<string, number> = { DXT1: 8, DXT3: 16, DXT5: 16 };
function c565(v: number): [number, number, number] { return [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31]; }
export function decodeDxt(data: Uint8Array, w: number, h: number, fourcc: string): Uint8Array {
  const out = new Uint8Array(w * h * 4), bs = BLOCK[fourcc]!, bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4)), dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const o = (by * bw + bx) * bs, co = fourcc === 'DXT1' ? o : o + 8; if (co + 8 > data.length) continue;
    const a0 = dv.getUint16(co, true), a1 = dv.getUint16(co + 2, true), bits = dv.getUint32(co + 4, true), p0 = c565(a0), p1 = c565(a1);
    const pal = [p0, p1, a0 > a1 || fourcc !== 'DXT1' ? p0.map((v, i) => (2 * v + p1[i]!) / 3) : p0.map((v, i) => (v + p1[i]!) / 2), a0 > a1 || fourcc !== 'DXT1' ? p0.map((v, i) => (v + 2 * p1[i]!) / 3) : [0, 0, 0]];
    let alpha: number[] | null = null;
    if (fourcc === 'DXT5') {
      const al0 = data[o]!, al1 = data[o + 1]!, ap = [al0, al1];
      if (al0 > al1) for (let k = 1; k <= 6; k++) ap.push(((7 - k) * al0 + k * al1) / 7);
      else { for (let k = 1; k <= 4; k++) ap.push(((5 - k) * al0 + k * al1) / 5); ap.push(0, 255); }
      let ab = 0n; for (let k = 0; k < 6; k++) ab |= BigInt(data[o + 2 + k]!) << BigInt(8 * k);
      alpha = []; for (let k = 0; k < 16; k++) alpha.push(ap[Number((ab >> BigInt(3 * k)) & 7n)]!);
    }
    if (fourcc === 'DXT3') { alpha = []; for (let k = 0; k < 16; k++) alpha.push(((data[o + (k >> 1)]! >> ((k & 1) * 4)) & 15) * 17); }
    for (let k = 0; k < 16; k++) {
      const x = bx * 4 + (k & 3), y = by * 4 + (k >> 2); if (x >= w || y >= h) continue;
      const idx = (bits >>> (2 * k)) & 3, c = pal[idx]!, d = (y * w + x) * 4;
      out[d] = c[0]!; out[d + 1] = c[1]!; out[d + 2] = c[2]!; out[d + 3] = alpha ? alpha[k]! : fourcc === 'DXT1' && a0 <= a1 && idx === 3 ? 0 : 255;
    }
  }
  return out;
}
// a DDS (logos): height @12, width @16, mip count @28, FourCC @84, blocks from 128; `maxSide` picks the first mip that fits
export function decodeDds(dds: Uint8Array, maxSide = 256): Rgba {
  const b = Buffer.from(dds.buffer, dds.byteOffset, dds.byteLength); const h0 = b.readUInt32LE(12), w0 = b.readUInt32LE(16), mips = b.readUInt32LE(28) || 1, fourcc = b.toString('latin1', 84, 88);
  if (!BLOCK[fourcc]) throw new Error(`DDS ${fourcc}: unsupported`);
  let off = 128, w = w0, h = h0, lvl = 0;
  while (lvl + 1 < mips && Math.max(w, h) > maxSide) { off += Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * BLOCK[fourcc]!; w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); lvl++; }
  return { width: w, height: h, rgba: decodeDxt(dds.subarray(off), w, h, fourcc) };
}
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const v of b) c = CRC[(c ^ v) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function encodePng(img: Rgba): Buffer {
  const { width: w, height: h, rgba } = img, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t, 'latin1'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
