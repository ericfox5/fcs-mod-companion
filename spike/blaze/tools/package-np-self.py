"""Package an adapter ELF with scetool; never installs or overwrites console files.

Run under WSL: package-np-self.py SCETOOL DATA_DIR ORIGINAL_EBOOT ADAPTER_ELF NEW_EBOOT
Requires operator-supplied scetool loader curves. Uses the original APP template;
this is an experimental retail SELF, not a claim of HEN/hardware compatibility.
"""
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys

sha = lambda b: hashlib.sha256(b).hexdigest()
ORIGINAL_SELF = '0fe9530fc77c7980e54a4d3c942c59d3b9130a1e80e27a6929b9e3a6f6b74e5a'

def loads(b):
    if b[:6] != b'\x7fELF\x02\x02': raise ValueError('Expected big-endian ELF64')
    base = struct.unpack_from('>Q',b,32)[0]
    stride,count = struct.unpack_from('>HH',b,54)
    return [struct.unpack_from('>IIQQQQQQ',b,base+i*stride) for i in range(count)]

def main():
    if len(sys.argv) != 6: raise ValueError(__doc__)
    tool,data,template,elf,dst = [Path(x).resolve() for x in sys.argv[1:]]
    report = Path(str(dst)+'.manifest.json'); decoded = Path(str(dst)+'.verified.elf')
    if any(p.exists() for p in (dst,report,decoded)): raise ValueError('Refusing overwrite')
    if sha(template.read_bytes()) != ORIGINAL_SELF: raise ValueError('Unsupported original SELF template')
    source=elf.read_bytes(); m=json.loads(Path(str(elf)+'.manifest.json').read_text())
    if sha(source) != m['outputSha256'] or not m.get('hooks') or m['titleId'] != 'BLUS31159':
        raise ValueError('Expected hash-matched adapter ELF and manifest')
    if not (data/'keys').is_file(): raise ValueError('Missing scetool DATA_DIR/keys with APP revision 0004')
    if not (data/'ldr_curves').is_file() or (data/'ldr_curves').stat().st_size != 7744:
        raise ValueError('Missing scetool DATA_DIR/ldr_curves (7744 bytes; APP revision 0004 uses curve 0x14)')
    env=dict(os.environ,PS3=str(data))
    def run(args):
        p=subprocess.run([str(tool),*args],env=env,capture_output=True,text=True)
        if p.returncode or 'Error:' in p.stdout+p.stderr:
            raise ValueError('scetool failed; no verified build. Inspect the local tool configuration.')
        return p
    # Include all original program headers, preserve the template APP identity/capabilities.
    args=['--template',str(template),'--sce-type','SELF','--compress-data','TRUE',
          '--skip-sections','FALSE','--encrypt',str(elf),str(dst)]
    run(args)
    packed=dst.read_bytes()
    if packed[:4] != b'SCE\0' or struct.unpack_from('>H',packed,8)[0] != 4:
        raise ValueError('Unexpected SELF magic/key revision')
    run(['--decrypt',str(dst),str(decoded)])
    recovered=decoded.read_bytes()
    before,after=loads(source),loads(recovered)
    if before != after: raise ValueError('Round-trip program headers differ')
    for typ,flags,off,va,pa,size,mem,align in before:
        if typ == 1 and source[off:off+size] != recovered[off:off+size]:
            raise ValueError(f'Round-trip load bytes differ at VA {va:x}')
    if source[16:40] != recovered[16:40]: raise ValueError('Round-trip executable identity/entry differs')
    verification=subprocess.run([sys.executable,str(Path(__file__).with_name('verify-self-signature.py')),str(data),str(dst)],
                                capture_output=True,text=True)
    if verification.returncode: raise ValueError('Independent SELF signature verification failed')
    result=dict(artifact='EXPERIMENTAL APP SELF; HEN loader test required',inputElfSha256=sha(source),
                templateSha256=ORIGINAL_SELF,outputSha256=sha(packed),toolSha256=sha(tool.read_bytes()),
                loaderCurvesSha256=sha((data/'ldr_curves').read_bytes()),argv=args,
                loadSegmentsRoundTripVerified=True,exactElfRoundTrip=source==recovered,
                cryptographicSignatureIndependentlyVerified=True,hardwareTested=False)
    with report.open('x') as f: json.dump(result,f,indent=2)
    print(json.dumps(result,indent=2))

if __name__ == '__main__':
    try: main()
    except Exception as e: print(str(e),file=sys.stderr);sys.exit(1)
