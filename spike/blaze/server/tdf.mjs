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

// Hostile input: a length or element count is checked against the bytes that are actually left (every element takes
// at least one byte), so a 20-byte packet cannot ask for a billion list items; varints stop at 64 bits and nesting is
// capped. A caller can tighten two more caps per message (blaze.mjs does, by command): maxElements = most items in
// one list or map, maxNodes = most values decoded in the whole message. Exceeding either throws.
const MAX_DEPTH = 48;
export const DEFAULT_DECODE_LIMITS = Object.freeze({ maxElements: 1000000, maxNodes: 8000000 });
export class Reader {
  constructor(buf, { maxElements = DEFAULT_DECODE_LIMITS.maxElements, maxNodes = DEFAULT_DECODE_LIMITS.maxNodes } = {}) {
    this.buf = buf; this.pos = 0; this.depth = 0; this.nodes = 0; this.maxElements = maxElements; this.maxNodes = maxNodes;
  }
  count() {
    const n = Number(this.varint());
    if (!Number.isSafeInteger(n) || n < 0 || n > this.remaining) throw new Error('tdf: bad element count');
    if (n > this.maxElements) throw new Error(`tdf: a list of ${n} items is over the limit of ${this.maxElements}`);
    return n;
  }
  get remaining() { return this.buf.length - this.pos; }
  u8() { if (this.pos >= this.buf.length) throw new Error('tdf: unexpected end'); return this.buf[this.pos++]; }
  // 6 bits in the first byte, 7 in each that follows. Up to seven bytes (48 bits) is plain number arithmetic: nearly
  // every integer on the wire. Only a longer one goes through BigInt, and comes back as a BigInt when it does not fit
  // a double exactly (as before).
  varint() {
    let b = this.u8();
    const neg = (b & 0x40) !== 0;
    let v = b & 0x3f, mul = 64, bytes = 1;
    while ((b & 0x80) && bytes < 7) { b = this.u8(); v += (b & 0x7f) * mul; mul *= 128; bytes++; }
    if (!(b & 0x80)) return neg && v !== 0 ? -v : v;
    let big = BigInt(v), shift = 48n;
    while (b & 0x80) { if (shift > 62n) throw new Error('tdf: varint too long'); b = this.u8(); big |= BigInt(b & 0x7f) << shift; shift += 7n; }
    const n = neg ? -big : big;
    return n >= -(2n ** 53n) && n <= 2n ** 53n ? Number(n) : n;
  }
  bytes(n) { if (!Number.isSafeInteger(n) || n < 0 || this.pos + n > this.buf.length) throw new Error('tdf: unexpected end'); const s = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return s; }
  value(type) {
    if (++this.nodes > this.maxNodes) throw new Error(`tdf: more than ${this.maxNodes} values in one message`);
    switch (type) {
      case T.INT: case T.TIME: return this.varint();
      case T.STRING: { const n = Number(this.varint()); const s = this.bytes(n); return Buffer.from(s.subarray(0, Math.max(0, n - 1))).toString('utf8'); }
      case T.BLOB: { const n = Number(this.varint()); return '0x' + Buffer.from(this.bytes(n)).toString('hex'); }
      case T.STRUCT: return this.struct();
      case T.LIST: { const et = this.u8(); const n = this.count(); const out = []; for (let i = 0; i < n; i++) out.push(this.value(et)); return { $list: TYPE_NAMES[et] ?? et, items: out }; }
      case T.MAP: { const kt = this.u8(); const vt = this.u8(); const n = this.count(); const out = []; for (let i = 0; i < n; i++) { const k = this.value(kt); const v = this.value(vt); out.push([k, v]); } return { $map: `${TYPE_NAMES[kt]}->${TYPE_NAMES[vt]}`, entries: out }; }
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
    if (++this.depth > MAX_DEPTH) throw new Error('tdf: nested too deep');
    try { return this.structBody(); } finally { this.depth--; }
  }
  structBody() {
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

// limits: { maxElements, maxNodes } (see Reader); omitted = the generous defaults.
export function decode(buf, limits) {
  const r = new Reader(buf, limits);
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
    if (typeof n === 'number' && Number.isInteger(n) && n > -0x80000000 && n < 0x80000000) { // the usual case, without BigInt
      let u = n < 0 ? -n : n; const sign = n < 0 ? 0x40 : 0;
      if (u < 0x40) { this.parts.push(Buffer.from([u | sign])); return; }
      const out = [(u & 0x3f) | 0x80 | sign]; u >>>= 6;
      while (u >= 0x80) { out.push((u & 0x7f) | 0x80); u >>>= 7; }
      out.push(u); this.parts.push(Buffer.from(out)); return;
    }
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
