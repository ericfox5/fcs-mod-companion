# Builds the RPCS3 patch "FCS mod: jersey #0" and prints the be32 lines plus a before/after disassembly check.
# Usage: python jersey-zero-patch.py ../private/EBOOT.elf
#
# Why the game crashes on #0 (RPCS3 log: FGGameSim, VM access violation at 0x1791c4 = return address of strcmp inside
# FindStringIndex 0x179188): the in-game player editor builds its "Jersey Number Name" list from the numbers 1..99 that
# are free on the team plus the player's own number (0x177c84), but counts the entries separately (0x17a3b4) and adds
# one for the player's own number. With own = 0 the builder never reaches 0, the count is one too large, and the lookup
# of "0" reads a pointer past the end of the list. The taken-number mask (0x483b1c) also ignores 0.
# The decal placement code (0x5e2678, 0x5e4fcc) sends n == 0 down the two-digit path while the helmet/material setup
# (0x5f143c, 0x5f651c) treats 0 as a single digit; both now treat 0 as one digit.
import struct, sys
from capstone import Cs, CS_ARCH_PPC, CS_MODE_32, CS_MODE_BIG_ENDIAN

data = bytearray(open(sys.argv[1], 'rb').read())
off = lambda va: va - 0x10000  # PT_LOAD 0 maps file offset 0 to VA 0x10000
word = lambda va: struct.unpack('>I', data[off(va):off(va) + 4])[0]

PATCH = [
    # va,        original,   new,        what
    (0x483bb8, 0x28030001, 0x28030000, 'taken-number mask: cmplwi r3,1 -> cmplwi r3,0 (PJEN 0 sets bit 0)'),
    (0x17a3fc, 0x38a00001, 0x38a00000, 'jersey list count: li r5,1 -> li r5,0 (count 0..99)'),
    (0x177d80, 0x63d80000, 0x3b000000, 'jersey list builder: mr r24,r30 -> li r24,0 (list 0..99)'),
    (0x5e2688, 0x4c460342, 0x4c400042, 'decal placement A: crorc cr0eq,cr1eq,cr0lt -> crnor cr0eq,cr0lt,cr0lt (0 = one digit)'),
    (0x5e5064, 0x4c5a0342, 0x4c400042, 'decal placement B: crorc cr0eq,cr6eq,cr0lt -> crnor cr0eq,cr0lt,cr0lt (0 = one digit)'),
]
for va, orig, new, what in PATCH:
    assert word(va) == orig, f'{va:#x}: expected {orig:#010x}, found {word(va):#010x}'

md = Cs(CS_ARCH_PPC, CS_MODE_32 | CS_MODE_BIG_ENDIAN)
def dis1(va, w):
    got = list(md.disasm(struct.pack('>I', w), va))
    return f'{got[0].mnemonic:<9} {got[0].op_str}' if got else f'.long     {w:#010x}'

for va, orig, new, what in PATCH:
    print(f'--- {va:#x}: {what}')
    for a in range(va - 8, va + 12, 4):
        w = word(a)
        line = f'{a:08x}  {dis1(a, w)}'
        if a == va:
            line += f'   =>  {dis1(a, new)}'
        print(line)
    data[off(va):off(va) + 4] = struct.pack('>I', new)
print()
print('    Patch:')
for va, orig, new, what in PATCH:
    print(f'      - [ be32, 0x{va:08x}, 0x{new:08x} ]')
