import {
  FILE_HEADER_SIZE, DIR_ENTRY_SIZE, TABLE_HEADER_SIZE, FIELD_DEF_SIZE, INDEX_ENTRY_SIZE, EOF_CRC_SIZE,
  BIG_ENDIAN, hasExtraData, storedRecordCount,
  type TdbFileHeader, type TdbDirectoryEntry, type TdbTableHeader, type TdbFieldDef,
} from './format.js';
import { TdbTable } from './table.js';

const latin1 = new TextDecoder('latin1');

export class TdbFile {
  constructor(
    public header: TdbFileHeader,
    public directory: TdbDirectoryEntry[], // directory entries in file order
    public tables: TdbTable[], // tables in file (offset) order
    public eofCrc: number,
    public fileLength: number, // length as read; saves are zero-padded beyond dbSize
  ) {}

  table(name: string): TdbTable {
    const t = this.tables.find((x) => x.name === name);
    if (!t) throw new Error(`no table ${name}`);
    return t;
  }

  hasTable(name: string): boolean {
    return this.tables.some((x) => x.name === name);
  }
}

function decodeName(raw: Uint8Array, endian: number): string {
  const v = endian === BIG_ENDIAN
    ? ((raw[0]! << 24) | (raw[1]! << 16) | (raw[2]! << 8) | raw[3]!) >>> 0
    : ((raw[3]! << 24) | (raw[2]! << 16) | (raw[1]! << 8) | raw[0]!) >>> 0;
  if (v < 65536) return '';
  const s = latin1.decode(raw);
  return endian === BIG_ENDIAN ? [...s].reverse().join('') : s;
}

export function parseTdb(bytes: Uint8Array): TdbFile {
  if (bytes.length < FILE_HEADER_SIZE) throw new Error('not a TDB file: too short');
  if (bytes[0] !== 0x44 || bytes[1] !== 0x42) throw new Error('not a TDB file: missing DB magic');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endian = bytes[4]!;
  const le = endian !== BIG_ENDIAN;
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);

  const header: TdbFileHeader = {
    digit: dv.getUint16(0, false),
    version: dv.getUint16(2, false),
    endian,
    unknown1: bytes[5]!,
    unknown2: u16(6),
    dbSize: u32(8),
    zero: u32(12),
    numTables: u32(16),
    headerCrc: u32(20),
  };
  if (header.dbSize > bytes.length) throw new Error(`TDB dbSize ${header.dbSize} exceeds file length ${bytes.length}`);

  const directory: TdbDirectoryEntry[] = [];
  for (let i = 0; i < header.numTables; i++) {
    const e = FILE_HEADER_SIZE + i * DIR_ENTRY_SIZE;
    const nameRaw = bytes.slice(e, e + 4);
    directory.push({ name: decodeName(nameRaw, endian), nameRaw, offset: u32(e + 4) });
  }

  const dataStart = FILE_HEADER_SIZE + header.numTables * DIR_ENTRY_SIZE;
  const order = directory.map((d, i) => ({ d, i })).sort((a, b) => a.d.offset - b.d.offset);

  const tables: TdbTable[] = [];
  for (let k = 0; k < order.length; k++) {
    const { d } = order[k]!;
    let pos = dataStart + d.offset;
    if (pos + TABLE_HEADER_SIZE > header.dbSize) throw new Error(`table ${d.name} header at ${pos} exceeds dbSize`);
    const th: TdbTableHeader = {
      priorCrc: u32(pos),
      allocType: u32(pos + 4),
      lengthBytes: u32(pos + 8),
      lengthBits: u32(pos + 12),
      zero: u32(pos + 16),
      maxRecords: u16(pos + 20),
      currentRecords: u16(pos + 22),
      unknown2: u32(pos + 24),
      numFields: bytes[pos + 28]!,
      indexCount: bytes[pos + 29]!,
      zero2: u16(pos + 30),
      zero3: u32(pos + 32),
      headerCrc: u32(pos + 36),
    };
    pos += TABLE_HEADER_SIZE;

    const fieldDefsRaw = bytes.slice(pos, pos + th.numFields * FIELD_DEF_SIZE);
    const fields: TdbFieldDef[] = [];
    for (let f = 0; f < th.numFields; f++) {
      const o = pos + f * FIELD_DEF_SIZE;
      const nameRaw = bytes.slice(o + 8, o + 12);
      fields.push({ type: u32(o), bitOffset: u32(o + 4), name: decodeName(nameRaw, endian) || latin1.decode(nameRaw), nameRaw, bits: u32(o + 12) });
    }
    pos += th.numFields * FIELD_DEF_SIZE;

    const next = order[k + 1];
    const expectedEnd = next ? dataStart + next.d.offset : header.dbSize - EOF_CRC_SIZE;
    let dataLen: number;
    if (hasExtraData(th)) dataLen = expectedEnd - pos - th.indexCount * INDEX_ENTRY_SIZE;
    else dataLen = th.lengthBytes * storedRecordCount(th);
    if (dataLen < 0 || pos + dataLen > header.dbSize) throw new Error(`table ${d.name}: data length ${dataLen} at ${pos} exceeds dbSize`);
    const data = bytes.slice(pos, pos + dataLen);
    pos += dataLen;
    const index = bytes.slice(pos, pos + th.indexCount * INDEX_ENTRY_SIZE);
    pos += index.length;
    if (pos !== expectedEnd) throw new Error(`table ${d.name}: ended at ${pos}, expected ${expectedEnd} (allocType ${th.allocType})`);

    tables.push(new TdbTable(d.name, d.nameRaw, th, fields, fieldDefsRaw, data, index));
  }

  const eofCrc = u32(header.dbSize - EOF_CRC_SIZE);
  return new TdbFile(header, directory, tables, eofCrc, bytes.length);
}
