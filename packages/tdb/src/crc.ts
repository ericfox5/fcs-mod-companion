// CRC-32/BE (polynomial 0x04C11DB7, nibble table) as used by EA Tiburon "DB" save databases.
// Ported from madden-file-tools services/CRC.js (MIT, bep713) with attribution; see archive/ref.
const POLY = 0x04c11db7;

const TABLE: Uint32Array = (() => {
  const t = new Uint32Array(16);
  let crc = 0x80000000;
  for (let i = 1; i < 16; i <<= 1) {
    crc = ((crc << 1) ^ (crc & 0x80000000 ? POLY : 0)) >>> 0;
    for (let j = 0; j < i; j++) t[i + j] = (crc ^ t[j]!) >>> 0;
  }
  return t;
})();

/** Raw crc32_be over bytes[start, end). */
export function crc32be(data: Uint8Array, start = 0, end = data.length, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = start; i < end; i++) {
    crc = (crc ^ (data[i]! << 24)) >>> 0;
    crc = (((crc << 4) >>> 0) ^ TABLE[crc >>> 28]!) >>> 0;
    crc = (((crc << 4) >>> 0) ^ TABLE[crc >>> 28]!) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The value EA stores in DB files: bitwise NOT of crc32_be. */
export function tdbChecksum(data: Uint8Array, start = 0, end = data.length): number {
  return ~crc32be(data, start, end) >>> 0;
}

/** Checksum over the concatenation of several byte ranges without copying. */
export function tdbChecksumParts(parts: Uint8Array[]): number {
  let crc = 0;
  let first = true;
  for (const p of parts) {
    if (p.length === 0) continue;
    crc = crc32be(p, 0, p.length, first ? 0 : crc);
    first = false;
  }
  return ~crc >>> 0;
}
