import struct, sys
from capstone import Cs, CS_ARCH_PPC, CS_MODE_32, CS_MODE_BIG_ENDIAN
# usage: ppcdis.py EBOOT.elf start_hex end_hex [start end ...]
data = open(sys.argv[1], 'rb').read()
e_phoff = struct.unpack('>Q', data[0x20:0x28])[0]; n = struct.unpack('>H', data[0x38:0x3a])[0]
segs = []
for i in range(n):
    o = e_phoff + i * 56
    t, f, off, va, pa, fsz, msz, al = struct.unpack('>IIQQQQQQ', data[o:o+56])
    if t == 1 and fsz: segs.append((va, fsz, off))
def off(va):
    for v, sz, o in segs:
        if v <= va < v + sz: return o + (va - v)
    return None
def cstr(va, n=80):
    o = off(va)
    if o is None: return None
    e = data.find(b'\0', o, o + n)
    s = data[o:e if e != -1 else o + n]
    return s if s and all(32 <= c < 127 for c in s) else None
md = Cs(CS_ARCH_PPC, CS_MODE_32 | CS_MODE_BIG_ENDIAN)
md.detail = False
args = sys.argv[2:]
for i in range(0, len(args), 2):
    start, end = int(args[i], 16), int(args[i+1], 16)
    print(f'===== {start:#x}-{end:#x}')
    o = off(start)
    code = data[o:o + (end - start)]
    regs = {}
    for ins in md.disasm(code, start):
        note = ''
        m = ins.mnemonic; ops = ins.op_str
        # track lis/addi for string refs
        try:
            if m == 'lis':
                rd, imm = ops.split(', '); regs[rd] = (int(imm, 0) & 0xffff) << 16
            elif m in ('addi', 'addic', 'ori', 'addis') and ', ' in ops:
                parts = ops.split(', ')
                rd, ra, imm = parts[0], parts[1], int(parts[2], 0)
                if ra in regs:
                    addr = (regs[ra] + (imm if m != 'ori' else imm & 0xffff)) & 0xffffffff
                    s = cstr(addr)
                    if s: note = f'  ; "{s.decode()}" @{addr:#x}'
                    else:
                        oo = off(addr)
                        if oo is not None: note = f'  ; ->{struct.unpack(">I", data[oo:oo+4])[0]:#x} @{addr:#x}'
                    regs[rd] = addr
            elif m in ('lwz', 'ld') and '(' in ops:
                rd, rest = ops.split(', ')
                disp, base = rest[:-1].split('(')
                if base in regs:
                    addr = (regs[base] + int(disp, 0)) & 0xffffffff
                    oo = off(addr)
                    if oo is not None:
                        v = struct.unpack('>I', data[oo:oo+4])[0]
                        s = cstr(v)
                        note = f'  ; [{addr:#x}]={v:#x}' + (f' "{s.decode()}"' if s else '')
        except Exception:
            pass
        print(f'{ins.address:08x}  {m:<8} {ops}{note}')
