export const SESSION_COOKIE='__Host-supersim';
const enc=new TextEncoder();
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const unb64=s=>Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
async function key(secret){if(!secret||secret.length<32)throw new Error('Supersim session signing secret is not configured.');return crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
/** Call ONLY after your real login verifies the identity. Never feed a persona cookie into this. */
export async function issueSession(secret,{dynastyId,blazeId},now=Math.floor(Date.now()/1000)){
 const claims={v:1,dynastyId,blazeId,iat:now,exp:now+3600};
 const body=b64(enc.encode(JSON.stringify(claims)));const sig=b64(new Uint8Array(await crypto.subtle.sign('HMAC',await key(secret),enc.encode(body))));
 return `${SESSION_COOKIE}=${body}.${sig}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600`;
}
export async function verifySession(req,secret,now=Math.floor(Date.now()/1000)){
 try{const raw=(req.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(SESSION_COOKIE+'='))?.slice(SESSION_COOKIE.length+1);if(!raw||raw.length>2048)return null;
 const [body,sig,...rest]=raw.split('.');if(rest.length||!body||!sig)return null;
 if(!await crypto.subtle.verify('HMAC',await key(secret),unb64(sig),enc.encode(body)))return null;
 const p=JSON.parse(new TextDecoder().decode(unb64(body)));if(p.v!==1||!Number.isSafeInteger(p.blazeId)||!Number.isSafeInteger(p.dynastyId)||!Number.isFinite(p.exp)||!Number.isFinite(p.iat)||p.exp<=now||p.iat>now+60||p.exp-p.iat>3600)return null;return p;
 }catch{return null;}
}
export function allowedGame(dyn,member,game){return !!member&&Number.isInteger(member.tgid)&&member.tgid>0&&member.tgid<300&&!!game&&dyn.week_type!==151&&game.season_year===dyn.season_year&&game.week===dyn.week&&(game.home_tgid===member.tgid||game.away_tgid===member.tgid);}
export function sameOrigin(req){const origin=req.headers.get('origin');return !!origin&&origin===new URL(req.url).origin&&req.headers.get('content-type')?.split(';')[0]==='application/json';}
