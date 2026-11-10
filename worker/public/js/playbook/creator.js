// The play creator: draw an offensive play for one set of the book. A field canvas (SVG, yards) with the set's eleven
// men, an assignment panel for the selected man (route / carry / block / pass block / release / fake / stalk / move,
// quarterback: drop-back, play action, handoff, read option), presets, waypoints added by clicking the field and
// dragged by their handles, the progression, and a live tile exactly as the picker will show it. The result is a
// DrawnPlay (packages/ncaa14/src/playbook/model.ts) kept in the book's edits; the server compiles it into the game's own
// step language when the edits are saved (playbook/compile.ts), so this file only draws and checks the obvious.
import { sv, h, diagram, FAM_LABEL } from './art.js';

export const POS = ['QB', 'HB', 'FB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT', 'LE', 'RE', 'DT', 'LLB', 'MLB', 'RLB', 'CB', 'FS', 'SS', 'K', 'P', 'KR', 'PR', 'KO', 'LS'];
export const DROPS = ['Drop back', 'Quick game', 'Deep drop', 'Roll right', 'Roll left', 'Screen', 'RPO'];
const QB_KINDS = ['qb', 'qbpa', 'handoff', 'qbopt'];
const KIND_LABEL = { route: 'Route', stalk: 'Stalk block', block: 'Run block', pblock: 'Pass block', release: 'Release (screen)', carry: 'Carry', fake: 'Fake handoff', move: 'Move', qb: 'Pass', qbpa: 'Play action', handoff: 'Handoff', qbopt: 'Read option' };
const PATH_KINDS = new Set(['route', 'stalk', 'block', 'release', 'carry', 'fake', 'move', 'qbopt']);
const isOL = (pos) => pos >= 5 && pos <= 9;
const kindsFor = (slot) => (slot.pos === 0 ? QB_KINDS : isOL(slot.pos) ? ['block', 'pblock', 'release'] : ['route', 'carry', 'block', 'pblock', 'release', 'fake', 'stalk', 'move', 'qb', 'handoff']);
// presets in yards for a man on the right side (x right, y downfield); mirrored for a man on the left
const ROUTES = [['Go', [[0, 20]]], ['Slant', [[0, 3], [-6, 8]]], ['Out', [[0, 10], [8, 10]]], ['In', [[0, 12], [-12, 12]]], ['Post', [[0, 10], [-6, 20]]], ['Corner', [[0, 10], [6, 20]]], ['Curl', [[0, 12], [-1.5, 10.5]], { sit: 1.5 }], ['Hitch', [[0, 5], [-1, 4]], { sit: 1.5 }], ['Comeback', [[0, 14], [2, 11]]], ['Flat', [[0, 1], [8, 3]]], ['Wheel', [[6, 2], [8, 20]]], ['Drag', [[0, 3], [-16, 5]]], ['Fade', [[2, 6], [3, 22]]]];
const RUNS = [['Dive', [[2, 2], [2.5, 9]]], ['Off tackle', [[4, 1], [6, 9]]], ['Toss', [[8, -1], [12, 7]]], ['Draw', [[0, 2], [1, 9]], { delay: 0.5 }], ['Counter', [[-2, 0], [3, 2], [5, 9]]]];
const r1 = (n) => Math.round(n * 10) / 10;
const mirror = (p, left) => p.map(([x, y]) => [left ? -x : x, y]);

// the play's family from the quarterback's assignment, as the compiler's playType decides it
export function familyOf(draw) {
  const qb = (draw.slots || []).find((s) => s && QB_KINDS.includes(s.k));
  if (!qb) return (draw.slots || []).some((s) => s && s.k === 'carry') ? 'run' : 'pass';
  if (qb.k === 'qbpa') return 'pa'; if (qb.k === 'handoff') return 'run'; if (qb.k === 'qbopt') return 'option';
  return Number(qb.o?.drop) === 5 ? 'screen' : 'pass';
}
// a book-shaped preview of a drawn play, for diagram(): kinds and caps the way the compiled play will come back
export function previewBook(draw, set) {
  const asg = set.slots.map((sl) => { const d = draw.slots?.[sl.i] || { k: isOL(sl.pos) ? 'pblock' : 'route' }; const p = d.p && d.p.length ? [[0, 0], ...d.p] : null;
    switch (d.k) {
      case 'route': return { r: 0, k: 'route', p: p || [[0, 0], [0, 10]], c: 2 };
      case 'stalk': return { r: 0, k: 'route', p: p || [[0, 0], [0, 10]], c: 1 };
      case 'block': return { r: 0, k: 'block', p: p && !isOL(sl.pos) ? p : [[0, 0], [0, 1]], c: 1 };
      case 'pblock': return { r: 0, k: 'pblock', p: [[0, 0], [0, 1]], c: 1 };
      case 'release': return { r: 0, k: 'block', p: p || [[0, 0], [0, 1]], c: 1 };
      case 'carry': return { r: 0, k: 'carry', p: p || [[0, 0], [0, 6]], c: 2 };
      case 'fake': return { r: 0, k: 'pblock', p: p || [[0, 0], [2, 1]], c: 1 };
      case 'move': return { r: 0, k: 'move', p: p || [[0, 0], [0, 3]], c: 2 };
      case 'qb': { const drop = Number(d.o?.drop); return drop === 3 || drop === 4 ? { r: 0, k: 'qb', p: [[0, 0], [drop === 3 ? 4 : -4, -3], [drop === 3 ? 7 : -7, -2]], c: 2 } : { r: 0, k: 'qb' }; }
      case 'qbopt': return p ? { r: 0, k: 'qbopt', p, c: 2 } : { r: 0, k: 'qbopt' };
      default: return { r: 0, k: d.k };
    } });
  const play = { id: 0, n: draw.n, t: 0, sit: 2, f: 0, v: 1, a: asg.map((_, i) => i) };
  return { book: { side: 'off', asg, plays: { 0: play } }, play };
}
// a stock play as a drawing to start from: kinds and paths from its assignments, the quarterback's drop from the type
export function drawFromPlay(book, play, set) {
  const slots = set.slots.map((sl, i) => {
    const a = book.asg?.[play.a?.[i]] || { k: 'move' }; const p = a.p && a.p.length > 1 ? a.p.slice(1).map(([x, y]) => [r1(x), r1(y)]) : undefined;
    switch (a.k) {
      case 'route': case 'screen': return p ? { k: 'route', p } : { k: 'route', p: [[0, 10]] };
      case 'block': return p && !isOL(sl.pos) && p.length ? { k: 'block', p } : { k: 'block' };
      case 'pblock': return { k: 'pblock' };
      case 'carry': return { k: 'carry', p: p || [[0, 6]] };
      case 'move': return p ? { k: 'move', p } : { k: 'move', p: [[0, 3]] };
      case 'qb': { const t = play.t; const drop = t === 101 ? 1 : t === 7 ? (p && p[p.length - 1][0] < 0 ? 4 : 3) : t === 5 || t === 100 ? 5 : t === 6 ? 6 : 0; return { k: 'qb', o: { drop } }; }
      case 'qbpa': { const back = set.slots.find((s, j) => j !== i && (s.pos === 1 || s.pos === 2)); return { k: 'qbpa', o: { fake: back ? back.i : 1 } }; }
      case 'handoff': return { k: 'handoff' };
      case 'qbopt': return p ? { k: 'qbopt', p } : { k: 'qbopt' };
      default: return isOL(sl.pos) ? { k: 'block' } : { k: 'route', p: [[0, 10]] };
    }
  });
  // play action: the back who fakes becomes a fake, the first pass blocker among the backs
  if (slots.some((s) => s.k === 'qbpa')) { const fakeI = slots.find((s) => s.k === 'qbpa').o.fake; if (slots[fakeI] && slots[fakeI].k === 'pblock') slots[fakeI] = { k: 'fake', p: [[set.slots[fakeI].x < 0 ? 2 : -2, 1]] }; }
  const prog = (play.prog || []).map(([slot]) => [slot, 0]).filter(([s]) => slots[s] && slots[s].k === 'route');
  return { n: `${play.n} 2`.slice(0, 24), t: play.t, set: set.id, slots, ...(prog.length ? { prog } : {}) };
}
export function blankDraw(set, kind) {
  const run = kind === 'run'; const qb = set.slots.find((s) => s.pos === 0); const back = set.slots.find((s) => s.pos === 1) || set.slots.find((s) => s.pos === 2);
  const slots = set.slots.map((sl) => {
    if (sl.pos === 0) return run ? { k: 'handoff' } : { k: 'qb', o: { drop: 0 } };
    if (isOL(sl.pos)) return { k: run ? 'block' : 'pblock' };
    if (run && back && sl.i === back.i) return { k: 'carry', p: mirror([[2, 2], [2.5, 9]], sl.x < (qb ? qb.x : 0)) };
    if (run) return sl.pos === 4 || sl.pos === 2 ? { k: 'block' } : { k: 'stalk' };
    if (sl.pos === 1 || sl.pos === 2) return { k: 'pblock' };
    return { k: 'route', p: [[0, 10]] };
  });
  return { n: run ? 'New Run' : 'New Pass', t: 0, set: set.id, slots };
}

// ---- the creator dialog -------------------------------------------------------------------------------------------------
// opts: { set, draw (a DrawnPlay to edit, else a blank pass), title, onSave(draw), onClose() }
export function openCreator(opts) {
  const set = opts.set; const slots = set.slots;
  const draw = JSON.parse(JSON.stringify(opts.draw || blankDraw(set, 'pass'))); draw.set = set.id;
  draw.slots = slots.map((sl) => draw.slots?.[sl.i] || { k: isOL(sl.pos) ? 'pblock' : 'route', p: isOL(sl.pos) ? undefined : [[0, 10]] });
  const S = { sel: slots.findIndex((s) => s.pos === 0), drag: null, msg: '' };
  const left = (sl) => sl.x < 0;
  // field geometry: 10 px per yard, x from -27 to 27, y from 28 downfield to -12 behind the ball
  const K = 10, X0 = -27, Y1 = 28, W = 540, H = 400;
  const tx = (x, y) => [(x - X0) * K, (Y1 - y) * K];
  const fromClient = (svg, cx, cy) => { const pt = new DOMPoint(cx, cy).matrixTransform(svg.getScreenCTM().inverse()); return [Math.round((pt.x / K + X0) * 2) / 2, Math.round((Y1 - pt.y / K) * 2) / 2]; };
  const cur = () => draw.slots[S.sel]; const curSlot = () => slots[S.sel];
  const carrierIndex = () => draw.slots.findIndex((d) => d.k === 'carry');
  const setKind = (k) => { const d = cur(), sl = curSlot(); const keepPath = PATH_KINDS.has(k) && d.p; const n = { k }; if (keepPath) n.p = d.p; if (k === 'qb') n.o = { drop: 0 }; if (k === 'qbpa') { const back = slots.find((s) => s.i !== sl.i && (s.pos === 1 || s.pos === 2)) || slots.find((s) => s.i !== sl.i); n.o = { fake: back ? back.i : 0 }; }
    if (k === 'carry') { const other = carrierIndex(); if (other >= 0 && other !== S.sel) draw.slots[other] = { k: 'stalk' }; if (!n.p) n.p = mirror([[2, 2], [2.5, 9]], left(sl)); }
    if (k === 'route' && !n.p) n.p = [[0, 10]];
    if (k === 'fake' && !n.p) n.p = [[left(sl) ? 2 : -2, 1]];
    if (k === 'qbopt' && !n.p) n.p = mirror([[-4, 1], [-8, 8]], left(sl));
    draw.slots[S.sel] = n; if (!['route'].includes(k)) draw.prog = (draw.prog || []).filter(([s]) => s !== S.sel); render(); };
  const addPoint = (x, y) => { const d = cur(), sl = curSlot(); if (!PATH_KINDS.has(d.k)) { S.msg = `${KIND_LABEL[d.k]} has no path. Pick Route, Carry, Block or Move to draw one.`; render(); return; } if (d.k === 'stalk') d.p = [[r1(x - sl.x), r1(y - sl.y)]]; else { d.p = d.p || []; if (d.p.length >= 8) { S.msg = 'Eight points at most per man.'; render(); return; } d.p.push([r1(x - sl.x), r1(y - sl.y)]); } S.msg = ''; render(); };
  const root = h('div', { class: 'pb-overlay cr-overlay', onclick: (e) => { if (e.target === e.currentTarget) close(); } });
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); opts.onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  function field() {
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ss-dia cr-svg', role: 'img', 'aria-label': 'Field' });
    svg.append(sv('rect', { class: 'cr-grass', x: 0, y: 0, width: W, height: H }));
    for (let y = -10; y <= 25; y += 5) { const [, sy] = tx(0, y); svg.append(sv('line', { class: y === 0 ? 'd-los cr-los' : 'cr-yard', x1: tx(-26.65, 0)[0], y1: sy, x2: tx(26.65, 0)[0], y2: sy })); if (y > 0 && y % 10 === 0) svg.append(sv('text', { class: 'cr-num', x: tx(-24, 0)[0], y: sy - 3 }, String(y))); }
    for (const x of [-26.65, 26.65, -3.1, 3.1]) { const [sx] = tx(x, 0); svg.append(sv('line', { class: Math.abs(x) > 10 ? 'cr-side' : 'cr-hash', x1: sx, y1: 0, x2: sx, y2: H })); }
    // every man's assignment, the selected one's on top with handles
    const pv = previewBook(draw, set);
    const art = sv('g'), men = sv('g'), handles = sv('g');
    slots.forEach((sl, i) => {
      const a = pv.book.asg[i]; const [x, y] = tx(sl.x, sl.y);
      if (a.p && a.p.length > 1) art.append(pathArt(a.p.map(([px, py]) => tx(sl.x + px, sl.y + py)), a, i === S.sel ? 'sel' : ''));
      const g = sv('g', { class: `cr-man${i === S.sel ? ' sel' : ''}${a.k === 'carry' ? ' hot' : ''}`, tabindex: '0', role: 'button', 'aria-label': `${POS[sl.pos]} ${KIND_LABEL[draw.slots[i].k]}` });
      g.append(sl.pos === 7 ? sv('rect', { class: 'd-man', x: x - 7, y: y - 7, width: 14, height: 14 }) : sv('circle', { class: 'd-man', cx: x, cy: y, r: 7.5 }));
      g.append(sv('text', { class: 'cr-lab', x, y: y + 17 }, POS[sl.pos]));
      g.addEventListener('pointerdown', (e) => { e.stopPropagation(); S.sel = i; S.msg = ''; render(); });
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); S.sel = i; render(); } });
      men.append(g);
    });
    const d = cur(), sl = curSlot();
    if (PATH_KINDS.has(d.k) && d.p) d.p.forEach((pt, j) => { const [hx, hy] = tx(sl.x + pt[0], sl.y + pt[1]); const c = sv('circle', { class: 'cr-handle', cx: hx, cy: hy, r: 6 }); c.addEventListener('pointerdown', (e) => { e.stopPropagation(); c.setPointerCapture(e.pointerId); S.drag = { j, id: e.pointerId }; }); c.addEventListener('pointermove', (e) => { if (!S.drag || S.drag.j !== j) return; const [x, y] = fromClient(svg, e.clientX, e.clientY); d.p[j] = [r1(x - sl.x), r1(y - sl.y)]; render(); }); c.addEventListener('pointerup', () => { S.drag = null; }); handles.append(c); });
    svg.append(art, men, handles);
    svg.addEventListener('pointerdown', (e) => { if (S.drag) return; const [x, y] = fromClient(svg, e.clientX, e.clientY); addPoint(x, y); });
    return svg;
  }
  function pathArt(pts, a, extra) { const g = sv('g', { class: `art k-${a.k} ${extra}` }); g.append(sv('polyline', { points: pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') })); const [x1, y1] = pts[pts.length - 2], [x2, y2] = pts[pts.length - 1]; const ang = Math.atan2(y2 - y1, x2 - x1);
    if (a.c === 1) { const px = -Math.sin(ang) * 6, py = Math.cos(ang) * 6; g.append(sv('line', { x1: x2 - px, y1: y2 - py, x2: x2 + px, y2: y2 + py })); } else { const L = 9, wd = 4.5; const bx = x2 - Math.cos(ang) * L, by = y2 - Math.sin(ang) * L; g.append(sv('polygon', { class: 'arrow', points: `${x2},${y2} ${bx - Math.sin(ang) * wd},${by + Math.cos(ang) * wd} ${bx + Math.sin(ang) * wd},${by - Math.cos(ang) * wd}` })); }
    return g; }

  function sidePanel() {
    const d = cur(), sl = curSlot(); const o = d.o || (d.o = {});
    const kinds = kindsFor(sl);
    const opt = (label, ctl) => h('label', { class: 'cr-opt' }, h('span', {}, label), ctl);
    const sel = (value, options, onchange) => h('select', { onchange: (e) => onchange(e.target.value) }, options.map(([v, text]) => h('option', { value: String(v), selected: String(v) === String(value) }, text)));
    const body = [];
    body.push(h('div', { class: 'cr-kinds' }, kinds.map((k) => h('button', { type: 'button', class: `btn sm ${d.k === k ? '' : 'light'}`, onclick: () => setKind(k) }, KIND_LABEL[k]))));
    const backs = slots.filter((s) => s.i !== sl.i && !isOL(s.pos) && s.pos !== 0).map((s) => [s.i, `${POS[s.pos]} (${s.x < 0 ? 'left' : 'right'} ${Math.abs(s.x)} yd)`]);
    if (d.k === 'qb') body.push(opt('Drop', sel(o.drop ?? 0, DROPS.map((n, i) => [i, n]), (v) => { o.drop = Number(v); render(); })), Number(o.drop) === 6 && carrierIndex() < 0 ? h('p', { class: 'cr-hint warn' }, 'An RPO needs a Carry: pick a back and give him Carry.') : null);
    if (d.k === 'qbpa') body.push(opt('Fakes to', sel(o.fake ?? 1, backs, (v) => { o.fake = Number(v); if (draw.slots[o.fake] && draw.slots[o.fake].k !== 'fake' && draw.slots[o.fake].k !== 'carry') draw.slots[o.fake] = { k: 'fake', p: [[slots[o.fake].x < 0 ? 2 : -2, 1]] }; render(); })), h('p', { class: 'cr-hint' }, 'The back gets a Fake handoff assignment (fake, then pass block). Give him a Route instead to let him out.'));
    if (d.k === 'handoff' || d.k === 'qbopt') { const ci = carrierIndex(); body.push(h('p', { class: `cr-hint${ci < 0 ? ' warn' : ''}` }, ci < 0 ? 'Pick the ball carrier: select a back and give him Carry.' : `Ball to the ${POS[slots[ci].pos]} (${d.k === 'qbopt' ? 'read: keep or give; draw where the quarterback keeps it' : 'draw his track on the carrier'}).`)); }
    if (d.k === 'route') body.push(h('div', { class: 'cr-presets' }, ROUTES.map(([n, p, extra]) => h('button', { type: 'button', class: 'btn light sm', onclick: () => { d.p = mirror(p, left(sl)); d.o = extra ? { ...extra } : {}; render(); } }, n))),
      opt('Settle at the end', sel(o.sit ?? 0, [[0, 'No'], [1, '1 s (hitch)'], [1.5, '1.5 s (curl)'], [2.5, '2.5 s']], (v) => { o.sit = Number(v); render(); })), opt('Speed', sel(o.speed ?? 100, [[100, 'Full'], [75, '75 %'], [50, 'Half']], (v) => { o.speed = Number(v); render(); })),
      (sl.pos === 1 || sl.pos === 2) ? opt('Fake handoff first', sel(o.fake ?? 0, [[0, 'No'], [1, 'Yes']], (v) => { o.fake = Number(v); render(); })) : null);
    if (d.k === 'carry') body.push(h('div', { class: 'cr-presets' }, RUNS.map(([n, p, extra]) => h('button', { type: 'button', class: 'btn light sm', onclick: () => { d.p = mirror(p, left(sl)); d.o = extra ? { ...extra } : {}; render(); } }, n))),
      opt('Delay', sel(o.delay ?? 0, [[0, 'None'], [0.25, '¼ s'], [0.5, '½ s (draw)'], [1, '1 s']], (v) => { o.delay = Number(v); render(); })), opt('Speed', sel(o.speed ?? 75, [[75, 'Normal'], [100, 'Full'], [50, 'Patient']], (v) => { o.speed = Number(v); render(); })));
    if (d.k === 'block') body.push(h('p', { class: 'cr-hint' }, isOL(sl.pos) ? 'Linemen block where they stand.' : 'Draw a path to make it a lead block; no path blocks at the line.'));
    if (d.k === 'release') body.push(h('p', { class: 'cr-hint' }, 'Blocks for a beat, then releases along the path and blocks for the screen receiver.'));
    if (d.k === 'stalk') body.push(h('p', { class: 'cr-hint' }, 'Runs the stem, then blocks the defender over him. Click the field to set the depth.'));
    if (d.k === 'fake') body.push(h('p', { class: 'cr-hint' }, 'Fakes the handoff along the path, then pass blocks.'));
    if (PATH_KINDS.has(d.k)) body.push(h('div', { class: 'cr-pathctl' }, h('span', { class: 'muted' }, d.k === 'stalk' ? 'Click the field for the depth.' : `Click the field to add points (${(d.p || []).length}/8), drag a point to move it.`), h('button', { type: 'button', class: 'btn light sm', disabled: !(d.p && d.p.length), onclick: () => { d.p.pop(); render(); } }, 'Undo point'), h('button', { type: 'button', class: 'btn light sm', disabled: !(d.p && d.p.length), onclick: () => { d.p = []; render(); } }, 'Clear')));
    return h('section', { class: 'cr-side' }, h('h4', {}, `${POS[sl.pos]}${sl.depth ? sl.depth + 1 : ''}`, h('small', {}, `${sl.x < 0 ? 'left' : sl.x > 0 ? 'right' : 'centre'} ${Math.abs(sl.x)} yd · ${-sl.y} yd deep`)), ...body);
  }
  function playPanel() {
    const receivers = slots.filter((s) => draw.slots[s.i].k === 'route');
    const prog = (draw.prog || []).filter(([s]) => draw.slots[s] && draw.slots[s].k === 'route'); draw.prog = prog;
    const notIn = receivers.filter((s) => !prog.some(([p]) => p === s.i) && s.i <= 7);
    const fm = familyOf(draw); const pv = previewBook(draw, set);
    return h('section', { class: 'cr-play' }, h('h4', {}, 'Play', h('small', {}, FAM_LABEL[fm] || fm)),
      h('div', { class: 'cr-tile' }, diagram(pv.book, pv.play, set), h('span', { class: 'muted' }, 'as the picker will show it')),
      h('p', { class: 'cr-h' }, 'Progression'),
      prog.length ? h('ol', { class: 'cr-prog' }, prog.map(([s], i) => h('li', {}, h('span', {}, `${POS[slots[s].pos]} (${slots[s].x < 0 ? 'L' : 'R'} ${Math.abs(slots[s].x)})`), h('span', { class: 'pb-ctl' }, h('button', { class: 'pb-ib', type: 'button', disabled: i === 0, 'aria-label': 'Earlier', onclick: () => { [prog[i - 1], prog[i]] = [prog[i], prog[i - 1]]; render(); } }, '▲'), h('button', { class: 'pb-ib', type: 'button', disabled: i === prog.length - 1, 'aria-label': 'Later', onclick: () => { [prog[i + 1], prog[i]] = [prog[i], prog[i + 1]]; render(); } }, '▼'), h('button', { class: 'pb-ib del', type: 'button', 'aria-label': 'Remove', onclick: () => { prog.splice(i, 1); render(); } }, '✕'))))) : h('p', { class: 'muted' }, 'No reads yet: the quarterback goes deepest first.'),
      notIn.length && prog.length < 5 ? h('div', { class: 'cr-presets' }, notIn.map((s) => h('button', { type: 'button', class: 'btn light sm', onclick: () => { prog.push([s.i, 0]); render(); } }, `+ ${POS[s.pos]} (${s.x < 0 ? 'L' : 'R'} ${Math.abs(s.x)})`))) : null,
      receivers.some((s) => s.i > 7) ? h('p', { class: 'cr-hint' }, 'The game numbers reads among the first eight men of the set.') : null);
  }
  function problems() {
    const out = []; const qbs = draw.slots.filter((d) => QB_KINDS.includes(d.k)); const carriers = draw.slots.filter((d) => d.k === 'carry');
    if (!draw.n.trim()) out.push('Name the play.'); if (qbs.length > 1) out.push('One quarterback assignment.'); if (carriers.length > 1) out.push('One ball carrier.');
    const qb = qbs[0]; if (qb && (qb.k === 'handoff' || qb.k === 'qbopt' || (qb.k === 'qb' && Number(qb.o?.drop) === 6)) && !carriers.length) out.push('Give a back the Carry assignment.');
    if (qb && qb.k !== 'handoff' && qb.k !== 'qbopt' && !draw.slots.some((d) => d.k === 'route')) out.push('A pass needs a route.');
    draw.slots.forEach((d, i) => { if (PATH_KINDS.has(d.k) && d.k !== 'stalk' && d.k !== 'block' && d.k !== 'qbopt' && !(d.p && d.p.length)) out.push(`${POS[slots[i].pos]}: draw the ${d.k === 'carry' ? 'run track' : 'path'}.`); });
    return out;
  }
  function render() {
    const probs = problems();
    root.replaceChildren(h('div', { class: 'pb-dialog cr-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Play creator' },
      h('div', { class: 'pb-dlghead cr-head' }, h('h3', {}, opts.title || 'Draw a play'), h('label', { class: 'pb-field' }, h('span', {}, 'Name'), h('input', { type: 'text', maxlength: '24', value: draw.n, oninput: (e) => { draw.n = e.target.value; renderBar(); } })), h('span', { class: 'cr-set' }, set.n),
        h('span', { class: 'cr-actions' }, h('span', { class: 'cr-probs', role: 'status' }, probs[0] || S.msg || ''), h('button', { class: 'btn', type: 'button', disabled: probs.length > 0, onclick: () => { opts.onSave(JSON.parse(JSON.stringify(draw))); close(); } }, 'Save play'), h('button', { class: 'btn light', type: 'button', onclick: close }, 'Cancel'), h('button', { class: 'pb-ib', type: 'button', 'aria-label': 'Close', onclick: close }, '✕'))),
      h('div', { class: 'cr-body' }, h('div', { class: 'cr-field' }, field()), h('div', { class: 'cr-panels' }, sidePanel(), playPanel()))));
  }
  function renderBar() { const probs = problems(); const st = root.querySelector('.cr-probs'); if (st) st.textContent = probs[0] || ''; const b = root.querySelector('.cr-actions .btn'); if (b) b.disabled = probs.length > 0; }
  render(); document.body.append(root);
  return { close };
}
