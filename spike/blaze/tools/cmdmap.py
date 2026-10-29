import struct, sys, json, re
from capstone import Cs, CS_ARCH_PPC, CS_MODE_32, CS_MODE_BIG_ENDIAN
# usage: cmdmap.py EBOOT.elf tdf-classes.json namespace_filter out.json
# For each TDF class: find its constructor (stores the vtable address), the nested classes constructed at member offsets,
# and the callers of the constructor with nearby `li rX, N` immediates (candidate RPC command ids).
data = open(sys.argv[1], 'rb').read()
meta = json.load(open(sys.argv[2]))
classes = meta['classes']; vt_index = {int(k, 16): v for k, v in meta['vtables'].items()}
flt = sys.argv[3]; out_path = sys.argv[4]
e_phoff = struct.unpack('>Q', data[0x20:0x28])[0]; n = struct.unpack('>H', data[0x38:0x3a])[0]
segs = []
for i in range(n):
    o = e_phoff + i * 56
    t, f, off, va, pa, fsz, msz, al = struct.unpack('>IIQQQQQQ', data[o:o+56])
    if t == 1 and fsz: segs.append((va, fsz, off))
va0, sz0, off0 = segs[0]; code = data[off0:off0 + sz0]
def w_at(va): return struct.unpack('>I', code[va - va0: va - va0 + 4])[0]
md = Cs(CS_ARCH_PPC, CS_MODE_32 | CS_MODE_BIG_ENDIAN)
# index: lis/addic materialisations of every vtable address -> code sites
vt_sites = {}
want = set(vt_index)
for i in range(0, len(code) - 4, 4):
    w = struct.unpack('>I', code[i:i+4])[0]
    if (w >> 26) == 15 and ((w >> 16) & 31) == 0:
        rd = (w >> 21) & 31; hi = (w & 0xffff) << 16
        for k in range(4, 24, 4):
            w2 = struct.unpack('>I', code[i+k:i+k+4])[0]; op = w2 >> 26
            if op in (14, 12) and ((w2 >> 16) & 31) == rd:
                imm = w2 & 0xffff; imm -= 0x10000 if imm >= 0x8000 else 0
                addr = (hi + imm) & 0xffffffff
                if addr in want: vt_sites.setdefault(addr, []).append(va0 + i)
                break
            if op == 24 and ((w2 >> 21) & 31) == rd:
                addr = hi | (w2 & 0xffff)
                if addr in want: vt_sites.setdefault(addr, []).append(va0 + i)
                break
def func_start(va):
    a = va
    while a > va0 + 8:
        w = w_at(a - 4)
        if w == 0x4e800020 or ((w >> 26) == 18 and not (w & 1) and not (w & 2) and (w & 0x3fffffc) and (a - 4 + ((w & 0x3fffffc) - (0x4000000 if w & 0x2000000 else 0))) >= 0x1400000): return a
        a -= 4
    return a
# callers index: bl target -> sites
bl_sites = {}
for i in range(0, len(code) - 4, 4):
    w = struct.unpack('>I', code[i:i+4])[0]
    if (w >> 26) == 18 and (w & 1) and not (w & 2):
        off = (w & 0x3fffffc); off -= 0x4000000 if w & 0x2000000 else 0
        bl_sites.setdefault(va0 + i + off, []).append(va0 + i)
def disasm(start, length):
    return list(md.disasm(code[start - va0: start - va0 + length], start))
ctor_cache = {}
def ctor_of(vt):
    """function that stores the vtable address into 0(this)"""
    if vt in ctor_cache: return ctor_cache[vt]
    res = None
    for site in vt_sites.get(vt, []):
        fs = func_start(site)
        regs = {}
        for ins in disasm(fs, 0x400):
            if ins.mnemonic == 'lis':
                rd, imm = ins.op_str.split(', '); regs[rd] = (int(imm, 0) & 0xffff) << 16
            elif ins.mnemonic in ('addic', 'addi', 'ori') and ', ' in ins.op_str:
                rd, ra, imm = ins.op_str.split(', ')
                if ra in regs: regs[rd] = (regs[ra] + int(imm, 0)) & 0xffffffff
            elif ins.mnemonic == 'stw' and '(' in ins.op_str:
                rs, rest = ins.op_str.split(', ')
                if regs.get(rs) == vt and rest.startswith('0('): res = fs; break
            elif ins.mnemonic == 'blr': break
        if res: break
    ctor_cache[vt] = res
    return res
result = {}
for full, c in classes.items():
    if flt not in full: continue
    vt = int(c['vtable'], 16); ctor = ctor_of(vt)
    entry = {'ctor': hex(ctor) if ctor else None, 'nested': {}, 'callers': []}
    if ctor:
        # nested member constructors: addic r3, rThis, OFF ; bl F  where F stores a vtable
        regs = {}; this_reg = None
        for ins in disasm(ctor, 0x600):
            if ins.mnemonic in ('ori', 'mr') and re.fullmatch(r'r(\d+), r3, 0', ins.op_str): this_reg = ins.op_str.split(',')[0]
            if ins.mnemonic in ('addic', 'addi') and this_reg and ins.op_str.startswith(f'r3, {this_reg}, '):
                off = int(ins.op_str.split(', ')[2], 0); regs['pending'] = off
            elif ins.mnemonic == 'bl' and 'pending' in regs:
                tgt = int(ins.op_str, 0); off = regs.pop('pending')
                # which vtable does tgt store?
                for vt2, sites in vt_sites.items():
                    if any(func_start(s) == tgt for s in sites[:4]):
                        entry['nested'][hex(off)] = vt_index[vt2]; break
            elif ins.mnemonic == 'blr': break
        for site in bl_sites.get(ctor, [])[:12]:
            fs = func_start(site); ids = []
            for ins in disasm(fs, site - fs + 4):
                if ins.mnemonic == 'li':
                    v = int(ins.op_str.split(', ')[1], 0)
                    if 0 < v < 1100: ids.append(v)
            entry['callers'].append({'site': hex(site), 'li': ids[-6:]})
    result[full] = entry
json.dump(result, open(out_path, 'w'), indent=1)
for full in sorted(result):
    e = result[full]
    nested = ', '.join(f"{k}={v.split('::')[-1]}" for k, v in e['nested'].items())
    callers = ' | '.join(f"{c['site']}:{c['li']}" for c in e['callers'][:4])
    print(f"{full.split('::')[-1]}: ctor={e['ctor']} nested[{nested}] callers {callers}")
