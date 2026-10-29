import struct, sys, re
# usage: vtdump.py EBOOT.elf fn_addr_hex [fn_addr_hex ...]
# Finds the vtable(s) holding a function pointer and prints neighbouring entries, resolving constant-return functions.
data = open(sys.argv[1], 'rb').read()
e_phoff = struct.unpack('>Q', data[0x20:0x28])[0]; n = struct.unpack('>H', data[0x38:0x3a])[0]
segs = []
for i in range(n):
    o = e_phoff + i * 56
    t, f, off, va, pa, fsz, msz, al = struct.unpack('>IIQQQQQQ', data[o:o+56])
    if t == 1 and fsz: segs.append((va, fsz, off))
def va2off(va):
    for v, sz, o in segs:
        if v <= va < v + sz: return o + (va - v)
def off2va(o):
    for v, sz, oo in segs:
        if oo <= o < oo + sz: return v + (o - oo)
def u32(va):
    o = va2off(va); return struct.unpack('>I', data[o:o+4])[0] if o is not None else None
def cstr(va, n=96):
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
def const_of(fn):
    o = va2off(fn)
    if o is None: return None
    w0, w1, w2 = struct.unpack('>III', data[o:o+12])
    if (w0 >> 26) == 15 and ((w0 >> 21) & 31) == 3 and ((w0 >> 16) & 31) == 0 and w2 == 0x4e800020 and (w1 >> 26) in (14, 12):
        imm = w1 & 0xffff; imm -= 0x10000 if imm >= 0x8000 else 0
        return (((w0 & 0xffff) << 16) + imm) & 0xffffffff
    if w0 == 0x38600000 and w1 == 0x4e800020: return 'li0'
    if w0 == 0x4e800020: return 'ret'
    return None
va0, sz0, off0 = segs[0]
for fa in sys.argv[2:]:
    fn = int(fa, 16); pat = struct.pack('>I', fn)
    j = data.find(pat); hits = 0
    while j != -1 and hits < 2:
        if j % 4 == 0 and off2va(j) and off2va(j) >= va0 + sz0:
            hits += 1; base = off2va(j)
            print(f'##### {fn:#x} referenced at {base:#x}')
            for k in range(-24, 28):
                va = base + 4 * k; w = u32(va)
                if w is None: continue
                note = ''
                if va0 <= w < va0 + sz0:
                    c = const_of(w)
                    if isinstance(c, int):
                        s = cstr(c); t = dectag(u32(c))
                        note = f' -> {c:#x}' + (f' "{s}"' if s else (f' table[{t.strip()}...]' if t else ''))
                    elif c: note = f' -> {c}'
                    else: note = ' (code)'
                else:
                    s = cstr(w); note = f' "{s}"' if s else ''
                print(f'  [{k:+3d}] {va:08x}: {w:08x}{note}')
        j = data.find(pat, j + 1)
