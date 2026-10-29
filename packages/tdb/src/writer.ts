import { tdbChecksum, tdbChecksumParts } from './crc.js';
import { FILE_HEADER_SIZE, DIR_ENTRY_SIZE, TABLE_HEADER_SIZE, EOF_CRC_SIZE, BIG_ENDIAN } from './format.js';
import type { TdbFile } from './reader.js';
import type { TdbTable } from './table.js';

export interface SerializeOptions {
  // Pad the output with zeros to this length (the game pads dynasty saves to 8,278,016). Default: file.fileLength.
  padTo?: number;
}

function tableSize(t: TdbTable): number {
  return TABLE_HEADER_SIZE + t.fieldDefsRaw.length + t.data.length + t.index.length;
}

function sameName(t: TdbTable, nameRaw: Uint8Array): boolean {
  return t.nameRaw.length === nameRaw.length && t.nameRaw.every((b, j) => b === nameRaw[j]);
}

// Serialize with every offset, size and checksum recomputed. Updates the header/offset fields in `file` to match.
export function serializeTdb(file: TdbFile, opts: SerializeOptions = {}): Uint8Array {
  const le = file.header.endian !== BIG_ENDIAN;
  const numTables = file.directory.length;
  if (file.tables.length !== numTables) throw new Error(`directory has ${numTables} entries but ${file.tables.length} tables`);
  const dataStart = FILE_HEADER_SIZE + numTables * DIR_ENTRY_SIZE;
  const bodySize = file.tables.reduce((n, t) => n + tableSize(t), 0);
  const dbSize = dataStart + bodySize + EOF_CRC_SIZE;
  const padTo = Math.max(opts.padTo ?? file.fileLength, dbSize);
  const out = new Uint8Array(padTo);
  const dv = new DataView(out.buffer);
  const w16 = (o: number, v: number) => dv.setUint16(o, v, le);
  const w32 = (o: number, v: number) => dv.setUint32(o, v >>> 0, le);

  const offsets = new Map<TdbTable, number>();
  let off = 0;
  for (const t of file.tables) {
    offsets.set(t, off);
    off += tableSize(t);
  }

  const h = file.header;
  h.dbSize = dbSize;
  h.numTables = numTables;
  dv.setUint16(0, h.digit, false);
  dv.setUint16(2, h.version, false);
  out[4] = h.endian;
  out[5] = h.unknown1;
  w16(6, h.unknown2);
  w32(8, h.dbSize);
  w32(12, h.zero);
  w32(16, h.numTables);
  h.headerCrc = tdbChecksum(out, 0, 0x14);
  w32(20, h.headerCrc);

  const used = new Set<TdbTable>();
  for (let i = 0; i < numTables; i++) {
    const d = file.directory[i]!;
    const t = file.tables.find((x) => !used.has(x) && sameName(x, d.nameRaw));
    if (!t) throw new Error(`directory entry ${i} (${d.name || 'unnamed'}) has no table`);
    used.add(t);
    d.offset = offsets.get(t)!;
    const e = FILE_HEADER_SIZE + i * DIR_ENTRY_SIZE;
    out.set(d.nameRaw, e);
    w32(e + 4, d.offset);
  }

  let prior = tdbChecksum(out, FILE_HEADER_SIZE, dataStart);
  for (const t of file.tables) {
    const pos = dataStart + offsets.get(t)!;
    const th = t.header;
    th.priorCrc = prior;
    th.numFields = t.fields.length;
    w32(pos, th.priorCrc);
    w32(pos + 4, th.allocType);
    w32(pos + 8, th.lengthBytes);
    w32(pos + 12, th.lengthBits);
    w32(pos + 16, th.zero);
    w16(pos + 20, th.maxRecords);
    w16(pos + 22, th.currentRecords);
    w32(pos + 24, th.unknown2);
    out[pos + 28] = th.numFields;
    out[pos + 29] = th.indexCount;
    w16(pos + 30, th.zero2);
    w32(pos + 32, th.zero3);
    th.headerCrc = tdbChecksum(out, pos + 4, pos + 36);
    w32(pos + 36, th.headerCrc);
    let p = pos + TABLE_HEADER_SIZE;
    out.set(t.fieldDefsRaw, p);
    p += t.fieldDefsRaw.length;
    out.set(t.data, p);
    p += t.data.length;
    out.set(t.index, p);
    prior = tdbChecksumParts([t.fieldDefsRaw, t.data, t.index]);
  }
  file.eofCrc = prior;
  w32(dbSize - EOF_CRC_SIZE, file.eofCrc);
  file.fileLength = padTo;
  return out;
}

export interface VerifyProblem {
  where: string;
  expected: number;
  actual: number;
}

// Check every checksum in a parsed file against its bytes. Empty result means the file is consistent.
export function verifyTdb(bytes: Uint8Array, file: TdbFile): VerifyProblem[] {
  const problems: VerifyProblem[] = [];
  const le = file.header.endian !== BIG_ENDIAN;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataStart = FILE_HEADER_SIZE + file.directory.length * DIR_ENTRY_SIZE;

  const hc = tdbChecksum(bytes, 0, 0x14);
  if (hc !== file.header.headerCrc) problems.push({ where: 'file header crc', expected: hc, actual: file.header.headerCrc });

  let prior = tdbChecksum(bytes, FILE_HEADER_SIZE, dataStart);
  const used = new Set<number>();
  for (const t of file.tables) {
    const di = file.directory.findIndex((x, i) => !used.has(i) && sameName(t, x.nameRaw));
    used.add(di);
    const pos = dataStart + file.directory[di]!.offset;
    if (t.header.priorCrc !== prior) problems.push({ where: `${t.name || '?'} priorCrc`, expected: prior, actual: t.header.priorCrc });
    const hcrc = tdbChecksum(bytes, pos + 4, pos + 36);
    if (t.header.headerCrc !== hcrc) problems.push({ where: `${t.name || '?'} headerCrc`, expected: hcrc, actual: t.header.headerCrc });
    const bodyStart = pos + TABLE_HEADER_SIZE;
    const bodyEnd = bodyStart + t.fieldDefsRaw.length + t.data.length + t.index.length;
    prior = tdbChecksum(bytes, bodyStart, bodyEnd);
  }
  const eof = dv.getUint32(file.header.dbSize - EOF_CRC_SIZE, le);
  if (eof !== prior) problems.push({ where: 'eof crc', expected: prior, actual: eof });
  return problems;
}
