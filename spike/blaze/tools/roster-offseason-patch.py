#!/usr/bin/env python3
# "FCS mod: 100-player rosters (offseason)": the dynasty passes that were sized for 126 teams x 70 = 8,820 players.
# With 90-man rosters a league holds ~11,300 players; stock code never sees more than 8,820 because 126 x 70 caps it.
#
#   1. Training Players (0x4934c8) snapshots every player before progression with
#      "insert into RCTN * select * from PLAY where PTYP != 3"; RCTN holds 8,820 rows (dynasty files keep that size),
#      the copy fails when it fills, and the failure path (0x493828) skips training and zeroes the progression
#      fields: nobody would progress. The query is replaced by a call to the game's own grow-then-copy helper
#      0x3046e4(dest 'NTCR', src 'YALP') (count both, resize dest to the sum with 0xa56dbc, then "insert into dest *
#      select * from src", in the current database = the dynasty), and the error check becomes `cmpw r3,r3`. RCTN is
#      only read back by PGID for the old overall (0x2239d8, 0x223f24), so the PTYP != 3 rows the stock filter skipped
#      are harmless extras (dynasty files hold no PTYP 3 players).
#   2. Graduation (0x4835a8, "Commencing Graduation Ceremonies") creates the temporary one-column table TMLE (the PGID
#      field of PLAY) with 8,820 rows at 0x48368c; it becomes 13,000.
#   3. The recruiting passes' player lists (0x47e6f4 -> 0x47e468(126 teams, 17 groups, 70 per team)) hold 126 x 70 =
#      8,820 nodes and silently skip everyone after that; 70 -> 100 at 0x47e7d8 gives 12,600 (the pool is allocated
#      from these numbers and the insert is bounded by them; nothing indexes it per team).
#
# Usage: python roster-offseason-patch.py [--elf PATH] [--yml OUT.yml] [--words OUT.json]
import json, struct, sys
from capstone import Cs, CS_ARCH_PPC, CS_MODE_32, CS_MODE_BIG_ENDIAN

def opt(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv): return sys.argv[i + 1]
    return default

ELF = opt('--elf', 'C:/Users/efoxo/OneDrive/Desktop/football-sim-project/spike/blaze/private/EBOOT.elf')
VA0 = 0x10000
d = open(ELF, 'rb').read()
def word(a): return struct.unpack('>I', d[a - VA0:a - VA0 + 4])[0]
def branch(at, target, link=False):
    delta = target - at
    assert -0x2000000 <= delta <= 0x1fffffc
    return (0x48000000 | (delta & 0x3fffffc) | int(link)) & 0xffffffff
GROW_COPY = 0x3046e4
NOP = 0x60000000

# the helper is what the header says it is
assert word(GROW_COPY) == 0x7c0802a6
assert word(GROW_COPY + 0x10) == 0x7c9f2378 or word(GROW_COPY + 0x10) == 0x609f0000, 'mr r31,r4 (source)'
assert word(GROW_COPY + 0x14) == 0x607e0000, 'mr r30,r3 (destination)'
assert word(0x304768) == branch(0x304768, 0xa56dbc, True), 'helper resizes the destination'

words = []
def put(a, old, new, why):
    if word(a) != old: raise SystemExit(f'{a:#x}: expected {old:#010x}, found {word(a):#010x} ({why})')
    words.append((a, old, new, why))

# 1. Training Players snapshot
TRAIN = [
    (0x49353c, 0x3cc00177, 0x3c604e54, "lis r3,'NT'         (was lis r6: query text)"),
    (0x493540, 0x38600000, 0x60634352, "ori r3,r3,'CR'      dest RCTN"),
    (0x493544, 0x30c62e58, 0x3c805941, "lis r4,'YA'"),
    (0x493548, 0x38800000, 0x60844c50, "ori r4,r4,'LP'      src PLAY"),
    (0x49354c, 0x38a00000, branch(0x49354c, GROW_COPY, True), 'bl 0x3046e4 grow RCTN, copy PLAY'),
    (0x493550, 0x38e00003, NOP, 'nop (was li r7,3: PTYP filter)'),
    (0x493554, branch(0x493554, 0xa691b0, True), NOP, 'nop (was the query call)'),
    (0x493558, 0x2c030000, 0x7c031800, 'cmpw r3,r3: no error branch'),
]
for a, old, new, why in TRAIN: put(a, old, new, why)
assert word(0x49355c) >> 26 == 16, 'bne to the failure path follows'
# 2. Graduation temp table
put(0x48368c, 0x38c02274, 0x38c032c8, 'li r6,13000: TMLE rows (was 8,820)')
assert word(0x483688) == 0x60844d54 and word(0x483694) == branch(0x483694, 0xa57ce0, True), 'TMLE creation call'
# 3. Recruiting player lists
put(0x47e7d8, 0x38c00046, 0x38c00064, 'li r6,100: per-team nodes for the player lists (126 x 100)')
assert word(0x47e7d0) == 0x3880007e and word(0x47e7dc) == branch(0x47e7dc, 0x47e468, True), 'player-list container setup'

md = Cs(CS_ARCH_PPC, CS_MODE_32 | CS_MODE_BIG_ENDIAN)
def show(a, w):
    got = list(md.disasm(struct.pack('>I', w), a))
    return f'{got[0].mnemonic} {got[0].op_str}' if got else f'.long {w:#010x}'
for a, o, n, why in words: print(f'  {a:08x}  {show(a, o):<26} -> {show(a, n):<26} {why}')
yml = opt('--yml'); wj = opt('--words')
if wj: open(wj, 'w').write(json.dumps([{'va': f'{a:#x}', 'old': f'{o:#010x}', 'new': f'{n:#010x}'} for a, o, n, _ in words], indent=0))
if yml:
    y = ['  "FCS mod: 100-player rosters (offseason)":', '    Games:', '      "NCAA Football 14":', '        BLUS31159: [ 01.00, 01.02 ]', '    Author: "football-sim-project"',
         '    Notes: "Dynasty passes sized for 126 teams x 70 = 8,820 players, which 90-man leagues exceed: Training Players snapshots every player into an 8,820-row table and skipped training when it filled (now the game\'s own grow-then-copy helper 0x3046e4), graduation\'s temporary table goes 8,820 -> 13,000 rows, and the recruiting passes\' player lists 126 x 70 -> 126 x 100. Requires the stride, capacity and player-table entries. Generated by spike/blaze/tools/roster-offseason-patch.py."',
         '    Patch Version: 1.0', '    Patch:']
    for a, _, n, _ in words: y.append(f'      - [ be32, 0x{a:08x}, 0x{n:08x} ]')
    open(yml, 'w', encoding='utf8').write('\n'.join(y) + '\n')
    print(f'yml: {yml} ({len(words)} words)')
