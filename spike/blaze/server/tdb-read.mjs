// Minimal read-only EA "DB" (TDB) reader for the league server: enough to look up rows of the dynasty file the console
// last uploaded (locker DYNASTY.dynasty = zlib of a 4-byte prefix + DB). Same layout as packages/tdb (format.ts/reader.ts):
// 0x18 file header, 8-byte directory entries, per table a 0x28 header, 0x10-byte field defs, then MSB-first bit-packed
// records. Field names are stored byte-reversed on the PS3 (big-endian) files.
import fs from 'node:fs';
import zlib from 'node:zlib';

const name4 = (b) => Buffer.from(b).reverse().toString('latin1');

function readBits(buf, bitOffset, bits) {
  let value = 0, b = bitOffset, left = bits;
  while (left > 0) {
    const byte = buf[b >>> 3], inByte = b & 7, take = Math.min(8 - inByte, left);
    value = value * (1 << take) + ((byte >>> (8 - inByte - take)) & ((1 << take) - 1));
    b += take; left -= take;
  }
  return value;
}

export function parseDb(bytes) {
  if (bytes[0] !== 0x44 || bytes[1] !== 0x42) throw new Error('not an EA DB');
  const le = bytes[4] !== 1, dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  const dbSize = u32(8), count = u32(16), dataStart = 0x18 + count * 8;
  const dir = [];
  for (let i = 0; i < count; i++) { const e = 0x18 + i * 8; dir.push({ name: name4(bytes.subarray(e, e + 4)), offset: u32(e + 4) }); }
  const order = [...dir].sort((a, b) => a.offset - b.offset);
  const tables = new Map();
  order.forEach((d, k) => {
    let pos = dataStart + d.offset;
    const h = { alloc: u32(pos + 4), lengthBytes: u32(pos + 8), maxRecords: u16(pos + 20), currentRecords: u16(pos + 22), numFields: bytes[pos + 28] };
    pos += 0x28;
    const fields = [];
    for (let f = 0; f < h.numFields; f++) { const o = pos + f * 0x10; fields.push({ type: u32(o), bitOffset: u32(o + 4), name: name4(bytes.subarray(o + 8, o + 12)), bits: u32(o + 12) }); }
    pos += h.numFields * 0x10;
    const next = order[k + 1]; const end = next ? dataStart + next.offset : dbSize - 4;
    tables.set(d.name, { name: d.name, header: h, fields, data: bytes.subarray(pos, end) });
  });
  return { tables };
}

// Rows of one table as plain objects (strings/blobs left out: the league server only needs numbers).
export function rows(db, table) {
  const t = db.tables.get(table); if (!t) return [];
  const out = [];
  for (let i = 0; i < t.header.currentRecords; i++) {
    const base = i * t.header.lengthBytes * 8, r = {};
    for (const f of t.fields) {
      if (f.type === 0 || f.type === 1) continue;
      let v = readBits(t.data, base + f.bitOffset, f.bits);
      if (f.type === 2 && v >= 2 ** (f.bits - 1)) v -= 2 ** f.bits;
      r[f.name] = v;
    }
    out.push(r);
  }
  return out;
}

// The dynasty database inside a locker DYNASTY.dynasty blob.
export function readDynastyFile(file) {
  const z = zlib.inflateSync(fs.readFileSync(file));
  const at = z.indexOf(Buffer.from('DB\0\x08', 'latin1'));
  if (at < 0) throw new Error('no DB in dynasty file');
  return parseDb(new Uint8Array(z.buffer, z.byteOffset + at, z.length - at));
}
