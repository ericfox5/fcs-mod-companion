import { readBits, writeBits, toSigned, fromSigned } from './bits.js';
import { FieldType, type TdbFieldDef, type TdbTableHeader, storedRecordCount, hasExtraData } from './format.js';

export type FieldValue = number | string;

const latin1 = new TextDecoder('latin1');
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => { const clean = h.replace(/^0x/, ''); const out = new Uint8Array(clean.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16); return out; };
const latin1Bytes = (s: string) => Uint8Array.from(s, (c) => { const code = c.charCodeAt(0); if (code > 255) throw new RangeError(`non-latin1 character ${JSON.stringify(c)}`); return code; });

export class TdbTable {
  readonly fieldMap: Map<string, TdbFieldDef>;

  constructor(
    public name: string,
    public nameRaw: Uint8Array,
    public header: TdbTableHeader,
    public fields: TdbFieldDef[],
    // raw field-definition bytes (numFields * 0x10) kept for exact round trips
    public fieldDefsRaw: Uint8Array,
    // record storage (and, for allocType 34/66, trailing extra data)
    public data: Uint8Array,
    public index: Uint8Array,
  ) {
    this.fieldMap = new Map(fields.map((f) => [f.name, f]));
  }

  get recordCount(): number {
    return this.header.currentRecords;
  }

  get storedRecords(): number {
    return storedRecordCount(this.header);
  }

  field(name: string): TdbFieldDef {
    const f = this.fieldMap.get(name);
    if (!f) throw new Error(`table ${this.name}: no field ${name}`);
    return f;
  }

  private recordStart(i: number): number {
    if (i < 0 || i >= this.storedRecords) throw new RangeError(`table ${this.name}: record ${i} out of range (${this.storedRecords} stored)`);
    return i * this.header.lengthBytes;
  }

  // Raw unsigned bits of a numeric field (no sign interpretation).
  raw(i: number, name: string): number {
    const f = this.field(name);
    const start = this.recordStart(i);
    if (f.type === FieldType.String || f.type === FieldType.Binary) throw new Error(`table ${this.name}: ${name} is not numeric`);
    return readBits(this.data, start * 8 + f.bitOffset, f.bits);
  }

  get(i: number, name: string): FieldValue {
    const f = this.field(name);
    const start = this.recordStart(i);
    switch (f.type) {
      case FieldType.String: {
        const byteStart = start + f.bitOffset / 8;
        const bytes = this.data.subarray(byteStart, byteStart + f.bits / 8);
        const nul = bytes.indexOf(0);
        return latin1.decode(nul === -1 ? bytes : bytes.subarray(0, nul));
      }
      case FieldType.Binary: {
        const byteStart = start + f.bitOffset / 8;
        return '0x' + toHex(this.data.subarray(byteStart, byteStart + f.bits / 8));
      }
      case FieldType.SInt:
        return toSigned(readBits(this.data, start * 8 + f.bitOffset, f.bits), f.bits);
      case FieldType.VarChar1:
      case FieldType.VarChar2:
        if (!hasExtraData(this.header)) return readBits(this.data, start * 8 + f.bitOffset, f.bits);
        throw new Error(`table ${this.name}: varchar field ${name} (extra-data tables) not supported yet`);
      default:
        return readBits(this.data, start * 8 + f.bitOffset, f.bits);
    }
  }

  set(i: number, name: string, value: FieldValue): void {
    const f = this.field(name);
    const start = this.recordStart(i);
    switch (f.type) {
      case FieldType.String: {
        if (typeof value !== 'string') throw new TypeError(`table ${this.name}: ${name} expects a string`);
        const max = f.bits / 8;
        const bytes = latin1Bytes(value);
        if (bytes.length > max) throw new RangeError(`table ${this.name}: ${name} is limited to ${max} bytes (got ${bytes.length})`);
        const byteStart = start + f.bitOffset / 8;
        this.data.fill(0, byteStart, byteStart + max);
        this.data.set(bytes, byteStart);
        return;
      }
      case FieldType.Binary: {
        if (typeof value !== 'string') throw new TypeError(`table ${this.name}: ${name} expects a hex string`);
        const bytes = fromHex(value);
        if (bytes.length !== f.bits / 8) throw new RangeError(`table ${this.name}: ${name} expects ${f.bits / 8} bytes`);
        this.data.set(bytes, start + f.bitOffset / 8);
        return;
      }
      case FieldType.SInt: {
        if (typeof value !== 'number') throw new TypeError(`table ${this.name}: ${name} expects a number`);
        writeBits(this.data, start * 8 + f.bitOffset, f.bits, fromSigned(value, f.bits));
        return;
      }
      default: {
        if (typeof value !== 'number') throw new TypeError(`table ${this.name}: ${name} expects a number`);
        writeBits(this.data, start * 8 + f.bitOffset, f.bits, value);
      }
    }
  }

  // All fields of record i as a plain object.
  row(i: number): Record<string, FieldValue> {
    const out: Record<string, FieldValue> = {};
    for (const f of this.fields) out[f.name] = this.get(i, f.name);
    return out;
  }

  // Populated records only (0..currentRecords).
  *rows(): IterableIterator<Record<string, FieldValue>> {
    for (let i = 0; i < this.header.currentRecords; i++) yield this.row(i);
  }

  // Remove a record: the last populated record moves into its slot (record order is not meaningful to the game's
  // keyed lookups; tables with an index are refused). Grow-on-demand storage shrinks with the count.
  removeRecord(i: number): void {
    const h = this.header;
    if (i < 0 || i >= h.currentRecords) throw new RangeError(`table ${this.name}: record ${i} out of range (${h.currentRecords} populated)`);
    // index entries are 16-byte definitions ({4CC, 0x0101, field no, 1}), not per-record data, so they survive a removal
    if (hasExtraData(h)) throw new Error(`table ${this.name}: removing records from extra-data tables not supported`);
    const L = h.lengthBytes, lastIdx = h.currentRecords - 1;
    if (i !== lastIdx) this.data.copyWithin(i * L, lastIdx * L, (lastIdx + 1) * L);
    this.data.fill(0, lastIdx * L, (lastIdx + 1) * L);
    h.currentRecords = lastIdx;
    if (this.storedRecords !== h.maxRecords) this.data = this.data.slice(0, lastIdx * L);
  }

  // Raise the capacity. Fixed-allocation tables (2/6/10/14) store every slot on disk, so their storage is extended with
  // zeroed records; grow-on-demand tables only change the header. The allocation type is left as it is. Index entries
  // are 16-byte definitions ({field name, flags, field number, 1}: the console's PLAY carries PGID and TGID, TEAM carries
  // TGID), not per-row data, so they are kept as they are. Extra-data tables are refused (layout not understood).
  growTable(newMaxRecords: number): void {
    const h = this.header;
    if (!Number.isInteger(newMaxRecords) || newMaxRecords < h.maxRecords) throw new RangeError(`table ${this.name}: cannot shrink maxRecords ${h.maxRecords} to ${newMaxRecords}`);
    if (newMaxRecords > 0xffff) throw new RangeError(`table ${this.name}: maxRecords is a 16-bit field (${newMaxRecords})`);
    if (hasExtraData(h)) throw new Error(`table ${this.name}: growing extra-data tables not supported`);
    if (newMaxRecords === h.maxRecords) return;
    if (this.storedRecords === h.maxRecords) {
      const grown = new Uint8Array(newMaxRecords * h.lengthBytes);
      grown.set(this.data);
      this.data = grown;
    }
    h.maxRecords = newMaxRecords;
  }

  // Append a record and return its index. Fixed-allocation tables need a free slot; grow-on-demand
  // tables get their storage extended and the "written" flag set, as the game does (BTES 26 -> 30).
  appendRecord(values: Record<string, FieldValue> = {}): number {
    const h = this.header;
    if (h.currentRecords >= h.maxRecords) throw new RangeError(`table ${this.name}: full (${h.maxRecords} max records)`);
    const idx = h.currentRecords;
    if (this.storedRecords === h.maxRecords) {
      this.data.fill(0, idx * h.lengthBytes, (idx + 1) * h.lengthBytes);
    } else {
      if (hasExtraData(h)) throw new Error(`table ${this.name}: appending to extra-data tables not supported`);
      const grown = new Uint8Array(this.data.length + h.lengthBytes);
      grown.set(this.data);
      this.data = grown;
      h.allocType |= 4;
    }
    h.currentRecords = idx + 1;
    for (const [k, v] of Object.entries(values)) this.set(idx, k, v);
    return idx;
  }
}
