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
