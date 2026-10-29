import struct, sys, json, re
from capstone import Cs, CS_ARCH_PPC, CS_MODE_32, CS_MODE_BIG_ENDIAN
# usage: cmdtable.py EBOOT.elf tdf-classes.json dod-cmdmap.json factory_start factory_end
# 1. find "IncomingTDF" factory functions in [start,end) and map them to the TDF class they construct
# 2. find OPD entries for those factories and the data tables that point at them (the component command table)
data = open(sys.argv[1], 'rb').read()
meta = json.load(open(sys.argv[2])); cmdmap = json.load(open(sys.argv[3]))
classes = meta['classes']
ctor_to_class = {int(v['ctor'], 16): k for k, v in cmdmap.items() if v['ctor']}
# also ctors of non-DOD classes: derive from vtables generically (store vtable at 0(this)) is expensive; use cmdmap only
e_phoff = struct.unpack('>Q', data[0x20:0x28])[0]; n = struct.unpack('>H', data[0x38:0x3a])[0]
segs = []
for i in range(n):
    o = e_phoff + i * 56
    t, f, off, va, pa, fsz, msz, al = struct.unpack('>IIQQQQQQ', data[o:o+56])
    if t == 1 and fsz: segs.append((va, fsz, off))
va0, sz0, off0 = segs[0]; code = data[off0:off0 + sz0]
def va2off(va):
    for v, sz, o in segs:
        if v <= va < v + sz: return o + (va - v)
def u32(va):
    o = va2off(va); return struct.unpack('>I', data[o:o+4])[0] if o is not None else None
def cstr(va, n=64):
    o = va2off(va)
    if o is None: return None
    e = data.find(b'\0', o, o + n); s = data[o:e] if e != -1 else None
    return s.decode() if s and all(32 <= c < 127 for c in s) else None
md = Cs(CS_ARCH_PPC, CS_MODE_32 | CS_MODE_BIG_ENDIAN)
start, end = int(sys.argv[4], 16), int(sys.argv[5], 16)
ins = list(md.disasm(code[start - va0:end - va0], start))
# split into functions at 'mflr r0' boundaries
factories = {}
cur_start = None; cur_bl = []
for k, x in enumerate(ins):
    if x.mnemonic == 'mflr':
        if cur_start is not None and cur_bl: factories[cur_start] = cur_bl
        cur_start = x.address; cur_bl = []
    elif x.mnemonic == 'bl' and cur_start is not None:
        cur_bl.append(int(x.op_str, 0))
if cur_start is not None and cur_bl: factories[cur_start] = cur_bl
fac_class = {}
for fs, bls in factories.items():
    for t in bls:
        if t in ctor_to_class: fac_class[fs] = ctor_to_class[t]; break
print('factory functions mapped:', len(fac_class))
# OPD entries for factories
opd_of = {}
for v, sz, o in segs[1:]:
    seg = data[o:o + sz]
    for i in range(0, len(seg) - 8, 4):
        c, t = struct.unpack('>II', seg[i:i+8])
        if c in fac_class and t == 0x1c75050: opd_of[v + i] = c
print('opd entries:', len(opd_of))
# data words pointing at those OPD entries
refs = {}
for v, sz, o in segs:
    seg = data[o:o + sz]
    for i in range(0, len(seg) - 4, 4):
        w = struct.unpack('>I', seg[i:i+4])[0]
        if w in opd_of: refs[v + i] = w
print('references:', len(refs))
addrs = sorted(refs)
if addrs:
    lo, hi = addrs[0] - 0x60, addrs[-1] + 0x40
    print(f'table region {lo:#x}-{hi:#x}')
    for va in range(lo, hi, 4):
        w = u32(va)
        if w is None: continue
        note = ''
        if w in opd_of: note = ' -> ' + fac_class[opd_of[w]].split('::')[-1] + ' factory'
        else:
            s = cstr(w) if w > 0x10000 else None
            if s: note = f' "{s}"'
        if note or (0 < w < 2000): print(f'  {va:08x}: {w:08x}{note}')
