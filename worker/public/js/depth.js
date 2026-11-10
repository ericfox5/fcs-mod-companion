// Depth chart page: lineup cards. Tap a slot (the starter card or a backup row), then tap another slot to swap the two
// players, or tap a roster card to put that player in the slot; a roster card first, then a slot, works too. Every slot
// owns a hidden input (s<pos>_<depth>) that the form posts, so nothing here changes what the server saves. A player's
// details come from his roster card's data attributes. Swaps glide with the Web Animations API (not under reduced motion).
(function () {
  var root = document.querySelector('.lc-box'); if (!root || !root.querySelector('button.lc-slot')) return;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var EASE = 'cubic-bezier(.25, .8, .25, 1)';
  var save = document.querySelector('[data-save]'), hint = document.querySelector('[data-hint]');
  var hint0 = hint ? hint.textContent : '';
  var sel = null; // the first tap: { kind: 'slot' | 'bench', el }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function player(id) { var b = root.querySelector('.lc-mini[data-bench="' + id + '"]'); return b ? b.dataset : null; }
  function slotInput(el) { var m = /^(\d+)_(\d+)$/.exec(el.getAttribute('data-slot') || ''); return m ? root.querySelector('input[name="s' + m[1] + '_' + m[2] + '"]') : null; }
  var rsTag = '<span class="tag rs" title="Redshirting this season: the game keeps him off the field">RS</span>';
  function starter(p, id) {
    if (!p) return '<span class="lc-strip"><span class="lc-num">' + (id ? '#' + esc(id) : '') + '</span></span><span class="lc-pic"><img class="lc-shot" src="/img/faces/0.png" alt="" width="86" height="104"></span><span class="lc-name muted">' + (id ? 'Not on the roster' : 'Empty') + '</span><span class="lc-cls">&nbsp;</span>';
    return '<span class="lc-strip"><span class="lc-num">#' + esc(p.num) + '</span>' + (p.rs === '1' ? rsTag : '') + '<span class="ovr-pill t-' + esc(p.tier) + '">' + esc(p.ovr) + '</span></span><span class="lc-pic"><img class="lc-shot" src="' + esc(p.shot) + '" alt="" width="86" height="104"></span><span class="lc-name">' + esc(p.name) + '</span><span class="lc-cls">' + esc(p.cls) + ' · ' + esc(p.pos) + '</span>';
  }
  function backup(p, id, d) {
    if (!p) return '<span class="lc-d">' + (d + 1) + '</span><span class="lc-bname muted">' + (id ? '#' + esc(id) : '—') + '</span><span class="lc-bovr"></span>';
    return '<span class="lc-d">' + (d + 1) + '</span><span class="lc-bname">' + esc(p.name) + (p.rs === '1' ? ' ' + rsTag : '') + '</span><span class="lc-bovr t-' + esc(p.tier) + '">' + esc(p.ovr) + '</span>';
  }
  // show player `id` in a slot and write it to the slot's input
  function render(el, id) {
    id = Number(id) || 0;
    var p = id ? player(id) : null, d = Number((el.getAttribute('data-slot') || '0_0').split('_')[1]);
    el.setAttribute('data-pgid', String(id));
    var inp = slotInput(el); if (inp) inp.value = String(id);
    el.innerHTML = el.classList.contains('lc-starter') ? starter(p, id) : backup(p, id, d);
    el.classList.toggle('dirty', String(id) !== (el.getAttribute('data-orig') || '0'));
    el.classList.toggle('rs', !!(p && p.rs === '1'));
  }
  function fly(el, from) { // glide an element in from where `from` was
    if (reduce || !el.animate) return;
    var to = el.getBoundingClientRect(), dx = from.left + from.width / 2 - (to.left + to.width / 2), dy = from.top + from.height / 2 - (to.top + to.height / 2);
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) { pulse(el); return; }
    el.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)', opacity: .7 }, { transform: 'none', opacity: 1 }], { duration: 280, easing: EASE });
  }
  function pulse(el) { if (reduce || !el.animate) return; el.animate([{ boxShadow: '0 0 0 3px #f5c518' }, { boxShadow: '0 0 0 0 rgba(245, 197, 24, 0)' }], { duration: 500, easing: 'ease-out' }); }
  function swap(a, b) {
    var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(), ia = a.getAttribute('data-pgid'), ib = b.getAttribute('data-pgid');
    render(a, ib); render(b, ia); fly(a, rb); fly(b, ra);
  }
  // a roster player into a slot: if he already holds another slot of that position, the two slots trade (the game and
  // the save both refuse the same player twice at one position); elsewhere on the chart he may stay
  function place(el, id, fromRect) {
    var card = el.closest('.lc'), other = card ? card.querySelector('.lc-slot[data-pgid="' + id + '"]') : null;
    if (other && other !== el) { swap(el, other); return; }
    render(el, id); if (fromRect) fly(el, fromRect); else pulse(el);
  }
  function select(kind, el) {
    clear();
    sel = { kind: kind, el: el }; el.classList.add('on'); el.setAttribute('aria-pressed', 'true');
    if (hint) hint.textContent = kind === 'slot' ? 'Now tap the slot he swaps with, or a roster player who takes his spot. Esc cancels.' : 'Now tap the slot he takes. Esc cancels.';
  }
  function clear() {
    if (sel) { sel.el.classList.remove('on'); sel.el.removeAttribute('aria-pressed'); }
    sel = null; if (hint) hint.textContent = hint0;
  }
  function count() {
    if (!save) return;
    var n = root.querySelectorAll('.lc-slot.dirty').length;
    save.textContent = n ? 'Save depth chart (' + n + ' change' + (n === 1 ? '' : 's') + ')' : 'Save depth chart';
  }
  root.addEventListener('click', function (e) {
    var s = e.target.closest('button.lc-slot'), b = e.target.closest('button.lc-mini');
    if (s) {
      if (!sel) select('slot', s);
      else if (sel.el === s) clear();
      else if (sel.kind === 'slot') { swap(sel.el, s); clear(); }
      else { var r = sel.el.getBoundingClientRect(), id = sel.el.getAttribute('data-bench'); clear(); place(s, id, r); }
      count();
    } else if (b) {
      if (sel && sel.kind === 'slot') { var el = sel.el; clear(); place(el, b.getAttribute('data-bench'), b.getBoundingClientRect()); count(); }
      else if (sel && sel.el === b) clear();
      else select('bench', b);
    }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && sel) clear(); });
  // the roster drawer's search box
  var find = root.querySelector('[data-bench-filter]');
  if (find) find.addEventListener('input', function () {
    var q = find.value.trim().toLowerCase();
    root.querySelectorAll('.lc-mini').forEach(function (m) { var hit = !q || (m.getAttribute('data-search') || '').indexOf(q) >= 0; if (hit) m.removeAttribute('hidden'); else m.setAttribute('hidden', ''); });
  });
  count();
})();
