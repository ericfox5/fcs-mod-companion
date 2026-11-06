"""Explicit backup/install helper for the authorized BLUS31159 physical test.
backup HOST NEW_BACKUP_DIR | install HOST BACKUP_DIR PLAYER_A_SELF
Never touches disc files or saves on the console; install preserves a remote rollback copy.
"""
import ftplib, hashlib, json, re, sys, urllib.request
from pathlib import Path

TARGET='/dev_hdd0/game/BLUS31159/USRDIR/EBOOT.BIN'
ORIGINAL='0fe9530fc77c7980e54a4d3c942c59d3b9130a1e80e27a6929b9e3a6f6b74e5a'
PLAYER_A='105e30d78a91c6e9aa3d1589cde8fcaf4972b0a4bb01a3584fb4e049908ce325'
sha=lambda b:hashlib.sha256(b).hexdigest()

def xmb(host):
    html=urllib.request.urlopen('http://'+host+'/cpursx.ps3',timeout=15).read().decode(errors='replace')
    if '(XMB)' not in html:raise RuntimeError('Console does not report XMB; close the game first')

def listing(ftp,remote):
    rows=[];ftp.retrlines('LIST '+remote,rows.append);out=[]
    for row in rows:
        p=row.split(None,8)
        if len(p)!=9:raise RuntimeError('Unrecognized FTP listing')
        name=p[8]
        if name in ('.','..'):continue
        if '/' in name or '\\' in name:raise RuntimeError('Invalid remote name')
        if p[0][0] not in ('d','-'):raise RuntimeError('Unsupported remote file type')
        out.append((name,p[0][0]=='d',int(p[4])))
    return out

def download(ftp,remote,local):
    local.parent.mkdir(parents=True,exist_ok=True)
    h=hashlib.sha256();size=0
    with local.open('xb') as f:
        def block(b):
            nonlocal size
            f.write(b);h.update(b);size+=len(b)
        ftp.retrbinary('RETR '+remote,block,262144)
    return dict(remote=remote,local=str(local),size=size,sha256=h.hexdigest())

def main():
    mode,host,directory=sys.argv[1:4];root=Path(directory).resolve();xmb(host)
    ftp=ftplib.FTP(host,timeout=30,encoding='latin-1');ftp.login();ftp.set_pasv(True)
    try:
        if mode=='backup':
            root.mkdir(parents=True,exist_ok=False);records=[]
            records.append(download(ftp,TARGET,root/'EBOOT.BIN'))
            records.append(download(ftp,'/dev_hdd0/game/BLUS31159/PARAM.SFO',root/'PARAM.SFO'))
            def tree(remote,local):
                for name,isdir,size in listing(ftp,remote):
                    if isdir:tree(remote+'/'+name,local/name)
                    else:
                        record=download(ftp,remote+'/'+name,local/name)
                        if record['size']!=size:raise RuntimeError('Downloaded size mismatch')
                        records.append(record)
            for user,isdir,_ in listing(ftp,'/dev_hdd0/home'):
                if isdir and re.fullmatch(r'\d{8}',user):
                    children=listing(ftp,'/dev_hdd0/home/'+user)
                    if any(n=='savedata' and d for n,d,s in children):
                        tree('/dev_hdd0/home/'+user+'/savedata',root/'saves'/user)
                        print('Savedata backed up: '+user,flush=True)
            manifest=dict(host=host,gameClosed=True,files=records,complete=True)
            (root/'backup.json').write_text(json.dumps(manifest,indent=2))
            print(json.dumps(dict(backup=str(root),files=len(records),bytes=sum(r['size'] for r in records),ebootSha256=records[0]['sha256'])))
        elif mode=='install':
            manifest=json.loads((root/'backup.json').read_text())
            if not manifest.get('complete') or manifest['host']!=host:raise RuntimeError('Complete matching backup required')
            for record in manifest['files']:
                if sha(Path(record['local']).read_bytes())!=record['sha256']:raise RuntimeError('Backup verification failed')
            if sha((root/'EBOOT.BIN').read_bytes())!=ORIGINAL:raise RuntimeError('Console original differs from supported template')
            build=Path(sys.argv[4]);payload=build.read_bytes()
            if sha(payload)!=PLAYER_A:raise RuntimeError('Wrong Player A SELF hash')
            current=[];ftp.retrbinary('RETR '+TARGET,current.append,262144)
            if sha(b''.join(current))!=ORIGINAL:raise RuntimeError('Remote executable changed since backup')
            staged=TARGET+'.np-test-upload';rollback=TARGET+'.before-np-test'
            names={n for n,d,s in listing(ftp,TARGET.rsplit('/',1)[0])}
            if staged.rsplit('/',1)[1] in names or rollback.rsplit('/',1)[1] in names:raise RuntimeError('Remote test/rollback name already exists')
            with build.open('rb') as f:ftp.storbinary('STOR '+staged,f,262144)
            check=[];ftp.retrbinary('RETR '+staged,check.append,262144)
            if sha(b''.join(check))!=PLAYER_A:raise RuntimeError('Staged upload verification failed; original untouched')
            xmb(host)
            ftp.rename(TARGET,rollback)
            try:ftp.rename(staged,TARGET)
            except Exception:
                ftp.rename(rollback,TARGET);raise
            check=[];ftp.retrbinary('RETR '+TARGET,check.append,262144)
            if sha(b''.join(check))!=PLAYER_A:raise RuntimeError('Installed verification failed; use remote rollback copy')
            result=dict(target=TARGET,sha256=PLAYER_A,remoteRollback=rollback,verified=True)
            (root/'installation.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
        else:raise ValueError('Expected backup or install')
    finally:ftp.quit()

if __name__=='__main__':main()
