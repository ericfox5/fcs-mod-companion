// Read-only webMAN process inspection. Never reads the credential/ticket payload.
import fs from 'node:fs';
const host=process.argv[2]??'192.168.137.2';
const get=async route=>{const r=await fetch(`http://${host}${route}`,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.text()};
const page=await get('/home.ps3mapi');
const pid=page.match(/<option value="(0x[0-9a-f]+)"\/>[^<]*main_EBOOT\.BIN/i)?.[1];
if(!pid){console.log('No running EBOOT process (XMB).');process.exit(0)}
async function memory(addr,len){
 const html=await get(`/getmem.ps3mapi?proc=${pid}&addr=${addr.toString(16)}&len=${len}`);
 const hex=html.match(/<textarea id="output"[^>]*>([0-9a-f]+)<\/textarea>/i)?.[1];
 if(!hex||hex.length!==len*2)throw new Error('Memory read failed');return Buffer.from(hex,'hex');
}
const code=await memory(0x719b80,32),state=await memory(0x1d61150,80);
const result={at:new Date().toISOString(),pid,signInCallWord:code.subarray(8,12).toString('hex'),adapterLoaded:code.readUInt32BE(8)===0x494a8b69};
if(result.adapterLoaded){
 const ctx=state.readUInt32BE(0);result.contextVa='0x'+ctx.toString(16);result.ticketAvailable=state.readUInt32BE(8);
 if(ctx>0x10000&&ctx<0x40000000){const b=await memory(ctx,256);Object.assign(result,{completionDescriptor:b.readUInt32BE(0xb8),ticketPointer:b.readUInt32BE(0xc0),ticketSize:b.readUInt32BE(0xc4),completionResult:b.readInt32BE(0xe0),pending:b.readInt8(0xe5),ready:b[0xed]});}
}
if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify(result,null,2));
