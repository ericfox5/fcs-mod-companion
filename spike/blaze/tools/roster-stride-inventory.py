# Inventory of every place the EBOOT depends on the 70-player roster stride (PGID = TGID * 70 + slot).
# Usage: python roster-stride-inventory.py ../private/EBOOT.elf [out.csv] [out.md]
# Read-only. Classes:
#   div-mulli   (x+1) * 0x7507 >> 21            PGID / 70 for 16-bit ids
#   div-magic   mulhwu by 0xD41D41D5 (+ subf, srwi 1, add, srwi 6)   PGID / 70 for 32-bit values
#   mul-shift   slwi 5 ; add X x3 ; add (double)  TGID * 70 by shift-add (pattern hit; confidence from context)
#   limit-li    li rX,70                        a count, loop bound or buffer size
#   limit-cmp   cmpwi/cmplwi rX,69|70            a roster-size compare or loop bound
#   size-const  50000 / 0x7e5000 / 0x15e000     league package DB, dynasty DB buffer, roster save size
# Evidence per site: enclosing function (nearest `mflr r0` prologue), DB query calls (bl 0xa691b0) and reversed-4CC
# immediates (DIGP = PGID, DIGT = TGID, YALP = PLAY, MAET = TEAM, THCD = DCHT, DIOP = POID) in that function, whether a
# `li 70` is passed beside a stack buffer (addic rY,r1,...) to a call, and whether a compare bounds a backward loop.
import struct, sys, csv, bisect, collections
from capstone import Cs, CS_ARCH_PPC, CS_MODE_32, CS_MODE_BIG_ENDIAN

elf = sys.argv[1]
out_csv = sys.argv[2] if len(sys.argv) > 2 else 'roster-stride-inventory.csv'
out_md = sys.argv[3] if len(sys.argv) > 3 else None
data = open(elf, 'rb').read()
e_phoff = struct.unpack('>Q', data[0x20:0x28])[0]; n_ph = struct.unpack('>H', data[0x38:0x3a])[0]
segs = []
for i in range(n_ph):
    o = e_phoff + i * 56
    t, f, off, va, pa, fsz, msz, al = struct.unpack('>IIQQQQQQ', data[o:o + 56])
    if t == 1 and fsz: segs.append((va, fsz, off, f))
va0, sz0, off0, _ = segs[0]
code = data[off0:off0 + sz0]; nw = len(code) // 4
W = struct.unpack('>%dI' % nw, code[:nw * 4])
va = lambda i: va0 + i * 4
idx = lambda a: (a - va0) // 4
s16 = lambda x: x - 0x10000 if x >= 0x8000 else x
md = Cs(CS_ARCH_PPC, CS_MODE_32 | CS_MODE_BIG_ENDIAN)
def dis1(a):
    got = list(md.disasm(struct.pack('>I', W[idx(a)]), a))
    return f'{got[0].mnemonic} {got[0].op_str}' if got else f'.long {W[idx(a)]:#010x}'

DBQ = 0xa691b0
FOURCC = {0x44494750: 'PGID', 0x44494754: 'TGID', 0x59414c50: 'PLAY', 0x4d414554: 'TEAM', 0x54484344: 'DCHT', 0x44494f50: 'POID'}
SIZES = {50000: 'league-package-db', 0x7e5000: 'dynasty-db-buffer', 0x15e000: 'roster-save-size'}

# prologues, DB query calls, 4CC immediates
prologues = [va(i) for i, w in enumerate(W) if w == 0x7c0802a6]
dbq = []
imm4 = {}  # address of the completing instruction -> name
sizes = {}
for i, w in enumerate(W):
    op = w >> 26
    if op == 18 and (w & 3) == 1:
        li = w & 0x03fffffc
        if li & 0x02000000: li -= 0x04000000
        if va(i) + li == DBQ: dbq.append(va(i))
    if op == 15 and ((w >> 16) & 31) == 0:  # lis
        rd = (w >> 21) & 31; hi = w & 0xffff
        for k in range(1, 12):
            if i + k >= nw: break
            w2 = W[i + k]; op2 = w2 >> 26
            if op2 in (14, 12) and ((w2 >> 16) & 31) == rd:
                v = ((hi << 16) + s16(w2 & 0xffff)) & 0xffffffff
                if v in FOURCC: imm4[va(i + k)] = FOURCC[v]
                if v in SIZES: sizes[va(i + k)] = SIZES[v]
                break
            if op2 == 24 and ((w2 >> 21) & 31) == rd:
                v = (hi << 16) | (w2 & 0xffff)
                if v in FOURCC: imm4[va(i + k)] = FOURCC[v]
                if v in SIZES: sizes[va(i + k)] = SIZES[v]
                break
imm4_addrs = sorted(imm4)

def func_of(a):
    j = bisect.bisect_right(prologues, a) - 1
    start = prologues[j] if j >= 0 and a - prologues[j] < 0x6000 else None
    end = prologues[j + 1] if j + 1 < len(prologues) else va0 + nw * 4
    return start, end
def in_range(sorted_list, lo, hi):
    j = bisect.bisect_left(sorted_list, lo); k = bisect.bisect_left(sorted_list, hi)
    return sorted_list[j:k]
def is_add(w): return (w >> 26) == 31 and ((w >> 1) & 0x1ff) in (266, 10)
def is_bc_back(w, a):
    if (w >> 26) != 16: return False
    d = w & 0xfffc
    if d & 0x8000: d -= 0x10000
    return d < 0

sites = []
def add(a, cls, detail, extra=None):
    start, end = func_of(a)
    lo = start if start else a - 0x400
    q = in_range(dbq, lo, end); f4 = [imm4[x] for x in in_range(imm4_addrs, lo, end)]
    near_q = in_range(dbq, a - 0x300, a + 0x300)
    region = 'dynasty' if 0x420000 <= a < 0x540000 else 'engine' if 0xa00000 <= a < 0xb30000 else 'frontend' if a < 0x420000 else 'other'
    sites.append({'va': f'{a:#x}', 'class': cls, 'function': f'{start:#x}' if start else '', 'region': region,
                  'detail': detail, 'db_queries_in_function': len(q), 'db_query_within_0x300': len(near_q),
                  'fourcc_in_function': ' '.join(sorted(set(f4))), **(extra or {})})

for i, w in enumerate(W):
    a = va(i); op = w >> 26; imm = w & 0xffff
    if op == 7 and imm == 0x7507:
        add(a, 'div-mulli', dis1(a))
    elif op == 15 and ((w >> 16) & 31) == 0 and imm == 0xd41d:
        rd = (w >> 21) & 31
        for k in range(1, 8):
            w2 = W[i + k]
            if (w2 >> 26) == 24 and ((w2 >> 21) & 31) == rd and (w2 & 0xffff) == 0x41d5:
                add(va(i + k), 'div-magic', f'{dis1(a)} ; {dis1(va(i + k))}'); break
    elif (op == 21 and ((w >> 11) & 31) == 5 and (w & 0x3e) == (26 << 1)) or (op == 30 and ((w >> 2) & 7) == 1 and (((w >> 11) & 31) | ((w & 2) << 4)) == 5):
        X = (w >> 16) & 31; cnt = 0; dbl = None
        for k in range(1, 9):
            if i + k >= nw: break
            w2 = W[i + k]
            if is_add(w2):
                if X in ((w2 >> 16) & 31, (w2 >> 11) & 31): cnt += 1
                if ((w2 >> 16) & 31) == ((w2 >> 11) & 31): dbl = (w2 >> 21) & 31
        if cnt >= 3 and dbl is not None:
            # confidence: the product (register dbl) feeds a DB query parameter / compare / store nearby
            flow = 'none'
            for k in range(1, 24):
                if i + k >= nw: break
                w2 = W[i + k]; op2 = w2 >> 26
                if op2 == 18 and (w2 & 3) == 1:
                    li = w2 & 0x03fffffc
                    if li & 0x02000000: li -= 0x04000000
                    if va(i + k) + li == DBQ: flow = 'db-query-call'; break
                if op2 == 31 and ((w2 >> 1) & 0x3ff) in (0, 32) and dbl in ((w2 >> 16) & 31, (w2 >> 11) & 31): flow = 'compare'; break
            add(a, 'mul-shift', f'x={X} result=r{dbl}', {'flow': flow})
    elif op == 14 and ((w >> 16) & 31) == 0 and s16(imm) == 70:
        stack = any((W[i + k] >> 26) == 12 and ((W[i + k] >> 16) & 31) == 1 for k in range(-12, 13) if 0 <= i + k < nw)
        call = any((W[i + k] >> 26) == 18 and (W[i + k] & 1) for k in range(1, 9) if i + k < nw)
        add(a, 'limit-li', dis1(a), {'stack_buffer_arg': 'yes' if stack and call else ''})
    elif op in (10, 11) and s16(imm) in (69, 70):
        loop = is_bc_back(W[i + 1], a + 4) if i + 1 < nw else False
        add(a, 'limit-cmp', dis1(a), {'loop_bound': 'yes' if loop else ''})
for a, name in sizes.items():
    add(a, 'size-const', f'{name}: {dis1(a)}')

sites.sort(key=lambda s: int(s['va'], 16))
cols = ['va', 'class', 'region', 'function', 'detail', 'flow', 'stack_buffer_arg', 'loop_bound', 'db_queries_in_function', 'db_query_within_0x300', 'fourcc_in_function']
with open(out_csv, 'w', newline='') as f:
    wr = csv.DictWriter(f, fieldnames=cols); wr.writeheader()
    for s in sites: wr.writerow({c: s.get(c, '') for c in cols})

# summary
by = collections.defaultdict(list)
for s in sites: by[s['class']].append(s)
def pg(s): return 'PGID' in s['fourcc_in_function'] or 'TGID' in s['fourcc_in_function'] or s['db_query_within_0x300'] > 0
lines = ['| class | sites | with PGID/TGID/DB evidence | dynasty region | engine region |', '|---|---|---|---|---|']
for cls in ('div-mulli', 'div-magic', 'mul-shift', 'limit-li', 'limit-cmp', 'size-const'):
    L = by.get(cls, [])
    lines.append(f"| {cls} | {len(L)} | {sum(1 for s in L if pg(s))} | {sum(1 for s in L if s['region'] == 'dynasty')} | {sum(1 for s in L if s['region'] == 'engine')} |")
mul = by.get('mul-shift', [])
lines += ['', f"mul-shift confidence: {sum(1 for s in mul if s['flow'] == 'db-query-call')} feed a DB query, {sum(1 for s in mul if s['flow'] == 'compare')} feed a compare, {sum(1 for s in mul if s['flow'] == 'none')} unresolved; {sum(1 for s in mul if pg(s))} sit in functions with PGID/TGID/DB evidence."]
li = by.get('limit-li', []); cmpv = by.get('limit-cmp', [])
lines += [f"limit-li: {sum(1 for s in li if s.get('stack_buffer_arg'))} pass 70 beside a stack buffer to a call; {sum(1 for s in li if pg(s))} in functions with PGID/TGID/DB evidence.",
          f"limit-cmp: {sum(1 for s in cmpv if s.get('loop_bound'))} bound a backward loop; {sum(1 for s in cmpv if pg(s))} in functions with PGID/TGID/DB evidence."]
funcs = collections.Counter(s['function'] for s in sites if pg(s) and s['function'])
lines += ['', f'functions touched (with evidence): {len(funcs)}; top by site count:']
for fn, c in funcs.most_common(25): lines.append(f'  {fn}: {c}')
summary = '\n'.join(lines)
print(summary)
if out_md:
    with open(out_md, 'w') as f:
        f.write(summary + '\n')
