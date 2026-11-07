# Builds the RPCS3 patch "FCS mod: 100-player rosters" (PGID = TGID * 100 + slot) from the decrypted 1.02 EBOOT.elf.
# Usage: python roster-stride-patch.py ../private/EBOOT.elf [--stride 100] [--yml out.yml] [--report out.md] [--json out.json]
#        [--scope evidence|all] [--limits]
# Read-only on the ELF. What it rewrites (see docs/roster-stride-inventory.md):
#   div-mulli   (x+1) * 0x7507 >> 21  ->  (x+1) * 0x51EB >> 21   (= x / 100, exact for x < 40,400: TGID <= 403)
#   div-magic   mulhwu 0xD41D41D5 + subf/srwi 1/add/srwi 6  ->  mulhwu 0x47AE147B + same tail (= x / 100, all 32-bit x)
#   mul-chain   slwi 5 + adds producing 70*x  ->  mulli R,X,100 + nops (the chain is found by tracking coefficients of X)
#   package     0x8ae38 li r6,70 -> li r6,100 (league package PLAY rows)
#   save size   0x3b4690/0x3b46a0 roster save buffer 0x15e000 -> 0x1c0000
#   limits      a curated list (LIMITS below), only with --limits
# Multiply chains are patched only in functions with PGID/TGID/DB-query evidence unless --scope all. Everything skipped
# or flagged (unexpected shapes, interleaved readers, carry consumers) goes to the report for hand review.
import struct, sys, bisect, json, re, collections
from capstone import Cs, CS_ARCH_PPC, CS_MODE_32, CS_MODE_BIG_ENDIAN

args = sys.argv[1:]
elf = args[0]
def opt(name, default=None):
    if name in args:
        i = args.index(name); return args[i + 1] if i + 1 < len(args) else True
    return default
STRIDE = int(opt('--stride', 100))
SCOPE = opt('--scope', 'evidence')
WITH_LIMITS = '--limits' in args
yml_out, rep_out, json_out = opt('--yml'), opt('--report'), opt('--json')
CAPACITY = '--capacity' in args   # second entry: dynasty-side roster capacity 70 -> 100 (games keep 70 dressed)
cap_yml, cap_words = opt('--cap-yml'), opt('--cap-words')
CUT = int(opt('--cut') or 90)      # in-season roster limit: the offseason "Cut Players" stage trims every team to this (was 70)

data = open(elf, 'rb').read()
VA0 = 0x10000
e_phoff = struct.unpack('>Q', data[0x20:0x28])[0]; n_ph = struct.unpack('>H', data[0x38:0x3a])[0]
sz0 = None
for i in range(n_ph):
    o = e_phoff + i * 56
    t, f, off, va, pa, fsz, msz, al = struct.unpack('>IIQQQQQQ', data[o:o + 56])
    if t == 1 and fsz and va == VA0: sz0 = fsz
nw = sz0 // 4
W = list(struct.unpack('>%dI' % nw, data[:nw * 4]))
va = lambda i: VA0 + i * 4
idx = lambda a: (a - VA0) // 4
word = lambda a: W[idx(a)]
s16 = lambda x: x - 0x10000 if x >= 0x8000 else x
md = Cs(CS_ARCH_PPC, CS_MODE_32 | CS_MODE_BIG_ENDIAN)
def dis1(a, w=None):
    w = word(a) if w is None else w
    got = list(md.disasm(struct.pack('>I', w), a))
    return f'{got[0].mnemonic} {got[0].op_str}' if got else f'.long {w:#010x}'
NOP = 0x60000000
def enc_mulli(rd, ra, imm): return (7 << 26) | (rd << 21) | (ra << 16) | (imm & 0xffff)
def enc_li(rd, imm): return (14 << 26) | (rd << 21) | (imm & 0xffff)

# ---------------- function / evidence map (as in roster-stride-inventory.py)
DBQ = 0xa691b0
FOURCC = {0x44494750: 'PGID', 0x44494754: 'TGID', 0x59414c50: 'PLAY', 0x4d414554: 'TEAM', 0x54484344: 'DCHT', 0x44494f50: 'POID'}
prologues = [va(i) for i, w in enumerate(W) if w == 0x7c0802a6]
dbq = []; imm4 = {}
for i, w in enumerate(W):
    op = w >> 26
    if op == 18 and (w & 3) == 1:
        li = w & 0x03fffffc
        if li & 0x02000000: li -= 0x04000000
        if va(i) + li == DBQ: dbq.append(va(i))
    if op == 15 and ((w >> 16) & 31) == 0:
        rd = (w >> 21) & 31; hi = w & 0xffff
        for k in range(1, 12):
            if i + k >= nw: break
            w2 = W[i + k]; op2 = w2 >> 26
            if op2 in (14, 12) and ((w2 >> 16) & 31) == rd:
                v = ((hi << 16) + s16(w2 & 0xffff)) & 0xffffffff
                if v in FOURCC: imm4[va(i + k)] = FOURCC[v]
                break
            if op2 == 24 and ((w2 >> 21) & 31) == rd:
                v = (hi << 16) | (w2 & 0xffff)
                if v in FOURCC: imm4[va(i + k)] = FOURCC[v]
                break
imm4_addrs = sorted(imm4)
def func_of(a):
    j = bisect.bisect_right(prologues, a) - 1
    start = prologues[j] if j >= 0 and a - prologues[j] < 0x6000 else None
    end = prologues[j + 1] if j + 1 < len(prologues) else VA0 + nw * 4
    return start, end
def in_range(lst, lo, hi):
    return lst[bisect.bisect_left(lst, lo):bisect.bisect_left(lst, hi)]
def evidence(a):
    start, end = func_of(a); lo = start if start else a - 0x400
    f4 = sorted(set(imm4[x] for x in in_range(imm4_addrs, lo, end)))
    return {'function': start, 'dbq': len(in_range(dbq, lo, end)), 'near': len(in_range(dbq, a - 0x300, a + 0x300)), 'fourcc': f4}
def region(a):
    return 'dynasty' if 0x420000 <= a < 0x540000 else 'engine' if 0xa00000 <= a < 0xb30000 else 'frontend' if a < 0x420000 else 'other'
def has_evidence(ev):
    return bool(set(ev['fourcc']) & {'PGID', 'TGID'}) or ev['near'] > 0

# ---------------- instruction helpers
def fields(w):
    return {'op': w >> 26, 'rd': (w >> 21) & 31, 'ra': (w >> 16) & 31, 'rb': (w >> 11) & 31, 'xo': (w >> 1) & 0x3ff, 'xo9': (w >> 1) & 0x1ff, 'imm': w & 0xffff}
def is_add(w):   # add / addc (no carry-in forms)
    f = fields(w); return f['op'] == 31 and f['xo9'] in (266, 10)
def is_shift_left(w):  # returns (rd, rs, sh) for slwi / sldi, else None
    f = fields(w)
    if f['op'] == 21 and (w & 0x3e) == (26 << 1) and ((w >> 6) & 31) == 0:  # rlwinm rA,rS,sh,0,31-sh
        sh = f['rb']
        if ((w >> 1) & 31) == 31 - sh: return (f['ra'], f['rd'], sh)
    if f['op'] == 30 and ((w >> 2) & 7) == 1:  # rldicr rA,rS,sh,63-sh
        sh = f['rb'] | ((w & 2) << 4); me = ((w >> 6) & 31) | (w & 0x20)
        if me == 63 - sh: return (f['ra'], f['rd'], sh)
    return None
def writes(w):  # destination gpr of an instruction, or None
    f = fields(w); op = f['op']
    if op in (14, 15, 12, 13, 7, 8, 24, 25, 26, 27, 28, 29, 32, 33, 34, 35, 40, 41, 42, 43, 50, 58, 20, 21, 23, 30): return f['rd'] if op not in (24, 25, 26, 27, 28, 29, 20, 21, 23, 30) else f['ra']
    if op == 31:
        xo = f['xo']
        if xo in (24, 28, 60, 124, 284, 316, 412, 444, 476, 536, 539, 792, 794, 824, 922, 954, 986, 26, 58, 27, 539): return f['ra']  # logical/shift: rA
        if xo in (20, 21, 23, 53, 55, 84, 87, 119, 149, 151, 183, 215, 247, 279, 311, 343, 375, 407, 439, 533, 534, 535, 567, 599, 631, 663, 695, 727, 759, 790, 791, 918, 919, 983, 1014): return f['rd'] if xo not in (150, 151, 183, 215, 247, 407, 439, 534, 535, 567, 663, 695, 727, 759, 918, 919, 983, 1014) else None
        if f['xo9'] in (266, 10, 40, 8, 138, 234, 202, 136, 232, 200, 235, 233, 75, 11, 73, 9, 491, 459, 489, 457, 104, 232, 200, 170): return f['rd']
        if xo in (339, 19, 371, 83, 595): return f['rd']
    return None
def reads(w):  # set of gprs read (approximate, over-inclusive is fine for flagging)
    f = fields(w); op = f['op']; out = set()
    if op in (14, 15, 12, 13, 7, 8, 10, 11, 32, 33, 34, 35, 40, 41, 42, 43, 50, 58, 36, 37, 38, 39, 44, 45, 46, 47, 62, 54):
        if f['ra'] or op in (10, 11): out.add(f['ra'])
        if op in (36, 37, 38, 39, 44, 45, 46, 47, 62, 54): out.add(f['rd'])
    elif op in (24, 25, 26, 27, 28, 29, 20, 21, 23, 30): out.add(f['rd']);  out.add(f['rb']) if op in (23, 30) else None
    elif op == 31:
        out.add(f['ra']); out.add(f['rb'])
        if writes(w) == f['ra']: out.add(f['rd'])
    return out
CARRY_XO9 = {138, 234, 202, 136, 232, 200}  # adde addze addme subfe subfze subfme

# ---------------- site detection
sites = []   # dicts: kind, va, words {va: (old, new)}, note, flags, evidence
def add_site(kind, a, words, note='', flags=None, extra=None):
    ev = evidence(a)
    s = {'kind': kind, 'va': a, 'words': words, 'note': note, 'flags': flags or [], 'region': region(a), **ev, **(extra or {})}
    sites.append(s); return s

# div-mulli: (x+1)*0x7507>>21
M_MULLI = {70: 0x7507, 100: 0x51EB}[STRIDE] if STRIDE in (70, 100) else None
for i, w in enumerate(W):
    f = fields(w)
    if f['op'] == 7 and f['imm'] == 0x7507:
        a = va(i); fl = []
        # expect an addic X,.,1 before and a srwi rd,.,21 after (within 6)
        if not any(fields(W[i - k])['op'] == 12 and s16(fields(W[i - k])['imm']) == 1 and fields(W[i - k])['rd'] == f['ra'] for k in range(1, 7)): fl.append('no +1 before')
        if not any(fields(W[i + k])['op'] == 21 and ((W[i + k] >> 11) & 31) == 11 and ((W[i + k] >> 6) & 31) == 21 for k in range(1, 9)): fl.append('no >>21 after')
        if a == 0x45396c:
            # inside the "preseason All-Conference crash fix" window: that patch moves this mulli one slot up (0x453968);
            # the stride word is emitted at the moved position and the stride entry must follow that entry in the yml
            add_site('div-mulli', a, {0x453968: (0x1d237507, 0x1d2351eb)}, dis1(a) + ' (moved to 0x453968 by the All-Conference patch)', [], {'depends': 'All-Conference patch'})
        else:
            add_site('div-mulli', a, {a: (w, (w & 0xffff0000) | 0x51EB)}, dis1(a), fl)

# div-magic: lis 0xd41d; ori 0x41d5; mulhwu T,T,X ; subf U,T,X ; srwi U,U,1 ; add U,U,T ; srwi V,U,6
for i, w in enumerate(W):
    f = fields(w)
    if f['op'] == 15 and f['ra'] == 0 and f['imm'] == 0xd41d:
        rd = f['rd']; ori_at = None
        for k in range(1, 8):
            w2 = W[i + k]; f2 = fields(w2)
            if f2['op'] == 24 and f2['rd'] == rd and f2['imm'] == 0x41d5: ori_at = i + k; break
        if ori_at is None: continue
        a = va(i); fl = []
        # locate mulhwu using rd within 6 after the ori
        mh = None
        for k in range(1, 7):
            w3 = W[ori_at + k]; f3 = fields(w3)
            if f3['op'] == 31 and f3['xo9'] == 11 and f3['ra'] == f2['ra']: mh = (ori_at + k, f3); break
        if not mh: fl.append('no mulhwu')
        else:
            T = mh[1]['rd']; X = mh[1]['rb']; j = mh[0]
            seq = []
            for k in range(1, 30):
                w4 = W[j + k]; f4 = fields(w4)
                if f4['op'] == 31 and f4['xo9'] in (40, 8) and f4['ra'] == T and f4['rb'] == X and 'subf' not in seq: seq.append('subf'); U = f4['rd']; continue
                if 'subf' in seq and 'srwi1' not in seq and f4['op'] == 21 and f4['rd'] == U and ((w4 >> 11) & 31) == 31 and ((w4 >> 6) & 31) == 1: seq.append('srwi1'); U = f4['ra']; continue
                if 'srwi1' in seq and 'add' not in seq and f4['op'] == 31 and f4['xo9'] in (266, 10) and {f4['ra'], f4['rb']} == {U, T}: seq.append('add'); U2 = f4['rd']; continue
                if 'add' in seq and f4['op'] == 21 and f4['rd'] == U2 and ((w4 >> 11) & 31) == 26 and ((w4 >> 6) & 31) == 6: seq.append('srwi6'); break
            if seq != ['subf', 'srwi1', 'add', 'srwi6']: fl.append(f'tail shape {seq}')
        new_hi, new_lo = (0x47AE, 0x147B) if STRIDE == 100 else (0xd41d, 0x41d5)
        add_site('div-magic', a, {a: (w, (w & 0xffff0000) | new_hi), va(ori_at): (W[ori_at], (W[ori_at] & 0xffff0000) | new_lo)}, f'{dis1(a)} ; {dis1(va(ori_at))}', fl)

# how the product is used: 'base' (PGID range: +70 / compare / DB-query parameter), 'index' (scaled and added to a
# pointer, or an index register: a per-team array of 70 entries, which stays 70 until the arrays are grown), else 'unknown'
# Engine-region chains are the 70-per-side layout of the in-game tables (PLGA/DCGA rows, 140-entry arrays) and stay
# at 70 until those structures are grown; only the slot computations (PGID - team*70) and PGID assembly are forced.
# 0xa31228: slot = DCHT.PGID - team*70 packed into the in-game depth chart; 0xa23c84: the engine creates the player
# objects from base = GINF.GHTG/GATG * 70 + i (checkpoint 1 found this: no players loaded); 0xa2a3e8: PGID = TGID*70 +
# packed slot when the in-game depth chart is applied. The loop bounds (70 per side) and the +70 away offsets stay.
FORCE_APPLY = {0xa94bb4, 0xa94c24, 0xa31228, 0xa23c84, 0xa2a3e8}
def classify_use(end_i, R):
    derived = {R}; verdict = []
    for j in range(end_i + 1, min(end_i + 16, nw)):
        w = W[j]; f = fields(w); op = f['op']; rd = writes(w)
        if op == 18 and (w & 3) == 1:
            if va(j) + ((w & 0x03fffffc) - (0x04000000 if w & 0x02000000 else 0)) == DBQ and any(r in derived for r in range(3, 11)): verdict.append('query')
            derived -= set(range(3, 13))
            continue
        if op in (14, 12) and f['ra'] in derived:
            if s16(f['imm']) in (70, 69, STRIDE): verdict.append('range')
            derived.add(f['rd']); continue
        if op in (10, 11) and f['ra'] in derived: verdict.append('compare'); continue
        if op == 31 and f['xo'] in (0, 32) and (f['ra'] in derived or f['rb'] in derived): verdict.append('compare'); continue
        sh = is_shift_left(w)
        if sh and sh[1] in derived and 1 <= sh[2] <= 3: verdict.append('index'); derived.add(sh[0]); continue
        if op == 31 and f['xo'] in (23, 87, 279, 343, 151, 215, 407, 21, 149) and (f['ra'] in derived or f['rb'] in derived): verdict.append('index'); continue
        if op in (36, 37, 44, 45, 38, 39) and f['rd'] in derived: verdict.append('stored'); continue
        if op == 31 and f['xo9'] in (266, 10) and (f['ra'] in derived or f['rb'] in derived): derived.add(f['rd']); continue
        if op == 24 and f['imm'] == 0 and f['rd'] in derived: derived.add(f['ra']); continue
        if op == 30 and f['rd'] in derived: derived.add(f['ra']); continue
        if op == 31 and f['xo'] == 986 and f['rd'] in derived: derived.add(f['ra']); continue
        if rd is not None and rd in derived and not (f['ra'] in derived or f['rb'] in derived): derived.discard(rd)
    if 'index' in verdict and not ({'query', 'range'} & set(verdict)): return 'index'
    if {'query', 'range', 'compare'} & set(verdict): return 'base'
    return 'unknown'

# mul-chain: symbolic coefficients of X
def find_chain(i):
    sh = is_shift_left(W[i])
    if not sh: return None
    S, X, k = sh
    if S == X or k > 6: return None
    coef = {X: 1, S: 1 << k}
    chain = [i]
    for j in range(i + 1, min(i + 12, nw)):
        w = W[j]; f = fields(w)
        if is_add(w) and f['ra'] in coef and f['rb'] in coef:
            c = coef[f['ra']] + coef[f['rb']]
            coef[f['rd']] = c; chain.append(j)
            if c == 70: return {'start': i, 'end': j, 'X': X, 'R': f['rd'], 'chain': chain, 'coef': dict(coef)}
            continue
        sh2 = is_shift_left(w)
        if sh2 and sh2[1] in coef and sh2[0] != sh2[1]:
            coef[sh2[0]] = coef[sh2[1]] << sh2[2]; chain.append(j); continue
        d = writes(w)
        if d is not None and d in coef:
            if d == X: return None
            del coef[d]
        if (w >> 26) in (16, 18, 19) or w == 0x4e800020: return None  # branch: chain must be straight-line
    return None
for i in range(nw):
    ch = find_chain(i)
    if not ch: continue
    a = va(i); X, R = ch['X'], ch['R']; fl = []
    chain_set = set(ch['chain'])
    between = [j for j in range(ch['start'], ch['end'] + 1) if j not in chain_set]
    # X intact at the end? (a chain instruction writing X means R == X by construction; interleaved writers are flagged)
    x_written_in_chain = any(writes(W[j]) == X for j in ch['chain'][:-1])
    if any(writes(W[j]) == X for j in between): fl.append('interleaved write to X')
    tracked = set(ch['coef']) - {X}
    if any(reads(W[j]) & tracked for j in between): fl.append('interleaved read of a chain register')
    if any(fields(W[j])['op'] == 31 and fields(W[j])['xo9'] in CARRY_XO9 for j in range(ch['end'] + 1, min(ch['end'] + 6, nw))): fl.append('carry consumer after the chain')
    words = {}
    if x_written_in_chain and R != X:
        # X becomes 35X before the final doubling into R: compute R = 100X at the chain start instead (R must be dead
        # across the chain, X stays intact for anyone after it)
        if any(R in reads(W[j]) or writes(W[j]) == R for j in between): fl.append('R live across the chain')
        for j in ch['chain']: words[va(j)] = (W[j], enc_mulli(R, X, STRIDE) if j == ch['start'] else NOP)
    elif x_written_in_chain:
        first_x = next(j for j in ch['chain'] if writes(W[j]) == X)
        for j in ch['chain']: words[va(j)] = (W[j], enc_mulli(X, X, STRIDE) if j == first_x else NOP)
        if any(X in reads(W[j]) for j in between if j > first_x): fl.append('interleaved read of X after its overwrite')
    else:
        for j in ch['chain']: words[va(j)] = (W[j], enc_mulli(R, X, STRIDE) if j == ch['end'] else NOP)
    use = classify_use(ch['end'], R)
    add_site('mul-chain', a, words, f'X=r{X} R=r{R} ({len(ch["chain"])} instr, {ch["end"] - ch["start"] + 1} span) use={use}', fl, {'X': X, 'R': R, 'use': use})

# package rows and roster save size (explicit words, verified)
def fixed(kind, a, old, new, note):
    if word(a) != old: raise SystemExit(f'{a:#x}: expected {old:#010x}, found {word(a):#010x}')
    add_site(kind, a, {a: (old, new)}, note)
fixed('package', 0x8ae38, 0x38c00046, enc_li(6, STRIDE), 'league package: PLAY rows per team')
fixed('save-size', 0x3b4690, 0x3c600015, 0x3c60001c, 'roster save buffer: lis r3,0x15 -> 0x1c (0x1c0000 = 1,835,008 bytes)')
fixed('save-size', 0x3b46a0, 0x6068e000, 0x60680000, 'roster save buffer: ori r8,r3,0xe000 -> 0')

# curated limit sites (filled in as they are confirmed; each: va, old word, new word, note)
LIMITS = [
]
if WITH_LIMITS:
    for a, old, new, note in LIMITS: fixed('limit', a, old, new, note)

# ---------------- scope decision
for s in sites:
    if s['kind'] == 'mul-chain':
        s['apply'] = (SCOPE == 'all') or s['va'] in FORCE_APPLY or (s['region'] == 'dynasty' and has_evidence(s) and s.get('use') != 'index')
    else:
        s['apply'] = True
    if s['flags'] and s['kind'] in ('div-mulli', 'div-magic'): s['apply'] = False
    if any(f.startswith('interleaved read') or f.startswith('R live') or f.startswith('carry') for f in s['flags']): s['apply'] = False
sites.sort(key=lambda s: s['va'])

# overlapping words check
seen = {}
for s in sites:
    if not s['apply']: continue
    for a in s['words']:
        if a in seen: raise SystemExit(f'overlap at {a:#x}: {seen[a]:#x} and {s["va"]:#x}')
        seen[a] = s['va']

# ---------------- capacity entry (checkpoint 2): dynasty-side 70 -> 100; everything that feeds the in-game copies
# (tables named ..GA: PLGA, DCGA, SPGA, TSGA, CSGA, CCGA, PRGA; 140-entry structures) keeps 70 = the dressed roster.
cap_sites = []
def cap_add(kind, a, old, new, note, fn=None):
    if word(a) != old: raise SystemExit(f'capacity {a:#x}: expected {old:#010x}, found {word(a):#010x}')
    cap_sites.append({'kind': kind, 'va': a, 'old': old, 'new': new, 'note': note, 'function': fn if fn is not None else func_of(a)[0]})
GA = {}
for i, w in enumerate(W):
    if (w >> 26) == 15 and ((w >> 16) & 31) == 0:
        hi = w & 0xffff; rd = (w >> 21) & 31
        for k in range(1, 10):
            if i + k >= nw: break
            w2 = W[i + k]; op2 = w2 >> 26
            if op2 == 24 and ((w2 >> 21) & 31) == rd:
                v = (hi << 16) | (w2 & 0xffff); b = bytes.fromhex('%08x' % v)[::-1]
                if b[2:] == b'GA' and all(65 <= c <= 90 for c in b): GA.setdefault(func_of(va(i + k))[0], set()).add(b.decode())
                break
            if op2 in (14, 12) and ((w2 >> 16) & 31) == rd: break
# in-game tables also appear inside SQL strings ("insert into \\x8d.'AGLP' ..."): scan the strings a function references
GA_STR = {}
for i, w in enumerate(W):
    if (w >> 26) == 15 and ((w >> 16) & 31) == 0:
        hi = w & 0xffff; rd = (w >> 21) & 31
        for k in range(1, 10):
            if i + k >= nw: break
            w2 = W[i + k]; op2 = w2 >> 26
            if op2 in (14, 12) and ((w2 >> 16) & 31) == rd:
                ad = ((hi << 16) + s16(w2 & 0xffff)) & 0xffffffff; o = ad - VA0
                if 0 <= o < len(data) - 8:
                    e = data.find(b'\0', o, o + 200); txt = data[o:e if e != -1 else o + 200]
                    import re as _re
                    for m in _re.finditer(rb"'(AG[A-Z]{2})'", txt): GA_STR.setdefault(func_of(va(i + k))[0], set()).add(m.group(1)[::-1].decode())
                break
            if op2 == 24 and ((w2 >> 21) & 31) == rd: break
def in_game_function(f): return bool(GA.get(f)) or bool(GA_STR.get(f))
if CAPACITY:
    # A. range ends: addi/addic rX, R, 70 fed by an applied multiply chain's result (R or a plain copy of it)
    excluded_range = []
    KEEP70 = {0x46dfe0}  # 0x46de34: season-stat rows of the dressed players, called from the game setup (0x46f704)
    for s in sites:
        if s['kind'] != 'mul-chain' or not s['apply']: continue
        R = s['R']; end = max(s['words']); f = s['function']; fe = func_of(end)[1]
        cur = {R}; i = idx(end)
        for j in range(i + 1, min(i + 80, idx(fe))):
            w = W[j]; f2 = fields(w); op = f2['op']
            if op in (14, 12) and f2['ra'] in cur and s16(f2['imm']) == 70:
                if in_game_function(f) or f == 0x428f48 or va(j) in KEEP70: excluded_range.append((va(j), f)); continue
                cap_add('range-end', va(j), w, (w & 0xffff0000) | STRIDE, f'{dis1(va(j))} -> +{STRIDE} (base from chain {s["va"]:#x})', f)
                continue
            if op == 24 and (w & 0xffff) == 0 and f2['rd'] in cur: cur.add(f2['ra']); continue
            wr = writes(w)
            if wr is not None and wr in cur and not (is_add(w) and (f2['ra'] in cur or f2['rb'] in cur)): cur.discard(wr)
            if op == 18 and (w & 3) == 1: cur -= set(range(0, 13))
            if (op == 18 and not (w & 1)) or w == 0x4e800020: break
    # range ends whose base reaches them through a stack slot (verified by hand: the chain result is stored and reloaded)
    for a in (0x43e6f0, 0x43f288, 0x450df0, 0x46d480, 0x46d594):
        f = func_of(a)[0]
        if in_game_function(f): excluded_range.append((a, f)); continue
        w = word(a); cap_add('range-end', a, w, (w & 0xffff0000) | STRIDE, f'{dis1(a)} -> +{STRIDE} (base reloaded from the stack)', f)
    # B. roster-size checks (cmplwi). The in-season limit is CUT (default 90): the roster editor's room/add/full checks
    # (0x4ed494 count callers), the roster-management cut state, and the offseason "Cut Players" stage (0x5041e4: a team
    # with more than CUT players is handed to the auto-cut 0x502cf8, which keeps CUT). The free-slot search that places a
    # new row (recruit signing) scans the whole stride. Recruiting is capped per class (25, TEAM.SNCT/SDUR sanctions),
    # not by roster room, so teams grow past CUT in the offseason and the stage trims them back.
    for a, old, newimm, note in ((0x17eda0, 0x28030046, CUT, f'roster has room: count < 70 -> {CUT}'), (0x1849d4, 0x28030046, CUT, f'add player: count < 70 -> {CUT}'),
                                 (0x1f1360, 0x28040046, CUT, f'roster-management cut state: count > 70 -> {CUT}'), (0x2529ec, 0x28040045, CUT - 1, f'roster full: count >= 69 -> {CUT - 1}'),
                                 (0x5045b8, 0x28030046, CUT, f'offseason cut stage: count > 70 -> {CUT} hands the team to the auto-cut'), (0x50217c, 0x281d0046, STRIDE, f'free-slot search loop: slot < 70 -> {STRIDE}')):
        cap_add('limit', a, old, (old & 0xffff0000) | newimm, note)
    # B2. the auto-cut's keep count (li r22,70 in 0x502cf8: players kept after the per-position pass) and the UI's
    # GetMaxTeamRosterSize (TeamAdapter vtable 0x189ee48 + 0x3c -> li r3,70; blr at 0x266710, the "X / 70" and
    # "must cut N players" figure in the Cut Players screens)
    cap_add('limit', 0x5031ac, 0x3ac00046, enc_li(22, CUT), f'auto-cut keeps 70 -> {CUT} players')
    cap_add('limit', 0x266710, 0x38600046, enc_li(3, CUT), f'GetMaxTeamRosterSize: 70 -> {CUT}')
    # C. the team-management module's six per-player arrays (12/14/27/4/2/2 bytes x 70): allocation size (+8 header) and init length
    for a, old, per in ((0x46e384, 0x38800350, 12), (0x46e3d8, 0x388003dc, 14), (0x46e414, 0x3880076a, 27), (0x46e450, 0x38800120, 4), (0x46e490, 0x38800094, 2), (0x46e4c4, 0x38800094, 2)):
        cap_add('tm-array', a, old, enc_li(4, per * STRIDE + 8), f'team management array {per} B/player: alloc {per * 70 + 8} -> {per * STRIDE + 8}')
    for a, old, per in ((0x46e4fc, 0x38a00348, 12), (0x46e514, 0x38a003d4, 14), (0x46e524, 0x38a00762, 27), (0x46e538, 0x38a00118, 4), (0x46e548, 0x38a0008c, 2), (0x46e558, 0x38a0008c, 2)):
        cap_add('tm-array', a, old, enc_li(5, per * STRIDE), f'team management array {per} B/player: init {per * 70} -> {per * STRIDE}')
    cap_sites.sort(key=lambda x: x['va'])
    seen_cap = {}
    for c in cap_sites:
        if c['va'] in seen_cap: raise SystemExit(f'capacity overlap at {c["va"]:#x}')
        seen_cap[c['va']] = 1
        if c['va'] in seen: raise SystemExit(f'capacity word overlaps the stride entry at {c["va"]:#x}')

# ---------------- outputs
applied = [s for s in sites if s['apply']]
words_out = sorted((a, old, new) for s in applied for a, (old, new) in s['words'].items())
counts = collections.Counter((s['kind'], s['apply']) for s in sites)
fx = lambda v: f'{v:#x}' if v else '0'
lines = [f'# Roster stride patch report (stride {STRIDE}, scope {SCOPE})', '',
         '| kind | applied | skipped |', '|---|---|---|']
for kind in ('div-mulli', 'div-magic', 'mul-chain', 'package', 'save-size', 'limit'):
    lines.append(f"| {kind} | {counts[(kind, True)]} | {counts[(kind, False)]} |")
lines += ['', f'{len(words_out)} words in all.', '', '## Skipped or flagged sites', '']
for s in sites:
    if s['apply'] and not s['flags']: continue
    lines.append(f"- {s['va']:#x} {s['kind']} [{'applied' if s['apply'] else 'skipped'}] {s['region']} fn={fx(s['function'])} dbq={s['dbq']} near={s['near']} 4cc={','.join(s['fourcc'])} flags={s['flags']} :: {s['note']}")
lines += ['', '## Multiply chains by use', '']
uses = collections.Counter((s.get('use'), s['apply']) for s in sites if s['kind'] == 'mul-chain')
for u in ('base', 'index', 'unknown'): lines.append(f"- {u}: {uses[(u, True)]} applied, {uses[(u, False)]} skipped")
lines += ['', '## Applied multiply chains with use=unknown (review)', '']
for s in applied:
    if s['kind'] == 'mul-chain' and s.get('use') == 'unknown': lines.append(f"- {s['va']:#x} fn={fx(s['function'])} near={s['near']} 4cc={','.join(s['fourcc'])} :: {s['note']}")
report = '\n'.join(lines)
print(report)
if rep_out: open(rep_out, 'w', encoding='utf8').write(report + '\n')
if json_out: open(json_out, 'w').write(json.dumps([{**s, 'va': f"{s['va']:#x}", 'function': f"{s['function']:#x}" if s['function'] else '', 'words': {f'{a:#x}': [f'{o:#010x}', f'{n:#010x}'] for a, (o, n) in s['words'].items()}} for s in sites], indent=1))
words_json = opt('--words')
if words_json:
    open(words_json, 'w').write(json.dumps([{'va': f'{a:#x}', 'old': f'{o:#010x}', 'new': f'{n:#010x}'} for a, o, n in words_out], indent=0))
if yml_out:
    y = ['  "FCS mod: 100-player rosters":', '    Games:', '      "NCAA Football 14":', '        BLUS31159: [ 01.00, 01.02 ]', '    Author: "football-sim-project"',
         f'    Notes: "PGID = TGID * {STRIDE} + slot instead of * 70: {counts[("div-mulli", True)]} mulli divisions, {counts[("div-magic", True)]} magic divisions, {counts[("mul-chain", True)]} shift-add multiplies, the league package PLAY rows ({STRIDE}) and the roster save buffer (0x1c0000). Needs dynasty/roster files re-keyed to stride {STRIDE} (ncaa-bridge roster grow). Generated by spike/blaze/tools/roster-stride-patch.py."',
         '    Patch Version: 1.0', '    Patch:']
    for a, old, new in words_out: y.append(f'      - [ be32, 0x{a:08x}, 0x{new:08x} ]')
    open(yml_out, 'w', encoding='utf8').write('\n'.join(y) + '\n')
    print(f'yml: {yml_out} ({len(words_out)} words)')
if CAPACITY:
    kinds = collections.Counter(c['kind'] for c in cap_sites)
    print(f"capacity entry: {len(cap_sites)} words ({dict(kinds)}); range ends kept at 70 in in-game functions: {len(excluded_range)}")
    for a, f in excluded_range: print(f'   kept +70: {a:#x} fn={fx(f)} tables={sorted(GA.get(f, set()) | GA_STR.get(f, set()))}')
    if cap_words: open(cap_words, 'w').write(json.dumps([{'va': f"{c['va']:#x}", 'old': f"{c['old']:#010x}", 'new': f"{c['new']:#010x}"} for c in cap_sites], indent=0))
    if cap_yml:
        y = ['  "FCS mod: 100-player rosters (capacity)":', '    Games:', '      "NCAA Football 14":', '        BLUS31159: [ 01.00, 01.02 ]', '    Author: "football-sim-project"',
             f'    Notes: "Dynasty-side roster capacity 70 -> {STRIDE} with an in-season limit of {CUT}: {kinds["range-end"]} player-id range ends (base + 70 -> base + {STRIDE}), {kinds["limit"]} roster-size words (the offseason Cut Players stage and the auto-cut keep {CUT}, GetMaxTeamRosterSize reports {CUT}, the roster editor allows {CUT}), the team management module\'s per-player arrays. Games still dress the first 70 slots of a team (the in-game tables and arrays stay 2 x 70). Requires the stride entry. Generated by spike/blaze/tools/roster-stride-patch.py --capacity --cut {CUT}."',
             '    Patch Version: 1.0', '    Patch:']
        for c in cap_sites: y.append(f"      - [ be32, 0x{c['va']:08x}, 0x{c['new']:08x} ]")
        open(cap_yml, 'w', encoding='utf8').write('\n'.join(y) + '\n')
        print(f'capacity yml: {cap_yml} ({len(cap_sites)} words)')
