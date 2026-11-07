#!/usr/bin/env python3
# "FCS mod: 100-player rosters (player table)": let the Rosters screens and a new dynasty hold 13,000 players.
#
# A roster file is loaded as the 'LEAG' database with its own table sizes (the 90-man FCS 2026 file carries 13,000 PLAY
# rows). The Rosters screens and a new dynasty work in their own databases, ROST and DYND, which the game assembles
# from game data (0x43c904 asset load, 0x44768c template tables), indexes, and then fills from LEAG team by team
# (0x4e9984 -> 0x44a6f0). Their PLAY table holds 9,100 rows (130 x 70) and the fill stops silently when it is full, so
# with 100-slot ids every team past physical row 9,100 shows no players.
#
# v1 of this entry resized PLAY inside the template copier 0x447320; in game nothing changed (the patch applied and
# the 1,835,008-byte file was read in full), so PLAY of these databases does not come through that copier. v2 grows
# PLAY in the finished database right before its indexes are built, wherever the table came from:
#
#   0x4f417c  bl 0x4f237c  ->  bl S_ROST   (Rosters builder 0x4f3ff0: create ROST indexes, then copy from LEAG)
#   0x4f5e9c  bl 0x4f4e44  ->  bl S_DYND   (new-dynasty builder 0x4f5d40: PLAY index prep, indexes, copy from LEAG)
#
#   S_xxxx:   lis r3,DB; ori r3,r3,DB; lis r11,CALLEE; ori r11,r11,CALLEE; b A
#   A:        mflr r0; stdu r1,-0x80(r1); std r0,0x90(r1); std r11,0x70(r1)
#             lis r4,0x5941; ori r4,r4,0x4c50; bl 0xa57d68          # table = FindTable(db name, 'YALP' = PLAY)
#             cmpwi r3,0; beq +0x14                                   # no table: skip
#             lhz r4,4(r3); cmplwi r4,ROWS; bge +8                    # already big enough: skip
#             b B.grow; b B.done
#   B.done:   ld r11,0x70(r1); ld r0,0x90(r1); addi r1,r1,0x80; mtlr r0; mtctr r11; bctr   # tail call the original
#   B.grow:   li r4,ROWS; bl 0xa56dbc; b B.done                       # TableResize(table, ROWS)
#
# 0xa57d68(db, table) locks the database list, returns 0 for a missing or read-only database, else the table;
# 0xa56dbc(table, rows) reallocates the record storage and sets the maximum the insert path checks (0xa56f94: slot =
# free list, else +0x4e < +4, else error 0x13 "full"). Both hooked callees take no arguments (they load their own r3)
# and are reached with LR still pointing at the original call site, so their result goes back unchanged.
#
# The code lives in the only four runs of inter-function padding in .text that are provably unused (filler words
# only, a function end before, a prologue after, no branch / data pointer / lis+addi(c)/ori reference into the run):
# 0x13b4b40 (15 words), 0x16367a4 (11), 0x1678cec (5), 0x69a9fc (5). Play Now (EXHI, 0x4f0a64) fills the same way and
# is not covered: there is no padding left for a third stub.
#
# Usage: python roster-table-patch.py [--elf PATH] [--rows 13000] [--yml OUT.yml] [--words OUT.json]
import json, struct, sys
from capstone import Cs, CS_ARCH_PPC, CS_MODE_32, CS_MODE_BIG_ENDIAN

def opt(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv): return sys.argv[i + 1]
    return default

ELF = opt('--elf', 'C:/Users/efoxo/OneDrive/Desktop/football-sim-project/spike/blaze/private/EBOOT.elf')
ROWS = int(opt('--rows', '13000'))
A, B = 0x13b4b40, 0x16367a4                 # common routine
S_ROST, S_DYND = 0x1678cec, 0x69a9fc        # per-database stubs
HOOKS = [  # (call site, original callee, database 4CC as in SQL text, stub)
    (0x4f417c, 0x4f237c, 0x54534f52, S_ROST),   # 'TSOR' = ROST
    (0x4f5e9c, 0x4f4e44, 0x444e5944, S_DYND),   # 'DNYD' = DYND
]
FIND_TABLE = 0xa57d68        # FindTable(dbName, tableName)
RESIZE = 0xa56dbc            # TableResize(table, rows)
NAME_PLAY = 0x59414c50       # 'YALP': PLAY as stored in the table header
TEXT = (0x10230, 0x16d501c)  # .text (section headers of the 1.02 ELF)
FILLERS = (0x48000000, 0x60000000)   # the toolchain pads with "b ." and nop
VA0 = 0x10000
d = open(ELF, 'rb').read()
nw = 0x1bb26e8 // 4
W = struct.unpack('>%dI' % nw, d[:nw * 4])
def word(a): return W[(a - VA0) // 4]
def va(i): return VA0 + 4 * i
def branch(at, target, link=False):
    delta = target - at
    assert at % 4 == 0 and target % 4 == 0 and -0x2000000 <= delta <= 0x1fffffc, f'branch reach {at:#x} -> {target:#x}'
    return (0x48000000 | (delta & 0x3fffffc) | int(link)) & 0xffffffff
def lis(rt, v): return 0x3c000000 | (rt << 21) | (v & 0xffff)
def ori(ra, rs, v): return 0x60000000 | (rs << 21) | (ra << 16) | (v & 0xffff)
if not 0 < ROWS <= 0x7fff: raise SystemExit('rows must fit a signed 16-bit immediate (li)')

# ---- the code we call and the sites we hook still look as documented
for site, callee, _, _ in HOOKS:
    assert word(site) == branch(site, callee, True), f'{site:#x}: expected bl {callee:#x}, found {word(site):#010x}'
    assert word(callee) == 0x7c0802a6, f'{callee:#x}: prologue'
assert word(0x4f238c) == lis(3, 0x1c8), '0x4f237c loads its own r3'
assert word(0x4f4e54) == lis(3, 0x444e), '0x4f4e44 loads its own r3 (DYND)'
assert word(FIND_TABLE) == 0x7c0802a6, 'FindTable: prologue'
assert word(FIND_TABLE + 0x10) == 0x607f0000, 'FindTable: mr r31,r3 (database name)'
assert word(FIND_TABLE + 0x14) == 0x609e0000, 'FindTable: mr r30,r4 (table name)'
assert word(FIND_TABLE + 0x68) == 0x7c1e1800, 'FindTable: cmpw r30,r3 (name compare)'
assert word(RESIZE) == 0x7c0802a6, 'resize: prologue'
assert word(RESIZE + 0x14) == 0x549d043e, 'resize: clrlwi r29,r4,0x10 (rows argument)'
assert word(RESIZE + 0x10c) == 0xb3bf0004, 'resize: sth r29,4(r31) (new maximum)'

# ---- code
a_words = [
    0x7c0802a6,                            # mflr r0
    0xf821ff81,                            # stdu r1,-0x80(r1)
    0xf8010090,                            # std r0,0x90(r1)
    0xf9610070,                            # std r11,0x70(r1)       original callee
    lis(4, NAME_PLAY >> 16),               # lis r4,0x5941
    ori(4, 4, NAME_PLAY),                  # ori r4,r4,0x4c50
    branch(A + 0x18, FIND_TABLE, True),    # bl FindTable(db, 'YALP')
    0x2c030000,                            # cmpwi r3,0
    0x41820014,                            # beq +0x14 (b B.done)
    0xa0830004,                            # lhz r4,4(r3)           current maximum
    0x28040000 | ROWS,                     # cmplwi r4,ROWS
    0x40800008,                            # bge +8 (b B.done)
    branch(A + 0x30, B + 0x18),            # b B.grow
    branch(A + 0x34, B),                   # b B.done
]
b_words = [
    0xe9610070,                            # done: ld r11,0x70(r1)
    0xe8010090,                            #       ld r0,0x90(r1)
    0x38210080,                            #       addi r1,r1,0x80
    0x7c0803a6,                            #       mtlr r0           (the original call site)
    0x7d6903a6,                            #       mtctr r11
    0x4e800420,                            #       bctr              tail call the original callee
    0x38800000 | ROWS,                     # grow: li r4,ROWS
    branch(B + 0x1c, RESIZE, True),        #       bl TableResize(table, ROWS)
    branch(B + 0x20, B),                   #       b done
]
def stub(at, db, callee):
    return [lis(3, db >> 16), ori(3, 3, db), lis(11, callee >> 16), ori(11, 11, callee), branch(at + 0x10, A)]

# ---- the padding must be exactly that
targets = {}
for i, w in enumerate(W):
    op = w >> 26
    if op == 18:
        li = w & 0x03fffffc; li = li - 0x04000000 if li & 0x02000000 else li; t = i * 4 + li if not (w & 2) else li - VA0
    elif op == 16:
        bd = w & 0xfffc; bd = bd - 0x10000 if bd & 0x8000 else bd; t = i * 4 + bd if not (w & 2) else bd - VA0
    else: continue
    targets.setdefault(t // 4, []).append(i)
data = d[0x1bc0000:0x1bc0000 + 0xeb164]
ptrs = struct.unpack('>%dI' % (len(data) // 4), data[:len(data) // 4 * 4])
absrefs = []
for i, w in enumerate(W):
    if (w >> 26) == 15 and ((w >> 16) & 31) == 0:
        rt = (w >> 21) & 31; h = w & 0xffff
        for k in range(1, 17):
            if i + k >= nw: break
            p = W[i + k]; op = p >> 26
            if op in (14, 12) and ((p >> 16) & 31) == rt:
                imm = p & 0xffff; imm = imm - 0x10000 if imm >= 0x8000 else imm; absrefs.append((va(i + k), ((h << 16) + imm) & 0xffffffff)); break
            if op == 24 and ((p >> 21) & 31) == rt: absrefs.append((va(i + k), (h << 16) | (p & 0xffff))); break
            if op == 15 and ((p >> 21) & 31) == rt: break
def check_pad(start, n, label):
    if start % 4 or not (TEXT[0] <= start and start + 4 * n <= TEXT[1]): raise SystemExit(f'{label}: outside .text')
    run_start = start
    while word(run_start - 4) in FILLERS: run_start -= 4
    run_end = start
    while run_end < TEXT[1] and word(run_end) in FILLERS: run_end += 4
    if run_end < start + 4 * n: raise SystemExit(f'{label}: only {(run_end - start) // 4} padding words at {start:#x}')
    for t in range((run_start - VA0) // 4, (run_end - VA0) // 4):
        for s in targets.get(t, []):
            if not (run_start <= va(s) < run_end): raise SystemExit(f'{label}: branch from {va(s):#x} into the padding')
    for p in ptrs:
        if run_start <= p < run_end: raise SystemExit(f'{label}: data pointer {p:#x} into the padding')
    for at, a in absrefs:
        if run_start <= a < run_end: raise SystemExit(f'{label}: code at {at:#x} addresses the padding')
    before = word(run_start - 4)
    if not (before == 0x4e800020 or ((before >> 26) == 18 and not (before & 1))): raise SystemExit(f'{label}: no function end before the padding ({before:#010x})')
    if word(run_end) != 0x7c0802a6: raise SystemExit(f'{label}: the padding is not followed by a prologue ({word(run_end):#010x})')
    return (run_end - run_start) // 4
pads = {'A': (A, len(a_words)), 'B': (B, len(b_words)), 'S_ROST': (S_ROST, 5), 'S_DYND': (S_DYND, 5)}
sizes = {k: check_pad(a, n, k) for k, (a, n) in pads.items()}

words = []
for site, callee, db, s in HOOKS:
    words.append((site, word(site), branch(site, s, True)))
for site, callee, db, s in HOOKS:
    words += [(s + 4 * k, word(s + 4 * k), w) for k, w in enumerate(stub(s, db, callee))]
words += [(A + 4 * k, word(A + 4 * k), w) for k, w in enumerate(a_words)]
words += [(B + 4 * k, word(B + 4 * k), w) for k, w in enumerate(b_words)]
assert len({a for a, _, _ in words}) == len(words), 'overlapping words'

md = Cs(CS_ARCH_PPC, CS_MODE_32 | CS_MODE_BIG_ENDIAN)
def show(a, w):
    got = list(md.disasm(struct.pack('>I', w), a))
    return f'{got[0].mnemonic} {got[0].op_str}' if got else f'.long {w:#010x}'
print('padding runs (words):', ', '.join(f'{k} {pads[k][0]:#x} uses {pads[k][1]} of {sizes[k]}' for k in pads))
for a, o, n in words:
    print(f'  {a:08x}  {o:08x} -> {n:08x}  {show(a, n)}')
yml = opt('--yml'); wj = opt('--words')
if wj: open(wj, 'w').write(json.dumps([{'va': f'{a:#x}', 'old': f'{o:#010x}', 'new': f'{n:#010x}'} for a, o, n in words], indent=0))
if yml:
    y = ['  "FCS mod: 100-player rosters (player table)":', '    Games:', '      "NCAA Football 14":', '        BLUS31159: [ 01.00, 01.02 ]', '    Author: "football-sim-project"',
         f'    Notes: "The Rosters screens and a new dynasty copy the loaded roster file into their own databases, whose player table holds 9,100 rows, so a roster file with more rows loads only its first 9,100 players. v2: right before those databases build their indexes (0x4f417c Rosters, 0x4f5e9c new dynasty) their PLAY table is resized to {ROWS:,} rows with the library\'s own resize call (0xa56dbc). {len(a_words) + len(b_words) + 10} words of code in unused .text padding. Play Now is not covered. Requires the stride and capacity entries. Generated by spike/blaze/tools/roster-table-patch.py."',
         '    Patch Version: 2.0', '    Patch:']
    for a, _, n in words: y.append(f'      - [ be32, 0x{a:08x}, 0x{n:08x} ]')
    open(yml, 'w', encoding='utf8').write('\n'.join(y) + '\n')
    print(f'yml: {yml} ({len(words)} words)')
