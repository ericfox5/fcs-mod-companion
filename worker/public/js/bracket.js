// FCS playoff bracket page: runs the bracket games between two CPU teams from here (worker/src/supersim/routes.ts,
// a "drive": start the game, then let the CPU play it out 12 snaps per request until the final), one at a time.
// Spectators can watch any of them live on /d/<slug>/supersim/watch/<week>/<game_no>.
(() => {
  const root = document.querySelector('.bracket'); if (!root) return;
  const slug = root.dataset.slug; const log = document.querySelector('.bk-simlog');
  const say = (t) => { if (log) { log.hidden = !t; log.textContent = t; } };
  const post = async (game, body) => {
    const r = await fetch(`/d/${slug}/supersim/data?game=${encodeURIComponent(game)}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let d = null; try { d = await r.json(); } catch { /* not JSON */ }
    if (!r.ok && !(r.status === 409 && d?.stale)) throw new Error(d?.error || `Request failed (${r.status})`);
    return d;
  };
  const qLabel = (q) => (q <= 4 ? `Q${q}` : q === 5 ? 'OT' : `${q - 4}OT`);
  const simOne = async (btn) => {
    const game = btn.dataset.game; const label = btn.textContent; btn.disabled = true;
    try {
      let p = await post(game, { action: 'start' });
      let guard = 0;
      while (!(p.state && p.state.final) && guard++ < 80) {
        const n = p.state ? p.state.n : 0;
        btn.textContent = p.state ? `${qLabel(p.state.q)} · ${p.state.score[0]}-${p.state.score[1]} (${n} plays)` : 'Starting…';
        p = await post(game, { action: 'auto', plays: 12, version: p.version });
        if (p.stale && p.version === undefined) { p = await post(game, { action: 'auto', plays: 1, version: 0 }); }
      }
      btn.textContent = p.state ? `Final ${p.state.score[0]}-${p.state.score[1]}` : label;
      return true;
    } catch (e) { btn.textContent = label; btn.disabled = false; say(`${label}: ${e.message}`); return false; }
  };
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('.bk-sim'); if (!b) return;
    say('Playing… you can watch it live from the Supersim page.');
    if (await simOne(b)) location.reload();
  });
  document.addEventListener('click', async (e) => {
    const all = e.target.closest('.bk-sim-all'); if (!all) return;
    all.disabled = true; const buttons = [...root.querySelectorAll('.bk-sim')];
    say(`Playing ${buttons.length} game(s)…`);
    let ok = 0; for (const b of buttons) { if (await simOne(b)) ok++; }
    say(`${ok} of ${buttons.length} game(s) final.`); if (ok) location.reload(); else all.disabled = false;
  });
})();
