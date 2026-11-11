// Quickplay team picker (pages/quickplay.ts). Each side's <select> is the form control and the fallback; on top of it this
// builds the site's own picker: a button showing the team's logo and name that opens a searchable list of every team,
// grouped by conference, with logos. When either team changes, the matchup board for the new pair is swapped in
// (/quickplay/preview), the 3D figures are remounted, and the Play links and the address bar follow.
(() => {
  const form = document.querySelector('[data-quickplay]'); const boardEl = document.getElementById('qp-board'); if (!form || !boardEl) return;
  const away = form.elements.away, home = form.elements.home, len = document.getElementById('qp-q');
  const h = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (v == null || v === false) continue; if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v); } for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k))); return e; };
  const logoUrl = (key, abbr) => (key ? `/img/logos/${key.replace(/^teams\//, 'teams64/')}` : `/img/logos/teams/none.png?t=${encodeURIComponent((abbr || '?').slice(0, 4))}`);
  const teamOf = (o) => ({ id: o.value, name: o.dataset.name || o.textContent, abbr: o.dataset.abbr || '', ovr: o.dataset.ovr || '', logo: o.dataset.logo || '', conf: o.parentElement?.label || '' });
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '');

  // ---- the picker over one <select> ----
  let openOne = null;
  function combo(sel) {
    const wrap = sel.closest('.qp-sel'); const teams = [...sel.options].map(teamOf); let active = -1, shown = [];
    const img = h('img', { class: 'qp-cur-logo', alt: '', width: 32, height: 32 }), name = h('span', { class: 'qp-cur-name' }), meta = h('span', { class: 'qp-cur-meta' });
    const button = h('button', { type: 'button', class: 'qp-combo', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' }, img, h('span', { class: 'qp-cur' }, name, meta), h('span', { class: 'qp-caret', 'aria-hidden': 'true' }, '▾'));
    const search = h('input', { type: 'search', class: 'qp-search', placeholder: 'Search teams or conferences', 'aria-label': 'Search teams', autocomplete: 'off', spellcheck: 'false' });
    const list = h('div', { class: 'qp-list', role: 'listbox', tabindex: '-1' });
    const panel = h('div', { class: 'qp-panel', hidden: true }, search, list);
    wrap.classList.add('enhanced'); wrap.append(button, panel);
    const cur = () => teamOf(sel.selectedOptions[0]);
    function paint() { const t = cur(); img.src = logoUrl(t.logo, t.abbr); name.textContent = t.name; meta.textContent = `${t.conf}${t.ovr ? ` · ${t.ovr} overall` : ''}`; }
    function fill() {
      const q = norm(search.value).trim(); const words = q ? q.split(/\s+/) : [];
      shown = teams.filter((t) => { const hay = norm(`${t.name} ${t.abbr} ${t.conf}`); return words.every((w) => hay.includes(w)); });
      list.replaceChildren(); let conf = null;
      shown.forEach((t, i) => {
        if (t.conf !== conf) { conf = t.conf; list.append(h('div', { class: 'qp-group' }, conf || 'Other')); }
        list.append(h('div', { class: `qp-opt${t.id === sel.value ? ' cur' : ''}`, role: 'option', id: `${sel.name}-opt-${t.id}`, 'aria-selected': String(t.id === sel.value), 'data-i': i, onclick: () => choose(t.id) },
          h('img', { src: logoUrl(t.logo, t.abbr), alt: '', width: 22, height: 22, loading: 'lazy', decoding: 'async' }), h('span', { class: 'qp-opt-name' }, t.name), h('span', { class: 'qp-opt-abbr' }, t.abbr), h('span', { class: 'qp-opt-ovr' }, t.ovr)));
      });
      if (!shown.length) list.append(h('div', { class: 'qp-none' }, 'No team matches that.'));
      setActive(q ? 0 : shown.findIndex((t) => t.id === sel.value), !q);
    }
    function setActive(i, centre = false) { active = shown.length ? Math.max(0, Math.min(shown.length - 1, i)) : -1; for (const o of list.querySelectorAll('.qp-opt')) o.classList.toggle('active', Number(o.dataset.i) === active); const el = list.querySelector('.qp-opt.active'); if (el) { el.scrollIntoView({ block: centre ? 'center' : 'nearest' }); search.setAttribute('aria-activedescendant', el.id); } }
    function open() { if (openOne && openOne !== api) openOne.close(); openOne = api; panel.hidden = false; button.setAttribute('aria-expanded', 'true'); search.value = ''; fill(); search.focus(); }
    function close(focus = false) { if (panel.hidden) return; panel.hidden = true; button.setAttribute('aria-expanded', 'false'); if (openOne === api) openOne = null; if (focus) button.focus(); }
    function choose(id) { close(true); if (id === sel.value) return; sel.value = id; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    button.addEventListener('click', () => (panel.hidden ? open() : close()));
    search.addEventListener('input', fill);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); } else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) choose(shown[active].id); } else if (e.key === 'Escape') { e.preventDefault(); close(true); }
    });
    button.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); } });
    const api = { close, paint, wrap }; paint(); return api;
  }
  const combos = [combo(away), combo(home)];
  document.addEventListener('pointerdown', (e) => { if (openOne && !openOne.wrap.contains(e.target)) openOne.close(); });

  // ---- the matchup board follows the two picks ----
  let last = { away: away.value, home: home.value }, seq = 0;
  function links() { for (const a of document.querySelectorAll('.qp-play')) a.href = `/quickplay/play?away=${away.value}&home=${home.value}&side=${a.dataset.side}&q=${len?.value || 5}`; }
  async function update(changed) {
    // the same team on both sides: the other side takes the team this side just had
    if (away.value === home.value) { const other = changed === away ? home : away; other.value = changed === away ? last.away : last.home; if (other.value === changed.value) other.selectedIndex = (other.selectedIndex + 1) % other.options.length; }
    last = { away: away.value, home: home.value }; combos.forEach((c) => c.paint()); links();
    history.replaceState(null, '', `/quickplay?away=${away.value}&home=${home.value}`);
    const play = document.querySelectorAll('.qp-play'); const ab = (sel) => teamOf(sel.selectedOptions[0]).abbr;
    if (play.length >= 2) { play[0].textContent = `Play as ${ab(away)}`; play[1].textContent = `Play as ${ab(home)}`; }
    const mine = ++seq; boardEl.classList.add('loading');
    try {
      const r = await fetch(`/quickplay/preview?away=${away.value}&home=${home.value}`); const text = await r.text(); if (mine !== seq) return;
      boardEl.innerHTML = text; // the fragment's own <script> tag does not run again; the figures are mounted below
      if (window.mountHeroes) window.mountHeroes(boardEl);
    } catch { /* keep the board that is there */ } finally { if (mine === seq) boardEl.classList.remove('loading'); }
  }
  away.addEventListener('change', () => update(away)); home.addEventListener('change', () => update(home)); len?.addEventListener('change', links);
  form.querySelector('[data-swap]')?.addEventListener('click', () => { const a = away.value; away.value = home.value; home.value = a; last = { away: '', home: '' }; update(away); });
  form.querySelector('[data-random]')?.addEventListener('click', () => {
    const n = away.options.length; const i = Math.floor(Math.random() * n); let j = Math.floor(Math.random() * (n - 1)); if (j >= i) j++;
    away.selectedIndex = i; home.selectedIndex = j; update(away);
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); update(away); });
  links();
})();
