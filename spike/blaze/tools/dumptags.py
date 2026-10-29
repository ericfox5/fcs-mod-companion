import struct, sys
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
def cstr(va, n=40):
    o = va2off(va)
    if o is None: return None
    e = data.find(b'\0', o, o + n)
    s = data[o:e] if e != -1 else None
    return s.decode() if s and len(s) >= 2 and all(32 <= c < 127 for c in s) else None
def dectag(v):
    if v & 0xff: return None
    cs = [(v >> 26) & 63, (v >> 20) & 63, (v >> 14) & 63, (v >> 8) & 63]
    if cs[0] == 0: return None
    s = ''.join(chr(c + 32) if c else ' ' for c in cs)
    return s if all(ch.isalnum() or ch in ' _' for ch in s) else None
start, end = int(sys.argv[2], 16), int(sys.argv[3], 16)
o = va2off(start)
for va in range(start, end, 16):
    ws = struct.unpack('>IIII', data[o + (va - start): o + (va - start) + 16])
    cells = []
    for w in ws:
        t = dectag(w); s = cstr(w) if 0x10000 <= w < 0x1cc0000 else None
        cells.append(f'{w:08x}' + (f'={t!r}' if t else (f'->"{s}"' if s else '')).ljust(22))
    print(f'{va:08x} ' + ' '.join(cells))
