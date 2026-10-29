import struct, sys, json, re
from capstone import Cs, CS_ARCH_PPC, CS_MODE_32, CS_MODE_BIG_ENDIAN
# usage: cmdswitch.py EBOOT.elf tdf-classes.json start_hex end_hex
# Finds cmpwi/beq switches in [start,end) whose case bodies construct TDF objects; prints case id -> class name.
data = open(sys.argv[1], 'rb').read()
meta = json.load(open(sys.argv[2]))
vt_index = {int(k, 16): v for k, v in meta['vtables'].items()}
e_phoff = struct.unpack('>Q', data[0x20:0x28])[0]; n = struct.unpack('>H', data[0x38:0x3a])[0]
segs = []
for i in range(n):
    o = e_phoff + i * 56
    t, f, off, va, pa, fsz, msz, al = struct.unpack('>IIQQQQQQ', data[o:o+56])
    if t == 1 and fsz: segs.append((va, fsz, off))
def va2off(va):
    for v, sz, o in segs:
        if v <= va < v + sz: return o + (va - v)
def cstr(va, n=64):
    o = va2off(va)
    if o is None: return None
    e = data.find(b'\0', o, o + n); s = data[o:e] if e != -1 else None
    return s.decode() if s and all(32 <= c < 127 for c in s) else None
md = Cs(CS_ARCH_PPC, CS_MODE_32 | CS_MODE_BIG_ENDIAN)
def disasm(start, length):
    o = va2off(start); return list(md.disasm(data[o:o + length], start))
def vtables_in(fn, depth=0):
    """rodata vtable addresses materialised (lis/addic) in the first 80 instructions of fn, following one level of calls"""
    found = []; regs = {}
    for ins in disasm(fn, 320):
        if ins.mnemonic == 'lis':
            rd, imm = ins.op_str.split(', '); regs[rd] = (int(imm, 0) & 0xffff) << 16
        elif ins.mnemonic in ('addic', 'addi', 'ori') and ', ' in ins.op_str:
            rd, ra, imm = ins.op_str.split(', ')
            if ra in regs:
                addr = (regs[ra] + int(imm, 0)) & 0xffffffff
                if addr in vt_index: found.append(vt_index[addr])
                regs[rd] = addr
        elif ins.mnemonic == 'bl' and depth < 1:
            tgt = int(ins.op_str, 0)
            found += vtables_in(tgt, depth + 1)
        elif ins.mnemonic == 'blr': break
    return found
start, end = int(sys.argv[3], 16), int(sys.argv[4], 16)
ins = disasm(start, end - start)
# collect switch cases
cases = []
for k, x in enumerate(ins):
    if x.mnemonic == 'cmpwi' and x.op_str.startswith('r3,') and k + 1 < len(ins) and ins[k+1].mnemonic == 'beq':
        cases.append((int(x.op_str.split(', ')[1], 0), int(ins[k+1].op_str.strip(), 0), x.address))
print('cases', len(cases))
# group into switches by proximity of the cmpwi addresses
groups = []; cur = []
for c in sorted(cases, key=lambda c: c[2]):
    if cur and c[2] - cur[-1][2] > 0x40: groups.append(cur); cur = []
    cur.append(c)
if cur: groups.append(cur)
addr_to_ins = {x.address: i for i, x in enumerate(ins)}
for g in groups:
    if len(g) < 5: continue
    print(f'=== switch with {len(g)} cases, cmpwi at {g[0][2]:#x}..{g[-1][2]:#x}')
    for cid, tgt, _ in sorted(g):
        names = []; strs = []
        i = addr_to_ins.get(tgt)
        if i is None: print(f'  {cid:5d} -> {tgt:#x} (outside range)'); continue
        regs = {}
        for x in ins[i:i+24]:
            if x.mnemonic == 'lis':
                rd, imm = x.op_str.split(', '); regs[rd] = (int(imm, 0) & 0xffff) << 16
            elif x.mnemonic in ('addic', 'addi') and ', ' in x.op_str:
                rd, ra, imm = x.op_str.split(', ')
                if ra in regs:
                    a = (regs[ra] + int(imm, 0)) & 0xffffffff; regs[rd] = a
                    if a in vt_index: names.append(vt_index[a])
                    s = cstr(a)
                    if s: strs.append(s)
            elif x.mnemonic == 'bl':
                names += vtables_in(int(x.op_str, 0))
            elif x.mnemonic in ('b', 'blr'): break
        uniq = list(dict.fromkeys(names))
        print(f'  {cid:5d} -> ' + (', '.join(uniq) if uniq else '') + (f'  str={strs[:2]}' if strs and not uniq else ''))
