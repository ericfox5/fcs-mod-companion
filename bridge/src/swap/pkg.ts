// Read-only access to the CFBR "easy installer" (a PS3 debug pkg) and its EDATs, without installing anything:
// - debug pkg: header digest at 0x60; the data (from the u64 at 0x20) is XORed per 16-byte block with
//   SHA-1(digest[0:8] x2 || digest[8:16] x2 || 24 zero bytes || u64 block counter)[0:16]; a 32-byte record per item
//   {u32 name offset, u32 name size, u64 data offset, u64 size, u32 flags} sits at the start of the data;
// - EDAT (NPD v3, licence 3, flags 0x0c in CFBR): block i's key is AES-ECB(klicensee, dev_hash[0:12] || be32(i)),
//   AES-CBC-decrypted with EDAT_KEY_0 when the encrypted-key flag 0x08 is set (EDAT_KEY_1 for version 4); each block
//   is AES-128-CBC with the NPD digest as IV, so any block decrypts on its own. The klicensee for NCAA 14's DLC is the
//   one the game passes to sceNpDrmIsAvailable (RPCS3 logs it).
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export interface ByteSource { size: number; readAt(off: number, len: number): Buffer }
export interface PkgItem { name: string; off: number; size: number; type: number }

export class Pkg {
  readonly items: PkgItem[] = [];
  private readonly fd: number; private readonly dataOff: number; private readonly base: Buffer;
  constructor(readonly path: string) {
    this.fd = openSync(path, 'r'); const h = Buffer.alloc(0x80); readSync(this.fd, h, 0, h.length, 0);
    if (h.readUInt32BE(0) !== 0x7f504b47) throw new Error(`${path}: not a PS3 pkg`);
    if (h.readUInt16BE(4) !== 0) throw new Error(`${path}: retail pkg (revision ${h.readUInt16BE(4)}), not a debug pkg`);
    this.dataOff = Number(h.readBigUInt64BE(0x20)); const d = h.subarray(0x60, 0x70);
    this.base = Buffer.concat([d.subarray(0, 8), d.subarray(0, 8), d.subarray(8, 16), d.subarray(8, 16), Buffer.alloc(32)]);
    const n = h.readUInt32BE(0x14), tab = this.read(0, n * 32);
    for (let i = 0; i < n; i++) {
      const o = i * 32, no = tab.readUInt32BE(o), ns = tab.readUInt32BE(o + 4);
      this.items.push({ name: this.read(no, ns).toString('latin1'), off: Number(tab.readBigUInt64BE(o + 8)), size: Number(tab.readBigUInt64BE(o + 16)), type: tab.readUInt32BE(o + 24) & 255 });
    }
  }
  private read(rel: number, n: number): Buffer {
    const start = rel - (rel % 16), blocks = Math.ceil((rel + n - start) / 16), buf = Buffer.alloc(blocks * 16);
    readSync(this.fd, buf, 0, buf.length, this.dataOff + start);
    const b = Buffer.from(this.base);
    for (let i = 0; i < blocks; i++) { b.writeBigUInt64BE(BigInt(start / 16 + i), 56); const k = createHash('sha1').update(b).digest(); for (let j = 0; j < 16; j++) buf[i * 16 + j]! ^= k[j]!; }
    return buf.subarray(rel - start, rel - start + n);
  }
  source(item: PkgItem): ByteSource {
    return { size: item.size, readAt: (off, len) => { if (off < 0 || off + len > item.size) throw new Error(`${item.name}: read ${off}+${len} past ${item.size}`); return this.read(item.off + off, len); } };
  }
  find(test: (name: string) => boolean): PkgItem | undefined { return this.items.find((i) => test(i.name)); }
  close(): void { closeSync(this.fd); }
  static looksLikePkg(path: string): boolean { try { return statSync(path).isFile() && path.toLowerCase().endsWith('.pkg'); } catch { return false; } }
}

const EDAT_KEY_0 = Buffer.from('BE959CA8308DEFA2E5E180C63712A9AE', 'hex'), EDAT_KEY_1 = Buffer.from('4CA9C14B01C95309969BEC68AA0BC081', 'hex');
const aesEcbEnc = (key: Buffer, d: Buffer) => { const c = createCipheriv('aes-128-ecb', key, null); c.setAutoPadding(false); return Buffer.concat([c.update(d), c.final()]); };
const aesCbcDec = (key: Buffer, iv: Buffer, d: Buffer) => { const c = createDecipheriv('aes-128-cbc', key, iv); c.setAutoPadding(false); return Buffer.concat([c.update(d), c.final()]); };

export class Edat implements ByteSource {
  readonly size: number;
  private readonly block: number; private readonly n: number; private readonly flags: number; private readonly version: number;
  private readonly iv: Buffer; private readonly devHash: Buffer; private readonly cache = new Map<number, Buffer>();
  constructor(private readonly enc: ByteSource, private readonly klic: Buffer) {
    const h = enc.readAt(0, 0x100); if (h.toString('latin1', 0, 4) !== 'NPD\0') throw new Error('not an NPD (EDAT) file');
    this.version = h.readInt32BE(4); this.flags = h.readUInt32BE(0x80); this.block = h.readInt32BE(0x84); this.size = Number(h.readBigUInt64BE(0x88));
    if (this.flags & 0x21) throw new Error(`EDAT flags ${this.flags.toString(16)} (compressed / interleaved) are not handled`);
    this.iv = this.version <= 1 ? Buffer.alloc(16) : Buffer.from(h.subarray(0x40, 0x50)); this.devHash = Buffer.from(h.subarray(0x60, 0x70)); this.n = Math.ceil(this.size / this.block);
  }
  private blockData(i: number): Buffer {
    const hit = this.cache.get(i); if (hit) return hit;
    const len = i === this.n - 1 ? this.size - i * this.block : this.block, padded = (len + 15) & ~15;
    const bkey = Buffer.alloc(16); this.devHash.copy(bkey, 0, 0, 12); bkey.writeUInt32BE(i, 12);
    let key = aesEcbEnc(this.klic, bkey); if (this.flags & 0x08) key = aesCbcDec(this.version === 4 ? EDAT_KEY_1 : EDAT_KEY_0, Buffer.alloc(16), key);
    const raw = this.enc.readAt(0x100 + this.n * 0x10 + i * this.block, padded);
    const out = ((this.flags & 0x02) ? Buffer.from(raw) : aesCbcDec(key, this.iv, raw)).subarray(0, len);
    if (this.cache.size > 64) this.cache.clear(); this.cache.set(i, out); return out;
  }
  readAt(off: number, len: number): Buffer {
    const out = Buffer.alloc(len); let p = 0;
    while (p < len) { const i = Math.floor((off + p) / this.block), o = off + p - i * this.block, b = this.blockData(i), k = Math.min(len - p, b.length - o); if (k <= 0) throw new Error('EDAT read past end'); b.copy(out, p, o, o + k); p += k; }
    return out;
  }
}
