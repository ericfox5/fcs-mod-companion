import struct, sys
from capstone import Cs, CS_ARCH_PPC, CS_MODE_32, CS_MODE_BIG_ENDIAN
# usage: coderef.py EBOOT.elf (str:<string>|addr:<hex>) [before_bytes after_bytes]
# Finds code sites that materialise the address (lis/addi|ori pairs) and disassembles around them with string notes.
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
def cstr(va, n=60):
    o = va2off(va)
    if o is None: return None
    e = data.find(b'\0', o, o + n)
    s = data[o:e] if e != -1 else None
    return s.decode() if s and len(s) >= 2 and all(32 <= c < 127 for c in s) else None
va0, sz0, off0 = segs[0]; code = data[off0:off0 + sz0]
def find_imm(target, limit=8):
    hi, lo = target >> 16, target & 0xffff; out = []
    for i in range(0, len(code) - 4, 4):
        w = struct.unpack('>I', code[i:i+4])[0]
        if (w >> 26) == 15 and ((w >> 16) & 31) == 0 and (w & 0xffff) in (hi, (hi + 1) & 0xffff):
            rd = (w >> 21) & 31
            for k in range(4, 48, 4):
                w2 = struct.unpack('>I', code[i+k:i+k+4])[0]; op = w2 >> 26
                if op in (14, 12) and ((w2 >> 16) & 31) == rd:
                    imm = w2 & 0xffff; imm -= 0x10000 if imm >= 0x8000 else 0
                    if ((((w & 0xffff) << 16) + imm) & 0xffffffff) == target: out.append(va0 + i + k); break
                if op == 24 and ((w2 >> 21) & 31) == rd and (w2 & 0xffff) == lo and (w & 0xffff) == hi: out.append(va0 + i + k); break
            if len(out) >= limit: break
    return out
md = Cs(CS_ARCH_PPC, CS_MODE_32 | CS_MODE_BIG_ENDIAN)
def dis(start, end):
    o = va2off(start); regs = {}
    for ins in md.disasm(data[o:o + (end - start)], start):
        note = ''; m = ins.mnemonic; ops = ins.op_str
        try:
            if m == 'lis':
                rd, imm = ops.split(', '); regs[rd] = (int(imm, 0) & 0xffff) << 16
            elif m in ('addi', 'addic', 'ori') and ', ' in ops:
                rd, ra, imm = ops.split(', '); imm = int(imm, 0)
                if ra in regs:
                    addr = (regs[ra] + (imm if m != 'ori' else imm & 0xffff)) & 0xffffffff
                    s = cstr(addr); regs[rd] = addr
                    if s: note = f'  ; "{s}" @{addr:#x}'
                    elif va2off(addr) is not None: note = f'  ; @{addr:#x} = {struct.unpack(">I", data[va2off(addr):va2off(addr)+4])[0]:#010x}'
            elif m in ('lwz', 'ld', 'stw') and '(' in ops:
                rd, rest = ops.split(', '); disp, base = rest[:-1].split('(')
                if base in regs:
                    addr = (regs[base] + int(disp, 0)) & 0xffffffff; oo = va2off(addr)
                    if oo is not None:
                        v = struct.unpack('>I', data[oo:oo+4])[0]; s = cstr(v)
                        note = f'  ; [{addr:#x}]={v:#x}' + (f' "{s}"' if s else '')
            elif m == 'li':
                rd, imm = ops.split(', '); regs.pop(rd, None)
        except Exception:
            pass
        print(f'{ins.address:08x}  {m:<8} {ops}{note}')
what = sys.argv[2]; before = int(sys.argv[3], 16) if len(sys.argv) > 3 else 0x40; after = int(sys.argv[4], 16) if len(sys.argv) > 4 else 0x80
if what.startswith('str:'):
    name = what[4:].encode(); idx = data.find(b'\0' + name + b'\0')
    targets = []
    while idx != -1:
        targets.append(off2va(idx + 1)); idx = data.find(b'\0' + name + b'\0', idx + 1)
else:
    targets = [int(what[5:], 16)]
for t in targets:
    sites = find_imm(t)
    print(f'##### target {t:#x}: {len(sites)} code site(s) {[hex(s) for s in sites]}')
    for s in sites[:3]:
        print(f'--- around {s:#x}')
        dis((s - before) & ~3, s + after)
