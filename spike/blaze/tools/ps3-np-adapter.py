"""Build an UNSIGNED, experimental BLUS31159 1.02 game-local NP adapter.

No SDK, no Sony credentials. Python stdlib + Node (existing baseline patcher).
Leaf hooks use only r3-r12/CR0. The RTC wrapper saves/restores stack and LR;
its existing import thunks preserve r2. No hook changes nonvolatile registers.
They replace verified direct callsites, not loader-owned import stubs.
"""
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
INPUT_HASH = '144dee9040da9cb1e8337844fbb685a0f06e560b8fee8d9ba1eac87b9e300c1c'
SALT = bytes.fromhex('6759659904250490566427499489741a')
def nid(name):
    return int.from_bytes(hashlib.sha1(name.encode() + SALT).digest()[:4], 'little')
def d(op, rt, ra, imm):
    return (op << 26) | (rt << 21) | (ra << 16) | (imm & 65535)
def jump(at, target, link=False):
    delta = target - at
    if delta % 4 or not -0x2000000 <= delta <= 0x1fffffc:
        raise ValueError('branch reach/alignment')
    return 0x48000000 | (delta & 0x3fffffc) | int(link)

class Code:
    def __init__(self, base):
        self.base, self.words, self.labels, self.fixups = base, [], {}, []
    @property
    def pc(self): return self.base + 4 * len(self.words)
    def emit(self, w): self.words.append(w)
    def mark(self, label):
        if label in self.labels: raise ValueError('duplicate label')
        self.labels[label] = self.pc
    def li(self, r, value): self.emit(d(14,r,0,value))
    def addr(self, r, value):
        self.emit(d(15,r,0,value >> 16))
        self.emit((24 << 26) | (r << 21) | (r << 16) | (value & 65535))
    def cmp(self, r, value): self.emit(d(11,0,r,value))
    def branch(self, label, condition=None):
        self.fixups.append((len(self.words), label, condition)); self.emit(0)
    def ret(self, value=0):
        if -32768 <= value <= 32767: self.li(3,value)
        else: self.addr(3,value)
        self.emit(0x4e800020)
    def check(self, r, error='invalid'):
        self.cmp(r,0); self.branch(error,'eq')
    def bytes_to(self, dest, value):
        # Byte stores avoid alignment assumptions of the NP structs.
        last = None
        for i, v in enumerate(value):
            if last != v: self.li(12,v); last = v
            self.emit(d(38,12,dest,i))
    def finish(self):
        for index, label, cond in self.fixups:
            at, target = self.base+4*index, self.labels[label]
            if cond is None: self.words[index] = jump(at,target)
            else:
                delta = target-at
                if delta % 4 or not -32768 <= delta <= 32764: raise ValueError('conditional branch reach')
                self.words[index] = {'eq':0x41820000,'ne':0x40820000,'lt':0x41800000,'ge':0x40800000}[cond] | (delta & 0xfffc)
        return b''.join(struct.pack('>I',w) for w in self.words)

def build(original, profile):
    if hashlib.sha256(original).hexdigest() != INPUT_HASH: raise ValueError('Unsupported or modified input ELF')
    uid, name = profile['userId'], profile['onlineId']
    if not isinstance(uid,int) or not 0 < uid <= 0x7fffffff: raise ValueError('userId must be a positive signed 31-bit league ID')
    import re
    if not re.fullmatch(r'[A-Za-z0-9_-]{3,16}',name): raise ValueError('onlineId must be 3..16 ASCII characters')
    ticket = bytes.fromhex(profile['ticketHex'])
    if len(ticket) != 72 or ticket[:8] != b'FCSNP001': raise ValueError('Expected provisioned league credential')
    issued, expires = profile['issuedMs'], profile['expiresMs']
    if not isinstance(issued,int) or not isinstance(expires,int) or not 0 <= issued < expires < 2**63:
        raise ValueError('Invalid ticket lifetime')
    u16 = lambda o: struct.unpack_from('>H',original,o)[0]
    u32 = lambda o: struct.unpack_from('>I',original,o)[0]
    u64 = lambda o: struct.unpack_from('>Q',original,o)[0]
    segs = []
    for i in range(u16(56)):
        p = u64(32)+i*u16(54)
        kind,flags,off,va,pa,size,mem,align = struct.unpack_from('>IIQQQQQQ',original,p)
        if kind == 1 and size: segs.append(dict(header=p,flags=flags,offset=off,va=va,size=size,memory=mem))
    def offset(va, size=4):
        found = [s['offset']+va-s['va'] for s in segs if s['va'] <= va and va+size <= s['va']+s['size']]
        if len(found) != 1: raise ValueError(f'unmapped VA {va:x}')
        return found[0]
    imports = {}
    for o in range(0,len(original)-44,4):
        if original[o] not in (0x1c,0x2c) or not 0 < u16(o+6) < 1000: continue
        try:
            n = u16(o+6); ni = offset(u32(o+20),n*4); st = offset(u32(o+24),n*4)
            no = offset(u32(o+16),1); lib = original[no:original.index(0,no)].decode('ascii')
            if lib not in ('sceNp','cellRtc'): continue
            for j in range(n): imports[(lib,u32(ni+j*4))] = u32(st+j*4)
        except (ValueError,UnicodeError,struct.error): pass
    rx = next(s for s in segs if s['flags'] & 1)
    rw = next(s for s in segs if s['flags'] & 2)
    cave = (rx['va']+rx['size']+15)&~15
    state = (rw['va']+rw['memory']+15)&~15
    if state+128 >= 0x10000000: raise ValueError('unexpected data placement')
    c = Code(cave)
    hooks = {}
    def start(name): hooks[name] = c.pc; c.mark(name)
    def output_hook(name, value):
        start(name); c.check(3); c.bytes_to(3,value); c.ret()
    output_hook('GetStatus',struct.pack('>I',3))
    output_hook('GetNpId',name.encode().ljust(36,b'\0'))
    output_hook('GetOnlineId',name.encode().ljust(20,b'\0'))
    output_hook('GetSigninId',(name+'@league.invalid').encode().ljust(64,b'\0'))
    output_hook('GetChatRestrictionFlag',bytes(4))
    # Existing RTC imports, not an NP/network-time service. The import thunks restore r2.
    start('GetNetworkTime'); c.check(3)
    c.emit(0x7c0802a6); c.emit(0xf8010010); c.emit(0xf821ff61)  # mflr; std LR; stdu -0xa0
    c.emit(0xf8610070); c.emit(d(14,3,1,0x80)); c.li(4,0)
    c.emit(jump(c.pc,imports[('cellRtc',nid('cellRtcGetCurrentClock'))],True))
    c.cmp(3,0); c.branch('rtc_end','ne')
    c.emit(d(14,3,1,0x80)); c.emit(0xe8810070)
    c.emit(jump(c.pc,imports[('cellRtc',nid('cellRtcGetTick'))],True))
    c.mark('rtc_end'); c.emit(d(14,1,1,0xa0)); c.emit(0xe8010010); c.emit(0x7c0803a6); c.emit(0x4e800020)
    start('GetContentRatingFlag'); c.check(3); c.check(4)
    c.bytes_to(3,bytes(4)); c.bytes_to(4,struct.pack('>I',18)); c.ret()
    start('GetAccountRegion'); c.check(3); c.check(4)
    c.bytes_to(3,b'us\0\0'); c.bytes_to(4,struct.pack('>I',1)); c.ret()
    start('RegisterCallback'); c.check(3); c.check(4); c.addr(11,state)
    c.emit(d(36,4,11,0)); c.li(12,0); c.emit(d(36,12,11,8))
    c.emit(d(38,12,4,0xe4)); c.li(12,-1); c.emit(d(38,12,4,0xe5)); c.ret()
    start('UnregisterCallback'); c.addr(11,state); c.emit(d(32,10,11,0)); c.cmp(10,0); c.branch('unregistered','eq')
    c.li(12,-1); c.emit(d(38,12,10,0xe5)); c.li(12,0); c.emit(d(38,12,10,0xed)); c.emit(d(38,12,10,0xe4))
    c.mark('unregistered'); c.li(12,0); c.emit(d(36,12,11,0)); c.emit(d(36,12,11,8)); c.ret()
    start('RequestTicket2'); c.check(3); c.check(4); c.check(5); c.addr(11,state)
    c.emit(d(32,10,11,0)); c.check(10,'notready')
    # The sole caller already holds NetConn's mutex. Do NOT call the manager callback here.
    # Copy service into private BSS; all consumers see the last successful request's service.
    c.li(6,0); c.emit(d(14,7,11,16)); c.mark('service_copy')
    c.emit(d(34,12,5,0)); c.emit(d(38,12,7,0)); c.cmp(12,0); c.branch('service_done','eq')
    c.emit(d(14,5,5,1)); c.emit(d(14,7,7,1)); c.emit(d(14,6,6,1)); c.cmp(6,63); c.branch('service_copy','lt')
    c.li(12,0); c.emit(d(38,12,7,0)); c.branch('invalid')
    c.mark('service_done'); c.li(12,1); c.emit(d(36,12,11,8)); c.emit(d(38,12,10,0xe5))
    c.li(12,len(ticket)); c.emit(d(36,12,10,0xe0)); c.ret()
    start('GetTicket'); c.check(4); c.addr(11,state); c.emit(d(32,12,11,8)); c.check(12,'notready')
    c.emit(d(32,5,4,0)); c.li(12,len(ticket)); c.emit(d(36,12,4,0)); c.cmp(3,0); c.branch('success','eq')
    c.emit(d(10,0,5,len(ticket))); c.branch('small','lt'); c.bytes_to(3,ticket); c.ret()
    start('GetTicketParam'); c.check(4); c.addr(11,state); c.emit(d(32,12,11,8)); c.check(12,'notready')
    # Validate ID before clearing the 256-byte SceNpTicketParam union.
    c.emit(d(10,0,3,12)); c.branch('invalid','ge')
    c.bytes_to(4,bytes(256))
    values = {0:hashlib.sha256(ticket).digest()[:20],1:struct.pack('>I',1),2:struct.pack('>Q',issued),
              3:struct.pack('>Q',expires),4:struct.pack('>Q',uid),5:name.encode()+b'\0',6:b'us\0\1',7:b'league\0',
              9:bytes(4),10:bytes(4),11:struct.pack('>HBB',2000,1,1)}
    for param in range(12):
        c.cmp(3,param); c.branch(f'param{param}','eq')
    c.branch('invalid')
    for param,value in values.items():
        c.mark(f'param{param}'); c.bytes_to(4,value); c.ret()
    c.mark('param8'); c.li(5,0); c.emit(d(14,6,11,16)); c.mark('param_service')
    c.emit(d(34,12,6,0)); c.emit(d(38,12,4,0)); c.cmp(12,0); c.branch('success','eq')
    c.emit(d(14,6,6,1)); c.emit(d(14,4,4,1)); c.emit(d(14,5,5,1)); c.cmp(5,64); c.branch('param_service','lt'); c.branch('invalid')
    c.mark('success'); c.ret()
    c.mark('invalid'); c.ret(0x8002aa03)
    c.mark('notready'); c.ret(0x8002aa0a)
    c.mark('small'); c.ret(0x8002aa0f)
    payload = c.finish()
    cave_off = rx['offset']+cave-rx['va']; end = cave_off+len(payload)
    if end > rw['offset'] or cave+len(payload) > rw['va'] or any(original[cave_off:end]):
        raise ValueError('No verified zero gap for RX extension')
    # Reject overlap with any file-backed section, including zero-filled sections.
    for i in range(u16(60)):
        p = u64(40)+i*u16(58)
        if u32(p+4) == 8: continue  # SHT_NOBITS
        off,size = u64(p+24),u64(p+32)
        if size and off < end and off+size > cave_off: raise ValueError('Code gap overlaps section')
    # Reuse the independently tested baseline builder, always from the untouched input.
    js = "import fs from 'node:fs'; import {patchBaseline} from './spike/blaze/tools/ps3-eboot.mjs'; process.stdout.write(patchBaseline(fs.readFileSync(0),{commissioner:true}).output);"
    out = bytearray(subprocess.run(['node','--input-type=module','-e',js],input=original,stdout=subprocess.PIPE,check=True,cwd=ROOT).stdout)
    out[cave_off:end] = payload
    struct.pack_into('>Q',out,rx['header']+32,cave+len(payload)-rx['va'])
    struct.pack_into('>Q',out,rx['header']+40,cave+len(payload)-rx['va'])
    struct.pack_into('>Q',out,rw['header']+40,state+128-rw['va'])
    patches = []
    expected_counts = {'GetStatus':13,'GetNpId':10,'GetOnlineId':1,'GetSigninId':1,'GetChatRestrictionFlag':1,
        'GetContentRatingFlag':2,'GetAccountRegion':3,'RegisterCallback':1,'UnregisterCallback':1,
        'RequestTicket2':1,'GetTicket':6,'GetTicketParam':8,'GetNetworkTime':2}
    for name,target in hooks.items():
        stub = imports[('sceNp',nid('sceNpManager'+name))]; count = 0
        for s in segs:
            if not s['flags'] & 1: continue
            for off in range(s['offset'],s['offset']+s['size']-3,4):
                w = u32(off)
                if w >> 26 != 18 or w & 2: continue
                delta = w & 0x3fffffc
                if delta & 0x2000000: delta -= 0x4000000
                at = s['va']+off-s['offset']
                if at+delta != stub: continue
                if not w & 1: raise ValueError('Unexpected tail call')
                replacement = jump(at,target,True); struct.pack_into('>I',out,off,replacement)
                patches.append(dict(name=name,va=at,offset=off,original=f'{w:08x}',replacement=f'{replacement:08x}')); count+=1
        if count != expected_counts[name]: raise ValueError(f'Unexpected {name} caller count: {count}')
    # Preserve our queued completion instead of resetting it after the request returns.
    at = 0x719560; off = offset(at)
    if u32(off) != 0x987f00e5: raise ValueError('Request pending flag original differs')
    struct.pack_into('>I',out,off,0x60000000)
    patches.append(dict(name='retain-deferred-completion',va=at,offset=off,original='987f00e5',replacement='60000000'))
    manifest = dict(format=1,titleId='BLUS31159',version='01.02',artifact='UNSIGNED EXPERIMENTAL no-PSN adapter + offseason + five-dynasty fix',
        inputSha256=INPUT_HASH,outputSha256=hashlib.sha256(out).hexdigest(),credentialSha256=hashlib.sha256(ticket).hexdigest(),
        userId=uid,onlineId=profile['onlineId'],hooks=hooks,stateVa=state,codeVa=cave,codeOffset=cave_off,codeSize=len(payload),
        patches=patches,segmentsBefore=segs,
        headerWrites=[dict(offset=p,original=original[p:p+8].hex(),replacement=bytes(out[p:p+8]).hex())
                      for p in (rx['header']+32,rx['header']+40,rw['header']+40)],
        baselineIncluded=True,emulatorTested=False,hardwareTested=False,selfSigned=False,
        limitations=['Requires credential registry server mode, not legacy arbitrary-ticket login','EASW disabled in initial authenticated mode',
                      'NP Basic/Lookup and indirect NP paths are not emulated','RX/BSS extension requires loader validation'])
    return bytes(out),manifest

if __name__ == '__main__':
    try:
        if len(sys.argv) != 4: raise ValueError('Usage: ps3-np-adapter.py ORIGINAL.elf PRIVATE-PROFILE.json NEW.elf')
        src,prof,dst = map(Path,sys.argv[1:]); mf = Path(str(dst)+'.manifest.json')
        if dst.exists() or mf.exists() or src.resolve() == dst.resolve(): raise ValueError('Refusing overwrite')
        out,manifest = build(src.read_bytes(),json.loads(prof.read_text(encoding='utf-8-sig')))
        with dst.open('xb') as f: f.write(out)
        with mf.open('x') as f: json.dump(manifest,f,indent=2)
        print(json.dumps({k:manifest[k] for k in ['artifact','outputSha256','codeVa','codeSize','stateVa']},indent=2))
    except Exception as e:
        print(str(e),file=sys.stderr); sys.exit(1)
