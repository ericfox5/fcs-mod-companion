"""Summarize Ethernet/IPv4 endpoint counts from pcapng; never prints payloads."""
import collections,json,struct,sys
from pathlib import Path
b=Path(sys.argv[1]).read_bytes();pos=0;endian='<';flows=collections.Counter();packets=0;dns=set()
while pos+12<=len(b):
    if b[pos:pos+4]==b'\x0a\x0d\x0d\x0a':endian='<' if b[pos+8:pos+12]==b'\x4d\x3c\x2b\x1a' else '>'
    kind,size=struct.unpack_from(endian+'II',b,pos)
    if size<12 or pos+size>len(b):raise ValueError('Invalid pcapng block')
    if kind==6:
        packets+=1;cap=struct.unpack_from(endian+'I',b,pos+20)[0];p=b[pos+28:pos+28+cap]
        ip=14
        if len(p)>18 and p[12:14]==b'\x81\x00':ip=18
        if len(p)>=ip+20 and p[ip-2:ip]==b'\x08\x00':
            proto=p[ip+9];src='.'.join(map(str,p[ip+12:ip+16]));dst='.'.join(map(str,p[ip+16:ip+20]));off=ip+(p[ip]&15)*4
            sp,dp=struct.unpack_from('>HH',p,off) if proto in (6,17) and len(p)>=off+4 else (0,0)
            flows[(proto,src,sp,dst,dp)]+=1
            if proto==17 and dp==53 and len(p)>off+20:
                q=off+20;parts=[]
                while q<len(p) and p[q] and p[q]<64:
                    n=p[q];q+=1
                    if q+n>len(p):break
                    parts.append(p[q:q+n].decode('ascii',errors='replace'));q+=n
                if parts:dns.add('.'.join(parts))
    pos+=size
print(json.dumps({'capturedPackets':packets,'dnsQuestions':sorted(dns),'flows':[dict(protocol=k[0],source=f'{k[1]}:{k[2]}',destination=f'{k[3]}:{k[4]}',packets=v) for k,v in flows.most_common(60)]},indent=2))
