import struct, sys, json, re
from capstone import Cs, CS_ARCH_PPC, CS_MODE_32, CS_MODE_BIG_ENDIAN
# usage: apimap.py EBOOT.elf tdf-classes.json dod-cmdmap.json api_start api_end job_vt_lo job_vt_hi
# Scan the client API functions: each builds an RpcJob (vtable in [job_vt_lo, job_vt_hi)) and passes a command id.
data = open(sys.argv[1], 'rb').read()
meta = json.load(open(sys.argv[2])); cmdmap = json.load(open(sys.argv[3]))
ctor_to_class = {int(v['ctor'], 16): k.split('::')[-1] for k, v in cmdmap.items() if v['ctor']}
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
md = Cs(CS_ARCH_PPC, CS_MODE_32 | CS_MODE_BIG_ENDIAN)
api_s, api_e, vt_lo, vt_hi = (int(x, 16) for x in sys.argv[4:8])
# response factory map: OPD -> class (factories live in 0x144c800-0x1453800, identified by the ctor they call)
fac_s, fac_e = 0x144c800, 0x1453800
fins = list(md.disasm(code[fac_s - va0:fac_e - va0], fac_s))
fac_class = {}; cur = None
for x in fins:
    if x.mnemonic == 'mflr': cur = x.address
    elif x.mnemonic == 'bl' and cur is not None:
        t = int(x.op_str, 0)
        if t in ctor_to_class and cur not in fac_class: fac_class[cur] = ctor_to_class[t]
opd_class = {}
for v, sz, o in segs[1:]:
    seg = data[o:o + sz]
    for i in range(0, len(seg) - 8, 4):
        c, t = struct.unpack('>II', seg[i:i+8])
        if c in fac_class and t == 0x1c75050: opd_class[v + i] = fac_class[c]
def job_response(vt):
    for k in range(0, 0x60, 4):
        w = u32(vt + k)
        if w in opd_class and opd_class[w] != 'DynastyOnDemandError': return opd_class[w]
    for k in range(0, 0x60, 4):
        w = u32(vt + k)
        if w in opd_class: return opd_class[w]
    return None
ins = list(md.disasm(code[api_s - va0:api_e - va0], api_s))
funcs = []; cur = None
for x in ins:
    if x.mnemonic == 'mflr':
        cur = {'start': x.address, 'li': [], 'vt': [], 'req': [], 'regs': {}}; funcs.append(cur)
    if cur is None: continue
    if x.mnemonic == 'li':
        v = int(x.op_str.split(', ')[1], 0)
        if 0 < v < 1100: cur['li'].append(v)
    elif x.mnemonic == 'lis':
        rd, imm = x.op_str.split(', '); cur['regs'][rd] = (int(imm, 0) & 0xffff) << 16
    elif x.mnemonic in ('addic', 'addi', 'ori') and ', ' in x.op_str:
        rd, ra, imm = x.op_str.split(', ')
        if ra in cur['regs']:
            a = (cur['regs'][ra] + int(imm, 0)) & 0xffffffff; cur['regs'][rd] = a
            if vt_lo <= a < vt_hi: cur['vt'].append(a)
    elif x.mnemonic == 'bl':
        t = int(x.op_str, 0)
        if t in ctor_to_class: cur['req'].append(ctor_to_class[t])
rows = []
for f in funcs:
    if not f['vt']: continue
    resp = [job_response(v) for v in dict.fromkeys(f['vt'])]
    rows.append((f['start'], f['li'], f['req'], resp))
for start, li, req, resp in rows:
    print(f"{start:#x}: li={li[:8]} request={req} response={resp}")
