"""Independent APP-04 SELF signature check: OpenSSL AES + stdlib ECC arithmetic.

Usage (WSL): verify-self-signature.py DATA_DIR ORIGINAL_OR_REBUILT_SELF
No key material is printed. Verifies the public key, not merely a decrypt round trip.
"""
import configparser
import hashlib
from pathlib import Path
import struct
import subprocess
import sys

def verify(data, filename):
    keys=configparser.ConfigParser();keys.read(data/'keys')
    records=[v for v in keys.values() if v.get('self_type')=='APP' and int(v.get('revision','-1'),16)==4]
    if len(records)!=1: raise ValueError('Expected one APP-04 key record')
    k=records[0]; b=filename.read_bytes()
    if b[:4]!=b'SCE\0' or struct.unpack_from('>H',b,8)[0]!=4: raise ValueError('Expected SELF revision 4')
    off=32+struct.unpack_from('>I',b,12)[0]; end=struct.unpack_from('>Q',b,16)[0]
    def aes(cipher,key,iv,block):
        return subprocess.run(['openssl','enc','-'+cipher,'-d','-nopad','-K',key,'-iv',iv],
                              input=block,capture_output=True,check=True).stdout
    meta=aes('aes-256-cbc',k['erk'],k['riv'],b[off:off+64])
    if meta[16:32]!=bytes(16) or meta[48:64]!=bytes(16): raise ValueError('Metadata padding failed')
    plain=b[:off]+meta+aes('aes-128-ctr',meta[:16].hex(),meta[32:48].hex(),b[off+64:end])
    sig=struct.unpack_from('>Q',plain,off+64)[0]
    if not off+64 < sig < end-42: raise ValueError('Invalid signature offset')
    raw=(data/'ldr_curves').read_bytes(); c=int(k['ctype'],16)*121
    curve=bytes(x^255 for x in raw[c:c+121])
    def number(x,y): return int.from_bytes(curve[x:y],'big')
    p,a,bb,n=number(0,20),number(20,40),number(40,60),number(60,81)
    g=(number(81,101),number(101,121));pub=bytes.fromhex(k['pub'])
    q=(int.from_bytes(pub[:20],'big'),int.from_bytes(pub[20:],'big'))
    def add(x,y):
        if x is None:return y
        if y is None:return x
        if x[0]==y[0] and (x[1]+y[1])%p==0:return None
        slope=((3*x[0]*x[0]+a)*pow(2*x[1],-1,p) if x==y else (y[1]-x[1])*pow(y[0]-x[0],-1,p))%p
        xx=(slope*slope-x[0]-y[0])%p
        return xx,(slope*(x[0]-xx)-x[1])%p
    def mul(k,x):
        r=None
        while k:
            if k&1:r=add(r,x)
            x=add(x,x);k>>=1
        return r
    for point in (g,q):
        if (point[1]**2-point[0]**3-a*point[0]-bb)%p or mul(n,point) is not None:
            raise ValueError('Invalid curve/public-key point')
    r=int.from_bytes(plain[sig:sig+21],'big');s=int.from_bytes(plain[sig+21:sig+42],'big')
    if not 0<r<n or not 0<s<n:raise ValueError('Invalid signature scalar')
    z=int.from_bytes(hashlib.sha1(plain[:sig]).digest(),'big');w=pow(s,-1,n)
    point=add(mul(z*w%n,g),mul(r*w%n,q))
    if point is None or point[0]%n!=r:raise ValueError('SELF signature verification failed')
    return hashlib.sha256(b).hexdigest()

if __name__=='__main__':
    try:
        digest=verify(Path(sys.argv[1]),Path(sys.argv[2]))
        print('PASS: APP-04 ECDSA signature independently verified; SHA256 '+digest)
    except Exception as e:print(str(e),file=sys.stderr);sys.exit(1)
