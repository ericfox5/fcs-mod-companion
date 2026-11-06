"""Read only selected network settings from PS3 registry; never persist raw registry."""
import ftplib,json,struct,sys
chunks=[]
with ftplib.FTP(sys.argv[1],timeout=20,encoding='latin-1') as f:
    f.login();f.retrbinary('RETR /dev_flash2/etc/xRegistry.sys',chunks.append)
b=b''.join(chunks);pos=0x10000;result={}
allowed={'enable','ipAddress','netmask','defaultRoute','primaryDns','secondaryDns','ipConfig','dnsFlag','connectType','dnsConfig'}
while pos+9<len(b):
    off=struct.unpack_from('>H',b,pos+2)[0]+0x12;length=struct.unpack_from('>H',b,pos+6)[0]
    if off==0xccdd or off+3>=len(b) or pos+9+length>=len(b):break
    size=struct.unpack_from('>H',b,off)[0]
    key=b[off+3:off+3+size].rstrip(b'\0').decode('ascii',errors='replace')
    if key.startswith('/setting/net/') and key.split('/')[-1] in allowed:
        value=b[pos+9:pos+9+length]
        result[key]=int.from_bytes(value,'big') if length==4 else value.rstrip(b'\0').decode('ascii',errors='replace')
    pos+=10+length
print(json.dumps(result,indent=2))
