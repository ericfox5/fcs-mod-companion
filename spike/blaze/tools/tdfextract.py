import struct, sys, json, re
# Extract Blaze TDF class definitions from the NCAA 14 EBOOT (PPC64 ABI: vtable slots point to OPD {code, toc} pairs).
# A TDF class vtable has: slot 6 -> getClassName, slot 7 -> getFullClassName, slot 10 -> getMemberInfo table.
data = open(sys.argv[1], 'rb').read()
out_path = sys.argv[2]
e_phoff = struct.unpack('>Q', data[0x20:0x28])[0]; n = struct.unpack('>H', data[0x38:0x3a])[0]
segs = []
for i in range(n):
    o = e_phoff + i * 56
    t, f, off, va, pa, fsz, msz, al = struct.unpack('>IIQQQQQQ', data[o:o+56])
    if t == 1 and fsz: segs.append((va, fsz, off))
def va2off(va):
    for v, sz, o in segs:
        if v <= va < v + sz: return o + (va - v)
def u32(va):
    o = va2off(va); return struct.unpack('>I', data[o:o+4])[0] if o is not None else None
def cstr(va, n=120):
    o = va2off(va)
    if o is None: return None
    e = data.find(b'\0', o, o + n)
    s = data[o:e] if e != -1 else None
    return s.decode() if s and len(s) >= 2 and all(32 <= c < 127 for c in s) else None
def dectag(v):
    if v is None or v & 0xff: return None
    cs = [(v >> 26) & 63, (v >> 20) & 63, (v >> 14) & 63, (v >> 8) & 63]
    if cs[0] == 0: return None
    s = ''.join(chr(c + 32) if c else ' ' for c in cs)
    return s if re.fullmatch(r'[A-Z0-9_][A-Z0-9_ ]{3}', s) else None
va0, sz0, off0 = segs[0]; code = data[off0:off0 + sz0]
const_fn = {}
for i in range(0, len(code) - 12, 4):
    w0, w1, w2 = struct.unpack('>III', code[i:i+12])
    if (w0 >> 26) == 15 and ((w0 >> 21) & 31) == 3 and ((w0 >> 16) & 31) == 0 and w2 == 0x4e800020 and (w1 >> 26) in (14, 12) and ((w1 >> 21) & 31) == 3 and ((w1 >> 16) & 31) == 3:
        imm = w1 & 0xffff; imm -= 0x10000 if imm >= 0x8000 else 0
        const_fn[va0 + i] = (((w0 & 0xffff) << 16) + imm) & 0xffffffff
# OPD entries: {code, toc} pairs in non-text segments
opd = {}
for v, sz, o in segs[1:]:
    seg = data[o:o + sz]
    for i in range(0, len(seg) - 8, 4):
        c, t = struct.unpack('>II', seg[i:i+8])
        if va0 <= c < va0 + sz0 and t == 0x1c75050: opd[v + i] = c
print('const fns', len(const_fn), 'opd entries', len(opd))
def opd_const(w):
    c = opd.get(w)
    return const_fn.get(c) if c is not None else None
EXTRA = {0x04: 2, 0x08: 0, 0x03: 2, 0x0d: 2, 0x16: 2, 0x17: 2, 0x18: 2}
# 0x0b/0x0c (object type/id) carry no default words; 0x0e (bool8) and 0x1b (64-bit entity/blaze id) carry one (seen in the Locker tables).
TYPE_NAMES = {0x00: 'map', 0x01: 'list', 0x02: 'variable', 0x03: 'enum', 0x04: 'string', 0x05: 'float', 0x06: 'union', 0x07: 'objtype', 0x08: 'blob', 0x09: 'objid', 0x0a: 'struct', 0x0b: 'objtype', 0x0c: 'objid', 0x0d: 'time', 0x0e: 'bool8', 0x0f: 'bool', 0x10: 'int8', 0x11: 'uint8', 0x12: 'int16', 0x13: 'uint16', 0x14: 'int32', 0x15: 'uint32', 0x16: 'int64', 0x17: 'uint64', 0x18: 'uint64b', 0x1b: 'int64id'}
def parse_table(va):
    members = []; prev = -1
    while True:
        tag = dectag(u32(va))
        if not tag: break
        info = u32(va + 4)
        typ, flags, offset = info >> 24, (info >> 16) & 0xff, info & 0xffff
        if typ > 0x1b or offset >= 0x4000: break
        if u32(va) <= prev: break
        prev = u32(va)
        extra = 2 if (typ == 0x04 or typ in (0x03, 0x0d, 0x16, 0x17, 0x18) or (flags & 0x10)) else (0 if typ in (0x08, 0x0b, 0x0c) else 1)
        words = [u32(va + 8 + 4 * k) for k in range(extra)]
        m = {'tag': tag.strip(), 'type': TYPE_NAMES.get(typ, f'0x{typ:02x}'), 'tcode': typ, 'flags': flags, 'offset': offset}
        if typ == 0x04 and extra == 2: m['maxlen'] = words[1]
        elif extra: m['default'] = words[-1] if extra == 1 else (words[0] << 32 | words[1])
        members.append(m)
        va += 8 + 4 * extra
        if len(members) > 120: break
    return members
classes = {}; vt_index = {}
for v, sz, o in segs:
    seg = data[o:o + sz]
    for i in range(0, len(seg) - 20, 4):
        w = struct.unpack('>I', seg[i:i+4])[0]
        if w not in opd: continue
        name = const_fn.get(opd[w]); name = cstr(name) if name else None
        if not name or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name): continue
        w1 = struct.unpack('>I', seg[i+4:i+8])[0]
        full = opd_const(w1); full = cstr(full) if full else None
        if not full or '::' not in full or not full.endswith(name): continue
        w4 = struct.unpack('>I', seg[i+16:i+20])[0]
        tv = opd_const(w4)
        members = parse_table(tv) if tv and dectag(u32(tv)) else []
        base = v + i - 24
        classes[full] = {'name': name, 'vtable': hex(base), 'table': hex(tv) if tv else None, 'members': members}
        vt_index[hex(base)] = full
print('classes', len(classes))
json.dump({'classes': classes, 'vtables': vt_index}, open(out_path, 'w'), indent=1)
for full in sorted(classes):
    if not sys.argv[3:] or any(s in full for s in sys.argv[3:]):
        c = classes[full]
        print(f"{full}: " + ', '.join(f"{m['tag']}:{m['type']}@{m['offset']:x}" + (f"[{m['maxlen']}]" if 'maxlen' in m else '') for m in c['members']))
