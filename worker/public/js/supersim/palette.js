// Logo-derived accent selection, with explicit overrides for ambiguous multicolor marks.
export const OVERRIDES = {harvard:'#a51c30',dartmouth:'#00693e',brown:'#623c2a'};
export function paletteFromPixels(data) {
 const bins=new Map();
 for(let i=0;i<data.length;i+=4){const [r,g,b,a]=data.slice(i,i+4);if(a<180)continue;const hi=Math.max(r,g,b),lo=Math.min(r,g,b);if(hi>238&&lo>225||hi<28||hi-lo<25)continue;
 const key=[r,g,b].map(v=>Math.round(v/24)*24).join(',');bins.set(key,(bins.get(key)||0)+1);
 }
 const best=[...bins].sort((a,b)=>b[1]-a[1])[0];return best?'#'+best[0].split(',').map(v=>Math.min(255,+v).toString(16).padStart(2,'0')).join(''):null;
}
export async function teamColor(team) {
 const key=Object.keys(OVERRIDES).find(k=>team.name.toLowerCase().includes(k));
 if(/^#[\da-f]{6}$/i.test(team.color||''))return team.color;
 if(key)return OVERRIDES[key];
 if(!team.logo)return '#496caa';
 try {const img=new Image();img.crossOrigin='anonymous';img.src=team.logo;await Promise.race([img.decode(),new Promise((_,rej)=>setTimeout(()=>rej(new Error('Logo timeout')),2500))]);const c=document.createElement('canvas');c.width=c.height=48;const ctx=c.getContext('2d');ctx.drawImage(img,0,0,48,48);return paletteFromPixels(ctx.getImageData(0,0,48,48).data)||'#496caa';}catch{return '#496caa';}
}
export function readableAccent(hex) {
 let rgb=hex.slice(1).match(/../g).map(x=>parseInt(x,16));const lum=c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;};
 while((.2126*lum(rgb[0])+.7152*lum(rgb[1])+.0722*lum(rgb[2])+.05)/(.006+.05)<5 && Math.min(...rgb)<245)rgb=rgb.map(x=>Math.min(255,x+8));
 return '#'+rgb.map(x=>x.toString(16).padStart(2,'0')).join('');
}
