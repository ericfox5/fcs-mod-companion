"""Verify a console-initiated TCP connection to the same Node runtime as Blaze.
Uses active FTP to fetch only PARAM.SFO into a temporary Node receiver, not a game request.
"""
import ftplib,json,subprocess
js="""const net=require('net'),crypto=require('crypto');
const server=net.createServer(s=>{if(s.remoteAddress!=='192.168.137.2'){s.destroy();return}
 let chunks=[],size=0;s.on('data',b=>{size+=b.length;if(size>8192){s.destroy();process.exit(2)}chunks.push(b)});
 s.on('end',()=>{console.log(JSON.stringify({received:size,sha256:crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex')}));server.close()});});
server.listen(0,'0.0.0.0',()=>console.log(server.address().port));setTimeout(()=>process.exit(3),15000).unref();"""
p=subprocess.Popen(['node','-e',js],stdout=subprocess.PIPE,text=True)
try:
    port=int(p.stdout.readline())
    with ftplib.FTP('192.168.137.2',timeout=12,encoding='latin-1') as f:
        f.login();f.voidcmd('TYPE I');f.voidcmd(f'PORT 192,168,137,1,{port//256},{port%256}')
        f.sendcmd('RETR /dev_hdd0/game/BLUS31159/PARAM.SFO');f.voidresp()
    result=json.loads(p.stdout.readline());p.wait(timeout=5)
    if result['sha256']!='6920b30b9e1a80847b273c851002afdf676a62ef1d419d7d9be3dfd3f6cc1c69':raise RuntimeError('Unexpected metadata hash')
    print('PASS: PS3 initiated TCP to PC Node listener; title metadata received and hash verified')
finally:
    if p.poll() is None:p.kill()
