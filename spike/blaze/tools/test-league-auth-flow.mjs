// Isolated real TCP/HTTP handlers; never points at the running league or its stores.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { MAGIC,digest } from '../server/league-auth.mjs';
import { Writer } from '../server/tdf.mjs';
import { decode } from '../server/tdf.mjs';
import { PacketStream,encodePacket,MSG } from '../server/packet.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ncaa-auth-flow-'));
fs.mkdirSync(path.join(root,'server'));
for(const f of fs.readdirSync(new URL('../server/',import.meta.url)).filter(f=>f.endsWith('.mjs')))
  fs.copyFileSync(new URL('../server/'+f,import.meta.url),path.join(root,'server',f));
const ticket=n=>Buffer.concat([MAGIC,Buffer.alloc(64,n)]),ta=ticket(1),tb=ticket(2);
const registry={version:1,players:[{userId:101,onlineId:'CoachSame',ticketSha256:digest(ta),joinDynasties:[]},
 {userId:202,onlineId:'CoachSame',ticketSha256:digest(tb),joinDynasties:[]}]};
const registryPath=path.join(root,'registry.json'),save=()=>fs.writeFileSync(registryPath,JSON.stringify(registry));save();
async function freePort(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const port=await freePort(),httpPort=await freePort();
const child=spawn(process.execPath,[path.join(root,'server/blaze.mjs'),'--port',String(port),'--http-port',String(httpPort),
 '--easw','off','--sync','off','--ticket-registry',registryPath],{stdio:['ignore','pipe','pipe']});
let log='';child.stdout.on('data',d=>{log+=d});child.stderr.on('data',d=>{log+=d});
const clients=[];
try{
 await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('Server startup timeout: '+log)),8000);
  const check=d=>{if(String(d).includes('blaze stub listening')){clearTimeout(t);resolve();}};child.stdout.on('data',check);
  child.once('exit',code=>{clearTimeout(t);reject(new Error(`Server exited ${code}: ${log}`))});});
 async function client(){const sock=net.connect(port,'127.0.0.1');await once(sock,'connect');clients.push(sock);const stream=new PacketStream(),pending=new Map();let id=1;
  sock.on('data',data=>{for(const p of stream.feed(data)){const job=pending.get(p.id);if(job&&p.type!==MSG.NOTIFY){pending.delete(p.id);clearTimeout(job.timer);job.resolve({type:p.type,body:decode(p.payload)});}}});
  return async(component,command,build)=>{const w=new Writer();build?.(w);const seq=id++;return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error(`Timeout ${component}/${command}: ${log}`)),3000);pending.set(seq,{resolve,timer});
   sock.write(encodePacket({component,command,id:seq,type:MSG.REQUEST,payload:w.bytes()}));});};}
 const a=await client(),b=await client();
 assert.equal((await a(2148,2,w=>w.str('NAME','unauth'))).type,MSG.ERROR);
 assert.equal((await a(1,200,w=>w.blob('TCKT',ticket(3)))).type,MSG.ERROR);
 const la=await a(1,200,w=>w.blob('TCKT',ta)),lb=await b(1,200,w=>w.blob('TCKT',tb));
 assert.equal(la.body.SESS.UID,101);assert.equal(lb.body.SESS.UID,202);
 const ca=await a(2148,2,w=>w.str('NAME','A')),cb=await b(2148,2,w=>w.str('NAME','B'));
 const did=Number(ca.body.DID);assert.notEqual(did,Number(cb.body.DID));
 assert.equal((await b(2148,5,w=>w.int('DID',did))).type,MSG.ERROR);
 assert.equal((await b(2148,22,w=>w.str('NAME','A'))).body.DLST.items.length,0);
 registry.players[1].joinDynasties=[did];save();
 const found=await b(2148,22,w=>w.str('NAME','A'));
 assert.equal(found.body.DLST.items[0].DID,did);
 assert.equal((await b(2148,6,w=>w.int('DID',did))).type,MSG.RESPONSE);
 assert.equal((await b(2148,88,w=>w.int('DYID',did))).type,MSG.ERROR);
 const created=await a(20,1,w=>{w.str('CCAT','LeagueStorage');w.int('COID',202);w.str('NAME','TEST.dynasty')});
 const info=created.body.INFO,cid=Number(info.CID);assert.equal(Number(info.EID),101);assert.equal(Number(info.COID),101);
 assert.equal((await fetch(`http://127.0.0.1:${httpPort}/locker/upload?cid=${cid}`,{method:'POST',body:'bad'})).status,403);
 assert.equal((await fetch(info.UURL,{method:'POST',body:'saved dynasty'})).status,200);
 assert.equal((await b(20,8,w=>w.int('CID',cid))).type,MSG.ERROR);
 assert.equal((await a(20,14,w=>{w.int('CID',cid);w.objid('GPID',2148,1,did)})).type,MSG.RESPONSE);
 const shared=await b(20,8,w=>w.int('CID',cid));assert.equal(shared.type,MSG.RESPONSE);
 assert.equal(await(await fetch(shared.body.INFO.GURL)).text(),'saved dynasty');
 assert.equal((await fetch(shared.body.INFO.UURL,{method:'POST',body:'overwritten'})).status,403);
 assert.equal((await b(20,4,w=>{w.int('CID',cid);w.str('NAME','stolen')})).type,MSG.ERROR);
 // Full commissioner save, a separate member team save, and reconnect.
 assert.equal((await a(2148,56,w=>{w.int('DYID',did);w.int('UPDT',0)})).type,MSG.RESPONSE);
 assert.equal((await b(2148,56,w=>{w.int('DYID',did);w.int('UPDT',1)})).type,MSG.ERROR);
 assert.equal((await a(2148,57,w=>{w.int('DYID',did);w.int('UPDT',0);w.int('FID',cid);w.int('NWWK',4);w.int('NWYR',1)})).type,MSG.RESPONSE);
 const team=await b(20,1,w=>{w.str('CCAT','LeagueStorage');w.str('NAME','PLAYER.team')});
 const tid=Number(team.body.INFO.CID);
 assert.equal((await fetch(team.body.INFO.UURL,{method:'POST',body:'member team save'})).status,200);
 assert.equal((await b(2148,56,w=>{w.int('DYID',did);w.int('UPDT',1)})).type,MSG.RESPONSE);
 assert.equal((await b(2148,12,w=>{w.int('DYID',did);w.int('TABL',0x4d414554)})).type,MSG.RESPONSE);
 assert.equal((await b(2148,57,w=>{w.int('DYID',did);w.int('UPDT',1);w.int('TMID',42);w.int('FID',cid)})).type,MSG.ERROR);
 assert.equal((await b(2148,57,w=>{w.int('DYID',did);w.int('UPDT',1);w.int('TMID',42);w.int('FID',tid);w.int('NWWK',99)})).type,MSG.RESPONSE);
 assert.ok(fs.existsSync(path.join(root,'private/dynasty-member-tables',String(did),'202/TEAM.json')));
 const reconnected=await client();
 assert.equal((await reconnected(1,200,w=>w.blob('TCKT',tb))).body.SESS.UID,202);
 assert.equal((await reconnected(2148,5,w=>w.int('DID',did))).type,MSG.RESPONSE);
 assert.equal((await reconnected(2148,88,w=>w.int('DYID',did))).type,MSG.ERROR);
 registry.players[0].disabled=true;save();
 assert.equal((await fetch(info.UURL,{method:'POST',body:'revoked'})).status,403);
 assert.equal((await a(2148,88,w=>w.int('DYID',did))).type,MSG.ERROR);
 assert.equal((await b(2148,13)).type,MSG.RESPONSE);
 console.log('PASS: real isolated Blaze/Locker handlers: credential verification, two IDs/same name, creation, granted join, denied advance, capability upload/download, isolated transactions/table snapshots, commissioner/member saves, reconnect, ownership and revocation.');
}finally{for(const c of clients)c.destroy();child.kill();console.log('Isolated test artifacts:',root);}
