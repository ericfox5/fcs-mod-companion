// MSB-first bit packing helpers for TDB record data (PS3 saves are big-endian bit streams).

export function readBits(buf: Uint8Array, bitOffset: number, bits: number): number {
  if (bits > 53) throw new Error(`readBits: ${bits}-bit fields are not supported`);
  let value = 0;
  let b = bitOffset;
  let remaining = bits;
  while (remaining > 0) {
    const byte = buf[b >>> 3]!;
    const bitInByte = b & 7;
    const take = Math.min(8 - bitInByte, remaining);
    const chunk = (byte >>> (8 - bitInByte - take)) & ((1 << take) - 1);
    value = value * (1 << take) + chunk;
    b += take;
    remaining -= take;
  }
  return value;
}

export function writeBits(buf: Uint8Array, bitOffset: number, bits: number, value: number): void {
  if (bits > 53) throw new Error(`writeBits: ${bits}-bit fields are not supported`);
  if (!Number.isInteger(value) || value < 0) throw new Error(`writeBits: value must be a non-negative integer (got ${value})`);
  const max = 2 ** bits - 1;
  if (value > max) throw new RangeError(`writeBits: ${value} does not fit in ${bits} bits (max ${max})`);
  let b = bitOffset + bits - 1;
  let v = value;
  for (let i = 0; i < bits; i++, b--) {
    const idx = b >>> 3;
    const mask = 1 << (7 - (b & 7));
    if (v % 2 === 1) buf[idx] = buf[idx]! | mask;
    else buf[idx] = buf[idx]! & ~mask;
    v = Math.floor(v / 2);
  }
}

/** Interpret an unsigned n-bit value as two's-complement signed. */
export function toSigned(value: number, bits: number): number {
  const half = 2 ** (bits - 1);
  return value >= half ? value - 2 ** bits : value;
}

export function fromSigned(value: number, bits: number): number {
  return value < 0 ? value + 2 ** bits : value;
}
