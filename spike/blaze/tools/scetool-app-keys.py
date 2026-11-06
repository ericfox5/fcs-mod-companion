"""Convert public RPCS3 APP key records for local scetool inspection.

Input is RPCS3 rpcs3/Crypto/key_vault.cpp; no network or secret output.
This does NOT supply loader curves or establish that a SELF is HEN compatible.
"""
import hashlib
import json
from pathlib import Path
import re
import sys

source, destination = map(Path, sys.argv[1:3])
revision = int(sys.argv[3],0) if len(sys.argv)>3 else 4
data = source.read_bytes()
records = re.findall(r'sk_APP_arr.emplace_back\(0x([0-9a-fA-F]+),\s*0x([0-9a-fA-F]+),\s*0x([0-9a-fA-F]+),\s*KEY_APP,\s*"([0-9a-fA-F]+)",\s*"([0-9a-fA-F]+)",\s*"([0-9a-fA-F]+)",\s*"([0-9a-fA-F]*)",\s*0x([0-9a-fA-F]+)\)', data.decode())
selected = [r for r in records if int(r[2],16) == revision]
if len(selected) != 1:
    raise SystemExit('Expected one APP record for selected revision')
lo,hi,rev,erk,riv,pub,priv,curve = selected[0]
text = f'[ncaa-app-04]\ntype=SELF\nrevision={rev}\nversion={hi}\nself_type=APP\nerk={erk}\nriv={riv}\npub={pub}\npriv={priv.zfill(42)}\nctype={curve}\n'
destination.mkdir(exist_ok=True)
with (destination/'keys').open('x',newline='\n') as f: f.write(text)
print(json.dumps({'sourceSha256':hashlib.sha256(data).hexdigest(),'revision':rev,'curve':curve,
                  'nonzeroPrivateKey':int(priv or '0',16)!=0,'missing':'ldr_curves (7744 bytes) for signing'}))
