#!/usr/bin/env python3
# "FCS mod: long snapper recruiting fix": stop players at position 24 (LS) from corrupting the heap in the
# recruiting passes.
#
# The FCS mod uses PPOS 24 (long snapper) as a primary position; stock NCAA 14 never does. Four recruiting passes
# (Play Time 0x4b6328, roster needs 0x4810a0, 0x4c3e38, 0x500348) build per-team, per-position-group player lists
# through 0x47e6f4: 126 teams x 17 position groups of list heads, filled by 0x50dec0 / 0x50e068, which map each
# player's PPOS to a group with a virtual call and insert through 0x50de60. The insert bounds the node pool but not
# the group: heads[team][group] is written unchecked, and the group returned for an LS is outside 0..16, so every LS
# writes a node pointer somewhere past the head array. Usually it lands on something harmless; on 2026-11-07 a
# Youngstown State LS (PGID 6734, row 5961) landed on a heap allocator record (RPCS3 dump: the allocator's pointer
# held "1a 4e 4b 03" = PGID 6734, OVR 75, year 3, i.e. his node), and freeing the lists crashed "generating recruits".
#
# The fix rewrites the 24-word leaf 0x50de60 in place: a `cmplwi r5,17; bgelr` group check up front, the pool check
# kept, the redundant `clrldi r9,r10,32` dropped (the node address is used from r10 directly) and the heads table
# loaded once. Same registers clobbered, same callers (only 0x50e030 and 0x50e264; both containers have 17 groups:
# li r5,0x11 at 0x47e7d4 / 0x47e89c), result unused by both. Players outside the 17 groups are simply left out of
# those lists, which the readers (0x47d968, 0x47d62c: group < obj+8 checks) already treat as "no players".
#
# Usage: python ls-group-patch.py [--elf PATH] [--yml OUT.yml] [--words OUT.json]
import json, struct, sys
from capstone import Cs, CS_ARCH_PPC, CS_MODE_32, CS_MODE_BIG_ENDIAN

def opt(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv): return sys.argv[i + 1]
    return default

ELF = opt('--elf', 'C:/Users/efoxo/OneDrive/Desktop/football-sim-project/spike/blaze/private/EBOOT.elf')
FN = 0x50de60
GROUPS = 17
VA0 = 0x10000
d = open(ELF, 'rb').read()
def word(a): return struct.unpack('>I', d[a - VA0:a - VA0 + 4])[0]

ORIGINAL = [
    0x81230004,  # lwz r9,4(r3)           a (teams)
    0x8143000c,  # lwz r10,0xc(r3)        c (nodes per team)
    0x7d4951d6,  # mullw r10,r9,r10       pool size
    0x8123001c,  # lwz r9,0x1c(r3)        used
    0x7c095040,  # cmplw r9,r10
    0x40800048,  # bge +0x48 (blr)        pool full
    0x552a1838,  # slwi r10,r9,3
    0x81630018,  # lwz r11,0x18(r3)       pool
    0x31290001,  # addic r9,r9,1
    0x7d4b5014,  # addc r10,r11,r10       node
    0x548413ba,  # rlwinm r4,r4,2,14,29   team * 4 (16-bit team index)
    0x54a5103a,  # slwi r5,r5,2           group * 4
    0x9123001c,  # stw r9,0x1c(r3)
    0x79490020,  # clrldi r9,r10,32
    0xb0c90004,  # sth r6,4(r9)           PGID
    0x98e90006,  # stb r7,6(r9)           OVR
    0x99090007,  # stb r8,7(r9)           year
    0x80630010,  # lwz r3,0x10(r3)        heads by team
    0x7cc3202e,  # lwzx r6,r3,r4
    0x7cc6282e,  # lwzx r6,r6,r5          old head
    0x90c90000,  # stw r6,0(r9)           node.next
    0x7c63202e,  # lwzx r3,r3,r4
    0x7d23292e,  # stwx r9,r3,r5          head = node  (unchecked group)
    0x4e800020,  # blr
]
PATCHED = [
    0x28050000 | GROUPS,  # cmplwi r5,17
    0x4c800020,           # bgelr                  group outside 0..16: leave the player out
    ORIGINAL[0], ORIGINAL[1], ORIGINAL[2], ORIGINAL[3], ORIGINAL[4],
    0x4c800020,           # bgelr                  pool full
    ORIGINAL[6], ORIGINAL[7], ORIGINAL[8], ORIGINAL[9], ORIGINAL[10], ORIGINAL[11], ORIGINAL[12],
    0xb0ca0004,           # sth r6,4(r10)
    0x98ea0006,           # stb r7,6(r10)
    0x990a0007,           # stb r8,7(r10)
    0x80630010,           # lwz r3,0x10(r3)
    0x7c63202e,           # lwzx r3,r3,r4          heads of this team
    0x7cc3282e,           # lwzx r6,r3,r5          old head
    0x90ca0000,           # stw r6,0(r10)          node.next
    0x7d43292e,           # stwx r10,r3,r5         head = node
    0x4e800020,           # blr
]
assert len(PATCHED) == len(ORIGINAL) == 24
for k, w in enumerate(ORIGINAL):
    a = FN + 4 * k
    if word(a) != w: raise SystemExit(f'{a:#x}: expected {w:#010x}, found {word(a):#010x}')
assert word(FN + 4 * 24) == 0x7c0802a6, 'the next function starts right after the blr'
# both containers that feed this insert have 17 groups, and only the two populate routines call it
assert word(0x47e7d4) == 0x38a00011 and word(0x47e89c) == 0x38a00011, 'li r5,0x11 in both container setups'
words = [(FN + 4 * k, o, n) for k, (o, n) in enumerate(zip(ORIGINAL, PATCHED)) if o != n]

md = Cs(CS_ARCH_PPC, CS_MODE_32 | CS_MODE_BIG_ENDIAN)
def show(a, w):
    got = list(md.disasm(struct.pack('>I', w), a))
    return f'{got[0].mnemonic} {got[0].op_str}' if got else f'.long {w:#010x}'
for k in range(24):
    a = FN + 4 * k
    print(f'  {a:08x}  {show(a, ORIGINAL[k]):<28} -> {show(a, PATCHED[k])}')
print(f'{len(words)} words change')
yml = opt('--yml'); wj = opt('--words')
if wj: open(wj, 'w').write(json.dumps([{'va': f'{a:#x}', 'old': f'{o:#010x}', 'new': f'{n:#010x}'} for a, o, n in words], indent=0))
if yml:
    y = ['  "FCS mod: long snapper recruiting fix":', '    Games:', '      "NCAA Football 14":', '        BLUS31159: [ 01.00, 01.02 ]', '    Author: "football-sim-project"',
         '    Notes: "The FCS mod lists long snappers as position 24, which the recruiting passes (Play Time, roster needs and two more) cannot place in their 17 position groups; the list insert at 0x50de60 then writes a pointer outside its array and can corrupt the heap (seen as a freeze at generating recruits when a dynasty starts). Rewrites that insert in place with a group check, so such players are left out of those lists. Independent of the roster-size entries. Generated by spike/blaze/tools/ls-group-patch.py."',
         '    Patch Version: 1.0', '    Patch:']
    for a, _, n in words: y.append(f'      - [ be32, 0x{a:08x}, 0x{n:08x} ]')
    open(yml, 'w', encoding='utf8').write('\n'.join(y) + '\n')
    print(f'yml: {yml} ({len(words)} words)')
