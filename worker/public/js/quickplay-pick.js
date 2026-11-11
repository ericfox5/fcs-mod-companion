// Quickplay team picker (pages/quickplay.ts): when either team changes, swap in the matchup board for the new pair
// (/quickplay/preview), remount the 3D figures, and point the Play links and the address bar at it.
(() => {
  const form = document.querySelector('[data-quickplay]'); const boardEl = document.getElementById('qp-board'); if (!form || !boardEl) return;
  const away = form.elements.away, home = form.elements.home, len = document.getElementById('qp-q');
  const abbr = (sel) => (/^(.*) \(\d+\)$/.exec(sel.selectedOptions[0]?.textContent || '')?.[1] || '').trim();
  const logo = (sel) => { const k = sel.selectedOptions[0]?.dataset.logo; const img = sel.closest('.qp-sel')?.querySelector('img'); if (img) img.src = k ? `/img/logos/${k.replace(/^teams\//, 'teams64/')}` : `/img/logos/teams/none.png?t=${encodeURIComponent(abbr(sel).slice(0, 4))}`; };
  let last = { away: away.value, home: home.value }, seq = 0;
  function links() {
    for (const a of document.querySelectorAll('.qp-play')) a.href = `/quickplay/play?away=${away.value}&home=${home.value}&side=${a.dataset.side}&q=${len?.value || 5}`;
  }
  async function update(changed) {
    // the same team on both sides: the other side takes the team this side just had
    if (away.value === home.value) { const other = changed === away ? home : away; other.value = changed === away ? last.away : last.home; if (other.value === changed.value) other.selectedIndex = (other.selectedIndex + 1) % other.options.length; }
    last = { away: away.value, home: home.value }; logo(away); logo(home); links();
    history.replaceState(null, '', `/quickplay?away=${away.value}&home=${home.value}`);
    const mine = ++seq; boardEl.classList.add('loading');
    try {
      const r = await fetch(`/quickplay/preview?away=${away.value}&home=${home.value}`); const text = await r.text(); if (mine !== seq) return;
      boardEl.innerHTML = text; // the fragment's own <script> tag does not run again; the figures are mounted below
      const names = boardEl.querySelectorAll('.ob-side > .ob-ab'); const play = document.querySelectorAll('.qp-play');
      if (names.length === 2) { play[0].textContent = `Play as ${names[0].textContent}`; play[1].textContent = `Play as ${names[1].textContent}`; }
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
