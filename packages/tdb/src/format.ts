// On-disk layout of EA Tiburon "DB" (TDB) save databases, as written by NCAA Football 14 (PS3).

export const FILE_HEADER_SIZE = 0x18;
export const DIR_ENTRY_SIZE = 8;
export const TABLE_HEADER_SIZE = 0x28;
export const FIELD_DEF_SIZE = 0x10;
export const INDEX_ENTRY_SIZE = 0x10;
export const EOF_CRC_SIZE = 4;

export const LITTLE_ENDIAN = 0;
export const BIG_ENDIAN = 1;

export const FieldType = {
  String: 0,
  Binary: 1,
  SInt: 2,
  UInt: 3,
  Float: 4,
  VarChar1: 13,
  VarChar2: 14,
} as const;

// Allocation-type flag bits observed in NCAA 14 saves: 2,6,10,14 fixed; 26,30 grow-on-demand; 34,66 extra data.
export const AllocFlag = {
  Base: 2,
  Written: 4,
  Unknown8: 8,
  GrowOnDemand: 16,
  ExtraData: 32,
  Huffman: 64,
} as const;

export interface TdbFileHeader {
  digit: number; // always big-endian u16 ("DB")
  version: number; // always big-endian u16
  endian: number; // 0 little, 1 big
  unknown1: number;
  unknown2: number;
  dbSize: number;
  zero: number;
  numTables: number;
  headerCrc: number; // ~crc32_be(bytes 0..0x14)
}

export interface TdbDirectoryEntry {
  // 4-char table name, or empty when the raw value is not text (unnamed slot)
  name: string;
  // exact 4 bytes stored in the file (kept for byte-identical round trips)
  nameRaw: Uint8Array;
  // offset of the table relative to the end of the directory
  offset: number;
}

export interface TdbTableHeader {
  priorCrc: number; // checksum of the previous table body, or of the directory for the first table
  allocType: number;
  lengthBytes: number; // record length in bytes
  lengthBits: number; // record length in bits
  zero: number;
  maxRecords: number;
  currentRecords: number;
  unknown2: number; // 0x0000FFFF in every observed table
  numFields: number;
  indexCount: number;
  zero2: number;
  zero3: number;
  headerCrc: number; // ~crc32_be(header bytes 4..36)
}

export interface TdbFieldDef {
  type: number;
  bitOffset: number; // bit offset of the field inside a record
  name: string;
  nameRaw: Uint8Array;
  bits: number;
}

// Whether on-disk record storage covers maxRecords (fixed) or currentRecords (grow-on-demand).
export function storedRecordCount(h: TdbTableHeader): number {
  switch (h.allocType) {
    case 2:
    case 6:
    case 10:
    case 14:
      return h.maxRecords;
    default:
      return h.currentRecords;
  }
}

export function hasExtraData(h: TdbTableHeader): boolean {
  return h.allocType === 34 || h.allocType === 66;
}
