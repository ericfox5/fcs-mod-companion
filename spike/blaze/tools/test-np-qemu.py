"""PPC64 instruction/ABI tests using QEMU linux-user, not RPCS3 NP emulation.
Run under WSL Python: test-np-qemu.py PATCHED.elf PROFILE.json
Builds a PRIVATE Linux test harness containing the supplied game image. Not a PS3 executable.
Only local RTC imports are mocked. NP hooks and the original completion polling run as PPC64.
"""
import hashlib, json, os, struct, subprocess, sys
from pathlib import Path

elf_path,profile_path = map(lambda s:Path(s).resolve(),sys.argv[1:3])
m=json.loads(Path(str(elf_path)+'.manifest.json').read_text()); p=json.loads(profile_path.read_text())
elf=elf_path.read_bytes(); out=elf_path.parent/'qemu-np-test';out.mkdir(exist_ok=True)
if hashlib.sha256(elf).hexdigest()!=m['outputSha256'] or hashlib.sha256(bytes.fromhex(p['ticketHex'])).hexdigest()!=m['credentialSha256']:
    raise SystemExit('ELF/profile does not match manifest')
tools=Path(__file__).resolve().parents[1]/'private/ppc-tools/root'
env=dict(os.environ,LD_LIBRARY_PATH=str(tools/'usr/lib/x86_64-linux-gnu'))
BUF,CTX,STACK,FLAG=0x2200000,0x2201000,0x2210000,0x2203000
lines=['.machine power4','.section .harness,"ax"','.balign 8','.global _start',
       '_start: .quad entry,0,0','entry:',f'lis 1,{STACK>>16}',f'ori 1,1,{STACK&65535}']
failures=[]
def emit(s): lines.append(s)
def imm(r,v):
    v &= 0xffffffff;emit(f'lis {r},{v>>16}');emit(f'ori {r},{r},{v&65535}')
def check(label):
    failures.append(label); return len(failures)
def eq(r,v,n):
    imm(12,v);emit(f'cmpw {r},12');emit(f'bne fail{n}')
def memory(addr,value,n,size='lwz'):
    imm(11,addr);emit(f'{size} 10,0(11)');eq(10,value,n)
def store(addr,value): imm(11,addr);imm(12,value);emit('stw 12,0(11)')
def call(name,args,result=0):
    n=check(name+' '+str(args)+' result '+hex(result))
    for r in [2,*range(13,32)]: imm(r,0x11220000+r)
    for r,v in enumerate(args,3): imm(r,v)
    emit(f'bl hook_{name}');eq(3,result,n)
    for r in [2,*range(13,32)]: eq(r,0x11220000+r,n)
    eq(1,STACK,n)
    return n
n=call('GetStatus',[BUF]);memory(BUF,3,n)
call('GetStatus',[0],0x8002aa03)
for name,size in [('GetNpId',36),('GetOnlineId',20),('GetSigninId',64)]:
    store(BUF+size,0xA5A5A5A5);n=call(name,[BUF]);memory(BUF,int.from_bytes(p['onlineId'].encode()[:4],'big'),n);memory(BUF+size,0xA5A5A5A5,n)
    expected=(p['onlineId']+('@league.invalid' if name=='GetSigninId' else '')).encode().ljust(size,b'\0')
    for i in range(0,size,4): memory(BUF+i,int.from_bytes(expected[i:i+4],'big'),n)
n=call('GetContentRatingFlag',[BUF,BUF+4]);memory(BUF,0,n);memory(BUF+4,18,n)
n=call('GetAccountRegion',[BUF,BUF+4]);memory(BUF,0x75730000,n);memory(BUF+4,1,n)
n=call('GetChatRestrictionFlag',[BUF]);memory(BUF,0,n)
store(FLAG,0);n=call('GetNetworkTime',[BUF]);memory(BUF,0x00e302e5,n);memory(BUF+4,0x55ce0000,n)
store(FLAG,0x80010601);call('GetNetworkTime',[BUF],0x80010601);store(FLAG,0)
call('GetTicket',[0,BUF],0x8002aa0a)
n=call('RegisterCallback',[BUF,CTX]);memory(CTX+0xe5,255,n,'lbz')
store(BUF,0x73657276);store(BUF+4,0x69636500) # service\0
n=call('RequestTicket2',[CTX+0x4c,BUF+100,BUF,0,0,0,0]);memory(CTX+0xe0,72,n);memory(CTX+0xe5,1,n,'lbz')
# Execute the actual successful caller instructions; its pending-flag clear must be a NOP.
imm(31,CTX);emit('li 3,0');emit(f'.incbin "{elf_path}",{0x719550-0x10000},24')
memory(CTX+0xe5,1,n,'lbz');memory(CTX+0xed,0,n,'lbz')
# Queue game callback descriptor and execute the ORIGINAL polling block twice.
imm(11,BUF+0x600);emit('lis 12,callback@ha');emit('addi 12,12,callback@l');emit('stw 12,0(11)')
store(CTX+0xb8,BUF+0x600);store(CTX+0xbc,BUF+0x700);store(BUF+0x704,0)
imm(31,CTX);emit('b game_poll');emit('poll_return:')
memory(BUF+0x700,72,n);memory(BUF+0x704,1,n);memory(CTX+0xe5,255,n,'lbz')
# Second poll cannot invoke the callback again. Redirect its test-only tail to a second label.
imm(11,0x71ac8c);emit('lis 12,poll_return2@ha');emit('addi 12,12,poll_return2@l')
emit('subf 12,11,12');emit('oris 12,12,0x4800');emit('stw 12,0(11)');emit('dcbst 0,11');emit('sync');emit('icbi 0,11');emit('isync')
imm(31,CTX);emit('b game_poll');emit('poll_return2:');memory(BUF+0x704,1,n)
n=call('GetTicket',[0,BUF]);memory(BUF,72,n)
store(BUF,71);store(BUF+100,0xa5a5a5a5);n=call('GetTicket',[BUF+100,BUF],0x8002aa0f);memory(BUF,72,n);memory(BUF+100,0xa5a5a5a5,n)
store(BUF,72);store(BUF+172,0xa5a5a5a5);n=call('GetTicket',[BUF+100,BUF]);memory(BUF+172,0xa5a5a5a5,n)
ticket=bytes.fromhex(p['ticketHex'])
for i in range(0,len(ticket),4): memory(BUF+100+i,int.from_bytes(ticket[i:i+4],'big'),n)
for param in range(12):
    store(BUF+256,0xa5a5a5a5);n=call('GetTicketParam',[param,BUF]);memory(BUF+256,0xa5a5a5a5,n)
    if param==4: memory(BUF,0,n);memory(BUF+4,p['userId'],n)
    if param==3: memory(BUF,p['expiresMs']>>32,n);memory(BUF+4,p['expiresMs']&0xffffffff,n)
    if param==8: memory(BUF,0x73657276,n);memory(BUF+4,0x69636500,n)
call('GetTicketParam',[12,BUF],0x8002aa03)
store(BUF,0x6e657700);call('RequestTicket2',[CTX+0x4c,BUF+100,BUF,0,0,0,0])
n=call('UnregisterCallback',[]);memory(CTX+0xe5,255,n,'lbz')
call('GetTicket',[0,BUF],0x8002aa0a)
call('RequestTicket2',[CTX+0x4c,BUF+100,BUF,0,0,0,0],0x8002aa0a)
emit('li 3,0');emit('b exit')
for i,msg in enumerate(failures,1):emit(f'fail{i}: li 3,{i}');emit('b exit')
emit('exit: li 0,1');emit('sc')
emit('callback: stw 3,0(4)');emit('lwz 5,4(4)');emit('addi 5,5,1');emit('stw 5,4(4)');emit('blr')
# Preserve game bytes except explicit test-only RTC stubs and poll-block exit.
emit('.section .game,"awx"')
replacements=[(0x71ac8c,4,['b poll_return']),
 (0x16d84f8,56,[f'lis 12,{FLAG>>16}',f'ori 12,12,{FLAG&65535}','lwz 3,0(12)','blr','.space 40']),
 (0x16d85d8,56,['lis 12,0x00e3','ori 12,12,0x02e5','stw 12,0(4)','lis 12,0x55ce','stw 12,4(4)','li 3,0','blr','.space 28'])]
pos=0
for va,sz,asm in replacements:
    off=va-0x10000;emit(f'.incbin "{elf_path}",{pos},{off-pos}');lines.extend(asm);pos=off+sz
emit(f'.incbin "{elf_path}",{pos},{len(elf)-pos}')
emit(f'.space {max(0,m["stateVa"]+128-(len(elf)+0x10000))}')
emit('.section .scratch,"aw",@nobits');emit('.space 0x20000')
(out/'test.S').write_text('\n'.join(lines)+'\n')
(out/'test.ld').write_text('ENTRY(_start)\n'+''.join(f'hook_{k} = {v};\n' for k,v in m['hooks'].items())+
 'game_poll = 0x71ac44;\nSECTIONS { .game 0x10000 : { *(.game) } .harness 0x2100000 : { *(.harness) } .scratch 0x2200000 : { *(.scratch) } }\n')
subprocess.run([str(tools/'usr/bin/powerpc64-linux-gnu-as'),'-a64','-mbig','-o',str(out/'test.o'),str(out/'test.S')],env=env,check=True)
subprocess.run([str(tools/'usr/bin/powerpc64-linux-gnu-ld'),'-m','elf64ppc','-T',str(out/'test.ld'),'-o',str(out/'test.elf'),str(out/'test.o')],env=env,check=True)
result=subprocess.run([str(tools/'usr/bin/qemu-ppc64'),'-cpu','970',str(out/'test.elf')],timeout=30)
if result.returncode:
    msg=failures[result.returncode-1] if 0 < result.returncode <= len(failures) else 'runner exception'
    raise SystemExit(f'FAIL {result.returncode}: {msg}')
print(f'PASS: {len(failures)} PPC64 hook scenarios, all ticket bytes, output bounds, ABI, RTC failure, cancellation and real deferred polling. RTC mocked; not RPCS3/game or hardware validation.')
