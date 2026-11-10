// Play art shared by Supersim's play picker (supersim/coach.js) and the Playbook page (playbook/playbook.js): the
// 120x80 diagram tile drawn from a book's JSON (slots at their set coordinates, each slot's art path in yards), the
// play family labels and filters, and the play lookup. Vanilla ES module, no libraries; runs under CSP script-src 'self'.
// Data shapes: packages/ncaa14/src/playbook/types.ts (Book / SetDef / Play / Assign).
const NS = 'http://www.w3.org/2000/svg';
export function sv(tag, attrs, ...kids) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) { const v = attrs[k]; if (v != null && v !== false) e.setAttribute(k, v); }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
}

// plain DOM counterpart of sv: attributes, `class`, `text`, on<event> listeners, children (nodes or text)
export function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) { const v = attrs[k]; if (v == null || v === false) continue; if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k[0] === 'o' && k[1] === 'n') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v); }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
}

export const PASS_T = new Set([1, 3, 4, 5, 6, 7, 20, 100, 101, 102, 103, 104, 105, 106, 157, 159]);
export const FAM_LABEL = { run: 'Run', pass: 'Pass', pa: 'PA', screen: 'Screen', option: 'Option', kick: 'Kick', punt: 'Punt', kneel: 'Kneel', spike: 'Spike', man: 'Man', zone: 'Zone', blitz: 'Blitz', return: 'Return', fg: 'FG', other: '' };
export const FILTERS = { off: [['all', 'All'], ['run', 'Run'], ['pass', 'Pass'], ['special', 'Special']], def: [['all', 'All'], ['zone', 'Zone'], ['man', 'Man'], ['blitz', 'Blitz']] };

// a play by id with the first set and formation that list it (the book's own index, built once)
export function findPlay(book, id) {
  if (!book || id == null) return null;
  if (!book._idx) { book._idx = new Map(); for (const f of book.formations || []) for (const s of f.sets || []) for (const pid of s.plays || []) if (!book._idx.has(pid)) book._idx.set(pid, { set: s, form: f }); }
  const hit = book._idx.get(id); const play = book.plays?.[String(id)]; return hit && play ? { play, set: hit.set, form: hit.form } : null;
}
// play family from play.t plus the assignment kinds (kick vs punt, PA, screen)
export function fam(book, play) {
  if (!play) return 'other'; const t = play.t;
  if (book.side === 'def') return t === 33 || t === 34 ? 'man' : t === 42 || t === 43 || t === 45 || t === 36 ? 'zone' : t === 46 || t === 47 ? 'blitz' : t === 35 ? 'return' : t >= 49 && t <= 51 ? 'fg' : 'other';
  const kinds = (play.a || []).map((i) => book.asg?.[i]?.k);
  if (t === 21) return kinds.includes('punt') ? 'punt' : 'kick';
  if (t === 37) return 'kneel'; if (t === 38) return 'spike';
  if (PASS_T.has(t)) return kinds.includes('qbpa') ? 'pa' : kinds.includes('screen') ? 'screen' : 'pass';
  if (t === 17 || (t >= 162 && t <= 172)) return 'option';
  return 'run';
}
export const inFilter = (f, fm) => f === 'all' || (f === 'run' ? fm === 'run' || fm === 'option' : f === 'pass' ? fm === 'pass' || fm === 'pa' || fm === 'screen' : f === 'special' ? ['kick', 'punt', 'kneel', 'spike'].includes(fm) : f === fm);

// pts: screen points; a: assignment; u: size unit for the end caps
export function artPath(pts, a, cls, u) {
  const g = sv('g', { class: `art ${cls} k-${a.k || 'move'}` });
  g.append(sv('polyline', { points: pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') }));
  const [x1, y1] = pts[pts.length - 2], [x2, y2] = pts[pts.length - 1]; const ang = Math.atan2(y2 - y1, x2 - x1);
  if (a.c === 1) { const px = -Math.sin(ang) * 6 * u, py = Math.cos(ang) * 6 * u; g.append(sv('line', { x1: x2 - px, y1: y2 - py, x2: x2 + px, y2: y2 + py })); }
  else if (a.c === 2) { const L = 8 * u, wd = 4 * u; const bx = x2 - Math.cos(ang) * L, by = y2 - Math.sin(ang) * L; g.append(sv('polygon', { class: 'arrow', points: `${x2},${y2} ${bx - Math.sin(ang) * wd},${by + Math.cos(ang) * wd} ${bx + Math.sin(ang) * wd},${by - Math.cos(ang) * wd}` })); }
  else if (a.c >= 3) { const r = (a.c === 3 ? 4 : a.c === 4 ? 6 : 9) * u; g.append(sv('ellipse', { class: 'zone', cx: x2, cy: y2, rx: r * 1.4, ry: r })); }
  return g;
}
// per-set framing so every tile of a set shares one scale (art clamped so a Hail Mary does not shrink the rest)
export function setFrame(book, set) {
  if (set._fr) return set._fr;
  let x0 = -8, x1 = 8, y0 = -2, y1 = 4;
  const add = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  for (const s of set.slots || []) add(s.x, s.y);
  const yMax = book.side === 'off' ? 22 : 24;
  for (const id of set.plays || []) { const p = book.plays?.[String(id)]; if (!p) continue; p.a.forEach((ai, i) => { const a = book.asg?.[ai], s = set.slots[i]; if (!a?.p || !s) return; for (const [px, py] of a.p) add(Math.max(-30, Math.min(30, s.x + (px || 0))), Math.max(-20, Math.min(yMax, s.y + (py || 0)))); }); }
  const TW = 120, TH = 80, pad = 6; const sc = Math.min(3.2, (TW - pad * 2) / (x1 - x0), (TH - pad * 2) / (y1 - y0)); const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  set._fr = { sc, tx: (x, y) => [TW / 2 + (x - cx) * sc, TH / 2 - (y - cy) * sc] };
  return set._fr;
}
// the 120x80 tile: line of scrimmage, each slot's art, the men (offense circles, the centre a square, the carrier hot;
// defenders as X). `book` must be the book whose asg the play's `a` indexes.
export function diagram(book, play, set) {
  const fr = setFrame(book, set); const svg = sv('svg', { viewBox: '0 0 120 80', class: `ss-dia ${book.side}`, 'aria-hidden': 'true' });
  const ly = fr.tx(0, 0)[1]; svg.append(sv('line', { class: 'd-los', x1: 0, y1: ly, x2: 120, y2: ly }));
  const art = sv('g'), men = sv('g');
  (set.slots || []).forEach((s, i) => {
    const a = book.asg?.[play.a?.[i]]; const [x, y] = fr.tx(s.x, s.y);
    if (a?.p && a.p.length > 1) art.append(artPath(a.p.map(([px, py]) => fr.tx(s.x + (px || 0), s.y + (py || 0))), a, '', 0.4));
    if (book.side === 'off') men.append(s.pos === 7 ? sv('rect', { class: 'd-man', x: x - 2.2, y: y - 2.2, width: 4.4, height: 4.4 }) : sv('circle', { class: 'd-man' + (a?.k === 'carry' ? ' hot' : ''), cx: x, cy: y, r: 2.3 }));
    else men.append(sv('path', { class: 'd-man x', d: `M${x - 2.2} ${y - 2.2}L${x + 2.2} ${y + 2.2}M${x + 2.2} ${y - 2.2}L${x - 2.2} ${y + 2.2}` }));
  });
  svg.append(art, men); return svg;
}
