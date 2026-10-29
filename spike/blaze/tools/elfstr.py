import struct, sys
path = sys.argv[1]
data = open(path, 'rb').read()
assert data[:4] == b'\x7fELF'
is64 = data[4] == 2
assert data[5] == 2  # big endian
if is64:
    e_phoff = struct.unpack('>Q', data[0x20:0x28])[0]
    e_phentsize, e_phnum = struct.unpack('>HH', data[0x36:0x3a])
else:
    e_phoff = struct.unpack('>I', data[0x1c:0x20])[0]
    e_phentsize, e_phnum = struct.unpack('>HH', data[0x2a:0x2e])
segs = []
for i in range(e_phnum):
    o = e_phoff + i * e_phentsize
    if is64:
        p_type, p_flags, p_offset, p_vaddr, p_paddr, p_filesz, p_memsz, p_align = struct.unpack('>IIQQQQQQ', data[o:o+56])
    else:
        p_type, p_offset, p_vaddr, p_paddr, p_filesz, p_memsz, p_flags, p_align = struct.unpack('>IIIIIIII', data[o:o+32])
    if p_type == 1:
        segs.append((p_vaddr, p_filesz, p_offset))
def off(va):
    for v, sz, o in segs:
        if v <= va < v + sz: return o + (va - v)
    return None
def cstr(va, n=120):
    o = off(va)
    if o is None: return None
    e = data.find(b'\0', o, o + n)
    return data[o:e if e != -1 else o + n]
def u32(va):
    o = off(va); return struct.unpack('>I', data[o:o+4])[0] if o is not None else None
cmd = sys.argv[2]
if cmd == 'str':
    for a in sys.argv[3:]: print(hex(int(a, 16)), cstr(int(a, 16)))
elif cmd == 'scan':
    # scan code range for lis/addi|addic|ori pairs that form addresses of printable strings
    start, end = int(sys.argv[3], 16), int(sys.argv[4], 16)
    regs = {}
    for va in range(start, end, 4):
        w = u32(va)
        op = w >> 26
        if op == 15 and ((w >> 16) & 31) == 0:  # lis rD, imm
            regs[(w >> 21) & 31] = ((w & 0xffff) << 16)
        elif op in (14, 12, 24):  # addi/addic/ori
            rd, ra = (w >> 21) & 31, (w >> 16) & 31
            if op == 24: rd, ra = ra, rd  # ori rA,rS,imm : stores into rA
            if ra in regs:
                imm = w & 0xffff
                if op in (14, 12) and imm >= 0x8000: imm -= 0x10000
                addr = (regs[ra] + imm) & 0xffffffff
                s = cstr(addr)
                if s and len(s) >= 3 and all(32 <= c < 127 for c in s): print(hex(va), 'r%d' % rd, hex(addr), s)
                elif op != 24: print(hex(va), 'r%d' % rd, hex(addr), 'ptr->', hex(u32(addr)) if off(addr) else '?')
        elif op == 18 or op == 19:  # branch: clear
            pass
elif cmd == 'segs':
    for v, sz, o in segs: print(hex(v), hex(sz), hex(o))
