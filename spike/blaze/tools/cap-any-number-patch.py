# Builds the RPCS3 patch "FCS mod: Create-a-Player any jersey number" and prints the be32 lines plus a before/after
# disassembly check. Usage: python cap-any-number-patch.py ../private/EBOOT.elf [--entry]
#   --entry  also prints the whole yml entry (Games / Author / Notes / Patch Version / Patch) for rpcs3-patches.yml
#
# Who builds the Jersey Number list. Create-a-Player and the in-game player editor are one class, "Create A Player
# Manager" (ctor 0x173e70, vtable 0x18946f0), created by the feature adapter 0x250cbc with a script "featureKey" kind
# kept at this+4. The kind decides how the edit record [0x1c72064] is filled (ctor switch 0x173f90):
#   0  new player, team = 0x4d6fb8()     ("PlyrCreated.%d", has the School field 7)   -> Create-a-Player
#   2  new player, team 0x263            ("ProsCreated.%d", has School)
#   5  new player, team 0x262            ("LgndCreated.%d", "Create New"; no School field)
#   1  existing player loaded by 0x172cc4 with its PGID in rec+0x70             -> the player editor
#   6  existing player loaded by 0x172cc4, then the kind-5 setup (no School field)
#   7, 8 field tables without Jersey Number; 3 / 4 / 9 are the coach and Heisman managers (own count/fill; the
#   Heisman count 0x18475c returns 0 for field 6).
# Kinds 0/2/5 never load a player (the only other loader caller, the template import 0x17d498, passes "keep PGID"),
# kinds 1/6 always do. Field 6 is "Jersey Number" (label table 0x16fcc58: "Select your player's jersey number.").
# Its list is built per field by 0x17d5b8: count = vtable+0x64 (dispatcher 0x17a498 -> 0x17a3b4), malloc count x 4,
# fill = vtable+0x54 (dispatcher 0x178284 -> 0x177c84); the current value is found by vtable+0x48 (0x1791f0, jersey case
# 0x179518) and a pick is stored by 0x17bb4c as strtol(list[index]) into rec+0x78. The lists are freed (0x17183c on a
# School change, 0x171898 in the destructor) with the count recomputed at that moment, so count and fill must agree
# for the life of the manager, not just once.
# Before this patch: kind 5 counted 99 and listed "1".."99" (index n-1, then forced rec+0x78 = 1); every other kind
# took the team's taken-number mask 0x483b1c (TGID = rec+0x58) and listed only free numbers plus the player's own.
# So Create-a-Player (kind 0) offered the School's free numbers only; picking a School re-rolls the number to a free one
# (0x17b60c -> 0x483c5c), which this patch leaves alone.
#
# The patch: a "create" kind (any kind except 1 and 6: test (0x42 >> kind) & 1) gets "0".."99", all 100 numbers,
# unfiltered; kinds 1 and 6 keep the mask path (with "FCS mod: jersey #0" that is 0..99 minus teammates' numbers).
#   count 0x17a3b4: kind test replaces `kind == 5 -> 99`; create -> 100. `this` goes straight to r29 so the old
#                   `mr r29,r31` slot can hold the r30 = 0 the mask path needs.
#   fill  0x177c84: the same kind test sends create kinds into the old kind-5 loop, which now starts at 0, stores
#                   "n" at index n (was n-1) and no longer forces the number to 1.
#   value 0x179518: the kind-5 shortcut (index = number - 1) is skipped; every kind looks its number up by string
#                   (FindStringIndex 0x179188 returns 0 when absent, never past the list).
# Saving: Save 0x17ee90 -> new PGID (0x17ed84, 0x4458cc) -> defaults row (0x17e1b8) -> one UPDATE of every column
# (0x17e778, "update 'YALP' set ... 'NEJP' = ..." at 0x1700528) with PJEN = rec+0x78, then the depth chart (0x49c5d0).
# Nothing on that path calls the mask 0x483b1c or the number picker 0x483c5c (direct call graph, 14 levels), so the
# picked number is written as is. Automatic numbering (0x484508 recruits/transfers, 0x4ea978 team moves via TEAM.JJNM,
# 0x4eac04, 0x4d6374, 0x501bb8) and the Campus Legend picker 0x240f68 ("GetJerseyNumbersAvailableForTeam") are not
# touched. No word overlaps another entry; jersey #0 owns 0x17a3fc / 0x17a404 / 0x177d80 inside the mask paths.
import re, struct, sys, os
from capstone import Cs, CS_ARCH_PPC, CS_MODE_32, CS_MODE_BIG_ENDIAN

ELF = next((a for a in sys.argv[1:] if not a.startswith('--')), None) or os.path.join(os.path.dirname(__file__), '..', 'private', 'EBOOT.elf')
data = bytearray(open(ELF, 'rb').read())
off = lambda va: va - 0x10000  # PT_LOAD 0 maps file offset 0 to VA 0x10000
word = lambda va: struct.unpack('>I', data[off(va):off(va) + 4])[0]

def bc(at, target, bo, bi):
    d = target - at
    assert -0x8000 <= d < 0x8000 and d % 4 == 0
    return (16 << 26) | (bo << 21) | (bi << 16) | (d & 0xfffc)
def b(at, target):
    d = target - at
    assert -0x2000000 <= d < 0x2000000 and d % 4 == 0
    return (18 << 26) | (d & 0x3fffffc)
li = lambda rt, v: (14 << 26) | (rt << 21) | (v & 0xffff)
ori = lambda ra, rs, v: (24 << 26) | (rs << 21) | (ra << 16) | (v & 0xffff)
andi_ = lambda ra, rs, v: (28 << 26) | (rs << 21) | (ra << 16) | (v & 0xffff)
srw = lambda ra, rs, rb: (31 << 26) | (rs << 21) | (ra << 16) | (rb << 11) | (536 << 1)
NOP = 0x60000000
# --edit: the player editor (kinds 1 and 6, which load an existing player) gets the unfiltered list too, so no kind
# keeps the filtered one and the mask is 0. Without it those two kinds keep the filtered list (mask 0x42).
EDIT_TOO = '--edit' in sys.argv
EDIT_KINDS = 0 if EDIT_TOO else (1 << 1) | (1 << 6)
ENTRY_NAME = 'FCS mod: Create-a-Player and Edit Player any jersey number' if EDIT_TOO else 'FCS mod: Create-a-Player any jersey number'
ENTRY_NAMES = ('FCS mod: Create-a-Player any jersey number', 'FCS mod: Create-a-Player and Edit Player any jersey number')

PATCH = [
    # va,        original,   new,                        what
    # -- count 0x17a3b4 (r3 = this; returns the number of Jersey Number entries)
    (0x17a3c4, 0x607f0000, ori(29, 3, 0),             'count: mr r31,r3 -> mr r29,r3 (this straight to r29)'),
    (0x17a3cc, 0x3bc00000, li(30, EDIT_KINDS),        'count: li r30,0 -> li r30,0x42 (bits of kinds 1 and 6)'),
    (0x17a3d0, 0x2c030005, srw(30, 30, 3),            'count: cmpwi r3,5 -> srw r30,r30,r3 (0x42 >> kind)'),
    (0x17a3d4, 0x4082000c, andi_(30, 30, 1),          'count: bne -> andi. r30,r30,1 (eq = create kind)'),
    (0x17a3d8, 0x3bc00063, li(30, 100),               'count: li r30,99 -> li r30,100'),
    (0x17a3dc, 0x480000a4, bc(0x17a3dc, 0x17a480, 12, 2), 'count: b 0x17a480 -> beq 0x17a480 (create: return 100)'),
    (0x17a3e4, 0x63fd0000, li(30, 0),                 'count: mr r29,r31 -> li r30,0 (mask path starts from 0)'),
    # -- fill 0x177c84 (r3 = this, r5 = &array); the kind-5 loop becomes the create loop
    (0x177ca0, 0x2c030005, li(26, EDIT_KINDS),        'fill: cmpwi r3,5 -> li r26,0x42'),
    (0x177cb8, 0x408200a4, srw(26, 26, 3),            'fill: bne 0x177d5c -> srw r26,r26,r3'),
    (0x177cbc, 0x3b402810, andi_(26, 26, 1),          'fill: li r26,0x2810 -> andi. r26,r26,1'),
    (0x177cc0, 0x3c60016e, bc(0x177cc0, 0x177d5c, 4, 2), 'fill: lis r3,0x16e -> bne 0x177d5c (kinds 1/6: mask path)'),
    (0x177cc4, 0x63d90000, li(25, 0),                 'fill: mr r25,r30 -> li r25,0 (first number 0)'),
    (0x177cc8, 0x7f43d0ae, li(26, 0),                 'fill: lbzx r26,r3,r26 -> li r26,0 (the byte it read is 0; snprintf overwrites it)'),
    (0x177d2c, 0x3099ffff, ori(4, 25, 0),             'fill: addi r4,r25,-1 -> mr r4,r25 (number n at index n)'),
    (0x177d54, 0x9bc30078, NOP,                       'fill: stb r30,0x78(r3) -> nop (keep the chosen/default number)'),
    # -- current value 0x1791f0, jersey case
    (0x179520, 0x40820014, b(0x179520, 0x179534),     'value: bne 0x179534 -> b 0x179534 (look the number up by string for every kind)'),
]
# words the new code relies on but leaves as they are
CONTEXT = [
    (0x17a3c8, 0x80630004, 'count: lwz r3,4(r3) (kind)'),
    (0x17a3e0, 0x3c6001c7, 'count: lis r3,0x1c7 (mask path start)'),
    (0x17a3ec, 0x83e32064, 'count: lwz r31,[0x1c72064] (edit record)'),
    (0x17a3f8, 0x48309725, 'count: bl 0x483b1c (taken-number mask)'),
    (0x17a400, 0x807d0004, 'count: lwz r3,4(r29) (kind, for the kind-1 own-number rule)'),
    (0x17a480, 0x63c30000, 'count: mr r3,r30 (return)'),
    (0x177c94, 0x80630004, 'fill: lwz r3,4(r3) (kind)'),
    (0x177cac, 0x3bc00001, 'fill: li r30,1'),
    (0x177d40, 0x28190063, 'fill: cmplwi r25,99 (create loop runs while n <= 99)'),
    (0x177d58, 0x480000d8, 'fill: b 0x177e30 (return)'),
    (0x177d5c, 0x3c6001c7, 'fill: mask path start'),
    (0x179534, 0x3cc0016e, 'value: sprintf/FindStringIndex path'),
    (0x17bb58, 0x7c63d82e, 'set: lwzx r3,r3,r27 (strtol(list[index]) into rec+0x78)'),
    (0x17bb70, 0x98660078, 'set: stb r3,0x78(r6)'),
    (0x17e8e8, 0x8a8b0078, 'save: lbz r20,0x78(rec) -> PJEN in the UPDATE'),
]
JERSEY_ZERO = {0x17a3fc: (0x38a00001, 0x38a00000), 0x17a404: (0x60a40000, 0x38800001), 0x177d80: (0x63d80000, 0x3b000000)}

for va, orig, new, what in PATCH:
    assert word(va) == orig, f'{va:#x}: expected {orig:#010x}, found {word(va):#010x} ({what})'
for va, w, what in CONTEXT:
    assert word(va) == w, f'{va:#x}: expected {w:#010x}, found {word(va):#010x} ({what})'
for va, (orig, j0) in JERSEY_ZERO.items():
    assert word(va) in (orig, j0), f'{va:#x}: neither the original nor the jersey #0 word'
assert not set(va for va, *_ in PATCH) & set(JERSEY_ZERO)
for k in range(10):   # the kind test: create = (0x42 >> kind) & 1 == 0
    assert ((EDIT_KINDS >> k) & 1 == 0) == (EDIT_TOO or k not in (1, 6))

# no address shared with another entry of private/rpcs3-patches.yml
yml = os.path.join(os.path.dirname(ELF), 'rpcs3-patches.yml')
if os.path.exists(yml):
    taken, name = {}, None
    for line in open(yml, encoding='utf8'):
        m = re.match(r'^  "(.+)":\s*$', line)
        if m: name = m.group(1); continue
        m = re.search(r'\[ be32, (0x[0-9a-f]+), (0x[0-9a-f]+) \]', line)
        if m and name not in ENTRY_NAMES: taken[int(m.group(1), 16)] = name
    clash = [(hex(va), taken[va]) for va, *_ in PATCH if va in taken]
    assert not clash, f'addresses written by other entries: {clash}'

md = Cs(CS_ARCH_PPC, CS_MODE_32 | CS_MODE_BIG_ENDIAN)
def dis1(va, w):
    got = list(md.disasm(struct.pack('>I', w), va))
    return f'{got[0].mnemonic:<9} {got[0].op_str}' if got else f'.long     {w:#010x}'

new_words = {va: new for va, _, new, _ in PATCH}
for start, end, title in ((0x17a3c4, 0x17a3fc, 'count 0x17a3b4'), (0x177c94, 0x177cd0, 'fill 0x177c84 (head)'),
                          (0x177d2c, 0x177d5c, 'fill 0x177c84 (loop tail)'), (0x179518, 0x179538, 'value 0x1791f0 (jersey)')):
    print(f'--- {title}')
    for a in range(start, end, 4):
        w = word(a)
        line = f'{a:08x}  {dis1(a, w):<34}'
        if a in new_words: line += f'=>  {dis1(a, new_words[a])}'
        print(line)
print()
for va, orig, new, what in PATCH:
    print(f'{va:08x}  {orig:08x} -> {new:08x}  {what}')
print()
print('    Patch:')
for va, orig, new, what in PATCH:
    print(f'      - [ be32, 0x{va:08x}, 0x{new:08x} ]')

if '--entry' in sys.argv:
    notes = ("Create-a-Player listed only the numbers nobody on the chosen School wears: the Create A Player Manager "
             "(0x173e70) builds its Jersey Number list from the team's taken-number mask (count 0x17a3b4, fill 0x177c84) "
             "for every kind but 5. Kinds that create a player (any but 1 and 6, which load an existing one) now list "
             "0..99 unfiltered (count 100; fill reuses the kind-5 loop from 0 with index n and no forced #1), and the "
             "current value is looked up by string for every kind (0x179520). Save (0x17ee90 -> UPDATE 0x17e778) "
             "already writes rec+0x78 as PJEN unchecked. The player editor (kind 1), automatic numbering and the "
             "Campus Legend picker keep avoiding taken numbers. Generated by spike/blaze/tools/cap-any-number-patch.py.")
    print()
    print(f'  "{ENTRY_NAME}":')
    print('    Games:')
    print('      "NCAA Football 14":')
    print('        BLUS31159: [ 01.00, 01.02 ]')
    print('    Author: "football-sim-project"')
    if EDIT_TOO:
        notes = ("Create-a-Player and the player editor listed only the numbers nobody on the team wears: the Create A "
                 "Player Manager (0x173e70) builds its Jersey Number list from the team's taken-number mask (count "
                 "0x17a3b4, fill 0x177c84) for every kind but 5. Every kind now lists 0..99 unfiltered (count 100; fill "
                 "reuses the kind-5 loop from 0 with index n and no forced #1), the player editor (kinds 1 and 6) "
                 "included, and the current value is looked up by string for every kind (0x179520). Save (0x17ee90 -> "
                 "UPDATE 0x17e778) already writes rec+0x78 as PJEN unchecked. Automatic numbering and the Campus "
                 "Legend picker keep avoiding taken numbers. Replaces 'FCS mod: Create-a-Player any jersey number' "
                 "(same addresses: enable only one). Generated by cap-any-number-patch.py --edit.")
    print(f'    Notes: "{notes}"')
    print('    Patch Version: 1.0')
    print('    Patch:')
    for va, orig, new, what in PATCH:
        print(f'      - [ be32, 0x{va:08x}, 0x{new:08x} ]')
