// Small college-town environment, drawn as resolution-independent SVG geometry.
export function stadiumMarkup(){
 let s='<g class="ss-campus" aria-hidden="true"><path d="M-80 105 Q160 30 360 95T1090 85V620H-80Z" fill="var(--hill)"/>';
 const houses=[[30,74,64,45],[115,60,80,59],[222,73,58,46],[695,57,76,62],[801,72,60,47],[885,52,91,67]];
 for(const [x,y,w,h] of houses){s+=`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="var(--brick)" stroke="var(--building-line)"/><path d="M${x-5} ${y} L${x+w/2} ${y-18} L${x+w+5} ${y}Z" fill="var(--roof)"/>`;for(let j=10;j<w-5;j+=17)for(let k=10;k<h-5;k+=18)s+=`<rect x="${x+j}" y="${y+k}" width="7" height="10" fill="var(--window)"/>`;}
 s+='<g fill="var(--brick)" stroke="var(--building-line)"><path d="M342 118V47H455V118Z"/><path d="M545 118V47H658V118Z"/><path d="M462 118V25H538V118Z"/><path d="M490 25V-13H510V25Z"/></g><path d="M450 28L500 -2L550 28Z" fill="var(--roof)"/><circle cx="500" cy="44" r="12" fill="var(--clock-face)"/><path d="M500 35V44L507 48" stroke="#343d40" stroke-width="2" fill="none"/>';
 for(const x of [355,377,399,421,555,577,599,621])for(const y of [61,85])s+=`<rect x="${x}" y="${y}" width="11" height="16" fill="var(--window)"/>`;
 for(const x of [464,482,500,518])s+=`<rect x="${x}" y="73" width="12" height="34" rx="6" fill="var(--window)"/>`;
 for(const x of [-5,105,203,299,677,782,875,1000])s+=`<path d="M${x} 133v-22" stroke="var(--tree-trunk)" stroke-width="5"/><ellipse cx="${x}" cy="99" rx="19" ry="29" fill="var(--tree)"/>`;
 s+='<path d="M0 142Q500 110 1000 142" fill="none" stroke="var(--walkway)" stroke-width="15"/></g>';
 for(const side of [-1,1]){const x=n=>500+side*n; s+=`<g class="ss-bleachers"><path d="M${x(205)} 151L${x(270)} 135L${x(448)} 475L${x(365)} 490Z" fill="var(--stand-base)" stroke="var(--rail)"/>`;
 for(let row=0;row<7;row++){const top=210+row*8,bot=369+row*10;s+=`<path d="M${x(top)} ${153-row*2}L${x(bot)} ${488-row*2}" stroke="var(--seat)" stroke-width="6"/>`;for(let j=0;j<21;j++){const f=j/21,xx=x(top+(bot-top)*f),yy=153-row*2+(335)*f;s+=`<circle cx="${xx}" cy="${yy-2}" r="${1.4+f}" fill="${(j+row)%4===0?'var(--brand)':(j+row)%3===0?'#d1c8b3':'#536474'}"/>`;}}
 s+=`<path d="M${x(201)} 144L${x(361)} 480M${x(276)} 129L${x(453)} 469" stroke="var(--rail)" stroke-width="2"/></g>`;
 for(const [distance,y] of [[295,130],[460,460]])s+=`<g class="ss-floodlight"><path d="M${x(distance)} ${y}v-93" stroke="var(--rail)" stroke-width="4"/><rect x="${x(distance)-18}" y="${y-98}" width="36" height="11" rx="3" fill="var(--lamp)"/><path class="ss-lightbeam" d="M${x(distance)} ${y-88}L${x(distance-side*95)} ${y+90}L${x(distance-side*240)} ${y+40}Z" fill="#fff1ac" opacity="var(--beam-opacity)"/></g>`;}
 return s;
}
