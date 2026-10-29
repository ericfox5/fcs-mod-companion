// Minimal EA Blaze 3 "TDF" codec (decode everything we can, encode the handful of types a stub server needs).
// Wire format per public reimplementations (PocketRelay, Frostbite-3, BlazeSDK): tagged fields = 3-byte tag + 1-byte type.
export const T = { INT: 0, STRING: 1, BLOB: 2, STRUCT: 3, LIST: 4, MAP: 5, UNION: 6, VARIABLE: 7, INTLIST: 7, OBJTYPE: 8, OBJID: 9, FLOAT: 10, TIME: 11, GENERIC: 12 };
const TYPE_NAMES = ['int', 'string', 'blob', 'struct', 'list', 'map', 'union', 'intlist', 'objtype', 'objid', 'float', 'time', 'generic'];

export function encodeTag(tag) {
  const t = tag.toUpperCase().padEnd(4, ' ');
  let v = 0;
  v |= ((t.charCodeAt(0) - 32) & 0x3f) << 26;
  v |= ((t.charCodeAt(1) - 32) & 0x3f) << 20;
  v |= ((t.charCodeAt(2) - 32) & 0x3f) << 14;
  v |= ((t.charCodeAt(3) - 32) & 0x3f) << 8;
  v >>>= 0;
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff];
}

export function decodeTag(b0, b1, b2) {
  const v = ((b0 << 24) | (b1 << 16) | (b2 << 8)) >>> 0;
  const chars = [(v >>> 26) & 0x3f, (v >>> 20) & 0x3f, (v >>> 14) & 0x3f, (v >>> 8) & 0x3f];
  return chars.map((c) => (c === 0 ? '' : String.fromCharCode(c + 32))).join('');
}

export class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  get remaining() { return this.buf.length - this.pos; }
  u8() { if (this.pos >= this.buf.length) throw new Error('tdf: unexpected end'); return this.buf[this.pos++]; }
  varint() {
    let b = this.u8();
    let v = BigInt(b & 0x3f);
    const neg = (b & 0x40) !== 0;
    let shift = 6n;
    while (b & 0x80) { b = this.u8(); v |= BigInt(b & 0x7f) << shift; shift += 7n; }
    const n = neg ? -v : v;
    return n >= -(2n ** 53n) && n <= 2n ** 53n ? Number(n) : n;
  }
  bytes(n) { if (this.pos + n > this.buf.length) throw new Error('tdf: unexpected end'); const s = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return s; }
  value(type) {
    switch (type) {
      case T.INT: case T.TIME: return this.varint();
      case T.STRING: { const n = Number(this.varint()); const s = this.bytes(n); return Buffer.from(s.subarray(0, Math.max(0, n - 1))).toString('utf8'); }
      case T.BLOB: { const n = Number(this.varint()); return '0x' + Buffer.from(this.bytes(n)).toString('hex'); }
      case T.STRUCT: return this.struct();
      case T.LIST: { const et = this.u8(); const n = Number(this.varint()); const out = []; for (let i = 0; i < n; i++) out.push(this.value(et)); return { $list: TYPE_NAMES[et] ?? et, items: out }; }
      case T.MAP: { const kt = this.u8(); const vt = this.u8(); const n = Number(this.varint()); const out = []; for (let i = 0; i < n; i++) { const k = this.value(kt); const v = this.value(vt); out.push([k, v]); } return { $map: `${TYPE_NAMES[kt]}->${TYPE_NAMES[vt]}`, entries: out }; }
      case T.UNION: { const d = this.u8(); if (d === 0x7f) return { $union: null }; const f = this.field(); return { $union: d, ...f }; }
      case T.VARIABLE: { const present = this.u8(); if (!present) return { $variable: null }; const objType = { component: this.varint(), type: this.varint() }; const v = this.struct(); return { $variable: objType, ...v }; }
      case T.OBJTYPE: return { component: this.varint(), type: this.varint() };
      case T.OBJID: return { component: this.varint(), type: this.varint(), id: this.varint() };
      case T.FLOAT: { const b = this.bytes(4); return Buffer.from(b).readFloatBE(0); }
      default: throw new Error(`tdf: unsupported type ${type} at ${this.pos - 1}`);
    }
  }
  field() {
    const b0 = this.u8(), b1 = this.u8(), b2 = this.u8();
    const type = this.u8();
    const tag = decodeTag(b0, b1, b2);
    return { [tag]: this.value(type) };
  }
  struct() {
    const out = {};
    if (this.buf[this.pos] === 0x02) { this.pos++; out.$obj = true; }
    while (this.pos < this.buf.length) {
      const b = this.buf[this.pos];
      if (b === 0x00) { this.pos++; return out; }
      Object.assign(out, this.field());
    }
    return out;
  }
}

export function decode(buf) {
  const r = new Reader(buf);
  const out = {};
  while (r.remaining > 0) {
    const b = r.buf[r.pos];
    if (b === 0x00) { r.pos++; continue; }
    Object.assign(out, r.field());
  }
  return out;
}

export class Writer {
  constructor() { this.parts = []; }
  push(...bytes) { this.parts.push(Buffer.from(bytes)); }
  raw(buf) { this.parts.push(Buffer.from(buf)); }
  varint(n) {
    let v = BigInt(n);
    let first = 0;
    if (v < 0n) { v = -v; first = 0x40; }
    if (v < 0x40n) { this.push(Number(v) | first); return; }
    this.push(Number(v & 0x3fn) | 0x80 | first); v >>= 6n;
    while (v >= 0x80n) { this.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
    this.push(Number(v));
  }
  string(s) { const b = Buffer.from(s, 'utf8'); this.varint(b.length + 1); this.raw(b); this.push(0); }
  tag(tag, type) { const t = encodeTag(tag); this.push(t[0], t[1], t[2], type); }
  int(tag, n) { this.tag(tag, T.INT); this.varint(n); }
  str(tag, s) { this.tag(tag, T.STRING); this.string(s); }
  blob(tag, buf) { this.tag(tag, T.BLOB); this.varint(buf.length); this.raw(buf); }
  struct(tag, fn) { this.tag(tag, T.STRUCT); fn(this); this.push(0); }
  // list of a single element type; fn(writer, item) writes the untagged element
  list(tag, elemType, items, fn) { this.tag(tag, T.LIST); this.push(elemType); this.varint(items.length); for (const it of items) fn(this, it); }
  stringList(tag, items) { this.list(tag, T.STRING, items, (w, s) => w.string(s)); }
  intList(tag, items) { this.list(tag, T.INT, items, (w, n) => w.varint(n)); }
  // map<string,string>
  stringMap(tag, obj) { this.tag(tag, T.MAP); this.push(T.STRING, T.STRING); const e = Object.entries(obj); this.varint(e.length); for (const [k, v] of e) { this.string(k); this.string(v); } }
  // generic map: fk/fv write untagged key/value
  map(tag, kt, vt, entries, fk, fv) { this.tag(tag, T.MAP); this.push(kt, vt); this.varint(entries.length); for (const [k, v] of entries) { fk(this, k); fv(this, v); } }
  intMap(tag, entries) { this.map(tag, T.INT, T.INT, entries, (w, k) => w.varint(k), (w, v) => w.varint(v)); }
  // empty "variable" (generic) member: present flag 0
  emptyVariable(tag) { this.tag(tag, T.VARIABLE ?? 7); this.push(0); }
  // union with no active member
  unionUnset(tag) { this.tag(tag, T.UNION); this.push(0x7f); }
  // union with active member index and a tagged struct member
  unionStruct(tag, member, memberTag, fn) { this.tag(tag, T.UNION); this.push(member); this.struct(memberTag, fn); }
  objtype(tag, component, type) { this.tag(tag, T.OBJTYPE); this.varint(component); this.varint(type); }
  objid(tag, component, type, id) { this.tag(tag, T.OBJID); this.varint(component); this.varint(type); this.varint(id); }
  bytes() { return Buffer.concat(this.parts); }
}

export function ipToInt(ip) { return ip.split('.').reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0); }
