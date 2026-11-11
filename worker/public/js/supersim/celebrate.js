// Supersim celebrations: the overlay over the field when a team scores or wins. Team color backdrop, the team's logo,
// what happened, the player who did it (photo, name, role) and confetti in the team's colors. Resolves when it is
// dismissed (tap, click, key) or times out; with reduced motion it shows the card without the confetti.

const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (v == null || v === false) continue; if (k === 'class') e.className = v; else if (k === 'style') e.setAttribute('style', v); else e.setAttribute(k, v === true ? '' : v); }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
};
const hexRgb = (c) => { const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(c || '').trim()); return m ? [1, 2, 3].map((i) => parseInt(m[i], 16)) : [73, 108, 170]; };
const mix = (c, w, f) => { const a = hexRgb(c), b = hexRgb(w); return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * f)).join(',')})`; };
const initials = (name) => (name || '?').split(/\s+/).map((n) => n[0]).slice(0, 2).join('').toUpperCase();

// confetti: ribbons and squares bursting up from the bottom corners and falling with drag, flutter and spin
function confetti(canvas, colors, seconds) {
  const ctx = canvas.getContext('2d'); if (!ctx) return () => {};
  const dpr = Math.min(2, window.devicePixelRatio || 1); let W = 0, H = 0;
  const size = () => { const r = canvas.getBoundingClientRect(); W = r.width; H = r.height; canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  size();
  const parts = [];
  const burst = (n, x, y, dir) => { for (let i = 0; i < n; i++) { const a = (-Math.PI / 2) + dir * (0.25 + Math.random() * 0.55) + (Math.random() - 0.5) * 0.35; const v = (0.55 + Math.random() * 0.75) * Math.max(560, cy * 1.35); parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, w: 6 + Math.random() * 7, h: 4 + Math.random() * 9, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 14, ph: Math.random() * Math.PI * 2, ribbon: Math.random() < 0.35, c: colors[Math.floor(Math.random() * colors.length)] }); } };
  // the cannons sit at the sides, a little below the card (the stage can run past the bottom of the screen)
  const cy = Math.min(H * 0.92, Math.max(H * 0.55, (window.innerHeight - canvas.getBoundingClientRect().top) * 0.85));
  burst(90, W * 0.02, cy, 1); burst(90, W * 0.98, cy, -1);
  let t0 = performance.now(), last = t0, raf = 0, second = false; const end = t0 + seconds * 1000;
  const step = (now) => {
    const dt = Math.min(0.033, (now - last) / 1000); last = now;
    if (!second && now - t0 > 650) { second = true; for (let i = 0; i < 70; i++) parts.push({ x: Math.random() * W, y: -20 - Math.random() * 60, vx: (Math.random() - 0.5) * 80, vy: 60 + Math.random() * 120, w: 6 + Math.random() * 6, h: 4 + Math.random() * 8, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 10, ph: Math.random() * 6, ribbon: Math.random() < 0.3, c: colors[Math.floor(Math.random() * colors.length)] }); }
    ctx.clearRect(0, 0, W, H);
    const fade = Math.max(0, Math.min(1, (end - now) / 700));
    for (const p of parts) {
      p.vy += 900 * dt; p.vx *= 1 - 1.6 * dt; p.vy *= 1 - 1.6 * dt; p.ph += dt * 9; p.x += (p.vx + Math.sin(p.ph) * 40) * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      if (p.y > H + 30) continue;
      ctx.save(); ctx.globalAlpha = fade; ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c;
      const sq = Math.abs(Math.cos(p.ph)); // flutter: the piece turns edge-on and back
      if (p.ribbon) { ctx.beginPath(); ctx.moveTo(-p.w, 0); ctx.quadraticCurveTo(0, -p.h * sq, p.w, 0); ctx.lineWidth = 2.5; ctx.strokeStyle = p.c; ctx.stroke(); }
      else ctx.fillRect(-p.w / 2, (-p.h / 2) * sq, p.w, p.h * sq + 0.5);
      ctx.restore();
    }
    if (now < end) raf = requestAnimationFrame(step); else ctx.clearRect(0, 0, W, H);
  };
  raf = requestAnimationFrame(step);
  window.addEventListener('resize', size);
  return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', size); };
}

// opts: { kind, sub, points, team: { name, abbr, logo }, color, player?: { name, photoUrl, role, line }, score: [away, home], abbrs: [a, h], final?: boolean, ms?,
//         hero?: { kit: { helmet, jersey, pants, trim, number }, number, skin, primary, set } }  (the player as a flexing 3D figure)
export function celebrate(host, opts) {
  return new Promise((resolve) => {
    if (!host) { resolve(); return; }
    host.querySelector(':scope > .ss-celebrate')?.remove();
    const color = opts.color || '#496caa';
    const box = el('div', { class: `ss-celebrate${opts.final ? ' final' : ''}`, role: 'status', 'aria-live': 'polite', style: `--cel:${color};--cel-light:${mix(color, '#ffffff', 0.55)};--cel-dark:${mix(color, '#000000', 0.55)}` });
    const canvas = el('canvas', { 'aria-hidden': 'true' });
    const logo = opts.team?.logo ? el('img', { class: 'ss-cel-logo', src: opts.team.logo, alt: `${opts.team.name} logo` }) : el('div', { class: 'ss-cel-logo mono', 'aria-hidden': 'true' }, opts.team?.abbr || '');
    if (logo.tagName === 'IMG') logo.addEventListener('error', () => logo.replaceWith(el('div', { class: 'ss-cel-logo mono', 'aria-hidden': 'true' }, opts.team?.abbr || '')));
    const pl = opts.player;
    let playerRow = null;
    if (pl) {
      const ph = el('span', { class: 'ss-cel-photo' }, el('span', { 'aria-hidden': 'true' }, initials(pl.name)));
      if (pl.photoUrl) { const img = el('img', { src: pl.photoUrl, alt: pl.name, decoding: 'async' }); img.addEventListener('error', () => img.remove()); ph.append(img); }
      playerRow = el('div', { class: 'ss-cel-player' }, ph, el('div', { class: 'ss-cel-name' }, el('b', {}, pl.name), el('small', {}, [pl.role, pl.line].filter(Boolean).join(' · '))));
    }
    // the scorer as a 3D figure in his uniform, flexing (js/hero3d.js, the model from the game previews): loaded when the
    // first celebration needs it; the card shows without it where WebGL or the file is missing
    const hr = opts.hero; let heroEl = null;
    if (hr && !REDUCED) {
      const k = hr.kit || {}; const hex = (v) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : '');
      heroEl = el('div', { class: 'ob-hero ss-cel-hero', 'aria-hidden': 'true', 'data-anim': 'flex', 'data-set': hr.set || 'home', 'data-primary': hex(hr.primary) || hex(color), 'data-secondary': '#ffffff', 'data-helmet': hex(k.helmet), 'data-jersey': hex(k.jersey), 'data-pants': hex(k.pants), 'data-trim': hex(k.trim), 'data-number-color': hex(k.number), 'data-number': hr.number ?? '', 'data-skin': hex(hr.skin) });
      import('/js/hero3d.js').then(() => window.mountHeroes?.(box)).catch(() => heroEl.remove());
    }
    const sc = opts.score || [0, 0], ab = opts.abbrs || ['', ''];
    const card = el('div', { class: 'ss-cel-card' },
      opts.final ? el('div', { class: 'ss-cel-eyebrow' }, 'FINAL') : null,
      logo,
      el('div', { class: 'ss-cel-kind' }, opts.kind),
      opts.sub ? el('div', { class: 'ss-cel-sub' }, opts.sub) : opts.points ? el('div', { class: 'ss-cel-sub' }, `+${opts.points} ${opts.team?.abbr || ''}`) : null,
      playerRow,
      el('div', { class: 'ss-cel-score' }, el('span', {}, `${ab[0]} ${sc[0]}`), el('i', {}, '–'), el('span', {}, `${sc[1]} ${ab[1]}`)),
      el('small', { class: 'ss-cel-hint' }, 'Tap to continue'));
    box.append(el('div', { class: 'ss-cel-rays', 'aria-hidden': 'true' }), canvas, heroEl ? el('div', { class: 'ss-cel-stage' }, heroEl, card) : card);
    if (heroEl) box.classList.add('with-hero');
    host.append(box);
    let stop = () => {};
    if (!REDUCED) stop = confetti(canvas, [color, mix(color, '#ffffff', 0.45), '#ffffff', '#f0d18a', mix(color, '#000000', 0.25)], opts.final ? 4.6 : 3);
    let done = false;
    const close = () => { if (done) return; done = true; clearTimeout(timer); document.removeEventListener('keydown', onKey); box.classList.add('out'); setTimeout(() => { stop(); box.remove(); if (heroEl) window.mountHeroes?.(document.createElement('div')); /* releases his WebGL context */ resolve(); }, REDUCED ? 0 : 260); };
    const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); close(); } };
    box.addEventListener('click', close); document.addEventListener('keydown', onKey);
    const timer = setTimeout(close, opts.ms ?? (opts.final ? 5200 : heroEl ? 4400 : 3400));
  });
}
