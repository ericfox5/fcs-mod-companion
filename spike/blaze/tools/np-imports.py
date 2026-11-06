"""Read-only BLUS31159 NP import/caller inventory. Requires Python 3; no SDK."""
import hashlib
import json
import re
import struct
import sys

data = open(sys.argv[1], 'rb').read()
assert data[:6] == b'\x7fELF\x02\x02', 'expected ELF64 big-endian'
u16 = lambda o: struct.unpack_from('>H', data, o)[0]
u32 = lambda o: struct.unpack_from('>I', data, o)[0]
u64 = lambda o: struct.unpack_from('>Q', data, o)[0]
segments = []
for i in range(u16(56)):
    p = u64(32) + i * u16(54)
    kind, flags, off, va, _, size, mem, align = struct.unpack_from('>IIQQQQQQ', data, p)
    if kind == 1:
        segments.append(dict(va=va, offset=off, size=size, memory=mem, flags=flags))

def offset(va, size=4):
    matches = [s['offset'] + va - s['va'] for s in segments
               if s['va'] <= va and va + size <= s['va'] + s['size']]
    if len(matches) != 1:
        raise ValueError(f'unmapped/ambiguous VA {va:x}')
    return matches[0]

names = ['sceNpManager' + n for n in ['GetStatus', 'GetNpId', 'GetOnlineId',
    'RequestTicket', 'RequestTicket2', 'GetTicket', 'GetTicketParam',
    'RegisterCallback', 'UnregisterCallback', 'GetAccountRegion',
    'GetContentRatingFlag', 'GetChatRestrictionFlag', 'GetNetworkTime', 'GetOnlineName',
    'GetSigninId']]
names += ['cellRtcGetCurrentTick','cellRtcGetCurrentClock','cellRtcGetTick','cellRtcSetTick','cellRtcGetTime_t']
if len(sys.argv) > 2:
    names += re.findall(r'REG_FUNC\(sceNp, (\w+)\)', open(sys.argv[2], encoding='utf-8').read())
salt = bytes.fromhex('6759659904250490566427499489741a')
nids = {int.from_bytes(hashlib.sha1(n.encode() + salt).digest()[:4], 'little'): n for n in names}
found = []
for o in range(0, len(data) - 44, 4):
    if data[o] not in (0x2c, 0x1c) or not 0 < u16(o+6) < 1000:
        continue
    try:
        no = offset(u32(o+16), 1)
        end = data.index(0, no)
        name = data[no:end].decode('ascii')
        if not name.startswith('sceNp') and name != 'cellRtc':
            continue
        count = u16(o+6)
        ni, st = offset(u32(o+20), count*4), offset(u32(o+24), count*4)
        for j in range(count):
            nid, stub = u32(ni+j*4), u32(st+j*4)
            if nid in nids:
                found.append(dict(name=nids[nid], library=name, nid=f'{nid:08x}',
                                  stub=stub, stubHex=f'0x{stub:08x}', offset=offset(stub), callers=[]))
    except (ValueError, UnicodeError, struct.error):
        continue
targets = {f['stub']: f for f in found}
for s in segments:
    if not s['flags'] & 1:
        continue
    for off in range(s['offset'], s['offset']+s['size']-3, 4):
        w = u32(off)
        if w >> 26 == 18:
            delta = w & 0x3fffffc
            if delta & 0x2000000:
                delta -= 0x4000000
            at = s['va'] + off - s['offset']
            target = delta if w & 2 else at + delta
            if target in targets:
                targets[target]['callers'].append(f'0x{at:08x}')
print(json.dumps(dict(sha256=hashlib.sha256(data).hexdigest(), segments=segments, imports=found), indent=2))
