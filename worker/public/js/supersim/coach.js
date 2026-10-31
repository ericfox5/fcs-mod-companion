// Supersim coaching mode: browser client. Vanilla ES module, no build step, no libraries; runs under
// CSP script-src 'self' (handlers via addEventListener; innerHTML only for the static field markup with esc()).
// Server contract: worker/src/supersim/routes.ts. Data shapes: worker/src/supersim/coach/types.ts.
// Presentation follows the v1 Supersim client: perspective field inside a stadium (stadium.js), logo-derived team
// colors (palette.js), per-play popup with the players involved, live sideboxes, lighting that follows the clock.
// The play picker is a compact overlay on the near end of the field that only shows between plays.
// Field geometry: absolute yards 0 (away goal line, near end) .. 100 (home goal line, far end); the away offense
// drives toward the far end (dir 1), the home offense toward the viewer (dir -1). Actor paths are [t, x downfield, y right].
import { teamColor, readableAccent } from './palette.js';
import { stadiumMarkup } from './stadium.js';

const root = document.getElementById('coach');
const EP = root?.dataset.endpoint || '';
const BOOKS = root?.dataset.books || '/data/playbooks/';
const BACK = root?.dataset.back || '/';
const POS = ['QB', 'HB', 'FB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT', 'LE', 'RE', 'DT', 'LLB', 'MLB', 'RLB', 'CB', 'FS', 'SS', 'K', 'P', 'KR', 'PR', 'KO', 'LS'];
const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const PASS_T = new Set([1, 3, 4, 5, 6, 7, 20, 100, 101, 102, 103, 104, 105, 106, 157, 159]);
// depth-chart fallbacks per position (mirrors the engine's lineup())
const GROUP = { 0: [0], 1: [1, 2, 21, 22], 2: [2, 1, 4], 3: [3, 21, 22, 1], 4: [4, 2, 5, 9], 5: [5, 9, 6, 8, 7], 6: [6, 8, 7, 5, 9], 7: [7, 6, 8], 8: [8, 6, 7, 9, 5], 9: [9, 5, 8, 6, 7], 10: [10, 11, 12, 15, 13], 11: [11, 10, 12, 13, 15], 12: [12, 10, 11], 13: [13, 15, 14, 18], 14: [14, 13, 15, 18], 15: [15, 13, 14, 18], 16: [16, 17, 18, 3], 17: [17, 18, 16], 18: [18, 17, 16, 14], 19: [19, 20, 23], 20: [20, 19], 21: [21, 22, 3, 1, 16], 22: [22, 21, 3, 16, 1], 23: [23, 19, 20], 24: [24, 7, 4, 6] };
const FAM_LABEL = { run: 'Run', pass: 'Pass', pa: 'PA', screen: 'Screen', option: 'Option', kick: 'Kick', punt: 'Punt', kneel: 'Kneel', spike: 'Spike', man: 'Man', zone: 'Zone', blitz: 'Blitz', return: 'Return', fg: 'FG', other: '' };
const FILTERS = { off: [['all', 'All'], ['run', 'Run'], ['pass', 'Pass'], ['special', 'Special']], def: [['all', 'All'], ['zone', 'Zone'], ['man', 'Man'], ['blitz', 'Blitz']] };
const FLASH = { throw: 'THROW', catch: 'CATCH', incomplete: 'INCOMPLETE', interception: 'INTERCEPTED', handoff: 'HANDOFF', kick: 'KICK', punt: 'PUNT', faircatch: 'FAIR CATCH', good: "IT'S GOOD!", doinkin: 'DOINK… AND IN!', doink: 'DOINK! NO GOOD', widel: 'WIDE LEFT', wider: 'WIDE RIGHT', short: 'SHORT', blocked: 'BLOCKED' };
const ROLE = { QB: 'QUARTERBACK', TARGET: 'INTENDED RECEIVER', TACKLE: 'TACKLER', SACK: 'PASS RUSHER', INTERCEPTION: 'INTERCEPTOR', 'QB KEEPER': 'QUARTERBACK' };
const STATUS = { pending: 'Result sent to the league server. Waiting for the bridge to accept it.', accepted: 'Accepted by the league server.', synced: 'Synced with the console.', conflict: 'Overridden: the console recorded its own result for this game (it simmed the game at the advance, or the game was played in-game).' };
// The league server turns the final into console game data (spike/blaze/server/gamedata.mjs); first real test pending.
const CONSOLE_NOTE = 'Console import is new: the league server hands this final to the console as game data, so the week advance should keep this score and these stats instead of simming the game. If the console still sims it, the console result wins.';
const NOYDS = new Set(['kickoff', 'punt', 'xp', 'fg', 'penalty']);
const TABS_KEY = 'ss-coach-tabs';
// generic alignments for the side whose call is still hidden, [x downfield, y right]
const GEN_O = [[-1.5, 0], [-7, 0], [-0.6, 0], [-0.9, -1.7], [-0.9, 1.7], [-1.2, -3.3], [-1.2, 3.3], [-1.2, 5.5], [-0.8, -16], [-0.8, 16], [-2, -10]];
const GEN_D = [[1.6, -5.5], [1.6, -1], [1.6, 2.4], [1.6, 5.5], [4.5, -3], [4.5, 3.5], [4, -10], [8, -17.5], [8, 17.5], [13, -8.5], [13, 8.5]];
const GEN_KO = [[-10.7, -2.8], ...[-24.5, -19.2, -14, -8.7, -6, 3.5, 8.8, 14, 19.3, 24.5].map((y) => [-4.5, y])];
const GEN_KR = [[12, -14], [12, 0], [12, 14], [25, -18], [25, -6], [25, 6], [25, 18], [40, -10], [40, 10], [58, -5], [62, 5]];

// ---- state -----------------------------------------------------------------------------------------------------
const S = {
  payload: null, input: null, you: null, state: null, version: 0, final: null, opponentHuman: false, waiting: false,
  books: new Map(), bookErr: null, index: null, shell: false, colorsDone: false, lighting: 'auto', focus: false,
  gid: null, setId: null, filter: 'all', search: '', selected: null, curG: null, curSet: null, lastPhase: null, filtersOpen: false,
  tempo: 'normal', speed: 1, skipAnim: false, tab: 'drive', tabsOpen: false, picker: 'off', busy: false, autoRun: null, stopAuto: false, poll: null,
};
try { S.tabsOpen = localStorage.getItem(TABS_KEY) === '1'; } catch { /* storage unavailable */ }
const E = {}; // live DOM references
const F = {}; // field svg layers
const A = { an: null, detail: null, actors: [], t: 0, dur: 1, playing: false, raf: 0, last: 0, flashed: new Set(), done: null, flashT: 0, popup: false, air: [] };

// ---- tiny DOM helpers --------------------------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) { const v = attrs[k]; if (v == null || v === false) continue; if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k[0] === 'o' && k[1] === 'n') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v); }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
}
const NS = 'http://www.w3.org/2000/svg';
function sv(tag, attrs, ...kids) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) { const v = attrs[k]; if (v != null && v !== false) e.setAttribute(k, v); }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
}
const clear = (...els) => { for (const e of els) if (e) e.replaceChildren(); };
const mmss = (s) => { s = Math.max(0, Math.round(Number(s) || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const ord = (d) => ['', '1st', '2nd', '3rd', '4th'][d] || `${d}th`;
const qLabel = (q) => (q <= 4 ? `Q${q}` : q === 5 ? 'OT' : `${q - 4}OT`);
const shortName = (p) => { if (!p?.name) return '—'; const parts = p.name.trim().split(/\s+/); return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : p.name; };
const initials = (p) => (p?.name || '?').split(/\s+/).map((n) => n[0]).slice(0, 2).join('').toUpperCase();
const rnd = (list) => list[Math.floor(Math.random() * list.length)];
const actingOff = (st) => (st.phase === 'kickoff' ? st.kicking : st.off);
const abbr = (side) => S.input?.teams?.[side]?.abbr || (side === 0 ? 'AWAY' : 'HOME');
const spotLabel = (off, ball) => (ball === 50 ? '50' : ball < 50 ? `${abbr(off)} ${ball}` : `${abbr(1 - off)} ${100 - ball}`);
const downDist = (st) => (st.phase === 'toss' ? 'Coin toss' : st.phase === 'kickoff' ? 'Kickoff' : st.phase === 'pat' ? 'Point after' : `${ord(st.down)} & ${st.ball + st.toGo >= 100 ? 'Goal' : st.toGo}`);
const player = (side, id) => S.input?.teams?.[side]?.players?.find((p) => p.id === id);
const logo = (side, cls = '') => h('img', { class: `ss-logo ${cls}`, src: S.input?.teams?.[side]?.logo || '', alt: '' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---- API ---------------------------------------------------------------------------------------------------------
async function api(method, body) {
  const res = await fetch(EP, { method, credentials: 'same-origin', cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}
// POST with the version guard; a stale 409 re-syncs the view and returns null
async function post(body) {
  try { return await api('POST', { ...body, version: S.version }); } catch (e) {
    if (e.status === 409 && e.data?.stale) { toast(e.data.error || 'The game moved on; reloading.'); if (e.data.state !== undefined) { applyPayload(e.data); render(); drawPreSnap(); showPicker(); } else await reload(); return null; }
    throw e;
  }
}
async function reload() { try { applyPayload(await api('GET')); render(); afterLoadField(); } catch (e) { toast(e.message, { retry: reload }); } }

// ---- playbooks ---------------------------------------------------------------------------------------------------
function loadBook(id) {
  if (id == null) return Promise.reject(new Error('No playbook assigned.'));
  let entry = S.books.get(id);
  if (!entry) {
    entry = { book: null, promise: null };
    entry.promise = fetch(`${BOOKS}${id}.json`, { credentials: 'same-origin' }).then((r) => { if (!r.ok) throw new Error(`Playbook ${id} failed to load (${r.status}).`); return r.json(); }).then((b) => { entry.book = b; onBookLoaded(id); return b; }).catch((e) => { S.books.delete(id); throw e; });
    S.books.set(id, entry);
  }
  return entry.promise;
}
const bookSync = (id) => S.books.get(id)?.book || null;
function bookName(id) { return S.index?.books?.find((b) => b.id === id)?.name || bookSync(id)?.name || (id != null ? `Book ${id}` : '—'); }
// my two books first; the opponent's two are only needed to draw their art after the snap
function ensureBooks(retry) {
  const b = S.payload?.books; if (!b || S.you == null) return Promise.resolve();
  if (retry) S.bookErr = null;
  const mine = [loadBook(b.off[S.you]), loadBook(b.def[S.you])].map((p) => p.catch((e) => { S.bookErr = e.message; renderPicker(); }));
  const theirs = () => { loadBook(b.off[1 - S.you]).catch(() => {}); loadBook(b.def[1 - S.you]).catch(() => {}); };
  return Promise.all(mine).then(() => setTimeout(theirs, 400));
}
function onBookLoaded() { renderPicker(); renderTabs(); if (A.detail && !A.playing && (E.popup?.hidden ?? true)) startAnim(A.detail, false, false); }
function findPlay(book, id) {
  if (!book || id == null) return null;
  if (!book._idx) { book._idx = new Map(); for (const f of book.formations || []) for (const s of f.sets || []) for (const pid of s.plays || []) if (!book._idx.has(pid)) book._idx.set(pid, { set: s, form: f }); }
  const hit = book._idx.get(id); const play = book.plays?.[String(id)]; return hit && play ? { play, set: hit.set, form: hit.form } : null;
}
// play family from play.t plus the assignment kinds (kick vs punt, PA, screen)
function fam(book, play) {
  if (!play) return 'other'; const t = play.t;
  if (book.side === 'def') return t === 33 || t === 34 ? 'man' : t === 42 || t === 43 || t === 45 || t === 36 ? 'zone' : t === 46 || t === 47 ? 'blitz' : t === 35 ? 'return' : t >= 49 && t <= 51 ? 'fg' : 'other';
  const kinds = (play.a || []).map((i) => book.asg?.[i]?.k);
  if (t === 21) return kinds.includes('punt') ? 'punt' : 'kick';
  if (t === 37) return 'kneel'; if (t === 38) return 'spike';
  if (PASS_T.has(t)) return kinds.includes('qbpa') ? 'pa' : kinds.includes('screen') ? 'screen' : 'pass';
  if (t === 17 || (t >= 162 && t <= 172)) return 'option';
  return 'run';
}
const inFilter = (f, fm) => f === 'all' || (f === 'run' ? fm === 'run' || fm === 'option' : f === 'pass' ? fm === 'pass' || fm === 'pa' || fm === 'screen' : f === 'special' ? ['kick', 'punt', 'kneel', 'spike'].includes(fm) : f === fm);
// which formations/sets are callable in the current phase (see routes.ts / engine.ts phase gates)
function groups(book, side, st) {
  const F0 = book.formations || []; const special = F0.find((f) => /special/i.test(f.n));
  const named = (re, label) => (special ? [{ f: special, sets: special.sets.filter((s) => re.test(s.n)), label }] : []);
  // book order, except that the Hail Mary package goes last so a real formation opens by default
  const plain = (fs) => [...fs.filter((f) => !/hail mary/i.test(f.n)), ...fs.filter((f) => /hail mary/i.test(f.n))].map((f) => ({ f, sets: f.sets }));
  let out;
  if (side === 'off') {
    if (st.phase === 'kickoff') { let ko = F0.filter((f) => f.t === (st.freeKick ? 3 : 2)); if (!ko.length) ko = F0.filter((f) => f.t === 2 || f.t === 3); out = [...plain(ko), ...named(/^ncaa$/i, 'Onside kick')]; }
    else if (st.phase === 'pat') out = [...named(/^field goal$/i, 'Extra point'), ...plain(F0.filter((f) => f.t === 1 && f !== special))];
    else out = plain(F0.filter((f) => f.t === 1));
  } else if (st.phase === 'kickoff') { let kr = F0.filter((f) => f.t === (st.freeKick ? 13 : 12)); if (!kr.length) kr = F0.filter((f) => f.t === 12 || f.t === 13); out = [...plain(kr), ...named(/onside/i, 'Onside return')]; }
  else if (st.phase === 'pat') out = [...named(/field goal block/i, 'FG block'), ...plain(F0.filter((f) => f.t === 11))];
  else out = plain(F0.filter((f) => f.t === 11));
  return out.filter((g) => g.f && g.sets?.length).map((g) => ({ ...g, key: `${g.f.id}:${g.label || ''}`, name: g.label || g.f.n }));
}
// fill a set's slots from the depth chart (same rules as the server) so the pre-snap formation shows real numbers
// the team with this game's substitutions laid over its depth chart (mirrors the engine's withSubs)
function withSubs(team, subs) {
  if (!team || !subs || !Object.keys(subs).length) return team; const over = new Set(Object.keys(subs).map(Number));
  return { ...team, depthChart: [...(team.depthChart || []).filter((d) => !over.has(d.pos)), ...Object.entries(subs).flatMap(([pos, ids]) => ids.map((pgid, depth) => ({ pos: Number(pos), depth, pgid })))] };
}
const teamFor = (side) => withSubs(S.input?.teams?.[side], S.state?.subs?.[side]);
const qFlip = (q) => !!q && q % 2 === 0; // teams change ends every quarter
function lineup(team, set) {
  const used = new Set(); const players = team?.players || []; const byId = new Map(players.map((p) => [p.id, p])); const out = [];
  for (const slot of set?.slots || []) {
    let chosen = null; const chart = (team?.depthChart || []).filter((d) => d.pos === slot.pos).sort((a, b) => a.depth - b.depth);
    for (const d of [...chart.filter((d) => d.depth >= slot.depth), ...chart]) { const p = byId.get(d.pgid); if (p && !used.has(p.id)) { chosen = p; break; } }
    if (!chosen) for (const pos of GROUP[slot.pos] || [slot.pos]) { const c = players.filter((p) => p.pos === pos && !used.has(p.id)).sort((a, b) => b.overall - a.overall)[0]; if (c) { chosen = c; break; } }
    if (!chosen) chosen = players.filter((p) => !used.has(p.id)).sort((a, b) => b.overall - a.overall)[0] || null;
    if (chosen) used.add(chosen.id); out.push(chosen);
  }
  return out;
}

// ---- play art (shared by the field and the tiles) -------------------------------------------------------------------
// pts: screen points; a: assignment; u: size unit for the end caps
function artPath(pts, a, cls, u) {
  const g = sv('g', { class: `art ${cls} k-${a.k || 'move'}` });
  g.append(sv('polyline', { points: pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') }));
  const [x1, y1] = pts[pts.length - 2], [x2, y2] = pts[pts.length - 1]; const ang = Math.atan2(y2 - y1, x2 - x1);
  if (a.c === 1) { const px = -Math.sin(ang) * 6 * u, py = Math.cos(ang) * 6 * u; g.append(sv('line', { x1: x2 - px, y1: y2 - py, x2: x2 + px, y2: y2 + py })); }
  else if (a.c === 2) { const L = 8 * u, wd = 4 * u; const bx = x2 - Math.cos(ang) * L, by = y2 - Math.sin(ang) * L; g.append(sv('polygon', { class: 'arrow', points: `${x2},${y2} ${bx - Math.sin(ang) * wd},${by + Math.cos(ang) * wd} ${bx + Math.sin(ang) * wd},${by - Math.cos(ang) * wd}` })); }
  else if (a.c >= 3) { const r = (a.c === 3 ? 4 : a.c === 4 ? 6 : 9) * u; g.append(sv('ellipse', { class: 'zone', cx: x2, cy: y2, rx: r * 1.4, ry: r })); }
  return g;
}
// per-set framing so every tile of a set shares one scale (art clamped so a Hail Mary does not shrink the rest)
function setFrame(book, set) {
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
function diagram(book, play, set) {
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

// ---- perspective field (v1) -----------------------------------------------------------------------------------------
// x: yards along the field (-8..108, near end at the bottom), y: yards across (0..53.3, left to right)
const coord = (x, y) => [500 + (y - 26.65) * (760 - 3.8 * x) / 53.3, 550 - x * 4.1];
const point = (x, y) => coord(x, y).map((n) => n.toFixed(1)).join(',');
const depthScale = (x) => 1.18 - 0.42 * Math.min(1, Math.max(0, (x + 8) / 116)); // nearer = bigger
// offense-relative (x downfield, y right) -> field yards; the home offense's right is screen-left
const toField = (los, dir, x, y) => [los + dir * x, dir === 1 ? 26.65 + y : 26.65 - y];
// polyline through field points, subdivided so long diagonals follow the perspective
function fieldPts(pts) { const out = []; for (let i = 0; i < pts.length; i++) { if (i) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 5); for (let k = 1; k < n; k++) out.push(coord(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n)); } out.push(coord(pts[i][0], pts[i][1])); } return out; }
// goalposts on both end lines (the drawn end zones are 8 yards deep): uprights 18'6" apart, crossbar 10 ft up, uprights
// 20 ft above it, on a padded post at the end line (where the drawn turf stops); heights use the across-field scale at that depth
const POST_W = 3.08, BAR_H = 3.33, POST_H = 10, END_NEAR = -8, END_FAR = 108;
const pxYd = (x) => (760 - 3.8 * x) / 53.3;
function postsMarkup(x, id) {
  const n = (v) => v.toFixed(1); const k = pxYd(x), gy = coord(x, 26.65)[1], lx = coord(x, 26.65 - POST_W)[0], rx = coord(x, 26.65 + POST_W)[0];
  const bx = x, kb = pxYd(bx), by = coord(bx, 26.65)[1]; const bar = gy - BAR_H * k, top = gy - POST_H * k, w = Math.max(2.2, k * 0.2);
  const d = `M500 ${n(by)}V${n(bar)}M${n(lx)} ${n(top)}V${n(bar)}H${n(rx)}V${n(top)}`;
  return `<g id="${id}" class="f-posts"><path class="f-post-under" d="${d}" stroke-width="${n(w + 1.4)}"/><path class="f-post" d="${d}" stroke-width="${n(w)}"/><path class="f-post-pad" d="M500 ${n(by)}V${n(by - 1.8 * kb)}" stroke-width="${n(w * 2.4)}"/></g>`;
}
function fieldMarkup(flip = false) {
  const T = S.input?.teams || []; const a = T[0] || {}, hm = T[1] || {}; const nearT = flip ? a : hm, farT = flip ? hm : a;
  let s = `<defs><linearGradient id="ss-turf" x2="0" y2="1"><stop stop-color="var(--turf-far)"/><stop offset="1" stop-color="var(--turf-near)"/></linearGradient></defs>${stadiumMarkup()}`;
  s += `<path d="M${point(-8, 0)} L${point(108, 0)} L${point(108, 53.3)} L${point(-8, 53.3)}Z" fill="url(#ss-turf)" stroke="#86a89a" stroke-width="1.2"/>`;
  s += `<path d="M${point(-8, 0)} L${point(0, 0)} L${point(0, 53.3)} L${point(-8, 53.3)}Z" fill="var(${flip ? '--away' : '--home'})"/><path d="M${point(100, 0)} L${point(108, 0)} L${point(108, 53.3)} L${point(100, 53.3)}Z" fill="var(${flip ? '--home' : '--away'})"/>`;
  for (let x = 0; x <= 100; x += 5) {
    if (x % 10 === 0 && x < 100) s += `<path d="M${point(x, 0)} L${point(x + 5, 0)} L${point(x + 5, 53.3)} L${point(x, 53.3)}Z" fill="#ffffff03"/>`;
    s += `<path d="M${point(x, 0)} L${point(x, 53.3)}" stroke="#cbddd7" stroke-opacity="${x % 10 === 0 ? 0.5 : 0.2}" stroke-width="1"/>`;
    if (x > 0 && x < 100 && x % 10 === 0) for (const y of [5, 48]) { const [px, py] = coord(x, y); s += `<text x="${px.toFixed(1)}" y="${(py - 4).toFixed(1)}" fill="#d8e7df" opacity=".65" text-anchor="middle" font-size="${15 - x * 0.05}" font-weight="700">${Math.min(x, 100 - x)}</text>`; }
  }
  for (let x = 1; x < 100; x++) for (const y of [20, 33.3]) s += `<path d="M${point(x, y)} L${point(x, y + 0.75)}" stroke="#c6d6cc" stroke-opacity=".4" stroke-width="1"/>`;
  s += `<text x="500" y="580" text-anchor="middle" fill="white" opacity=".8" font-size="19" font-weight="800" letter-spacing="9">${esc(nearT.abbr)}</text><text x="500" y="120" text-anchor="middle" fill="white" opacity=".8" font-size="13" font-weight="800" letter-spacing="7">${esc(farT.abbr)}</text>`;
  s += hm.logo ? `<image class="ss-midfield-logo" href="${esc(hm.logo)}" x="449" y="305" width="102" height="80" opacity=".83" preserveAspectRatio="xMidYMid meet"/>` : `<text x="500" y="350" fill="#ffffff80" text-anchor="middle" font-size="24" font-weight="900">${esc(hm.abbr)}</text>`;
  // the far posts sit behind the players, the near ones in front of them (the ball always draws on top)
  s += `${postsMarkup(END_FAR, 'ss-posts-far')}<g id="ss-lines"></g><g id="ss-art"></g><g id="ss-path"></g><g id="ss-actors"></g>${postsMarkup(END_NEAR, 'ss-posts-near')}<g id="ss-ball"></g><g id="ss-flash"></g>`;
  return s;
}
function syncFlip(flip) { if (!F.svg || F.flip === !!flip) return; F.flip = !!flip; F.svg.innerHTML = fieldMarkup(F.flip); fieldRefs(F.svg); }
function fieldRefs(svg) { F.gLines = svg.querySelector('#ss-lines'); F.gArt = svg.querySelector('#ss-art'); F.gTrail = svg.querySelector('#ss-path'); F.gPlayers = svg.querySelector('#ss-actors'); F.gBall = svg.querySelector('#ss-ball'); F.gFlash = svg.querySelector('#ss-flash'); F.postsFar = svg.querySelector('#ss-posts-far'); F.postsNear = svg.querySelector('#ss-posts-near'); }
// absolute line of scrimmage for the state (the field is flipped in even quarters)
const absBall = (st, off, ball) => { const x = off === 0 ? ball : 100 - ball; return qFlip(st?.q) ? 100 - x : x; };
function buildField() {
  const svg = sv('svg', { class: 'ss-field', viewBox: '0 -20 1000 640', role: 'img', 'aria-label': 'Animated field with numbered player markers and the ball' });
  svg.innerHTML = fieldMarkup(false); F.flip = false;
  F.svg = svg; fieldRefs(svg);
  return svg;
}
const fieldLine = (x, cls) => sv('path', { class: cls, d: `M${point(x, 0)} L${point(x, 53.3)}` });
function setLines(los, fd) {
  clear(F.gLines); if (los == null) return;
  F.gLines.append(fieldLine(los, 'f-los'));
  if (fd != null && fd !== los && fd > 0 && fd < 100) F.gLines.append(fieldLine(fd, 'f-fd'));
  focusView(los);
}
function focusView(los) { if (!F.svg) return; cancelAnimationFrame(F.viewRaf); if (S.focus && los != null) { const cy = coord(los, 26)[1]; F.svg.setAttribute('viewBox', `80 ${Math.min(320, Math.max(50, cy - 160))} 840 320`); } else F.svg.setAttribute('viewBox', '0 -20 1000 640'); }
// kick camera: frame the hold and the goalposts the kick is going at (field aspect, at least 300 tall), easing in from
// the current view; the next pre-snap view puts the camera back
function kickCam(los, dir) {
  const end = dir === 1 ? END_FAR : END_NEAR, gy = coord(end, 26.65)[1], top = gy - POST_H * pxYd(end) - 30, ly = coord(los - dir * 9, 26.65)[1];
  const y0 = Math.min(top, ly - 60), y1 = Math.max(gy + 30, ly + 60), minH = 300 * Math.sqrt(pxYd(end) / pxYd(END_FAR)); // near things draw bigger: zoom less there
  const w = Math.min(1000, (Math.max(minH, y1 - y0) * 1000) / 640), h = (w * 640) / 1000;
  return [500 - w / 2, Math.max(-20, Math.min(620 - h, (y0 + y1) / 2 - h / 2)), w, h];
}
function easeView(to, dur) {
  if (!F.svg) return; cancelAnimationFrame(F.viewRaf); const put = (v) => F.svg.setAttribute('viewBox', v.map((n) => n.toFixed(1)).join(' '));
  const from = (F.svg.getAttribute('viewBox') || '0 -20 1000 640').split(/\s+/).map(Number); if (REDUCED || dur <= 0) { put(to); return; }
  const t0 = performance.now(); const step = (now) => { const f = Math.min(1, (now - t0) / (dur * 1000)), e = f * f * (3 - 2 * f); put(from.map((v, i) => v + (to[i] - v) * e)); if (f < 1) F.viewRaf = requestAnimationFrame(step); };
  F.viewRaf = requestAnimationFrame(step);
}
function place(el, abs, lat) { const [sx, sy] = coord(abs, lat); el.setAttribute('transform', `translate(${sx.toFixed(1)} ${sy.toFixed(1)}) scale(${depthScale(abs).toFixed(2)})`); }
// offense = circle, defense = rounded square (as in v1); jersey number on top; gold ring for the players involved
function marker(side, isOff, num, opts = {}) {
  const g = sv('g', { class: `f-pl t${side}` });
  if (opts.ring) g.append(sv('circle', { class: 'ring', r: 15 }));
  g.append(isOff ? sv('circle', { r: 10 }) : sv('rect', { x: -9, y: -9, width: 18, height: 18, rx: 4 }), sv('text', { y: 3.2 }, num == null ? '' : String(num)));
  if (opts.title) g.append(sv('title', {}, opts.title));
  return g;
}
const ghost = (side) => sv('g', { class: `f-ghost t${side}` }, sv('circle', { r: 8 }));
const ballEl = () => sv('g', { class: 'f-ballwrap' }, sv('ellipse', { class: 'f-ball', rx: 5.5, ry: 3.6, transform: 'rotate(-25)' }));
function fieldArt(g, book, play, set, los, dir, cls) {
  if (!book || !play || !set) return;
  (set.slots || []).forEach((s, i) => { const a = book.asg?.[play.a?.[i]]; if (!a?.p || a.p.length < 2) return; const pts = a.p.map(([px, py]) => toField(los, dir, s.y + (py || 0), s.x + (px || 0))); g.append(artPath(fieldPts(pts), a, cls, 0.75 * depthScale(pts[pts.length - 1][0]))); });
}
const genericO = (st) => (st.phase === 'kickoff' ? GEN_KO : GEN_O);
const genericD = (st) => (st.phase === 'kickoff' ? GEN_KR : GEN_D);
// before the snap: my eleven at their set slots with the play art; the other sideline as anonymous markers
function drawPreSnap() {
  stopAnim(); const st = S.state; if (!st || st.final || S.you == null || !F.svg) return;
  const flip = qFlip(st.q); syncFlip(flip);
  const off = actingOff(st), dir = (off === 0) !== flip ? 1 : -1; const ball = st.phase === 'pat' ? 97 : st.ball;
  const los = absBall(st, off, ball); const fd = st.phase === 'snap' ? absBall(st, off, ball + st.toGo) : null;
  setLines(los, fd); clear(F.gArt, F.gTrail, F.gPlayers, F.gBall, F.gFlash); hidePopup();
  const mineOff = S.you === off, sel = S.selected, team = teamFor(S.you);
  const put = (el, x, y) => { place(el, ...toField(los, dir, x, y)); F.gPlayers.append(el); };
  if (sel) {
    fieldArt(F.gArt, sel.book, sel.play, sel.set, los, dir, 'mine');
    const ps = lineup(team, sel.set);
    (sel.set.slots || []).forEach((s, i) => put(marker(S.you, mineOff, ps[i]?.number, { title: `${POS[s.pos] || ''} ${shortName(ps[i])}` }), s.y, s.x));
  } else for (const [x, y] of mineOff ? genericO(st) : genericD(st)) put(ghost(S.you), x, y);
  for (const [x, y] of mineOff ? genericD(st) : genericO(st)) put(ghost(1 - S.you), x, y);
  const b = ballEl(); place(b, los, 26.65); F.gBall.append(b);
  renderTicker();
}

// ---- animation -----------------------------------------------------------------------------------------------------
function interp(path, t) {
  if (!path?.length) return null; if (t <= path[0][0]) return [path[0][1], path[0][2]];
  for (let i = 1; i < path.length; i++) { const p = path[i - 1], q = path[i]; if (t <= q[0]) { const f = q[0] === p[0] ? 1 : (t - p[0]) / (q[0] - p[0]); return [p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f]; } }
  const l = path[path.length - 1]; return [l[1], l[2]];
}
// sets up the field for a play detail; resolves when the animation has finished (immediately when not animating)
function startAnim(detail, animate, popup = true) {
  stopAnim(); const an = detail?.anim; if (!an || !F.svg) return Promise.resolve();
  syncFlip(!!detail.flip);
  const dir = an.dir === -1 ? -1 : 1; let los = Number(an.los) || 0;
  if (los <= 0 || los >= 100) los -= dir * 3; // PAT snaps are reported at the goal line; spot them at the 3
  setLines(los, an.fd === an.los || an.fd <= 0 || an.fd >= 100 ? null : an.fd);
  clear(F.gArt, F.gTrail, F.gPlayers, F.gBall, F.gFlash); hidePopup();
  const off = detail.off, b = S.payload?.books; const offBook = bookSync(b?.off?.[off]), defBook = bookSync(b?.def?.[1 - off]);
  const op = findPlay(offBook, detail.offPlay?.id), dp = findPlay(defBook, detail.defPlay?.id);
  if (op) fieldArt(F.gArt, offBook, op.play, op.set, los, dir, off === S.you ? 'mine' : 'theirs');
  if (dp) fieldArt(F.gArt, defBook, dp.play, dp.set, los, dir, off === S.you ? 'theirs' : 'mine');
  const key = new Map((detail.people || []).map((p) => [p.id, p.role]));
  A.actors = (an.actors || []).map((a) => { const side = a.s === 'o' ? off : 1 - off; const p = player(side, a.id); const el = marker(side, a.s === 'o', a.num, { ring: key.has(a.id), title: `${POS[a.pos] || ''} ${shortName(p)}${key.has(a.id) ? ` — ${key.get(a.id)}` : ''}` }); F.gPlayers.append(el); return { a, el }; });
  A.shadow = an.kick ? sv('ellipse', { class: 'f-shadow', rx: 5.5, ry: 2.2, opacity: 0 }) : null; if (A.shadow) F.gBall.append(A.shadow);
  A.ball = ballEl(); F.gBall.append(A.ball); A.trail = sv('polyline', { class: `f-trail t${off}${an.kick ? ' kick' : ''}` }); F.gTrail.append(A.trail);
  // flight windows: throw/kick/punt until the next catch-like event (the ball arcs through the air between them)
  const ev = [...(an.events || [])].sort((x, y) => x.t - y.t); A.air = [];
  for (let i = 0; i < ev.length; i++) if (['throw', 'kick', 'punt'].includes(ev[i].k)) { const nxt = ev.slice(i + 1).find((e) => ['catch', 'incomplete', 'interception', 'faircatch'].includes(e.k)); A.air.push([ev[i].t, nxt ? nxt.t : (an.ball?.[an.ball.length - 1]?.[0] ?? ev[i].t + 2)]); }
  A.detail = detail; A.an = an; A.los = los; A.dir = dir; A.dur = Math.max(0.5, Number(an.dur) || 1); A.t = 0; A.last = 0; A.flashed = new Set(); A.popup = popup;
  if (an.kick && animate && !REDUCED) easeView(kickCam(los, dir), 0.8 / (S.speed || 1));
  updateControls();
  if (!animate || REDUCED) { A.t = A.dur; drawFrame(A.dur); finishAnim(); return Promise.resolve(); }
  // clocks: the game clock runs down from the pre-snap time while the 40-second play clock counts to the snap, then the
  // play's own seconds tick off during the animation (to 0:00 when the play ended the quarter)
  A.clk = detail.snap != null && detail.clk0 != null ? { c0: detail.clk0, snap: detail.snap, end: detail.q !== detail.pq ? 0 : detail.clock, pc: detail.pc ?? null } : null;
  A.playing = true; hidePicker(); renderTicker(); // the ticker reads "live" until the play is over; the outcome lands with the popup
  drawFrame(0);
  return runoffPhase().then(() => new Promise((res) => { A.done = res; if (!A.playing) { res(); return; } if (A.skipping) { A.skipping = false; A.t = A.dur; drawFrame(A.dur); finishAnim(); return; } A.raf = requestAnimationFrame(tick); }));
}
function clockText(gc, pc) {
  const g = E.score?.querySelector('.ss-game-clock b'), p = E.score?.querySelector('.ss-pclock');
  if (g && gc != null) g.textContent = mmss(gc);
  if (p) { p.textContent = pc == null ? '' : `:${String(Math.max(0, Math.round(pc))).padStart(2, '0')}`; p.classList.toggle('low', pc != null && pc <= 5); }
}
function runoffPhase() {
  const c = A.clk; if (!c) return Promise.resolve();
  const run = Math.max(0, c.c0 - c.snap); const dur = (run > 0 ? Math.min(2.2, Math.max(0.7, run / 14)) : c.pc != null ? 0.5 : 0) / (S.speed || 1);
  clockText(c.c0, c.pc != null ? 40 : null); if (!dur) return Promise.resolve();
  return new Promise((res) => {
    const t0 = performance.now(); A.runoff = res;
    const step = (now) => { if (A.runoff !== res) return; const f = Math.min(1, (now - t0) / (dur * 1000)); clockText(c.c0 - run * f, c.pc == null ? null : 40 - (40 - c.pc) * f); if (f >= 1) { A.runoff = null; res(); } else A.rafR = requestAnimationFrame(step); };
    A.rafR = requestAnimationFrame(step);
  });
}
function tick(ts) {
  if (!A.playing) return;
  if (A.last) A.t = Math.min(A.dur, A.t + Math.min(0.1, (ts - A.last) / 1000) * S.speed); A.last = ts;
  drawFrame(A.t);
  if (A.t >= A.dur) { finishAnim(); return; }
  A.raf = requestAnimationFrame(tick);
}
function drawFrame(t) {
  if (!A.an) return;
  if (A.clk && A.playing) clockText(A.clk.snap - (A.clk.snap - A.clk.end) * Math.min(1, t / A.dur), null);
  for (const { a, el } of A.actors) { const p = interp(a.path, t); if (p) place(el, ...toField(A.los, A.dir, p[0], p[1])); }
  const kp = kickAt(t); const bp = kp ? [kp.x, kp.y] : interp(A.an.ball, t) || [0, 0]; const [bxF, byF] = toField(A.los, A.dir, bp[0], bp[1]); const [bx, by0] = coord(bxF, byF);
  let lift = 0; if (kp) lift = kp.h * pxYd(bxF); else for (const [t0, t1] of A.air) if (t >= t0 && t <= t1 && t1 > t0) lift = Math.sin(((t - t0) / (t1 - t0)) * Math.PI) * 42 * depthScale(bxF);
  const by = by0 - lift; const sc = depthScale(bxF) * (kp ? 1 + Math.min(0.45, kp.h * 0.05) : lift ? 1.35 : 1);
  A.ball.setAttribute('transform', `translate(${bx.toFixed(1)} ${by.toFixed(1)}) scale(${sc.toFixed(2)})`);
  if (A.shadow) { A.shadow.setAttribute('transform', `translate(${bx.toFixed(1)} ${by0.toFixed(1)}) scale(${depthScale(bxF).toFixed(2)})`); A.shadow.setAttribute('opacity', kp && kp.h > 0.15 ? Math.max(0.12, 0.4 - kp.h * 0.025).toFixed(2) : '0'); }
  if (kp) A.trail.setAttribute('points', kickTrail(t));
  else { const pts = (A.an.ball || []).filter((k) => k[0] <= t).map((k) => toField(A.los, A.dir, k[1], k[2])); pts.push([bxF, byF]); A.trail.setAttribute('points', fieldPts(pts).map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')); }
  for (const e of A.an.events || []) if (e.t <= t && !A.flashed.has(e)) { A.flashed.add(e); if (t < A.dur || e.t > A.dur - 1.2) flash(FLASH[e.k] || String(e.k).toUpperCase(), bx, by); if (A.playing && t - e.t < 0.6) postFx(e.k); }
}
// ---- field goal / extra point flight: ground track from the hold to the end line (or where a short kick lands), height
// in yards on a parabola that comes down through kick.h at the end line; then the ball drops into the net behind the
// posts, caroms in or out off an upright, or bounces short; a blocked kick pops up off the block and falls
function kickAt(t) {
  const k = A.an?.kick; if (!k || t < k.t0) return null;
  if (k.res === 'blocked') { const p = interp(A.an.ball, t) || [0, 0]; const s = t - k.t1; return { x: p[0], y: p[1], h: s <= 0 ? 1.6 * Math.min(1, (t - k.t0) / Math.max(0.1, k.t1 - k.t0)) : Math.max(0, 1.6 * (1 - s / 0.4)) + (s > 0.4 && s < 0.8 ? 0.5 * Math.sin(((s - 0.4) / 0.4) * Math.PI) : 0) }; }
  const P = ((A.dir === 1 ? END_FAR : END_NEAR) - A.los) * A.dir; // the end line, offense-relative
  const X = k.res === 'short' ? P - (k.land || 3) : P, D = X + 7, T = Math.max(0.2, k.t1 - k.t0), f = (t - k.t0) / T;
  // apex, yards: kept under the upright tops so a make reads as going between them from either end of the field
  const Hm = k.res === 'short' ? 4.5 + D * 0.05 : Math.max(k.h + 0.4, Math.min(POST_H - 0.6, Math.max(k.h + 1.2, 6 + D * 0.08)));
  const L = k.res === 'short' ? 1 : 2 / (1 + Math.sqrt(Math.max(0, 1 - k.h / Hm))); // where the arc would come down (end line = 1)
  const arc = (g) => Math.max(0, 4 * Hm * (g / L) * (1 - g / L));
  const curve = (g) => (k.res === 'wide' ? g ** 1.6 : g); // a miss drifts late
  if (f <= 1) return { x: -7 + D * f, y: k.y * curve(f), h: arc(f) };
  const s = t - k.t1;
  if (k.res === 'short') { const g = Math.min(1, s / 0.7); return { x: X + 2.2 * g, y: k.y, h: 0.9 * Math.sin(g * Math.PI) * (1 - g * 0.5) }; }
  if (k.res === 'post') { const g = Math.min(1, s / 0.6), sd = Math.sign(k.y) || 1; return k.good ? { x: P + 2 * g, y: k.y + (sd * 1.4 - k.y) * g, h: k.h * (1 - g) } : { x: P - 4 * g, y: k.y + (sd * 5.5 - k.y) * g, h: Math.max(0, k.h * (1 - g) + 1.2 * Math.sin(g * Math.PI)) }; }
  const g = 1 + Math.min(s, 0.25) / T, h = arc(g); // through or wide: on into the net, then down
  return { x: -7 + D * g, y: k.y * curve(g), h: s <= 0.25 ? h : Math.max(0, h * (1 - (s - 0.25) / 0.35)) };
}
// the kick's path through the air (screen points, height included) up to time t
function kickTrail(t) {
  const k = A.an.kick; const out = (A.an.ball || []).filter((p) => p[0] <= k.t0).map((p) => coord(...toField(A.los, A.dir, p[1], p[2])));
  for (let s = k.t0; ; s = Math.min(t, s + 0.04)) { const p = kickAt(s); if (p) { const [fx, fy] = toField(A.los, A.dir, p.x, p.y); const [sx, sy] = coord(fx, fy); out.push([sx, sy - p.h * pxYd(fx)]); } if (s >= t) break; }
  return out.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
}
// the posts the kick is going at: they flash on a make and shake when the ball hits an upright
function postFx(k) {
  const g = A.dir === 1 ? F.postsFar : F.postsNear; const cls = k === 'good' ? ['good'] : k === 'doinkin' ? ['good', 'hit'] : k === 'doink' ? ['hit'] : null;
  if (!g || !cls || REDUCED) return;
  g.classList.remove('good', 'hit'); void g.getBoundingClientRect(); g.classList.add(...cls);
  clearTimeout(A.postT); A.postT = setTimeout(() => g.classList.remove('good', 'hit'), 1100 / (S.speed || 1));
}
function flash(text, x, y) {
  clear(F.gFlash); F.gFlash.append(sv('g', { class: 'f-flash', transform: `translate(${Math.min(940, Math.max(60, x)).toFixed(1)} ${Math.max(10, y - 24).toFixed(1)})` }, sv('text', {}, text)));
  clearTimeout(A.flashT); A.flashT = setTimeout(() => clear(F.gFlash), 900 / S.speed);
}
// the play is over: outcome in the ticker, then either the popup (picker follows its dismissal) or the picker itself
function finishAnim() { A.playing = false; cancelAnimationFrame(A.raf); A.clk = null; renderScore(); renderTicker(); if (A.popup && A.detail) showPopup(A.detail); else showPicker(); updateControls(); const d = A.done; A.done = null; if (d) d(); }
function skipAnim() { if (!A.an) return; if (A.runoff) { const r = A.runoff; A.runoff = null; cancelAnimationFrame(A.rafR); A.skipping = true; r(); return; } A.t = A.dur; drawFrame(A.dur); if (A.playing) finishAnim(); }
function replay() { if (!A.an || S.busy) return; A.t = 0; A.last = 0; A.flashed = new Set(); hidePopup(); hidePicker(); cancelAnimationFrame(A.raf); if (REDUCED) { drawFrame(A.dur); finishAnim(); return; } A.playing = true; A.raf = requestAnimationFrame(tick); updateControls(); }
function stopAnim() { if (A.runoff) { const r = A.runoff; A.runoff = null; cancelAnimationFrame(A.rafR); r(); } A.playing = false; A.clk = null; cancelAnimationFrame(A.raf); const d = A.done; A.done = null; if (d) d(); A.an = null; A.detail = null; }
async function showDetail(detail, animate, popup = true) { if (!detail) return; await startAnim(detail, animate, popup); }

// ---- per-play popup (v1 card: headline, the people involved as portraits, narrative) --------------------------------
function showPopup(detail) {
  const box = E.popup; if (!box || !detail) return; const T = S.input.teams;
  const people = (detail.people || []).map((p) => ({ ...p, pl: player(p.side, p.id) })).filter((p) => p.pl);
  const text = detail.text || ''; const key = people.find((p) => text.includes(shortName(p.pl))) || people[0] || null;
  const turnover = detail.kind === 'interception' || (/fumble/i.test(text) && !/recovers? (it|the ball) (him|her)self/i.test(text));
  const colorSide = detail.scoring ? (/^([A-Z0-9]+)/.exec(detail.scoring)?.[1] === T[1 - detail.off].abbr ? 1 - detail.off : detail.off) : turnover ? 1 - detail.off : detail.off;
  box.style.setProperty('--play-color', colorSide === 0 ? 'var(--away)' : 'var(--home)');
  const narrative = h('p'); const kn = key ? shortName(key.pl) : null;
  if (kn && text.includes(kn)) text.split(kn).forEach((chunk, i) => { if (i) narrative.append(h('strong', {}, kn)); narrative.append(chunk); }); else narrative.append(text);
  const portrait = (p) => {
    const span = h('span', { class: 'ss-portrait', style: `--portrait-color:${p.side === 0 ? 'var(--away)' : 'var(--home)'}` }, h('span', { 'aria-hidden': 'true' }, initials(p.pl)));
    if (p.pl.photoUrl) { const img = h('img', { src: p.pl.photoUrl, alt: p.pl.name, decoding: 'async' }); img.addEventListener('error', () => img.remove()); span.append(img); }
    return h('div', { class: `ss-featured-player${p === key ? ' key' : ''}` }, span, h('b', {}, shortName(p.pl)), h('small', {}, `${T[p.side].abbr} · ${ROLE[p.role] || p.role}`));
  };
  const yards = NOYDS.has(detail.kind) ? '' : `${detail.yards > 0 ? '+' : ''}${detail.yards} yd${Math.abs(detail.yards) === 1 ? '' : 's'}`;
  const bottom = [detail.scoring ? `${detail.scoring} · ${detail.score[0]}–${detail.score[1]}` : yards, detail.penalty && detail.penalty !== text ? detail.penalty : '', S.state?.running && !S.state.final ? 'clock running' : ''].filter(Boolean).join(' · ');
  clear(box); hidePicker();
  box.className = `ss-play-popup${detail.scoring ? ' score' : ''}${turnover ? ' turnover' : ''}`;
  box.append(
    h('div', { class: 'ss-popup-top' }, h('span', {}, detail.headline || 'PLAY'), h('small', {}, `PLAY ${detail.n}`), h('button', { type: 'button', 'aria-label': 'Dismiss play summary', onclick: dismissPopup }, '×')),
    h('div', { class: 'ss-popup-body' }, people.length ? h('div', { class: 'ss-portraits' }, people.slice(0, 3).map(portrait)) : null, h('div', { class: 'ss-play-narrative' }, narrative, h('small', {}, `${T[detail.off]?.abbr}: ${[detail.offPlay?.form, detail.offPlay?.set].filter(Boolean).join(' · ')} — ${detail.offPlay?.n || '—'}   ·   ${T[1 - detail.off]?.abbr}: ${[detail.defPlay?.form, detail.defPlay?.set].filter(Boolean).join(' · ')} — ${detail.defPlay?.n || '—'}`))),
    h('div', { class: 'ss-popup-bottom' }, h('span', {}, bottom || 'Result locked'), h('button', { type: 'button', onclick: dismissPopup }, S.state?.final ? 'View final' : 'Call next play →')));
  box.hidden = false;
}
function hidePopup() { if (E.popup) E.popup.hidden = true; }
// the coach closed the card: bring the picker back (and scroll to it when it sits below the field)
function dismissPopup() { hidePopup(); showPicker(); if (window.innerWidth < 1000) E.picker?.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }); }

// ---- picker visibility: 'open' (full), 'min' (thin "Call a play" bar), 'off' (play in progress) -------------------------
function setPicker(mode) {
  S.picker = mode; if (!E.picker) return;
  E.picker.classList.toggle('show', mode === 'open');
  E.pickerBar.className = `ss-pickerbar ${mode}`; clear(E.pickerBar);
  if (mode === 'min') E.pickerBar.append(h('button', { type: 'button', 'aria-expanded': 'false', onclick: () => setPicker('open') }, 'Call a play ▴'));
  else if (mode === 'off') E.pickerBar.append(h('span', {}, S.autoRun ? 'Simulating…' : S.busy ? 'Rolling the snap…' : 'Play in progress…'));
}
// between plays only: never during an auto run, a request in flight, an animation or while the popup is open
function showPicker() { if (!E.picker) return; if (S.state && !S.state.final && !S.waiting && (S.autoRun || S.busy || A.playing || (E.popup && !E.popup.hidden))) return; setPicker('open'); }
function hidePicker() { setPicker('off'); }

// ---- payload / colors / lighting --------------------------------------------------------------------------------------
function applyPayload(p) {
  if (!p) return; S.payload = p; S.input = p.input || S.input; S.you = p.you ?? null; S.state = p.state ?? null; S.version = p.version ?? S.version; S.final = p.final ?? null; S.opponentHuman = !!p.opponentHuman;
  if (p.state?.tempo) S.tempo = p.state.tempo;
  S.waiting = p.pendingSide != null && !!p.pendingMine;
  if (S.state && S.state.phase !== S.lastPhase) { S.lastPhase = S.state.phase; S.gid = null; S.setId = null; }
  S.selected = null; resolveColors(); ensureBooks();
}
const rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const close = (a, b) => { const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b); return Math.hypot(r1 - r2, g1 - g2, b1 - b2) < 70; };
// team colors from the logos (palette.js), the owned team drives --brand/--accent
async function resolveColors() {
  const T = S.input?.teams; if (!T || S.colorsDone) return; S.colorsDone = true;
  const cols = await Promise.all(T.map((t) => teamColor(t).catch(() => '#496caa')));
  if (close(cols[0], cols[1])) cols[1] = close(cols[1], '#d1c8b3') ? '#2d6a4f' : '#d1c8b3';
  root.style.setProperty('--away', cols[0]); root.style.setProperty('--home', cols[1]);
  const mine = cols[S.you ?? 0]; root.style.setProperty('--brand', mine); root.style.setProperty('--accent', readableAccent(mine));
}
// stadium lighting follows the game clock (kickoff 4:30 PM, three hours of real time per game) unless overridden
function sceneTime(st) {
  const qsec = S.input?.quarterSeconds || 900, total = 4 * qsec;
  const elapsed = st ? Math.min(total, Math.max(0, (Math.min(st.q, 4) - 1) * qsec + qsec - (st.q > 4 ? 0 : st.clock))) : 0;
  const minutes = 16 * 60 + 30 + (elapsed / total) * 180 + (st?.ot ? st.ot.period * 15 : 0);
  const local = minutes % 1440, sunrise = 360, sunset = 18 * 60 + 30;
  let phase = local < sunrise - 30 || local >= sunset + 30 ? 'night' : local < sunrise + 30 ? 'dawn' : local < sunset - 45 ? 'day' : 'dusk';
  if (S.lighting !== 'auto') phase = S.lighting;
  const hh = Math.floor(minutes / 60) % 24, mm = Math.floor(minutes % 60);
  return { phase, label: `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}` };
}
function updateLighting() { const time = sceneTime(S.state); root.dataset.time = time.phase; if (E.stadiumTime) E.stadiumTime.textContent = `${time.label} · ${time.phase.toUpperCase()}`; }

// ---- actions -------------------------------------------------------------------------------------------------------
async function snap() {
  if (S.busy || !S.selected || S.waiting || !S.state || S.state.final) return;
  S.busy = true; hidePopup(); hidePicker(); updateControls();
  try {
    const r = await post({ action: 'play', play: S.selected.id, tempo: S.tempo }); if (!r) return;
    applyPayload(r); render();
    if (r.waiting) { startPoll(); return; }
    if (r.detail) await showDetail(r.detail, !S.skipAnim, true);
    if (S.state?.final) render();
  } catch (e) { toast(e.message, { retry: snap }); }
  finally { S.busy = false; updateControls(); showPicker(); }
}
async function auto(mode) {
  if (S.busy || S.waiting || !S.state || S.state.final) return;
  if (mode === 'final' && !window.confirm('Simulate the rest of the game? The CPU calls your plays from here and the result is final.')) return;
  S.busy = true; S.autoRun = mode; S.stopAuto = false; hidePopup(); hidePicker(); updateControls();
  const st0 = S.state, q0 = st0.q, drives0 = st0.drives?.length || 0, off0 = actingOff(st0); let plays = 0;
  const chunk = mode === 'next' ? 1 : mode === 'drive' ? 6 : mode === 'quarter' ? 20 : 40;
  try {
    for (;;) {
      setProgress(`Simulating… ${plural(plays, 'play')}`);
      const r = await post({ action: 'auto', plays: chunk }); if (!r) break;
      applyPayload(r); render(); const ds = r.details || []; plays += ds.length;
      if (mode === 'next' || mode === 'drive') { for (const d of ds) { if (S.stopAuto) break; await showDetail(d, !S.skipAnim && !S.stopAuto, !S.skipAnim && d === ds[ds.length - 1]); } }
      else if (ds.length) await showDetail(ds[ds.length - 1], false, false);
      const st = S.state; if (!st || st.final || S.stopAuto || mode === 'next' || r.waiting) { if (r.waiting) startPoll(); break; }
      if (mode === 'drive' && ((st.drives?.length || 0) !== drives0 || actingOff(st) !== off0 || st.phase !== 'snap')) break;
      if (mode === 'quarter' && st.q !== q0) break;
    }
  } catch (e) { toast(e.message); }
  finally { S.busy = false; S.autoRun = null; setProgress(''); render(); if (S.state && !S.state.final && !A.an) drawPreSnap(); showPicker(); }
}
async function callTimeout() {
  if (S.busy || S.waiting) return; S.busy = true; updateControls();
  try { const r = await post({ action: 'timeout' }); if (r) { applyPayload(r); render(); toast('Timeout. The clock is stopped.', { ok: true }); } } catch (e) { toast(e.message); }
  finally { S.busy = false; updateControls(); }
}
async function setTempo(t) {
  if (S.tempo === t) return; S.tempo = t; updateControls();
  try { const r = await post({ action: 'tempo', tempo: t }); if (r) { applyPayload(r); renderScore(); } } catch (e) { toast(e.message); }
}
async function startGame() {
  if (S.busy) return; S.busy = true; updateControls();
  try { const r = await post({ action: 'start' }); if (r) { applyPayload(r); render(); await ensureBooks(); drawPreSnap(); toast(S.state?.phase === 'toss' ? 'Captains to midfield for the coin toss.' : 'Kickoff. Every call from here is yours.', { ok: true }); } } catch (e) { toast(e.message, { retry: startGame }); }
  finally { S.busy = false; updateControls(); showPicker(); }
}
// human opponent: poll until the other sideline's call lands
function startPoll() {
  stopPoll(); S.waiting = true; renderPicker();
  S.poll = setInterval(async () => {
    try {
      const p = await api('GET'); if (p.version === S.version) return;
      const prevN = S.state?.n ?? 0; applyPayload(p);
      if (S.waiting) { renderScore(); return; } // still pending (the opponent changed tempo or called time)
      stopPoll(); render();
      if (p.state?.last && p.state.n > prevN) await showDetail(p.state.last, !S.skipAnim, true); else { drawPreSnap(); showPicker(); }
      if (S.state?.final) render();
    } catch { /* keep polling */ }
  }, 3000);
}
function stopPoll() { clearInterval(S.poll); S.poll = null; }
function select(book, play, set, form) { S.selected = { id: play.id, play, set, form, book }; drawPreSnap(); updateControls(); }
// a sensible local pick for the situation (random within the matching family, preferring the open set)
function suggest() {
  const c = callCtx(); if (!c?.book) return; const { book, side, gs, st } = c; const all = [];
  for (const g of gs) for (const s of g.sets) for (const id of s.plays) { const p = book.plays[String(id)]; if (p) all.push({ p, s, g, fm: fam(book, p) }); }
  if (!all.length) return;
  const pick = (fn) => { const list = all.filter(fn); return list.length ? rnd(list) : null; };
  const prefer = (fn) => pick((x) => x.s.id === S.setId && fn(x)) || pick(fn);
  const lead = st.score[S.you] - st.score[1 - S.you], late = st.q >= 4 && st.clock < 180, long = st.toGo >= 7, short = st.toGo <= 2, oppDist = 100 - st.ball;
  const normal = (x) => !/hail mary|special/i.test(x.g.f.n); let c2 = null;
  if (st.phase === 'kickoff') c2 = side === 'off' ? ((late && lead < 0 && lead >= -8 && pick((x) => /onside/i.test(x.p.n))) || pick((x) => x.fm === 'kick' && !/onside|squib/i.test(x.p.n))) : ((late && lead > 0 && lead <= 8 && pick((x) => /onside/i.test(x.s.n))) || pick((x) => !/onside/i.test(x.s.n)));
  else if (st.phase === 'pat') { const two = late && (lead === -2 || lead === -5 || lead === 1); c2 = side === 'off' ? (two ? pick((x) => normal(x) && (x.fm === 'run' || x.fm === 'pass') && (/goal/i.test(x.g.f.n) || Math.random() < 0.3)) || pick((x) => normal(x) && x.fm !== 'kick') : pick((x) => x.fm === 'kick' && x.p.t === 21)) : pick((x) => x.fm === 'fg') || pick((x) => x.fm === 'man' || x.fm === 'blitz'); }
  else if (side === 'off') {
    if (st.down === 4) { if (oppDist <= 35 && st.toGo > 1) c2 = pick((x) => x.fm === 'kick' && /field goal/i.test(x.s.n) && x.p.t === 21); else if (st.toGo > 2 && st.ball < 60) c2 = pick((x) => x.fm === 'punt' && /^punt$/i.test(x.p.n.trim())) || pick((x) => x.fm === 'punt' && x.p.t === 21); }
    if (!c2 && !st.ot && st.q >= 4 && lead > 0 && st.clock <= 40 * (4 - st.down) + 5) c2 = pick((x) => x.fm === 'kneel');
    if (!c2 && late && lead < 0 && st.clock < 8 && oppDist > 40) c2 = pick((x) => /hail mary/i.test(x.g.f.n));
    if (!c2) c2 = prefer((x) => normal(x) && (long ? x.fm === 'pass' || x.fm === 'pa' || x.fm === 'screen' : short ? x.fm === 'run' || x.fm === 'option' : ['run', 'option', 'pass', 'pa', 'screen'].includes(x.fm)));
  } else {
    if (st.down === 4 && st.toGo > 2 && st.ball < 60) c2 = pick((x) => /punt return/i.test(x.s.n) && !/safe/i.test(x.s.n)) || pick((x) => /punt/i.test(x.s.n));
    else if (st.down === 4 && st.ball >= 65) c2 = pick((x) => x.fm === 'fg');
    if (!c2) c2 = prefer((x) => normal(x) && (long ? x.fm === 'zone' || x.fm === 'man' : short ? x.fm === 'blitz' || x.fm === 'man' : x.fm === 'zone' || x.fm === 'man' || x.fm === 'blitz'));
  }
  c2 = c2 || rnd(all); S.gid = c2.g.key; S.setId = c2.s.id; S.search = ''; select(book, c2.p, c2.s, c2.g.f); renderPicker();
  E.tiles?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

// ---- rendering: shell (v1 layout, full-width stage) ----------------------------------------------------------------------
function topbar() {
  const me = S.input?.teams?.[S.you ?? 0];
  return h('header', { class: 'ss-topbar' },
    h('a', { class: 'ss-brand', href: BACK }, h('span', { class: 'ss-shield' }, 'FCS'), ' ONLINE DYNASTY ', h('span', { class: 'ss-context' }, '/ SUPERSIM')),
    h('div', { class: 'ss-own' }, me ? h('img', { src: me.logo || '', alt: '' }) : null, me ? h('span', {}, `${me.name} · Your team`) : null, S.input?.backUrl ? h('a', { href: S.input.backUrl }, 'Back to game ↗') : h('a', { href: BACK }, 'Dynasty ↗')));
}
function screen(node) { S.shell = false; root.className = 'ss'; clear(root); root.append(topbar(), h('main', { class: 'ss-wrap' }, node)); }
function errorPanel(msg, retry) { return h('div', { class: 'ss-error' }, h('h1', {}, 'Supersim unavailable'), h('p', {}, String(msg || 'Unknown error')), retry ? h('button', { class: 'primary', type: 'button', onclick: retry }, 'Reload') : null, ' ', h('a', { class: 'ss-btnlink', href: BACK }, 'Back to the dynasty')); }
function ensureShell() {
  if (S.shell) return; clear(root); root.className = 'ss';
  const heading = h('div', { class: 'ss-heading' },
    h('div', {}, h('div', { class: 'ss-eyebrow' }, `${S.input.dynasty || 'Dynasty'} / Week ${S.input.week}`), h('h1', {}, 'Super', h('span', {}, 'sim')), h('div', { class: 'ss-sub' }, 'Your game. Every snap is yours to call.')),
    h('div', { class: 'ss-heading-actions' }, h('span', { class: 'ss-tag' }, 'COACH MODE'), h('select', { 'aria-label': 'Stadium lighting', onchange: (e) => { S.lighting = e.target.value; updateLighting(); } }, [['auto', 'Auto daylight'], ['day', 'Day'], ['dusk', 'Dusk'], ['night', 'Night']].map(([v, l]) => h('option', { value: v }, l))), h('a', { class: 'ss-btnlink', href: S.input.backUrl || BACK }, 'Back to game ↗')));
  E.score = h('div', { class: 'ss-scoreboard' });
  E.side = [0, 1].map((i) => h('aside', { class: `ss-sidebox${i ? ' home' : ''}` }));
  E.popup = h('section', { class: 'ss-play-popup', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', hidden: true });
  E.picker = h('section', { class: 'ss-picker', 'aria-label': 'Play call' }); E.pickerBar = h('div', { class: 'ss-pickerbar off' });
  E.stadiumTime = h('span', { class: 'ss-stadium-time' }); E.progress = h('div', { class: 'ss-progress' });
  const arena = h('div', { class: 'ss-arena' }, F.svg || buildField(), E.picker, E.pickerBar, E.side[0], E.side[1], E.stadiumTime, E.progress, E.popup, (E.subs = h('section', { class: 'ss-subs', 'aria-label': 'Substitutions', hidden: true })));
  E.down = h('span', { class: 'ss-down' }); E.call = h('span', { class: 'ss-call' }); E.gain = h('span', { class: 'ss-gain' });
  E.speed = h('select', { 'aria-label': 'Playback speed', onchange: (e) => { S.speed = Number(e.target.value) || 1; } }, [1, 2, 4].map((s) => h('option', { value: s, selected: S.speed === s || null }, `${s}× speed`)));
  E.replay = h('button', { type: 'button', onclick: replay }, '↺ Replay'); E.skip = h('button', { type: 'button', onclick: skipAnim }, 'Skip ⇥');
  E.focus = h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => { S.focus = !S.focus; E.focus.setAttribute('aria-pressed', String(S.focus)); E.focus.textContent = S.focus ? 'Full field' : 'Focus play'; focusView(A.los ?? (S.state ? absBall(S.state, actingOff(S.state), S.state.ball) : null)); } }, 'Focus play');
  const stage = h('section', { class: 'ss-stage', 'aria-label': 'Football game' }, E.score, arena, h('div', { class: 'ss-ticker' }, E.down, E.call, E.gain), h('div', { class: 'ss-controls' }, E.speed, E.replay, E.skip, E.focus, h('span', { class: 'ss-legend' }, h('i', { class: 'los' }), 'Scrimmage ', h('i', { class: 'fd' }), 'First down')));
  E.panel = h('section', { class: 'ss-panel ss-collapsible' });
  root.append(topbar(), h('main', { class: 'ss-wrap' }, heading, stage, E.panel, h('div', { class: 'ss-footer' }, h('span', {}, 'FCS ONLINE DYNASTY · SUPERSIM / COACH MODE'), h('span', {}, `Game ${S.input.gameId || ''} · results are rolled when you snap; nothing is pre-decided`))));
  S.shell = true; setPicker(S.picker);
}
function render() {
  if (!S.payload) return;
  if (S.you == null) return screen(errorPanel('You are not one of the two teams in this game, so there is nothing to coach here.'));
  if (S.state?.final) stopPoll();
  ensureShell(); renderScore(); renderSide(); renderTicker(); renderPicker(); renderTabs(); updateControls(); updateLighting();
}
function setProgress(text) {
  if (!E.progress) return; clear(E.progress); if (!text) { E.progress.className = 'ss-progress'; return; }
  E.progress.className = 'ss-progress show'; E.progress.append(h('span', {}, text), h('button', { type: 'button', onclick: () => { S.stopAuto = true; skipAnim(); } }, 'Stop'));
}

// ---- rendering: scoreboard / sideboxes / ticker --------------------------------------------------------------------------
function renderScore() {
  const st = S.state, T = S.input?.teams; if (!E.score || !T) return; clear(E.score);
  const off = st && !st.final ? actingOff(st) : null;
  const team = (i) => h('div', { class: `ss-team-score${i ? ' home' : ''}${off === i ? ' poss' : ''}` },
    h('img', { src: T[i].logo || '', alt: '' }),
    h('div', { class: 'ss-team-label' }, h('strong', {}, T[i].name), h('small', {}, `${i ? 'HOME' : 'AWAY'}${S.you === i ? ' · YOUR TEAM' : S.opponentHuman ? ' · HUMAN COACH' : ' · CPU'}`), h('span', { class: 'ss-to', title: `${st?.to?.[i] ?? 3} timeouts left` }, [0, 1, 2].map((k) => h('i', { class: k < (st?.to?.[i] ?? 3) ? 'on' : '' })))),
    h('span', { class: 'points' }, String(st?.score?.[i] ?? 0)));
  const mid = h('div', { class: 'ss-game-clock' },
    h('span', {}, !st ? 'PREGAME' : st.final ? (st.ot ? 'FINAL / OT' : 'FINAL') : st.phase === 'toss' ? 'COIN TOSS' : `${qLabel(st.q)}${st.phase === 'kickoff' ? ' · KICKOFF' : st.phase === 'pat' ? ' · PAT' : ''}`),
    h('div', { class: 'ss-clocks' }, h('b', {}, st ? mmss(st.clock) : mmss(S.input.quarterSeconds || 720)), h('i', { class: 'ss-pclock', title: 'Play clock' }, st && !st.final && st.phase === 'snap' ? ':40' : '')),
    h('span', { class: 'ss-dd' }, !st ? 'READY FOR KICKOFF' : st.final ? 'GAME OVER' : st.phase === 'toss' ? 'CAPTAINS AT MIDFIELD' : st.phase === 'snap' ? `${downDist(st).toUpperCase()} · ${spotLabel(st.off, st.ball)}` : st.phase === 'kickoff' ? `${abbr(st.kicking)} KICK FROM THE ${st.freeKick ? 20 : 35}` : `${abbr(st.patTeam ?? st.off)} POINT AFTER`),
    st && !st.final && st.phase !== 'toss' ? h('span', {}, `${abbr(off)} BALL${st.running ? ' · CLOCK RUNNING' : ''}`) : null,
    st?.tempo && st.tempo !== 'normal' && !st.final ? h('em', { class: 'ss-tempo' }, st.tempo === 'hurry' ? 'HURRY-UP' : 'CHEW CLOCK') : null);
  E.score.append(team(0), mid, team(1));
}
function renderSide() {
  const st = S.state, T = S.input?.teams; if (!E.side || !T) return;
  [0, 1].forEach((i) => {
    const t = st?.team?.[i]; clear(E.side[i]);
    E.side[i].append(h('h3', {}, h('img', { src: T[i].logo || '', alt: '' }), T[i].abbr), ...[['1st downs', t?.fd ?? 0], ['Total yds', t?.yds ?? 0], ['Pass yds', t?.py ?? 0], ['Rush yds', t?.ry ?? 0], ['3rd down', t ? `${t.t3c}/${t.t3a}` : '0/0'], ['Turnovers', t?.to ?? 0], ['TOP', mmss(t?.top ?? 0)]].map(([l, v]) => h('div', { class: 'ss-stat' }, h('span', { class: 'statlabel' }, l), h('span', { class: 'statnum' }, String(v)))));
  });
}
function renderTicker() {
  const st = S.state, T = S.input?.teams; if (!E.down || !T) return;
  if (!st) { E.down.textContent = 'PREGAME'; E.call.textContent = `${T[0].name} at ${T[1].name}`; E.gain.textContent = `WEEK ${S.input.week}`; return; }
  E.down.textContent = st.final ? 'FINAL' : `${downDist(st).toUpperCase()}${st.phase === 'snap' ? ` · ${spotLabel(st.off, st.ball)}` : st.phase === 'kickoff' ? ` · ${abbr(st.kicking)} ${st.freeKick ? 20 : 35}` : ''}`;
  if (A.playing && A.detail) { E.call.textContent = `${abbr(A.detail.off)} snap it — ${A.detail.offPlay?.n || 'the play'} against ${A.detail.defPlay?.n || 'the defense'}…`; E.gain.textContent = 'LIVE'; return; }
  const d = A.detail || st.last, sel = S.selected;
  E.call.textContent = sel && !A.detail ? `Your call: ${sel.form.n} · ${sel.set.n} — ${sel.play.n}` : d ? d.text : S.waiting ? `Waiting for ${T[1 - S.you].name}…` : 'Pick a play to start the game.';
  E.gain.textContent = sel && !A.detail ? 'READY' : d ? (NOYDS.has(d.kind) ? (d.scoring || d.headline || '').toUpperCase() : `${d.yards > 0 ? '+' : ''}${d.yards} YDS`) : '';
}

// ---- rendering: picker (play call / start / final / waiting) -------------------------------------------------------------
function callCtx() {
  const st = S.state; if (!st || st.final || S.you == null) return null;
  const off = actingOff(st); const side = S.you === off ? 'off' : 'def'; const bookId = S.payload?.books?.[side]?.[S.you]; const book = bookSync(bookId);
  return { st, off, side, bookId, book, gs: book ? groups(book, side, st) : [] };
}
function matchTeam(i, cls, sub) { const T = S.input.teams[i]; return h('div', { class: `ss-mteam t${i}${cls}` }, h('img', { src: T.logo || '', alt: '' }), h('div', {}, h('b', {}, T.name), h('small', {}, sub))); }
function startCard() {
  const f = S.final, T = S.input.teams;
  const sub = (i) => `${S.you === i ? 'You' : S.opponentHuman ? 'Human coach' : 'CPU'} · ${bookName(T[i].offBook)} / ${bookName(T[i].defBook)}`;
  return h('div', { class: 'ss-cardbody' },
    h('div', { class: 'ss-cardhead' }, h('div', {}, h('div', { class: 'ss-eyebrow' }, 'Coach mode'), h('h2', {}, 'Call every snap')), h('div', { class: 'ss-matchup' }, matchTeam(0, S.you === 0 ? ' you' : '', sub(0)), h('span', { class: 'ss-at' }, 'at'), matchTeam(1, S.you === 1 ? ' you' : '', sub(1)))),
    h('p', { class: 'ss-summary' }, f ? `This game already has an official result. ${STATUS[f.status] || f.status}` : 'You call every play of your team’s game from its real NCAA Football 14 playbook: formation, set, play, snap. Results are rolled when you snap; nothing is pre-decided. On defense you call the coverage. The final is sent to the league server for the console.'),
    f ? null : h('p', { class: 'ss-warn' }, CONSOLE_NOTE),
    h('div', { class: 'ss-row' }, f ? null : h('button', { class: 'primary ss-snap', type: 'button', onclick: startGame }, 'Start game'), h('a', { class: 'ss-btnlink', href: S.input.backUrl || BACK }, 'Back to game page')));
}
// ---- coin toss: the visiting team calls it; the winner receives, kicks off, or defers to the second half
function tossCard() {
  const st = S.state, t = st.toss || {}, T = S.input.teams, you = S.you; const caller = T[t.caller]?.name || 'The visitors';
  const coin = h('div', { class: `ss-coin${S.tossSpin ? ' spin' : ''}${t.result ? ` show-${t.result}` : ''}`, 'aria-hidden': 'true' }, h('span', { class: 'face heads' }, 'H'), h('span', { class: 'face tails' }, 'T'));
  let body;
  if (!t.result) body = t.caller === you
    ? [h('p', { class: 'ss-summary' }, 'You are the visiting team, so you call it in the air.'), h('div', { class: 'ss-row' }, h('button', { class: 'primary', type: 'button', onclick: () => toss({ call: 'heads' }) }, 'Heads'), h('button', { class: 'primary', type: 'button', onclick: () => toss({ call: 'tails' }) }, 'Tails'))]
    : S.opponentHuman ? [h('p', { class: 'ss-summary' }, `${caller} call the toss. Waiting for the other coach…`)]
      : [h('p', { class: 'ss-summary' }, `${caller} are the visitors and call the toss.`), h('div', { class: 'ss-row' }, h('button', { class: 'primary', type: 'button', onclick: () => toss({}) }, 'Flip the coin'))];
  else if (t.winner === you && !t.choice) body = [h('p', { class: 'ss-summary' }, `${caller} called ${t.call}. It is ${t.result}: you win the toss.`),
    h('div', { class: 'ss-row' }, h('button', { class: 'primary', type: 'button', onclick: () => toss({ choice: 'defer' }) }, 'Defer'), h('button', { type: 'button', onclick: () => toss({ choice: 'receive' }) }, 'Receive'), h('button', { type: 'button', onclick: () => toss({ choice: 'kick' }) }, 'Kick off')),
    h('p', { class: 'ss-note' }, 'Defer: kick off now and receive the second-half kickoff. Kick off: the other team receives both halves.')];
  else body = [h('p', { class: 'ss-summary' }, 'The other coach won the toss and is choosing…')];
  return h('div', { class: 'ss-cardbody ss-toss' }, h('div', { class: 'ss-cardhead' }, h('div', {}, h('div', { class: 'ss-eyebrow' }, 'Coin toss'), h('h2', {}, 'Who gets the ball?')), coin), ...body);
}
async function toss(body) {
  if (S.busy) return; S.busy = true; S.tossSpin = true; renderPicker();
  try {
    const [r] = await Promise.all([post({ action: 'toss', ...body }), new Promise((ok) => setTimeout(ok, REDUCED ? 0 : 1200))]);
    S.tossSpin = false; if (!r) return; applyPayload(r); render();
    const t = S.state?.toss; const T = S.input.teams;
    if (S.state?.phase === 'kickoff') { const last = [...(S.state.log || [])].reverse().find((e) => e.k === 'toss'); toast(last?.t || 'Coin toss done.', { ok: true }); drawPreSnap(); showPicker(); }
    else if (t?.result) toast(`It is ${t.result}. ${t.winner === S.you ? 'You win the toss.' : `${T[t.winner].name} win the toss.`}`, { ok: true });
  } catch (e) { S.tossSpin = false; toast(e.message); renderPicker(); }
  finally { S.busy = false; S.tossSpin = false; updateControls(); }
}
// ---- substitutions: who starts at each spot for the rest of this game (Depth button in the call bar)
const SUB_SLOTS = [['Offense', [[0, 0, 'QB'], [1, 0, 'HB'], [2, 0, 'FB'], [3, 0, 'WR1'], [3, 1, 'WR2'], [3, 2, 'WR3'], [4, 0, 'TE'], [5, 0, 'LT'], [6, 0, 'LG'], [7, 0, 'C'], [8, 0, 'RG'], [9, 0, 'RT']]],
  ['Defense', [[10, 0, 'LE'], [12, 0, 'DT1'], [12, 1, 'DT2'], [11, 0, 'RE'], [13, 0, 'LOLB'], [14, 0, 'MLB'], [15, 0, 'ROLB'], [16, 0, 'CB1'], [16, 1, 'CB2'], [17, 0, 'FS'], [18, 0, 'SS']]],
  ['Special teams', [[19, 0, 'K'], [20, 0, 'P'], [21, 0, 'KR'], [22, 0, 'PR']]]];
function openSubs() {
  if (!E.subs || !S.state || S.state.final) return;
  const team = teamFor(S.you), players = team?.players || []; const byId = new Map(players.map((p) => [p.id, p])); const subs = S.state.subs?.[S.you] || {};
  const chartAt = (pos) => (team.depthChart || []).filter((d) => d.pos === pos).sort((a, b) => a.depth - b.depth).map((d) => d.pgid);
  const label = (p) => `#${p.number ?? ''} ${shortName(p)} · ${POS[p.pos] || ''} ${p.overall ?? ''}`;
  const row = ([pos, depth, name]) => {
    const cur = chartAt(pos)[depth]; const same = players.filter((p) => p.pos === pos).sort((a, b) => b.overall - a.overall); const rest = players.filter((p) => p.pos !== pos).sort((a, b) => a.pos - b.pos || b.overall - a.overall);
    const opt = (p) => h('option', { value: p.id, selected: p.id === cur || null }, label(p));
    const sel = h('select', { 'aria-label': `${name} starter`, onchange: (e) => sub(pos, depth, Number(e.target.value), name) }, cur && !byId.has(cur) ? h('option', { value: cur, selected: true }, 'Current starter') : null, h('optgroup', { label: POS[pos] || 'Position' }, same.map(opt)), h('optgroup', { label: 'Other positions' }, rest.map(opt)));
    return h('label', { class: `ss-subrow${subs[String(pos)] ? ' changed' : ''}` }, h('span', {}, name), sel);
  };
  clear(E.subs); E.subs.hidden = false;
  E.subs.append(h('div', { class: 'ss-subs-head' }, h('b', {}, 'Depth chart · this game'), h('button', { type: 'button', onclick: resetSubs, disabled: !Object.keys(subs).length || null }, 'Reset'), h('button', { type: 'button', 'aria-label': 'Close', onclick: () => { E.subs.hidden = true; } }, '✕')),
    h('p', { class: 'ss-note' }, 'Changes take effect on the next snap and last for the rest of this game. The console depth chart is not changed.'),
    ...SUB_SLOTS.map(([title, slots]) => h('div', { class: 'ss-subgroup' }, h('h4', {}, title), ...slots.map(row))));
}
async function sub(pos, depth, pgid, name) {
  if (S.busy) return; S.busy = true;
  try { const r = await post({ action: 'sub', pos, depth, pgid }); if (r) { applyPayload(r); render(); drawPreSnap(); openSubs(); const p = player(S.you, pgid); toast(`${p ? shortName(p) : 'Player'} in at ${name}.`, { ok: true }); } } catch (e) { toast(e.message); }
  finally { S.busy = false; updateControls(); }
}
async function resetSubs() {
  if (S.busy) return; S.busy = true;
  try { const r = await post({ action: 'subreset' }); if (r) { applyPayload(r); render(); drawPreSnap(); openSubs(); toast('Back to the depth chart.', { ok: true }); } } catch (e) { toast(e.message); }
  finally { S.busy = false; updateControls(); }
}
function finalCard() {
  const st = S.state, T = S.input.teams, f = S.final, w = st.winner;
  const side = (i) => h('div', { class: `ss-fteam t${i}${w === i ? ' won' : ''}` }, h('img', { src: T[i].logo || '', alt: '' }), h('div', {}, h('b', {}, T[i].abbr), h('span', {}, T[i].name)), h('div', { class: 'ss-fscore' }, String(st.score[i])));
  return h('div', { class: 'ss-cardbody' },
    h('div', { class: 'ss-cardhead' }, h('div', {}, h('div', { class: 'ss-eyebrow' }, st.ot ? `Final · ${st.q - 4}OT` : 'Final'), h('h2', {}, w == null ? 'Tie game' : `${T[w].name} win`)), h('div', { class: 'ss-matchup final' }, side(0), side(1))),
    h('div', { class: `ss-statuspill s-${f?.status || 'none'}` }, f ? STATUS[f.status] || f.status : 'The result is being recorded.'),
    f && f.status !== 'synced' && f.status !== 'conflict' ? h('p', { class: 'ss-warn' }, CONSOLE_NOTE) : null,
    h('div', { class: 'ss-row' }, h('a', { class: 'primary ss-btnlink', href: S.input.backUrl || BACK }, 'Back to game page'), h('button', { type: 'button', onclick: () => { S.tab = 'box'; setTabsOpen(true); E.panel?.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }); } }, 'Box score ↓')));
}
function renderPicker() {
  const el = E.picker; if (!el) return; clear(el); el.className = `ss-picker${S.picker === 'open' ? ' show' : ''}`;
  const card = (node) => { el.classList.add('card'); el.append(node); setPicker('open'); };
  if (!S.state) return card(startCard());
  if (S.state.final) return card(finalCard());
  if (S.state.phase === 'toss') return card(tossCard());
  const c = callCtx(); if (!c) return; const { st, side, book, gs } = c;
  if (S.waiting) return card(h('div', { class: 'ss-waiting' }, h('div', { class: 'ss-spin' }), h('b', {}, `Waiting for ${S.input.teams[1 - S.you].name}…`), h('p', { class: 'ss-note' }, 'Your call is in. The snap resolves when the other coach sends theirs; this page checks every few seconds.')));
  if (!book) { el.classList.add('card'); el.append(S.bookErr ? h('div', { class: 'ss-waiting' }, h('p', { class: 'ss-warning' }, S.bookErr), h('button', { class: 'primary', type: 'button', onclick: () => { ensureBooks(true); renderPicker(); } }, 'Reload playbook')) : h('div', { class: 'ss-waiting' }, h('div', { class: 'ss-spin' }), 'Loading your playbook…')); return; }
  const phaseTag = st.phase === 'kickoff' ? (side === 'off' ? 'Kickoff' : 'Return') : st.phase === 'pat' ? 'PAT' : side === 'off' ? 'Offense' : 'Defense';
  if (!gs.length) { el.append(h('div', { class: 'ss-waiting ss-note' }, 'No plays are available for this situation.'), callBar(c)); return; }
  const g = gs.find((x) => x.key === S.gid) || gs[0]; S.gid = g.key;
  const set = g.sets.find((s) => s.id === S.setId) || g.sets[0]; S.setId = set.id; S.curG = g; S.curSet = set;
  const forms = h('div', { class: 'ss-chips forms', 'aria-label': 'Formations' }, gs.map((x) => h('button', { class: 'ss-chip form', type: 'button', 'aria-pressed': String(x === g), onclick: () => { S.gid = x.key; S.setId = null; S.search = ''; renderPicker(); } }, x.name)));
  const sets = h('div', { class: 'ss-chips sets', 'aria-label': 'Sets' }, g.sets.length > 1 ? g.sets.map((s) => h('button', { class: 'ss-chip', type: 'button', 'aria-pressed': String(s === set), onclick: () => { S.setId = s.id; S.search = ''; renderPicker(); } }, s.n)) : h('span', { class: 'ss-setname' }, set.n));
  const filtering = S.filter !== 'all' || S.search.trim();
  el.append(h('div', { class: 'ss-pickhead' }, h('span', { class: `ss-pickside ${side}` }, phaseTag), h('div', { class: 'ss-pickrows' }, forms, sets),
    h('div', { class: 'ss-picktools' }, h('button', { class: `ss-icon${filtering ? ' active' : ''}`, type: 'button', 'aria-expanded': String(S.filtersOpen), 'aria-label': 'Filter and search plays', title: 'Filter and search', onclick: () => { S.filtersOpen = !S.filtersOpen; renderPicker(); } }, '⋯'),
      h('button', { class: 'ss-icon', type: 'button', onclick: suggest }, 'Suggest'), h('button', { class: 'ss-icon', type: 'button', 'aria-label': 'Hide the play picker', onclick: () => setPicker('min') }, '▾ hide'))));
  if (S.filtersOpen) {
    const search = h('input', { class: 'ss-search', type: 'search', placeholder: 'Search plays', value: S.search, 'aria-label': 'Search plays', oninput: (e) => { S.search = e.target.value; renderTiles(); } });
    el.append(h('div', { class: 'ss-filters' }, h('div', { class: 'ss-seg' }, FILTERS[side].map(([k, l]) => h('button', { class: 'ss-chip', type: 'button', 'data-filter': k, 'aria-pressed': String(S.filter === k), onclick: () => { S.filter = k; el.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === k))); renderTiles(); } }, l))), search));
  }
  E.tiles = h('div', { class: 'ss-tiles', 'aria-label': 'Plays' }); el.append(E.tiles); renderTiles();
  el.append(callBar(c));
}
function renderTiles() {
  const c = callCtx(); if (!E.tiles || !c?.book) return; const { book, gs } = c; clear(E.tiles);
  const q = S.search.trim().toLowerCase(); const items = [];
  const push = (g, s, id) => { const p = book.plays?.[String(id)]; if (!p) return; const fm = fam(book, p); if (!inFilter(S.filter, fm)) return; if (q && !`${p.n} ${s.n} ${g.f.n}`.toLowerCase().includes(q)) return; items.push({ p, s, g, fm }); };
  if (q) { for (const g of gs) for (const s of g.sets) for (const id of s.plays) push(g, s, id); } else if (S.curG && S.curSet) for (const id of S.curSet.plays) push(S.curG, S.curSet, id);
  if (!items.length) { E.tiles.append(h('div', { class: 'ss-note ss-empty' }, 'No plays match.')); return; }
  for (const it of items.slice(0, 120)) {
    E.tiles.append(h('button', { class: 'ss-tile', type: 'button', 'data-id': it.p.id, 'aria-pressed': String(S.selected?.id === it.p.id), onclick: () => { S.gid = it.g.key; S.setId = it.s.id; select(book, it.p, it.s, it.g.f); if (q) { S.search = ''; renderPicker(); } else markSelected(); } },
      diagram(book, it.p, it.s), h('div', { class: 'ss-tile-text' }, h('div', { class: 'ss-tile-name' }, it.p.n), h('div', { class: 'ss-tile-meta' }, FAM_LABEL[it.fm] ? h('span', { class: `ss-ptag f-${it.fm}` }, FAM_LABEL[it.fm]) : null, q ? h('span', { class: 'ss-tile-where' }, `${it.g.f.n} · ${it.s.n}`) : null))));
  }
}
function markSelected() { E.tiles?.querySelectorAll('.ss-tile').forEach((t) => t.setAttribute('aria-pressed', String(Number(t.dataset.id) === S.selected?.id))); }
function snapLabel(c) {
  const { st, side } = c; const sel = S.selected;
  if (st.phase === 'kickoff') return side === 'off' ? 'KICK' : 'RETURN';
  if (st.phase === 'pat') return side === 'off' ? (sel ? (fam(c.book, sel.play) === 'kick' ? 'KICK XP' : 'GO FOR 2') : 'KICK') : 'DEFEND';
  return side === 'off' ? 'SNAP' : 'DEFEND';
}
// one row: the big call button, tempo (offense only), timeout, sim menu
function callBar(c) {
  const st = c.st; E.tempoBtns = null;
  E.snap = h('button', { class: 'primary ss-snap', type: 'button', onclick: snap }, snapLabel(c));
  const bar = h('div', { class: 'ss-callbar' }, E.snap);
  if (c.side === 'off' && st.phase === 'snap') { const tempo = h('div', { class: 'ss-seg', role: 'group', 'aria-label': 'Tempo' }, [['normal', 'Normal'], ['hurry', 'Hurry'], ['chew', 'Chew']].map(([k, l]) => h('button', { class: 'ss-chip', type: 'button', 'data-tempo': k, 'aria-pressed': String(S.tempo === k), onclick: () => setTempo(k) }, l))); E.tempoBtns = [...tempo.children]; bar.append(tempo); }
  E.to = h('button', { type: 'button', onclick: callTimeout }, `Timeout (${st.to?.[S.you] ?? 0})`);
  E.subsBtn = h('button', { type: 'button', title: 'Substitutions for this game', onclick: openSubs }, 'Depth');
  bar.append(E.to, E.subsBtn, simMenu());
  return bar;
}
function simMenu() {
  const item = (label, mode) => h('button', { class: 'ss-mi', type: 'button', role: 'menuitem', onclick: () => auto(mode) }, label);
  const menu = h('div', { class: 'ss-menu', role: 'menu' }, item('Sim next play', 'next'), item('Sim this drive', 'drive'), item('Sim to end of quarter', 'quarter'), item('Sim to final…', 'final'),
    h('label', { class: 'ss-mi check', onclick: (e) => e.stopPropagation() }, h('input', { type: 'checkbox', checked: S.skipAnim || null, onchange: (e) => { S.skipAnim = e.target.checked; } }), ' Skip animations'));
  const wrap = h('div', { class: 'ss-menuwrap' });
  E.simBtn = h('button', { type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', onclick: (e) => { e.stopPropagation(); closeMenus(wrap); const open = wrap.classList.toggle('open'); E.simBtn.setAttribute('aria-expanded', String(open)); } }, 'Sim ▾');
  wrap.append(E.simBtn, menu); return wrap;
}
function closeMenus(except) { document.querySelectorAll('.ss-menuwrap.open').forEach((w) => { if (w !== except) { w.classList.remove('open'); w.querySelector('[aria-expanded]')?.setAttribute('aria-expanded', 'false'); } }); }
document.addEventListener('click', () => closeMenus(null));
function updateControls() {
  const st = S.state; const c = callCtx();
  if (E.snap && c) { E.snap.disabled = !S.selected || S.busy || S.waiting || !st || st.final; E.snap.textContent = S.busy && !S.autoRun ? 'Rolling…' : snapLabel(c); }
  if (E.to) E.to.disabled = S.busy || S.waiting || !st || st.phase !== 'snap' || !st.running || !(st.to?.[S.you] > 0);
  E.tempoBtns?.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tempo === S.tempo)));
  if (E.simBtn) E.simBtn.disabled = S.busy || S.waiting;
  if (E.subsBtn) E.subsBtn.disabled = S.busy;
  if (E.replay) E.replay.disabled = !A.an || S.busy; if (E.skip) E.skip.disabled = !A.playing;
  root.classList.toggle('busy', S.busy);
}

// ---- rendering: collapsible tabs panel (Drive / Box score / Drives) -------------------------------------------------------
function setTabsOpen(open) { S.tabsOpen = !!open; try { localStorage.setItem(TABS_KEY, open ? '1' : '0'); } catch { /* storage unavailable */ } renderTabs(); }
function renderTabs() {
  if (!E.panel) return; clear(E.panel); const open = S.tabsOpen, st = S.state;
  E.panel.append(h('button', { class: 'ss-panelbar', type: 'button', 'aria-expanded': String(open), onclick: () => setTabsOpen(!S.tabsOpen) }, h('span', { class: 'ss-panelbar-title' }, 'Drive · Box score · Drives'), h('span', { class: 'ss-panelbar-hint' }, open ? 'Hide' : 'Show'), h('span', { class: 'ss-caret', 'aria-hidden': 'true' }, open ? '▴' : '▾')));
  if (!open) return;
  const d = st?.drives?.[st.drives.length - 1];
  E.tabs = h('div', { class: 'ss-tabs', role: 'tablist' }, [['drive', 'Drive'], ['box', 'Box score'], ['drives', 'Drives']].map(([k, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(S.tab === k), onclick: () => { S.tab = k; renderTabs(); } }, l)),
    d ? h('span', { class: 'ss-drivenow' }, logo(d.off, 'xs'), `${abbr(d.off)} ball · ${plural(d.plays, 'play')} · ${d.yds} yds · ${mmss(d.time)}`) : null);
  const body = h('div', { class: 'ss-panelbody', role: 'tabpanel' }, !st ? h('p', { class: 'ss-note' }, 'Start the game to see the play-by-play, the box score and every drive.') : S.tab === 'box' ? boxScore() : S.tab === 'drives' ? drivesTable() : driveTab());
  E.panel.append(E.tabs, body);
}
function playName(kind, side, id) { const p = bookSync(S.payload?.books?.[kind]?.[side])?.plays?.[String(id)]; return p?.n || '…'; }
function driveTab() {
  const st = S.state; const list = h('ol', { class: 'ss-log' }); let prev = [0, 0]; const rows = [];
  for (const e of st.log || []) { const scored = e.s && (e.s[0] !== prev[0] || e.s[1] !== prev[1]); prev = e.s || prev; rows.push(logRow(e, scored)); }
  rows.reverse().slice(0, 250).forEach((r) => list.append(r));
  if (!rows.length) list.append(h('li', { class: 'ss-note ss-empty' }, 'No plays yet. Call the first one.'));
  return list;
}
function logRow(e, scored) {
  const turnover = e.k === 'interception' || /fumble/i.test(e.t || '');
  const cls = scored ? 'score' : turnover ? 'to' : e.k === 'sack' ? 'neg' : e.y >= 20 ? 'big' : '';
  const dd = e.d ? `${ord(e.d)} & ${e.ball + e.tg >= 100 ? 'Goal' : e.tg}` : e.k === 'kickoff' ? 'Kickoff' : 'PAT';
  return h('li', { class: `ss-logrow ${cls}` },
    h('div', { class: 'ss-logmeta' }, logo(e.off, 'xs'), h('span', { class: 'ss-dd' }, dd), h('span', { class: 'ss-note' }, e.d ? `${spotLabel(e.off, e.ball)} · ` : '', `${qLabel(e.q)} ${mmss(e.clk)}`)),
    h('div', { class: 'ss-logbody' }, h('div', { class: 'ss-logtext' }, e.t || ''), h('div', { class: 'ss-logplays' }, `${playName('off', e.off, e.op)} vs ${playName('def', 1 - e.off, e.dp)}`)),
    h('div', { class: 'ss-logyds' }, NOYDS.has(e.k) ? '—' : `${e.y > 0 ? '+' : ''}${e.y}`, scored ? h('span', { class: 'ss-logscore' }, `${e.s[0]}–${e.s[1]}`) : null));
}
function boxScore() {
  const st = S.state, T = S.input.teams; const ts = st.team || [{}, {}]; const sum = (side, k) => Object.values(st.stats?.[side] || {}).reduce((a, p) => a + (p[k] || 0), 0);
  const rows = [['First downs', (i) => ts[i].fd], ['Total yards', (i) => ts[i].yds], ['Passing', (i) => `${ts[i].pc}/${ts[i].pa}, ${ts[i].py} yds, ${sum(i, 'ptd')} TD, ${sum(i, 'pi')} INT`], ['Rushing', (i) => `${ts[i].ra} att, ${ts[i].ry} yds, ${sum(i, 'rtd')} TD`], ['3rd down', (i) => `${ts[i].t3c}/${ts[i].t3a}`], ['4th down', (i) => `${ts[i].t4c}/${ts[i].t4a}`], ['Turnovers', (i) => ts[i].to], ['Sacks allowed', (i) => ts[i].sk], ['Penalties', (i) => `${ts[i].pen}-${ts[i].peny}`], ['Time of possession', (i) => mmss(ts[i].top)], ['Plays', (i) => ts[i].plays]];
  const head = (i) => h('th', { class: `t${i}` }, logo(i, 'xs'), T[i].abbr);
  const tbl = h('table', { class: 'ss-table ss-cmp' }, h('thead', {}, h('tr', {}, head(0), h('th', {}), head(1))), h('tbody', {}, rows.map(([l, f]) => h('tr', {}, h('td', {}, String(f(0) ?? 0)), h('td', { class: 'lbl' }, l), h('td', {}, String(f(1) ?? 0))))));
  const ptable = (side, title, cols, filter, vals, sortKey) => {
    const list = Object.entries(st.stats?.[side] || {}).map(([id, s]) => ({ p: player(side, Number(id)), s })).filter((r) => filter(r.s)).sort((a, b) => (sortKey(b.s) || 0) - (sortKey(a.s) || 0));
    if (!list.length) return null;
    return h('table', { class: 'ss-table ss-pt' }, h('thead', {}, h('tr', {}, h('th', { class: 'name' }, title), cols.map((c) => h('th', {}, c)))), h('tbody', {}, list.map((r) => h('tr', {}, h('td', { class: 'name' }, r.p?.photoUrl ? h('img', { class: 'ss-head', src: r.p.photoUrl, alt: '', loading: 'lazy' }) : h('span', { class: 'ss-head ph' }, initials(r.p)), h('span', {}, shortName(r.p)), h('span', { class: 'ss-note' }, ` ${POS[r.p?.pos] || ''}`)), vals(r.s).map((v) => h('td', {}, String(v)))))));
  };
  const avg = (y, n) => (n ? (y / n).toFixed(1) : '0.0');
  const teamCol = (i) => h('div', { class: 'ss-pcol' }, h('h4', {}, logo(i, 'xs'), T[i].name),
    ptable(i, 'Passing', ['C/A', 'Yds', 'TD', 'Int', 'Lg'], (s) => s.pa > 0, (s) => [`${s.pc}/${s.pa}`, s.py, s.ptd, s.pi, s.lp], (s) => s.py),
    ptable(i, 'Rushing', ['Att', 'Yds', 'Avg', 'TD', 'Lg', 'Fum'], (s) => s.ra > 0, (s) => [s.ra, s.ry, avg(s.ry, s.ra), s.rtd, s.lr, s.fum], (s) => s.ry),
    ptable(i, 'Receiving', ['Rec', 'Tgt', 'Yds', 'TD', 'Lg'], (s) => s.tgt > 0 || s.rec > 0, (s) => [s.rec, s.tgt, s.rey, s.retd, s.lc], (s) => s.rey),
    ptable(i, 'Defense', ['Tk', 'TFL', 'Sk', 'Int', 'PD', 'TD'], (s) => s.tk > 0 || s.sk > 0 || s.int > 0 || s.pd > 0 || s.tfl > 0, (s) => [s.tk, s.tfl, s.sk, s.int, s.pd, s.dtd], (s) => s.tk + s.sk * 2 + s.int * 3),
    ptable(i, 'Kicking', ['FG', 'Lg', 'XP', 'Punts', 'Avg'], (s) => s.fga > 0 || s.xpa > 0 || s.pt > 0, (s) => [`${s.fgm}/${s.fga}`, s.fgl, `${s.xpm}/${s.xpa}`, s.pt, avg(s.pty, s.pt)], (s) => s.fga + s.xpa + s.pt),
    ptable(i, 'Returns', ['KR', 'Yds', 'PR', 'Yds', 'TD'], (s) => s.kr > 0 || s.pr > 0, (s) => [s.kr, s.kry, s.pr, s.pry, s.krtd], (s) => s.kry + s.pry));
  return h('div', { class: 'ss-box' }, tbl, h('div', { class: 'ss-pstats' }, teamCol(0), teamCol(1)));
}
function drivesTable() {
  const st = S.state, T = S.input.teams; const ds = [...(st.drives || [])].reverse();
  if (!ds.length) return h('p', { class: 'ss-note ss-empty' }, 'No drives yet.');
  return h('table', { class: 'ss-table ss-drives' }, h('thead', {}, h('tr', {}, ['Team', 'Qtr', 'Start', 'Plays', 'Yds', 'Time', 'Result'].map((c) => h('th', {}, c)))),
    h('tbody', {}, ds.map((d, i) => h('tr', { class: i === 0 && d.result === 'in progress' ? 'cur' : '' }, h('td', {}, logo(d.off, 'xs'), T[d.off]?.abbr), h('td', {}, qLabel(d.q)), h('td', {}, spotLabel(d.off, d.start)), h('td', { class: 'num' }, String(d.plays)), h('td', { class: 'num' }, String(d.yds)), h('td', { class: 'num' }, mmss(d.time)), h('td', { class: `res r-${String(d.result).replace(/\W+/g, '-')}` }, d.result)))));
}

// ---- toast -------------------------------------------------------------------------------------------------------------
function toast(msg, opts = {}) {
  if (!E.toast) { E.toast = h('div', { class: 'ss-toast', role: 'status' }); document.body.append(E.toast); }
  const t = E.toast; clear(t); t.append(h('span', {}, String(msg || 'Error')));
  if (opts.retry) t.append(h('button', { type: 'button', onclick: () => { hideToast(); opts.retry(); } }, 'Retry'));
  t.append(h('button', { class: 'ss-x', type: 'button', 'aria-label': 'Dismiss', onclick: hideToast }, '×'));
  t.className = `ss-toast show${opts.ok ? ' ok' : ''}`; clearTimeout(E.toastT); if (opts.ok) E.toastT = setTimeout(hideToast, 3500);
}
function hideToast() { if (E.toast) E.toast.className = 'ss-toast'; }

// ---- boot --------------------------------------------------------------------------------------------------------------
async function afterLoadField() {
  const st = S.state; if (!st || !F.svg) return;
  if (S.waiting) startPoll();
  await ensureBooks();
  if (st.last) await showDetail(st.last, false, false); else if (!st.final) { drawPreSnap(); showPicker(); }
}
async function boot() {
  if (!root || !EP) return;
  root.className = 'ss'; clear(root); root.append(h('div', { class: 'ss-loading' }, 'Loading your current matchup…'));
  fetch(`${BOOKS}index.json`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((idx) => { S.index = idx; if (S.payload && !S.state) renderPicker(); }).catch(() => {});
  try { applyPayload(await api('GET')); render(); afterLoadField(); } catch (e) { screen(errorPanel(e.status === 401 ? 'Sign in as a dynasty member to coach your game.' : e.message, boot)); }
}
boot();
