// The Supersim field as one projected 3D scene, drawn in SVG: a full-size college field (100 yards between the goal
// lines, 10-yard end zones, 53 1/3 yards wide, hash marks 20 yards in from each sideline) seen from a high end-zone
// camera, with everything placed in field yards and heights (x along the field, y across, z up) through one perspective
// projection: the turf and its paint, the goalposts, the grandstands and campus behind them, the players and the ball.
//
// The stadium is a typical FCS ground: one main grandstand with a press box on the home sideline, a smaller set of
// visitors' bleachers across from it, a grass bank and the scoreboard behind the far end zone, a brick field house,
// light towers, trees and hills. The home sideline (and so the way the midfield logo faces) swaps sides when the teams
// change ends each quarter, because the camera stays behind the near end zone.
export const FIELD_W = 160 / 3, MID = FIELD_W / 2, END_NEAR = -10, END_FAR = 110;
// the projection: screen x spreads from the centre line by the scale at that depth; screen y runs up the field, squeezed
// with distance; a height lifts a point by the same scale (VZ: the camera looks down at it)
const K = 15, PA = 0.005, PB = 6, Y0 = 600, VZ = 0.9;
const den = (x) => 1 + PA * (x + 10);
export const pxYd = (x) => K / den(x);            // pixels per yard across the field at depth x
export const zPx = (x) => (VZ * K) / den(x);       // pixels per yard of height at depth x
export const coord = (x, y, z = 0) => { const d = den(x); return [500 + ((y - MID) * K) / d, Y0 - (PB * (x + 10)) / d - (z * VZ * K) / d]; };
export const point = (x, y, z = 0) => { const p = coord(x, y, z); return `${p[0].toFixed(1)},${p[1].toFixed(1)}`; };
// marker scale: sprites are drawn 10 units to the yard
export const spriteScale = (x) => pxYd(x) / 10;
const n1 = (v) => v.toFixed(1), n3 = (v) => v.toFixed(3);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// a matrix that lays a flat decal on the turf at (x, y): local u runs along field vector U, local v (down) along V,
// both in yards (a first-order fit of the projection there, exact enough for paint a few yards across)
export function flat(x, y, U, V) {
  const d = den(x); const jx = [(-(y - MID) * K * PA) / (d * d), -PB / (d * d)], jy = [K / d, 0]; const [e, f] = coord(x, y);
  const m = (w) => [w[0] * jx[0] + w[1] * jy[0], w[0] * jx[1] + w[1] * jy[1]]; const a = m(U), c = m(V);
  return `matrix(${n3(a[0])} ${n3(a[1])} ${n3(c[0])} ${n3(c[1])} ${n1(e)} ${n1(f)})`;
}
const quad = (pts, attrs = '') => `<path d="M${pts.map((p) => point(...p)).join('L')}Z" ${attrs}/>`;
const line = (p, q, attrs = '') => `<path d="M${point(...p)}L${point(...q)}" ${attrs}/>`;
// a repeatable scatter for the crowd
function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// fine grain for the turf: a small noise tile, made once
let grainUrl = null;
function grain() {
  if (grainUrl !== null) return grainUrl;
  try {
    const c = document.createElement('canvas'); c.width = c.height = 96; const g = c.getContext('2d'); const img = g.createImageData(96, 96); const r = seeded(7);
    for (let i = 0; i < img.data.length; i += 4) { const v = r(); const dark = v < 0.5; img.data[i] = img.data[i + 1] = img.data[i + 2] = dark ? 0 : 255; img.data[i + 3] = Math.round((dark ? 0.5 - v : v - 0.5) * 2 * 46); }
    g.putImageData(img, 0, 0); grainUrl = c.toDataURL('image/png');
  } catch { grainUrl = ''; }
  return grainUrl;
}

// goalposts on an end line: uprights 18'6" apart, the crossbar 10 feet up, uprights 30 feet above the ground, on one
// padded post
export const POST_W = 3.08, BAR_H = 3.33, POST_H = 10;
export function postsMarkup(x, id, pad = 'var(--home)') {
  const w = Math.max(2, pxYd(x) * 0.17);
  const d = `M${point(x, MID, 0)}L${point(x, MID, BAR_H)}M${point(x, MID - POST_W, POST_H)}L${point(x, MID - POST_W, BAR_H)}L${point(x, MID + POST_W, BAR_H)}L${point(x, MID + POST_W, POST_H)}`;
  const sh = `M${point(x, MID, 0)}L${point(x + 3, MID + 4, 0)}`;
  return `<g id="${id}" class="f-posts"><path d="${sh}" stroke="#000" stroke-opacity=".25" stroke-width="${n1(w * 1.4)}" stroke-linecap="round" fill="none"/><path class="f-post-under" d="${d}" stroke-width="${n1(w + 1.6)}"/><path class="f-post" d="${d}" stroke-width="${n1(w)}"/><path class="f-post-pad" d="M${point(x, MID, 0)}L${point(x, MID, 2)}" stroke="${pad}" stroke-width="${n1(w * 2.6)}"/></g>`;
}

// ---- the stands --------------------------------------------------------------------------------------------------------
// a bank of bleachers along a sideline: side -1 = left of the camera, +1 = right; rows rise away from the field
function grandstand(side, x0, x1, depth, height, colour, rows, seed, pressBox) {
  const yIn = side < 0 ? -9 : FIELD_W + 9, yOut = yIn + side * depth, base = 1.3; const r = seeded(seed); let s = `<g class="ss-stand">`;
  // the end wall facing the camera, the kick wall along the front and the seating deck
  s += quad([[x0, yIn, 0], [x0, yOut, 0], [x0, yOut, height], [x0, yIn, base]], 'fill="var(--stand-wall)"');
  s += quad([[x0, yIn, base], [x1, yIn, base], [x1, yOut, height], [x0, yOut, height]], 'fill="var(--stand-base)"') + quad([[x0, yIn, base], [x1, yIn, base], [x1, yOut, height], [x0, yOut, height]], 'fill="#fff" opacity=".16"');
  s += quad([[x0, yIn, 0], [x1, yIn, 0], [x1, yIn, base], [x0, yIn, base]], `fill="${colour}"`) + line([x0, yIn, base], [x1, yIn, base], 'stroke="var(--rail)" stroke-width="1.2"');
  for (let i = 1; i <= rows; i++) { const f = i / (rows + 1), y = yIn + side * depth * f, z = base + (height - base) * f; s += line([x0, y, z], [x1, y, z], 'stroke="var(--seat)" stroke-width="1" stroke-opacity=".8"'); }
  for (let x = x0 + (x1 - x0) / 6; x < x1 - 1; x += (x1 - x0) / 6) s += line([x, yIn, base], [x, yOut, height], 'stroke="var(--stand-wall)" stroke-width="1.6" stroke-opacity=".7"'); // aisles
  // the crowd: one dot a seat or so, mostly the team's colour, on the part of the stand the camera sees
  let dots = '';
  for (let i = 1; i <= rows; i++) {
    const f = (i - 0.5) / (rows + 1), y = yIn + side * depth * f, z = base + (height - base) * f + 0.45;
    for (let x = x0 + 0.6; x < x1; x += 1.25) { const v = r(); if (v < 0.22) continue; const [sx, sy] = coord(x + r() * 0.5, y, z); if (sx < -12 || sx > 1012) continue; dots += `<circle cx="${n1(sx)}" cy="${n1(sy)}" r="${n1(Math.max(1.1, pxYd(x) * 0.2))}" fill="${v < 0.66 ? colour : v < 0.8 ? '#f1f1ee' : v < 0.9 ? '#2b2f33' : '#c9b08a'}"/>`; }
  }
  s += `<g class="ss-crowd">${dots}</g>`;
  s += line([x0, yOut, height], [x1, yOut, height], 'stroke="var(--rail)" stroke-width="1.6"');
  if (pressBox) { // the press box along the top row: a glass front, a flat roof, the school colour along the fascia
    const a = x0 + (x1 - x0) * 0.3, b = x0 + (x1 - x0) * 0.74, top = height + 4.2, back = yOut + side * 3.5;
    s += quad([[a, yOut, height], [a, back, height], [a, back, top], [a, yOut, top]], 'fill="var(--stand-wall)"');
    s += quad([[a, yOut, height], [b, yOut, height], [b, yOut, top], [a, yOut, top]], 'fill="var(--brick)" stroke="var(--building-line)" stroke-width=".8"');
    s += quad([[a + 0.6, yOut, height + 1.3], [b - 0.6, yOut, height + 1.3], [b - 0.6, yOut, height + 3], [a + 0.6, yOut, height + 3]], 'fill="var(--window)"');
    s += quad([[a, yOut, top], [b, yOut, top], [b, back, top], [a, back, top]], 'fill="var(--roof)"');
    s += quad([[a, yOut, top - 0.9], [b, yOut, top - 0.9], [b, yOut, top], [a, yOut, top]], `fill="${colour}"`);
  }
  return s + '</g>';
}
// a light tower: a pole, a bank of lamps, and at night its beam on the turf
function tower(x, y, h) {
  const [bx, by] = coord(x, y, 0), [tx, ty] = coord(x, y, h); const k = pxYd(x), w = Math.max(10, k * 4.2), hh = Math.max(5, k * 1.9); const inward = y < MID ? 1 : -1;
  const beam = `M${n1(tx)} ${n1(ty)}L${point(Math.max(2, x - 26), MID - inward * 6)}L${point(Math.min(98, x + 14), MID + inward * 22)}Z`;
  return `<g class="ss-floodlight"><path class="ss-lightbeam" d="${beam}" fill="#fff1ac" opacity="var(--beam-opacity)"/><path d="M${n1(bx)} ${n1(by)}L${n1(tx)} ${n1(ty)}" stroke="var(--rail)" stroke-width="${n1(Math.max(1.6, k * 0.3))}"/><rect x="${n1(tx - w / 2)}" y="${n1(ty - hh)}" width="${n1(w)}" height="${n1(hh)}" rx="1.5" fill="var(--pole)"/>${[0.2, 0.5, 0.8].map((f) => `<rect x="${n1(tx - w / 2 + 1)}" y="${n1(ty - hh + hh * f - hh * 0.11)}" width="${n1(w - 2)}" height="${n1(hh * 0.22)}" fill="var(--lamp)"/>`).join('')}</g>`;
}
const tree = (x, y, h, wide = 1) => { const [bx, by] = coord(x, y, 0), k = pxYd(x); return `<path d="M${n1(bx)} ${n1(by)}v${n1(-h * 0.45 * k)}" stroke="var(--tree-trunk)" stroke-width="${n1(Math.max(1.5, k * 0.5))}"/><ellipse cx="${n1(bx)}" cy="${n1(by - h * 0.62 * k)}" rx="${n1(h * 0.34 * k * wide)}" ry="${n1(h * 0.42 * k)}" fill="var(--tree)"/><ellipse cx="${n1(bx - h * 0.1 * k)}" cy="${n1(by - h * 0.72 * k)}" rx="${n1(h * 0.2 * k * wide)}" ry="${n1(h * 0.24 * k)}" fill="#fff" opacity=".07"/>`; };
// a brick building with rows of windows and a pitched roof, front face toward the field
function building(x, y0, y1, h, floors, bays) {
  let s = quad([[x, y0, 0], [x, y1, 0], [x, y1, h], [x, y0, h]], 'fill="var(--brick)" stroke="var(--building-line)" stroke-width=".8"');
  s += quad([[x, y0 - 0.8, h], [x, y1 + 0.8, h], [x + 4, (y0 + y1) / 2 + (y1 - y0) * 0.42, h + 3.4], [x + 4, (y0 + y1) / 2 - (y1 - y0) * 0.42, h + 3.4]], 'fill="var(--roof)"');
  for (let f = 0; f < floors; f++) for (let b = 0; b < bays; b++) { const ya = y0 + ((y1 - y0) * (b + 0.28)) / bays, yb = y0 + ((y1 - y0) * (b + 0.72)) / bays, z0 = (h * (f + 0.3)) / floors, z1 = (h * (f + 0.78)) / floors; s += quad([[x, ya, z0], [x, yb, z0], [x, yb, z1], [x, ya, z1]], 'fill="var(--window)"'); }
  return s;
}

/** The whole static scene. near / far: the teams defending the near and far end zones ({ name, abbr, colour });
 *  home: the home team ({ abbr, logo, colour }); flip: the teams have changed ends (even quarters), which also puts the
 *  home stand, and the midfield logo's bottom edge, on the other sideline. */
export function sceneMarkup({ near, far, home, flip = false }) {
  const hs = flip ? 1 : -1; // the home sideline: left of the camera in odd quarters
  const hc = home?.colour || 'var(--home)', vc = (near === home ? far : near)?.colour || 'var(--away)';
  const g = grain();
  let s = `<defs>
    <linearGradient id="ss-turf" x2="0" y2="1"><stop stop-color="var(--turf-far)"/><stop offset="1" stop-color="var(--turf-near)"/></linearGradient>
    <linearGradient id="ss-sun" x1="${hs < 0 ? 0 : 1}" x2="${hs < 0 ? 1 : 0}" y2="0"><stop stop-color="#000" stop-opacity=".2"/><stop offset=".3" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".05"/></linearGradient>
    <radialGradient id="ss-vig" cx=".5" cy=".55" r=".75"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".3"/></radialGradient>
    <radialGradient id="ss-ballg" cx=".38" cy=".3" r=".8"><stop stop-color="#c98850"/><stop offset=".55" stop-color="#8a4f24"/><stop offset="1" stop-color="#4a2710"/></radialGradient>
    <linearGradient id="ss-body" x2="1" y2="0"><stop stop-color="#fff" stop-opacity=".22"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".3"/></linearGradient>
    <radialGradient id="ss-helm" cx=".36" cy=".3" r=".75"><stop stop-color="#fff" stop-opacity=".5"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></radialGradient>
    ${g ? `<pattern id="ss-grain" width="96" height="96" patternUnits="userSpaceOnUse"><image href="${g}" width="96" height="96"/></pattern>` : ''}
    <clipPath id="ss-fieldclip"><path d="M${point(END_NEAR, 0)}L${point(END_FAR, 0)}L${point(END_FAR, FIELD_W)}L${point(END_NEAR, FIELD_W)}Z"/></clipPath>
  </defs>`;
  // ---- the country behind: hills, trees, the field house, the scoreboard on its bank ----
  s += `<g class="ss-campus" aria-hidden="true"><path d="M-80 104Q110 40 300 78T640 60T1090 92V640H-80Z" fill="var(--hill)"/><path d="M-80 118Q220 74 470 104T1090 100V640H-80Z" fill="var(--hill)" opacity=".75"/><path d="M-80 118Q220 74 470 104T1090 100V640H-80Z" fill="#000" opacity=".1"/>`;
  for (const [x, y, h, w] of [[160, -66, 9, 1.2], [158, -50, 10, 1], [162, -30, 8, 1.3], [158, 92, 10, 1.1], [162, 108, 8, 1.3], [158, 124, 10, 1], [164, 58, 8, 1.2], [166, 18, 8, 1.2], [166, 38, 7, 1.4]]) s += tree(x, y, h, w);
  s += building(150, hs < 0 ? -46 : 66, hs < 0 ? -14 : 98, 7, 2, 7); // the field house, on the home side
  s += building(152, hs < 0 ? 72 : -32, hs < 0 ? 92 : -12, 5, 2, 4);
  for (const [x, y, h, w] of [[140, -8, 7, 1.1], [142, 62, 8, 1], [138, -54, 7, 1.2], [138, 104, 7, 1.1], [144, 6, 6, 1.2], [144, 48, 6, 1.2]]) s += tree(x, y, h, w);
  s += '</g>';
  // ---- the ground around the field: a walkway, the grass bank behind the far end zone ----
  s += quad([[END_NEAR - 14, -70], [140, -70], [140, FIELD_W + 70], [END_NEAR - 14, FIELD_W + 70]], 'fill="var(--apron)"');
  s += quad([[118, -34], [132, -34], [132, FIELD_W + 34], [118, FIELD_W + 34]], 'fill="var(--bank)"') + quad([[118, -34, 0], [118, FIELD_W + 34, 0], [124, FIELD_W + 34, 2.4], [124, -34, 2.4]], 'fill="var(--bank)"') + quad([[118, -34, 0], [118, FIELD_W + 34, 0], [124, FIELD_W + 34, 2.4], [124, -34, 2.4]], 'fill="#fff" opacity=".05"');
  // the scoreboard: two legs, a black board, the school colour across the top, both teams' names and a video panel
  { const x = 128, y0 = MID - 13, y1 = MID + 13, z0 = 4.6, z1 = 12.4; const [ax, ay] = coord(x, y0, z1), [bx, by] = coord(x, y1, z0); const w = bx - ax, hh = by - ay;
    s += line([x, y0 + 3, 0], [x, y0 + 3, z0], 'stroke="var(--pole)" stroke-width="4"') + line([x, y1 - 3, 0], [x, y1 - 3, z0], 'stroke="var(--pole)" stroke-width="4"');
    s += `<rect x="${n1(ax)}" y="${n1(ay)}" width="${n1(w)}" height="${n1(hh)}" fill="#14171a" stroke="var(--pole)" stroke-width="1.5"/><rect x="${n1(ax)}" y="${n1(ay)}" width="${n1(w)}" height="${n1(hh * 0.2)}" fill="${hc}"/>`;
    s += `<text x="${n1(ax + w / 2)}" y="${n1(ay + hh * 0.155)}" text-anchor="middle" font-size="${n1(hh * 0.14)}" font-weight="800" fill="#fff" letter-spacing="1.5">${esc((home?.name || '').toUpperCase().slice(0, 22))}</text>`;
    s += `<rect x="${n1(ax + w * 0.3)}" y="${n1(ay + hh * 0.27)}" width="${n1(w * 0.4)}" height="${n1(hh * 0.62)}" fill="#0a2a1a" stroke="#2c3238"/>${home?.logo ? `<image href="${esc(home.logo)}" x="${n1(ax + w * 0.36)}" y="${n1(ay + hh * 0.31)}" width="${n1(w * 0.28)}" height="${n1(hh * 0.54)}" preserveAspectRatio="xMidYMid meet"/>` : ''}`;
    s += `<text id="ss-sb-away" x="${n1(ax + w * 0.15)}" y="${n1(ay + hh * 0.5)}" text-anchor="middle" font-size="${n1(hh * 0.15)}" font-weight="800" fill="#f2f2f2">${esc(far && near ? (near === home ? far.abbr : near.abbr) : '')}</text><text x="${n1(ax + w * 0.85)}" y="${n1(ay + hh * 0.5)}" text-anchor="middle" font-size="${n1(hh * 0.15)}" font-weight="800" fill="#f2f2f2">${esc(home?.abbr || '')}</text>`;
    s += `<text id="ss-sb-a" class="ss-sb-num" x="${n1(ax + w * 0.15)}" y="${n1(ay + hh * 0.8)}" text-anchor="middle" font-size="${n1(hh * 0.24)}" font-weight="800" fill="#ffd23f">0</text><text id="ss-sb-h" class="ss-sb-num" x="${n1(ax + w * 0.85)}" y="${n1(ay + hh * 0.8)}" text-anchor="middle" font-size="${n1(hh * 0.24)}" font-weight="800" fill="#ffd23f">0</text>`; }
  // ---- stands and light towers (far ones first) ----
  s += tower(116, -17, 26) + tower(116, FIELD_W + 17, 26);
  s += grandstand(-hs, 24, 76, 9, 5.5, vc, 8, 31, false);
  s += grandstand(hs, 8, 92, 17, 11.5, hc, 16, 17, true);
  s += tower(82, hs < 0 ? FIELD_W + 21 : -21, 28);
  // ---- the turf: base colour, mowing stripes every five yards, grain, the sun from the home side, darker edges ----
  s += `<g class="ss-turf">${quad([[END_NEAR - 4, -5], [END_FAR + 4, -5], [END_FAR + 4, FIELD_W + 5], [END_NEAR - 4, FIELD_W + 5]], 'fill="url(#ss-turf)"')}`;
  for (let x = 0; x < 100; x += 5) s += quad([[x, 0], [x + 5, 0], [x + 5, FIELD_W], [x, FIELD_W]], `fill="${(x / 5) % 2 ? '#000' : '#fff'}" opacity="${(x / 5) % 2 ? 0.07 : 0.045}"`);
  // end zones in the defending team's colour, its name across them (read from the camera's end)
  const zone = (x0, x1, team) => {
    let z = quad([[x0, 0], [x1, 0], [x1, FIELD_W], [x0, FIELD_W]], `fill="${team?.colour || '#335'}"`) + quad([[x0, 0], [x1, 0], [x1, FIELD_W], [x0, FIELD_W]], 'fill="#000" opacity=".12"');
    const label = (team?.name || team?.abbr || '').toUpperCase(); const words = label.length <= 16 ? label : (team?.abbr || '').toUpperCase(); const size = Math.min(6.4, 60 / Math.max(6, words.length));
    z += `<text transform="${flat((x0 + x1) / 2 - 0.36 * size, MID, [0, 1], [-1, 0])}" text-anchor="middle" font-size="${n1(size)}" font-weight="900" letter-spacing="${n1(size * 0.14)}" fill="#fff" fill-opacity=".92" stroke="#000" stroke-opacity=".35" stroke-width=".25" paint-order="stroke">${esc(words)}</text>`;
    return z;
  };
  s += zone(END_NEAR, 0, near) + zone(100, END_FAR, far);
  if (g) s += `<g clip-path="url(#ss-fieldclip)"><rect x="-100" y="100" width="1200" height="560" fill="url(#ss-grain)"/></g>`;
  // ---- paint: the six-foot border, goal lines, yard lines, hash marks, numbers ----
  const white = 'fill="#f7f8f4"';
  s += quad([[END_NEAR - 2, -2], [END_FAR + 2, -2], [END_FAR + 2, 0], [END_NEAR - 2, 0]], white) + quad([[END_NEAR - 2, FIELD_W], [END_FAR + 2, FIELD_W], [END_FAR + 2, FIELD_W + 2], [END_NEAR - 2, FIELD_W + 2]], white);
  s += quad([[END_NEAR - 2, 0], [END_NEAR, 0], [END_NEAR, FIELD_W], [END_NEAR - 2, FIELD_W]], white) + quad([[END_FAR, 0], [END_FAR + 2, 0], [END_FAR + 2, FIELD_W], [END_FAR, FIELD_W]], white);
  for (let x = 0; x <= 100; x += 5) { const goal = x === 0 || x === 100; s += line([x, 0], [x, FIELD_W], `stroke="#f7f8f4" stroke-opacity="${goal ? 0.95 : 0.8}" stroke-width="${n1(Math.max(goal ? 1.6 : 0.9, pxYd(x) * (goal ? 0.22 : 0.11)))}"`); }
  let ticks = '';
  for (let x = 1; x < 100; x++) { if (x % 5 === 0) continue; for (const [a, b] of [[0.25, 0.92], [20 - 0.34, 20 + 0.34], [FIELD_W - 20 - 0.34, FIELD_W - 20 + 0.34], [FIELD_W - 0.92, FIELD_W - 0.25]]) ticks += `M${point(x, a)}L${point(x, b)}`; }
  s += `<path d="${ticks}" stroke="#f7f8f4" stroke-opacity=".75" stroke-width="1" fill="none"/>`;
  // the numbers: two yards tall, nine yards in from each sideline, each row read from its own sideline
  for (let x = 10; x <= 90; x += 10) { const t = String(Math.min(x, 100 - x));
    s += `<text transform="${flat(x, 8, [-1, 0], [0, -1])}" text-anchor="middle" y=".72" font-size="2.2" font-weight="700" letter-spacing=".5" fill="#f7f8f4" fill-opacity=".86">${t[0]} ${t[1]}</text>`;
    s += `<text transform="${flat(x, FIELD_W - 8, [1, 0], [0, 1])}" text-anchor="middle" y=".72" font-size="2.2" font-weight="700" letter-spacing=".5" fill="#f7f8f4" fill-opacity=".86">${t[0]} ${t[1]}</text>`; }
  // the midfield logo: its bottom edge toward the home sideline (the press box side)
  const lu = hs < 0 ? [-1, 0] : [1, 0], lv = hs < 0 ? [0, -1] : [0, 1];
  s += home?.logo ? `<image class="ss-midfield-logo" href="${esc(home.logo)}" transform="${flat(50, MID, lu, lv)}" x="-8" y="-7" width="16" height="14" opacity=".9" preserveAspectRatio="xMidYMid meet"/>` : `<text transform="${flat(50, MID, lu, lv)}" y="2.2" fill="#fff" fill-opacity=".6" text-anchor="middle" font-size="6.5" font-weight="900">${esc(home?.abbr || '')}</text>`;
  // light and shade over the paint, then the pylons
  s += `<g clip-path="url(#ss-fieldclip)" pointer-events="none"><rect x="-100" y="100" width="1200" height="560" fill="url(#ss-sun)"/><rect x="-100" y="100" width="1200" height="560" fill="url(#ss-vig)"/></g></g>`;
  for (const x of [END_NEAR, 0, 100, END_FAR]) for (const y of [0, FIELD_W]) { const [px, py] = coord(x, y), k = pxYd(x); s += `<rect x="${n1(px - k * 0.14)}" y="${n1(py - zPx(x) * 0.5)}" width="${n1(k * 0.28)}" height="${n1(zPx(x) * 0.5)}" fill="#ff6a1f"/>`; }
  // ---- the team areas: the coaching line, benches, players and staff standing along them (home on the home side) ----
  for (const side of [-1, 1]) {
    const col = side === hs ? hc : vc; const y = (d) => (side < 0 ? -d : FIELD_W + d); const r = seeded(side < 0 ? 91 : 57);
    s += `<path d="M${point(25, y(2))}L${point(25, y(7.5))}L${point(75, y(7.5))}L${point(75, y(2))}" fill="none" stroke="#f7f8f4" stroke-opacity=".7" stroke-width="1"/>`;
    for (const [a, b] of [[30, 46], [54, 70]]) s += quad([[a, y(6), 0.5], [b, y(6), 0.5], [b, y(6.7), 0.5], [a, y(6.7), 0.5]], 'fill="#c9ccd0"') + line([a, y(6.35), 0], [b, y(6.35), 0], 'stroke="#000" stroke-opacity=".25" stroke-width="2"');
    for (let x = 27; x < 74; x += 1.7 + r() * 1.6) { const d = 3 + r() * 3.4; const [px, py] = coord(x, y(d)), k = pxYd(x) / 10; if (px < -10 || px > 1010) continue; s += `<g transform="translate(${n1(px)} ${n1(py)}) scale(${n3(k)})"><ellipse cx="1.5" cy=".3" rx="4" ry="1.5" fill="#000" opacity=".25"/><rect x="-2.4" y="-15" width="4.8" height="15" rx="2" fill="${r() < 0.75 ? col : '#e9e9e6'}"/><circle cy="-17.5" r="2.6" fill="${r() < 0.6 ? col : '#d8b89a'}"/></g>`; }
  }
  return s;
}

// ---- players and the ball (sprites: 10 units to the yard, the origin on the ground under him) ----------------------------
/** A standing player seen from the end-zone camera: his shadow, pants, jersey with shoulder pads and number, helmet.
 *  kit: { helmet, jersey, pants, number, trim } (CSS colours). ghost: an anonymous, see-through figure. */
export function playerMarkup(kit, num, { ghost = false } = {}) {
  const k = kit || {}; const jersey = k.jersey || '#496caa', helmet = k.helmet || jersey, pants = k.pants || '#e6e6e2', ink = k.number || '#fff', trim = k.trim || ink;
  if (ghost) return `<ellipse cx="2" cy=".4" rx="6" ry="2.3" fill="#000" opacity=".22"/><g opacity=".5"><rect x="-3" y="-8" width="6" height="8" rx="1.6" fill="${pants}"/><path d="M-5.6 -15.2Q-5.6 -18 -2.6 -18H2.6Q5.6 -18 5.6 -15.2V-9.6Q5.6 -7.4 3.4 -7.4H-3.4Q-5.6 -7.4 -5.6 -9.6Z" fill="${jersey}" stroke="#fff" stroke-opacity=".7" stroke-width=".7" stroke-dasharray="2 1.4"/><circle cy="-21" r="3.5" fill="${helmet}"/></g>`;
  return `<ellipse class="p-shadow" cx="2.6" cy=".5" rx="6.6" ry="2.5" fill="#000" opacity=".3"/>
    <rect x="-3.1" y="-8.4" width="6.2" height="8.4" rx="1.7" fill="${pants}"/><path d="M0 -6V0" stroke="#000" stroke-opacity=".25" stroke-width=".7"/><rect x="-3.1" y="-1.9" width="6.2" height="1.9" rx=".9" fill="#1b1d20"/>
    <path class="p-jersey" d="M-5.9 -15.3Q-5.9 -18.3 -2.7 -18.3H2.7Q5.9 -18.3 5.9 -15.3V-9.5Q5.9 -7.2 3.5 -7.2H-3.5Q-5.9 -7.2 -5.9 -9.5Z" fill="${jersey}" stroke="#0b0c0d" stroke-opacity=".55" stroke-width=".6"/>
    <path d="M-5.9 -13.2H-4.4M4.4 -13.2H5.9" stroke="${trim}" stroke-width="1.1"/>
    <path d="M-5.9 -15.3Q-5.9 -18.3 -2.7 -18.3H2.7Q5.9 -18.3 5.9 -15.3V-9.5Q5.9 -7.2 3.5 -7.2H-3.5Q-5.9 -7.2 -5.9 -9.5Z" fill="url(#ss-body)"/>
    <text class="p-num" y="-9.4" fill="${ink}">${num == null ? '' : esc(num)}</text>
    <circle cy="-21.3" r="3.7" fill="${helmet}" stroke="#0b0c0d" stroke-opacity=".5" stroke-width=".5"/><circle cy="-21.3" r="3.7" fill="url(#ss-helm)"/><path d="M-2.2 -19.2Q0 -18 2.2 -19.2" fill="none" stroke="#d9dde0" stroke-width=".7"/>`;
}
/** The ball: a shaded prolate ball with its stripes and laces (drawn about twice life size so it can be followed). */
export const ballMarkup = () => `<g class="f-ballspin"><ellipse rx="6.2" ry="3.7" fill="url(#ss-ballg)" stroke="#2b1608" stroke-width=".5"/><path d="M-3.9 -2.8Q-3.1 0 -3.9 2.8M3.9 -2.8Q3.1 0 3.9 2.8" fill="none" stroke="#f4f1ea" stroke-width=".9"/><path d="M-1.8 -1.2H1.8M-1.2 -1.9V-.5M0 -1.9V-.5M1.2 -1.9V-.5" stroke="#f4f1ea" stroke-width=".55"/><ellipse cx="-1.4" cy="-1.6" rx="3" ry="1.1" fill="#fff" opacity=".18"/></g>`;
