// Quickplay: any two 2026 FCS teams, played in Supersim with no dynasty and no account.
//
//   GET /quickplay[?away=<tgid>&home=<tgid>]          pick the two teams; the matchup board (the game preview's odds box:
//                                                      3D figures, projected score, win bar, the three lines) follows the picks
//   GET /quickplay/preview?away=<tgid>&home=<tgid>    that board alone, as an HTML fragment (the page swaps it in)
//   GET /quickplay/play?away=&home=&side=away|home|watch&q=<minutes>   the Supersim page; the game runs in the browser
//                                                      (public/js/supersim/quickplay.js), nothing is stored or sent
//
// The teams come from the static Quickplay rosters (public/data/quickplay/, tools/quickplay-data.mts): index.json holds
// each team's colours, logo, unit grades for the odds model and best player; the per-team files are only read by the browser.
import type { Env } from '../env.js';
import { html, page, notFound, type Raw } from '../html.js';
import { layout, box } from '../layout.js';
import { matchupOdds, type TeamUnits } from '@ncaa/ncaa14';
import type { TeamRow } from '../db/queries.js';
import { oddsBox, type Star } from './odds.js';
import { skinOf } from './game.js';
import { teamLogo } from './common.js';

export interface QuickTeam {
  id: number; name: string; abbr: string; mascot: string; conf: string; primary: string; secondary: string; logoKey: string | null; offBook: number; defBook: number; overall: number;
  units: TeamUnits; star: { pgid: number; name: string; pos: string; number: number; headId: number; stat: string };
}
interface QuickIndex { generated: string; roster: string; teams: QuickTeam[] }

// index.json, once per isolate (it only changes with a deploy)
let cached: Promise<QuickIndex | null> | null = null;
export function quickIndex(env: Env, origin: string): Promise<QuickIndex | null> {
  cached ??= env.ASSETS.fetch(new Request(`${origin}/data/quickplay/index.json`)).then((r) => (r.ok ? (r.json() as Promise<QuickIndex>) : null)).catch(() => null);
  cached.then((v) => { if (!v) cached = null; });
  return cached;
}

// the odds box takes TEAM rows: give it the few fields it reads (colours from raw_json, the logo key)
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const asRow = (t: QuickTeam): TeamRow => {
  const p = rgb(t.primary), s = rgb(t.secondary);
  return { tgid: t.id, name: t.name, long_name: t.name, mascot: t.mascot, abbr: t.abbr, logo_key: t.logoKey, raw_json: JSON.stringify({ TBCR: p[0], TBCG: p[1], TBCB: p[2], TB2R: s[0], TB2G: s[1], TB2B: s[2] }) } as unknown as TeamRow;
};
const star = (t: QuickTeam): Star => ({ pgid: t.star.pgid, name: t.star.name, pos: t.star.pos, number: t.star.number, stat: t.star.stat, skin: skinOf(t.star.headId) });
const board = (away: QuickTeam, home: QuickTeam): Raw => oddsBox(asRow(away), asRow(home), matchupOdds(home.units, away.units), '', { away: star(away), home: star(home) });

const pick = (idx: QuickIndex, v: string | null) => { const n = Number(v); return v !== null && Number.isInteger(n) ? idx.teams.find((t) => t.id === n) : undefined; };
const playHref = (away: QuickTeam, home: QuickTeam, side: string, q: number) => `/quickplay/play?away=${away.id}&home=${home.id}&side=${side}&q=${q}`;
// 'wasm-unsafe-eval' and blob: are for the 3D figure on celebration cards (js/hero3d.js): its mesh decoder is a small
// WebAssembly module and the model's textures are read through blob: URLs made in the page; nothing else is loosened
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' blob:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'";

export async function quickplay(req: Request, env: Env, parts: string[]): Promise<Response> {
  const url = new URL(req.url); const idx = await quickIndex(env, url.origin);
  if (!idx || idx.teams.length < 2) return notFound('Quickplay rosters are not installed on this site.');
  const a = pick(idx, url.searchParams.get('away')), h = pick(idx, url.searchParams.get('home'));

  if (parts[1] === 'preview') {
    if (!a || !h || a.id === h.id) return page(html`<p class="muted qp-none">Pick two different teams.</p>`, 400, { 'cache-control': 'no-store' });
    return page(board(a, h), 200, { 'cache-control': 'public, max-age=300' });
  }
  if (parts[1] === 'play') {
    if (!a || !h || a.id === h.id) return notFound('Pick two different teams on the Quickplay page.');
    return page(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${a.abbr} at ${h.abbr} | Supersim Quickplay</title><link rel="stylesheet" href="/css/coach.css"></head><body><div id="coach" data-endpoint="local" data-mode="coach" data-books="/data/playbooks/" data-back="/quickplay"></div><script type="module" src="/js/supersim/coach.js"></script></body></html>`, 200, { 'cache-control': 'private, no-store', 'content-security-policy': CSP });
  }
  if (parts.length > 1) return notFound();

  // the picker: the two strongest teams to start with, the stronger one at home
  const ranked = idx.teams.slice().sort((x, y) => y.units.overall - x.units.overall);
  const home = h ?? ranked.find((t) => t.id !== a?.id)!; const away = a && a.id !== home.id ? a : ranked.find((t) => t.id !== home.id)!;
  const confs = [...new Set(idx.teams.map((t) => t.conf || 'Other'))].sort();
  const select = (name: string, cur: QuickTeam, label: string) => html`<label class="qp-pick"><span class="qp-lbl">${label}</span>
    <span class="qp-sel"><span class="qp-native">${teamLogo(asRow(cur), 'md')}</span><select name="${name}" aria-label="${label} team">${confs.map((c) => html`<optgroup label="${c}">${idx.teams.filter((t) => (t.conf || 'Other') === c).map((t) => html`<option value="${t.id}" ${t.id === cur.id ? 'selected' : ''} data-logo="${t.logoKey ?? ''}" data-name="${t.name}" data-abbr="${t.abbr}" data-ovr="${t.overall}">${t.name} (${t.overall})</option>`)}</optgroup>`)}</select></span></label>`;
  const body = html`<div class="quickplay">
    <header class="qp-head"><img class="qp-mark" src="/img/quickplay-button.webp" alt="SuperSim QuickPlay" width="900" height="181">
      <p class="lede">Pick any two 2026 FCS teams and play the game in Supersim: call every snap from the real playbooks, or let the CPU play it out. No account, nothing saved.</p></header>
    <form class="qp-form" method="get" action="/quickplay" data-quickplay>
      ${select('away', away, 'Away')}
      <div class="qp-mid"><span class="qp-at">at</span><button class="btn light sm" type="button" data-swap title="Swap home and away">⇄ Swap</button><button class="btn light sm" type="button" data-random>Random</button></div>
      ${select('home', home, 'Home')}
      <noscript><button class="btn" type="submit">Show this matchup</button></noscript>
    </form>
    <div id="qp-board" aria-live="polite">${board(away, home)}</div>
    <section class="box qp-go"><div class="qp-gorow">
      <label class="qp-len">Quarters <select id="qp-q" aria-label="Minutes per quarter"><option value="3">3 min</option><option value="5" selected>5 min</option><option value="8">8 min</option><option value="12">12 min</option></select></label>
      <a class="btn qp-play" data-side="away" href="${playHref(away, home, 'away', 5)}">Play as ${away.abbr}</a>
      <a class="btn qp-play" data-side="home" href="${playHref(away, home, 'home', 5)}">Play as ${home.abbr}</a>
      <a class="btn light qp-play" data-side="watch" href="${playHref(away, home, 'watch', 5)}">Watch CPU vs CPU</a>
    </div><p class="muted">Quickplay uses the base FCS 2026 roster (${idx.teams.length} teams, roster of ${idx.generated}). The game is played in your browser on the same engine as dynasty Supersim games; the lines above are simulated, for fun, no wagering.</p></section>
  </div><script src="/js/quickplay-pick.js" defer></script>`;
  return layout({ title: 'Quickplay', siteName: env.SITE_NAME, body: html`${body}`, wide: true, css: ['/css/odds.css'] });
}

// the home page's entry
export const quickplayPromo = (): Raw => box('Quickplay', html`<div class="qp-promo"><a class="sim-badge wide" href="/quickplay"><img src="/img/quickplay-button.webp" alt="SuperSim QuickPlay: pick a matchup" width="900" height="181" loading="lazy"></a>
  <p>Any two 2026 FCS teams, one game. Call every snap from the real playbooks in Supersim, or sit back and watch the CPU play it out. No account needed.</p></div>`);
