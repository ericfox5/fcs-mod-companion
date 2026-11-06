"""Restore known update-1.02 metadata after confirmed disc-executable fallback.
Run from project root; requires XMB and exact before/after hashes. Saves remote rollback.
"""
import ftplib,hashlib,importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('transfer',Path(__file__).with_name('ps3-test-transfer.py'))
t=importlib.util.module_from_spec(spec);spec.loader.exec_module(t)
host='192.168.137.2';t.xmb(host)
root=Path('spike/blaze/private');source=root/'PARAM-update-1.02-test.SFO'
old='8ae6e6615e533b18818406853c0aff8f1d788435933db5731d9c6d6c68702806'
new='6920b30b9e1a80847b273c851002afdf676a62ef1d419d7d9be3dfd3f6cc1c69'
if t.sha(source.read_bytes())!=new:raise RuntimeError('Unsupported replacement metadata')
backup=root/'console-backup-2026-11-03-np-test-complete/PARAM.SFO'
if t.sha(backup.read_bytes())!=old:raise RuntimeError('Missing original metadata backup')
remote='/dev_hdd0/game/BLUS31159/PARAM.SFO'
with ftplib.FTP(host,timeout=30,encoding='latin-1') as ftp:
    ftp.login()
    def digest(path):
        h=hashlib.sha256();ftp.retrbinary('RETR '+path,h.update);return h.hexdigest()
    if digest(remote)!=old:raise RuntimeError('Remote metadata changed')
    names={n for n,d,s in t.listing(ftp,remote.rsplit('/',1)[0])}
    if {'PARAM.SFO.np-test-upload','PARAM.SFO.before-np-test'}&names:raise RuntimeError('Rollback/staging file exists')
    with source.open('rb') as f:ftp.storbinary('STOR '+remote+'.np-test-upload',f)
    if digest(remote+'.np-test-upload')!=new:raise RuntimeError('Upload mismatch; original unchanged')
    t.xmb(host);ftp.rename(remote,remote+'.before-np-test')
    try:ftp.rename(remote+'.np-test-upload',remote)
    except Exception:
        ftp.rename(remote+'.before-np-test',remote);raise
    if digest(remote)!=new:raise RuntimeError('Installed metadata mismatch')
    result=dict(target=remote,beforeSha256=old,afterSha256=new,remoteRollback=remote+'.before-np-test',verified=True)
    (root/'console-backup-2026-11-03-np-test-complete/metadata-installation.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result))
