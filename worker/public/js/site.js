// Small progressive enhancements: clickable table rows, the auto-scrolling scoreboard strip with its week dropdown.

// Expandable rows. morphRow eases a row between two states: apply(open) switches what the row shows, and the row's
// height glides from the old size to the new one (while closing, the content stays on screen until the row has shrunk).
// oneOpen keeps one row open per list: it closes the row's open siblings (openSel finds them; close(row, animate) shuts
// one). Rows above the tapped one close at once and the page scrolls by the same amount, so the tapped row stays put.
(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.morphRow = function (row, open, apply, instant) {
    if (row._morph) row._morph.finish();
    if (reduce || instant || !row.animate) { apply(open); return; }
    var from = row.getBoundingClientRect().height;
    apply(open);
    var to = row.getBoundingClientRect().height;
    if (Math.abs(to - from) < 1) return;
    if (!open) { apply(true); row.classList.add('closing'); }
    row.style.overflow = 'hidden';
    var anim = row.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration: open ? 280 : 220, easing: 'cubic-bezier(.25, .8, .25, 1)' });
    row._morph = anim;
    anim.onfinish = function () { row._morph = null; row.style.overflow = ''; if (!open) { row.classList.remove('closing'); apply(false); } };
  };
  window.oneOpen = function (row, openSel, close) {
    var list = row.parentElement; if (!list) return;
    var before = row.getBoundingClientRect().top;
    Array.prototype.slice.call(list.querySelectorAll(openSel)).forEach(function (r) {
      if (r === row || r.parentElement !== list) return;
      close(r, !(r.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING)); // animate only rows below the tapped one
    });
    var shift = row.getBoundingClientRect().top - before; if (shift) window.scrollBy(0, shift);
  };
})();
(function () {
  // rows that carry data-href open their page (links inside the row still work on their own)
  document.addEventListener('click', function (e) {
    var tr = e.target.closest ? e.target.closest('tr[data-href]') : null;
    if (!tr || e.target.closest('a, button, select, input, label')) return;
    location.href = tr.getAttribute('data-href');
  });

  var strip = document.querySelector('.scorestrip');
  if (!strip) return;
  var scroll = strip.querySelector('.st-scroll');
  var select = strip.querySelector('.st-select');
  var track = null, paused = false, touched = false;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var SPEED = 36; // px per second

  function setPaused(p) { paused = p; if (track) track.style.animationPlayState = p ? 'paused' : 'running'; }
  function build() {
    var tiles = Array.prototype.slice.call(scroll.querySelectorAll('.st-tile'));
    var empty = scroll.querySelector('.st-empty');
    scroll.innerHTML = '';
    track = document.createElement('div');
    track.className = 'st-track';
    if (empty) track.appendChild(empty);
    tiles.forEach(function (t) { track.appendChild(t); });
    scroll.appendChild(track);
    var width = track.scrollWidth;
    if (!reduceMotion && tiles.length && width > scroll.clientWidth + 1) {
      tiles.forEach(function (t) { track.appendChild(t.cloneNode(true)); }); // second copy makes the wrap seamless
      track.style.animationDuration = (width / SPEED) + 's';
      track.classList.add('st-anim');
      track.style.animationPlayState = paused ? 'paused' : 'running';
    }
  }
  strip.addEventListener('mouseenter', function () { if (!touched) setPaused(true); });
  strip.addEventListener('mouseleave', function () { if (!touched) setPaused(false); });
  strip.addEventListener('touchstart', function (e) { touched = true; if (!e.target.closest('select')) setPaused(!paused); }, { passive: true });
  if (select) {
    select.addEventListener('focus', function () { setPaused(true); });
    select.addEventListener('change', function () {
      var url = select.getAttribute('data-url') + '?week=' + encodeURIComponent(select.value);
      fetch(url).then(function (r) { return r.text(); }).then(function (htmlText) { scroll.innerHTML = htmlText; paused = false; build(); select.blur(); }).catch(function () {});
    });
  }
  build();
  var rt; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(build, 200); });
})();

// recruiting board: tap a prospect row to expand it; +/- steppers on number inputs
(function () {
  document.addEventListener('click', function (e) {
    var sum = e.target.closest('.pr-sum');
    if (sum && !sum.classList.contains('static') && !e.target.closest('a, input, button:not(.pr-sum), .istack')) {
      var pr = sum.closest('.pr'); var open = !pr.classList.contains('open');
      var state = function (r) { return function (o) { r.classList.toggle('open', o); var s = r.querySelector('.pr-sum'); if (s) s.setAttribute('aria-expanded', o ? 'true' : 'false'); }; };
      if (open) window.oneOpen(pr, '.pr.open', function (r, animate) { window.morphRow(r, false, state(r), !animate); });
      window.morphRow(pr, open, state(pr)); return;
    }
    var st = e.target.closest('.st-btn');
    if (st) {
      var input = document.getElementById(st.getAttribute('data-for')); if (!input) return;
      var step = Number(st.getAttribute('data-step')) || 0, min = Number(input.min) || 0, max = Number(input.max) || 100000;
      var v = Math.max(min, Math.min(max, (Number(input.value) || 0) + step));
      input.value = v; input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
})();

// prospect lists: sortable column headings and position/stars filters (client side)
(function () {
  function listFor(el) { var box = el.closest('.box') || document; return box.querySelector('.prlist'); }
  document.addEventListener('click', function (e) {
    var h = e.target.closest('.pr-head .ph[data-sort]');
    if (!h) return;
    var list = h.closest('.prlist'); var key = h.getAttribute('data-sort');
    var dir = h.classList.contains('asc') ? 'desc' : 'asc';
    list.querySelectorAll('.ph').forEach(function (x) { x.classList.remove('asc', 'desc'); });
    h.classList.add(dir);
    var rows = Array.prototype.slice.call(list.querySelectorAll('.pr'));
    rows.sort(function (a, b) {
      var va = a.getAttribute('data-' + key) || '', vb = b.getAttribute('data-' + key) || '';
      var na = parseFloat(va), nb = parseFloat(vb);
      var c = (!isNaN(na) && !isNaN(nb)) ? na - nb : va.localeCompare(vb);
      return dir === 'asc' ? c : -c;
    });
    rows.forEach(function (r) { list.appendChild(r); });
  });
  document.addEventListener('change', function (e) {
    var sel = e.target.closest('.prtools select[data-filter]');
    if (!sel) return;
    var tools = sel.closest('.prtools'); var list = listFor(tools); if (!list) return;
    var filters = Array.prototype.slice.call(tools.querySelectorAll('select[data-filter]')).map(function (s) { return [s.getAttribute('data-filter'), s.value]; }).filter(function (f) { return f[1]; });
    var shown = 0, total = 0;
    list.querySelectorAll('.pr').forEach(function (pr) {
      total++;
      var ok = filters.every(function (f) { return (pr.getAttribute('data-' + f[0]) || '') === f[1]; });
      pr.style.display = ok ? '' : 'none'; if (ok) shown++;
    });
    var c = tools.querySelector('.ft-count'); if (c) c.textContent = filters.length ? shown + ' of ' + total : '';
  });
})();

// dynasty menu (a <details> on the title in the bar): aria-expanded on the title; a click outside, Esc, or tabbing out
// closes it. A click outside only closes the menu, so it does not also follow a link under the dimmed page.
(function () {
  var dm = document.querySelector('.dmenu'); if (!dm) return;
  var sum = dm.querySelector('summary');
  function sync() { sum.setAttribute('aria-expanded', dm.open ? 'true' : 'false'); }
  function close(focus) { if (!dm.open) return; dm.open = false; sync(); if (focus) sum.focus(); }
  sync();
  dm.addEventListener('toggle', sync);
  document.addEventListener('click', function (e) { if (dm.open && !dm.contains(e.target)) { e.preventDefault(); e.stopPropagation(); close(false); } }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dm.open) { e.preventDefault(); close(dm.contains(document.activeElement)); } });
  dm.addEventListener('focusout', function (e) { if (dm.open && e.relatedTarget && !dm.contains(e.relatedTarget)) close(false); });
})();

// sortable tables (Rosters): click a heading to sort by that column, click again to flip the direction
(function () {
  document.addEventListener('click', function (e) {
    var th = e.target.closest('table.sortable th[data-sort]');
    if (!th) return;
    var table = th.closest('table'); var key = th.getAttribute('data-sort');
    var dir = th.classList.contains('asc') ? 'desc' : 'asc';
    table.querySelectorAll('th[data-sort]').forEach(function (x) { x.classList.remove('asc', 'desc'); x.removeAttribute('aria-sort'); });
    th.classList.add(dir); th.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : 'descending');
    var body = table.tBodies[0] || table;
    var rows = Array.prototype.slice.call(body.querySelectorAll('tr')).filter(function (r) { return r.hasAttribute('data-' + key) || r.querySelector('td'); });
    rows.sort(function (a, b) {
      var va = a.getAttribute('data-' + key) || '', vb = b.getAttribute('data-' + key) || '';
      var na = parseFloat(va), nb = parseFloat(vb);
      var c = (!isNaN(na) && !isNaN(nb)) ? na - nb : va.localeCompare(vb, undefined, { sensitivity: 'base' });
      return dir === 'asc' ? c : -c;
    });
    rows.forEach(function (r) { body.appendChild(r); });
  });
})();

// Transfer Portal: search / school / member-team filters and sort (rows carry data-search, data-team, data-member and
// the sort keys), plus the commissioner's inline Edit panels (destination options are cloned from <template id="tp-teams">)
(function () {
  function apply(tools, resort) {
    var box = tools.closest('.box'); var list = box && box.querySelector('.tp-list'); if (!list) return;
    var q = (tools.querySelector('[data-tp-search]') || {}).value || '';
    var team = (tools.querySelector('[data-tp-team]') || {}).value || '';
    var mem = tools.querySelector('[data-tp-members]'); var onlyMem = !!(mem && mem.checked);
    var words = q.toLowerCase().split(/\s+/).filter(Boolean); var shown = 0;
    var rows = Array.prototype.slice.call(list.querySelectorAll('.tp-row'));
    rows.forEach(function (li) {
      var s = li.getAttribute('data-search') || '';
      var ok = words.every(function (w) { return s.indexOf(w) !== -1; }) && (!team || li.getAttribute('data-team') === team) && (!onlyMem || li.getAttribute('data-member') === '1');
      li.style.display = ok ? '' : 'none'; if (ok) shown++;
    });
    if (resort) {
      var key = 'data-' + ((tools.querySelector('[data-tp-sort]') || {}).value || 'ovr'), desc = key === 'data-ovr';
      rows.sort(function (a, b) {
        var va = a.getAttribute(key) || '', vb = b.getAttribute(key) || '';
        if (!va !== !vb) return va ? -1 : 1; // blanks (no destination) last either way
        var na = parseFloat(va), nb = parseFloat(vb);
        var c = (!isNaN(na) && !isNaN(nb)) ? na - nb : va.localeCompare(vb, undefined, { sensitivity: 'base' });
        return desc ? -c : c;
      });
      rows.forEach(function (li) { list.appendChild(li); });
    }
    var c = tools.querySelector('.ft-count'); if (c) c.textContent = (words.length || team || onlyMem) ? shown + ' of ' + rows.length : '';
  }
  document.addEventListener('input', function (e) { var t = e.target.closest('.tp-tools'); if (t) apply(t, false); });
  document.addEventListener('change', function (e) { var t = e.target.closest('.tp-tools'); if (t) apply(t, !!e.target.closest('[data-tp-sort]')); });

  function fill(sel) {
    var tpl = document.getElementById('tp-teams'); if (!tpl || sel.getAttribute('data-filled')) return;
    var cur = sel.value, frag = tpl.content.cloneNode(true);
    var own = frag.querySelector('option[value="' + sel.getAttribute('data-from') + '"]'); if (own) own.parentNode.removeChild(own);
    Array.prototype.slice.call(sel.options).forEach(function (o) { if (o.value) sel.removeChild(o); });
    sel.appendChild(frag); sel.value = cur; sel.setAttribute('data-filled', '1');
  }
  // Each row has two disclosures: the stats/ratings drawer (tap the row or its caret) and the commissioner's Edit panel.
  // Opening either one closes whatever another row has open (oneOpen keeps the tapped row where it was on screen).
  function show(el, open) { if (!el) return; if (open) el.removeAttribute('hidden'); else el.setAttribute('hidden', ''); }
  function setMore(row, open) {
    show(row.querySelector('.tp-more'), open); row.classList.toggle('more', open);
    var c = row.querySelector('[data-tp-more]'); if (c) c.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function setEdit(row, open) {
    var b = row.querySelector('[data-tp-toggle]'); var panel = b && document.getElementById(b.getAttribute('data-tp-toggle')); if (!panel) return;
    show(panel, open); b.setAttribute('aria-expanded', open ? 'true' : 'false'); row.classList.toggle('open', open);
  }
  // shuts whatever another row has open (its drawer, its Edit panel or both), keeping it on screen while it closes
  function closeRow(r, animate) {
    var edit = r.classList.contains('open'), more = r.classList.contains('more');
    window.morphRow(r, false, function (o) { setEdit(r, o && edit); setMore(r, o && more); }, !animate);
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-tp-toggle]');
    var row = e.target.closest('.tp-row');
    if (b) {
      var panel = document.getElementById(b.getAttribute('data-tp-toggle')); if (!panel || !row) return;
      e.preventDefault();
      var open = panel.hasAttribute('hidden');
      if (open) window.oneOpen(row, '.tp-row.open, .tp-row.more', closeRow);
      window.morphRow(row, open, function (o) { setEdit(row, o); });
      if (open) { var sel = panel.querySelector('[data-tp-dest]'); if (sel) { fill(sel); sel.focus(); } }
      return;
    }
    if (!row) return;
    var caret = e.target.closest('[data-tp-more]');
    if (!caret && e.target.closest('a, button, select, input, textarea, label, form, .tp-panel, .tp-more, .tp-note')) return;
    if (!caret && window.getSelection && String(window.getSelection())) return; // selecting text, not tapping
    var opening = !row.classList.contains('more');
    if (opening) window.oneOpen(row, '.tp-row.open, .tp-row.more', closeRow);
    window.morphRow(row, opening, function (o) { setMore(row, o); });
  });
})();

// Player pages: selects that navigate (Switch Player) and tab strips ([data-tabs] with [data-tab] buttons and
// [data-panel] blocks, e.g. the game log's Passing / Rushing tables).
(function () {
  document.addEventListener('change', function (e) {
    var s = e.target.closest('select[data-nav]'); if (s && s.value) location.href = s.value;
  });
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-tabs] [data-tab]'); if (!b) return;
    var box = b.closest('[data-tabs]'), id = b.getAttribute('data-tab');
    var own = function (el) { return el.parentElement.closest('[data-tabs]') === box; }; // tab sets nest (season > category)
    box.querySelectorAll('[data-tab]').forEach(function (x) { if (own(x)) x.setAttribute('aria-selected', x === b ? 'true' : 'false'); });
    box.querySelectorAll('[data-panel]').forEach(function (p) { if (!own(p)) return; if (p.getAttribute('data-panel') === id) p.removeAttribute('hidden'); else p.setAttribute('hidden', ''); });
  });
})();

// Depth chart page: a slot select starts with its current player only; the roster (one <template id="dc-players">,
// grouped by position) is cloned into it the first time it is touched, with the slot's own position group first.
// A changed select is marked dirty so the coach sees what the save will send.
(function () {
  function fill(sel) {
    var tpl = document.getElementById('dc-players'); if (!tpl || sel.getAttribute('data-filled')) return;
    var cur = sel.value, frag = tpl.content.cloneNode(true), own = frag.querySelector('optgroup[data-pos="' + sel.getAttribute('data-pos') + '"]');
    if (own) frag.insertBefore(own, frag.firstChild);
    var dflt = sel.getAttribute('data-default'); // formation subs: "depth chart" (no sub) stays on top
    Array.prototype.slice.call(sel.options).forEach(function (o) { sel.removeChild(o); });
    if (dflt !== null) { var o = document.createElement('option'); o.value = '0'; o.textContent = dflt; sel.appendChild(o); }
    else if (!own) { var z = document.createElement('option'); z.value = '0'; z.textContent = '—'; sel.appendChild(z); }
    sel.appendChild(frag); sel.value = cur; sel.setAttribute('data-filled', '1');
  }
  ['pointerdown', 'focusin', 'keydown', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, function (e) { var s = e.target && e.target.closest ? e.target.closest('select[data-dc]') : null; if (s) fill(s); }, true); });
  document.addEventListener('change', function (e) {
    var s = e.target.closest('select[data-dc]'); if (!s) return;
    s.classList.toggle('dirty', s.value !== (s.getAttribute('data-orig') || '0'));
  });
})();

// recruit editor: the face picker shows the chosen head art beside it
document.addEventListener('change', function (e) {
  var sel = e.target && e.target.closest ? e.target.closest('select[data-face-for]') : null;
  if (!sel) return;
  var img = document.getElementById(sel.getAttribute('data-face-for'));
  if (img) img.src = '/img/faces/' + encodeURIComponent(sel.value) + '.png';
});
