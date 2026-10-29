import struct, sys
# Locate where a Blaze TDF tag (u32) is used: aligned data words and lis/ori|addi immediates in code.
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
def cstr(va, n=48):
    o = va2off(va)
    if o is None: return None
    e = data.find(b'\0', o, o + n)
    s = data[o:e] if e != -1 else None
    return s if s and len(s) >= 2 and all(32 <= c < 127 for c in s) else None
def enc(tag):
    t = tag.ljust(4)
    v = ((ord(t[0]) - 32) & 63) << 26 | ((ord(t[1]) - 32) & 63) << 20 | ((ord(t[2]) - 32) & 63) << 14 | ((ord(t[3]) - 32) & 63) << 8
    return v & 0xffffffff
for tag in sys.argv[2:]:
    v = int(tag, 16) if tag.startswith('0x') else enc(tag)
    print(f'=== {tag} = {v:#010x}')
    pat = struct.pack('>I', v)
    j = data.find(pat); hits = 0
    while j != -1 and hits < 6:
        if j % 4 == 0:
            hits += 1
            print(f' data word at {off2va(j):#x}:', ' '.join(f'{struct.unpack(">I", data[j+k:j+k+4])[0]:08x}' for k in range(-16, 32, 4)))
            for k in range(-16, 32, 4):
                w = struct.unpack('>I', data[j+k:j+k+4])[0]; s = cstr(w)
                if s: print(f'    [{k:+d}] -> "{s.decode()}"')
        j = data.find(pat, j + 1)
    # code: lis rX, hi ; (ori|addi) rY, rX, lo within 8 instructions
    hi, lo = v >> 16, v & 0xffff
    va0, sz0, off0 = segs[0]
    code = data[off0:off0 + sz0]
    found = 0
    for i in range(0, len(code) - 4, 4):
        w = struct.unpack('>I', code[i:i+4])[0]
        if (w >> 26) == 15 and ((w >> 16) & 31) == 0 and (w & 0xffff) == hi:
            rd = (w >> 21) & 31
            for k in range(4, 36, 4):
                w2 = struct.unpack('>I', code[i+k:i+k+4])[0]
                op = w2 >> 26
                if op == 24 and ((w2 >> 21) & 31) == rd and (w2 & 0xffff) == lo: ok = True
                elif op in (14, 12) and ((w2 >> 16) & 31) == rd and ((w2 & 0xffff) + (0x10000 if (w2 & 0xffff) >= 0x8000 and lo >= 0x8000 else 0)) % 0x10000 == lo and lo < 0x8000: ok = True
                else: ok = False
                if ok:
                    print(f' code immediate at {va0 + i:#x} (pair +{k})'); found += 1; break
        if found >= 6: break
