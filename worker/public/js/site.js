// Small progressive enhancements: clickable table rows, the auto-scrolling scoreboard strip with its week dropdown.
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
      var pr = sum.closest('.pr'); var open = pr.classList.toggle('open'); sum.setAttribute('aria-expanded', open ? 'true' : 'false'); return;
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
